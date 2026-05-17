/**
 * codex.js — Mines OpenAI Codex CLI (Desktop + CLI) conversation history
 *
 * Codex Desktop stores sessions as JSONL event streams:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 *
 * Each line in the JSONL is a typed event:
 *   { timestamp, type: "session_meta",   payload: { id, cwd, model_provider, ... } }
 *   { timestamp, type: "response_item",  payload: { type: "message", role, content: [...] } }
 *   { timestamp, type: "event_msg",      payload: { type: "task_started"|"task_complete", ... } }
 *
 * Messages we care about:
 *   role: "user"      — human turn (input_text content items)
 *   role: "assistant" — model response (output_text or text content items)
 *
 * We skip: role "developer" (system/permissions context), tool calls, tool results
 *
 * Also checks:
 *   ~/.codex/history.jsonl  — legacy plain JSONL history
 *   ~/.codex/session_index.jsonl — session index (used for metadata only)
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');

const CODEX_ROOT    = path.join(os.homedir(), '.codex');
const SESSIONS_DIR  = path.join(CODEX_ROOT, 'sessions');

// ── Main export ──────────────────────────────────────────────────────────────
async function mine({ since, verbose } = {}) {
  if (!fs.existsSync(CODEX_ROOT)) {
    return { source: 'codex', sessions: [], skipped: [CODEX_ROOT] };
  }

  const sessions = [];

  // Primary: YYYY/MM/DD/rollout-*.jsonl event stream files
  if (fs.existsSync(SESSIONS_DIR)) {
    const found = await mineSessionsDir(SESSIONS_DIR, { since, verbose });
    sessions.push(...found);
  }

  // Fallback: legacy ~/.codex/history.jsonl
  const historyFile = path.join(CODEX_ROOT, 'history.jsonl');
  const legacyFile  = path.join(CODEX_ROOT, 'history');
  for (const f of [historyFile, legacyFile]) {
    if (fs.existsSync(f)) {
      const found = await mineHistoryFile(f, { since, verbose });
      sessions.push(...found);
    }
  }

  // Deduplicate by session ID
  const seen   = new Set();
  const unique = sessions.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  unique.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return { source: 'codex', sessions: unique };
}

// ── Recursively walk sessions dir and parse each JSONL event stream ──────────
async function mineSessionsDir(dir, { since, verbose }) {
  const sessions = [];
  let entries;

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return sessions;
  }

  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;

    if (entry.isDirectory()) {
      const sub = await mineSessionsDir(path.join(dir, entry.name), { since, verbose });
      sessions.push(...sub);
      continue;
    }

    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.jsonl') continue;

    const filePath = path.join(dir, entry.name);
    try {
      const session = await parseRolloutJsonl(filePath, { since, verbose });
      if (session && session.messages.length > 0) {
        sessions.push(session);
      }
    } catch (err) {
      if (verbose) console.error(`  [WARN] codex: could not parse ${filePath}: ${err.message}`);
    }
  }

  return sessions;
}

// ── Parse a single Codex Desktop rollout JSONL event stream ─────────────────
async function parseRolloutJsonl(filePath, { since, verbose } = {}) {
  const messages = [];
  let sessionId  = null;
  let sessionTs  = null;
  let cwd        = null;
  let model      = null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }

    const { type, payload, timestamp } = event;
    if (!type || !payload) continue;

    // ── session_meta: grab session metadata ──────────────────────────────────
    if (type === 'session_meta') {
      sessionId = payload.id || sessionId;
      sessionTs = sessionTs || new Date(payload.timestamp || timestamp);
      cwd       = payload.cwd || cwd;
      model     = payload.model_provider || model;
      continue;
    }

    // ── response_item: extract user/assistant messages ────────────────────────
    if (type === 'response_item' && payload.type === 'message') {
      const role = payload.role;

      // Only extract user and assistant turns — skip developer (system/permissions)
      if (role !== 'user' && role !== 'assistant') continue;

      // content is an array of content items
      const contentItems = Array.isArray(payload.content) ? payload.content : [];
      const textParts = contentItems
        .filter(item => {
          // Keep: input_text (user), output_text (assistant), text
          // Skip: tool_call, tool_result, input_image, system context blobs
          if (!item || !item.type) return false;
          if (item.type === 'input_text')  return true;
          if (item.type === 'output_text') return true;
          if (item.type === 'text')        return true;
          return false;
        })
        .map(item => (item.text || item.content || '').trim())
        .filter(t => t.length > 0);

      if (textParts.length === 0) continue;

      const content = textParts.join('\n\n');

      // Skip massive system context injections (AGENTS.md, skills lists, permissions)
      // These are developer role items but occasionally bleed through — filter by size + patterns
      if (
        role === 'user' &&
        content.length > 8000 &&
        (content.includes('AGENTS.md instructions') ||
         content.includes('<permissions instructions>') ||
         content.includes('<environment_context>') ||
         content.includes('<app-context>'))
      ) {
        continue;
      }

      // Also skip the skills list injection (role=user, huge blob starting with "# AGENTS.md")
      if (role === 'user' && content.startsWith('# AGENTS.md instructions')) {
        continue;
      }

      messages.push({
        role:      role === 'user' ? 'human' : 'assistant',
        content,
        timestamp: timestamp ? new Date(timestamp) : null,
      });
    }
  }

  if (messages.length === 0) return null;

  // Apply since filter
  if (since && sessionTs && sessionTs < since) return null;

  // Derive title from first human message
  const firstHuman = messages.find(m => m.role === 'human');
  const title = firstHuman
    ? firstHuman.content.replace(/\s+/g, ' ').trim().slice(0, 80)
    : path.basename(filePath, '.jsonl');

  // Derive ID from session UUID or file path hash
  const id = sessionId || hashPath(filePath);

  // Derive workspace label from cwd
  const workspace = cwd ? path.basename(cwd) : null;

  return {
    source:     'codex',
    id,
    filePath,
    title:      title || 'Untitled Codex Session',
    timestamp:  sessionTs || fs.statSync(filePath).mtime,
    messages,
    turnCount:  messages.length,
    workspace,
    cwd,
    model,
  };
}

// ── Parse legacy ~/.codex/history.jsonl (one session summary per line) ───────
async function mineHistoryFile(filePath, { since, verbose } = {}) {
  const sessions = [];

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch (_) { continue; }

    // Extract whatever message-like fields exist
    const messages = [];
    if (obj.prompt || obj.input || obj.query) {
      messages.push({ role: 'human', content: obj.prompt || obj.input || obj.query, timestamp: null });
    }
    if (obj.response || obj.output || obj.completion) {
      messages.push({ role: 'assistant', content: obj.response || obj.output || obj.completion, timestamp: null });
    }

    if (messages.length === 0) continue;

    const ts = obj.timestamp ? new Date(obj.timestamp) : null;
    if (since && ts && ts < since) continue;

    sessions.push({
      source:    'codex',
      id:        obj.id || hashPath(`${filePath}-${sessions.length}`),
      filePath,
      title:     messages[0].content.slice(0, 80),
      timestamp: ts || fs.statSync(filePath).mtime,
      messages,
      turnCount: messages.length,
    });
  }

  return sessions;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPath(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

module.exports = { mine };
