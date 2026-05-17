/**
 * codex.js — Mines OpenAI Codex CLI (Desktop + CLI) conversation history
 *
 * Codex Desktop stores sessions as JSONL event streams:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 *
 * Each line is a typed event:
 *   { timestamp, type: "session_meta",   payload: { id, cwd, model_provider, originator, ... } }
 *   { timestamp, type: "response_item",  payload: { type: "message", role, content: [...] } }
 *   { timestamp, type: "event_msg",      payload: { type: "task_started"|"task_complete", ... } }
 *
 * We capture:
 *   - User + assistant message turns (the conversation)
 *   - Skills invoked (extracted from AGENTS.md injection in developer role)
 *   - Tool calls (shell commands, file edits, git ops run by Codex)
 *   - File paths touched (from tool calls and message content)
 *   - Working directory / project context (cwd from session_meta)
 *   - Automation directives (::automation-update{...} in assistant responses)
 *   - Task outcome (task_started / task_complete events)
 *   - Model and originator metadata
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');

const CODEX_ROOT   = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_ROOT, 'sessions');

// ── Main export ──────────────────────────────────────────────────────────────
async function mine({ since, verbose } = {}) {
  if (!fs.existsSync(CODEX_ROOT)) {
    return { source: 'codex', sessions: [], skipped: [CODEX_ROOT] };
  }

  const sessions = [];

  if (fs.existsSync(SESSIONS_DIR)) {
    const found = await mineSessionsDir(SESSIONS_DIR, { since, verbose });
    sessions.push(...found);
  }

  // Fallback: legacy ~/.codex/history.jsonl
  for (const f of ['history.jsonl', 'history'].map(n => path.join(CODEX_ROOT, n))) {
    if (fs.existsSync(f)) {
      const found = await mineHistoryFile(f, { since, verbose });
      sessions.push(...found);
    }
  }

  const seen   = new Set();
  const unique = sessions.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  unique.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return { source: 'codex', sessions: unique };
}

// ── Recursively walk sessions dir ────────────────────────────────────────────
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
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jsonl') continue;

    const filePath = path.join(dir, entry.name);
    try {
      const session = await parseRolloutJsonl(filePath, { since, verbose });
      if (session && session.messages.length > 0) sessions.push(session);
    } catch (err) {
      if (verbose) console.error(`  [WARN] codex: ${filePath}: ${err.message}`);
    }
  }
  return sessions;
}

// ── Parse a Codex Desktop rollout JSONL event stream ─────────────────────────
async function parseRolloutJsonl(filePath, { since, verbose } = {}) {
  const messages      = [];   // { role, content, timestamp }
  const toolCalls     = [];   // { tool, input, timestamp }
  const skillsUsed    = [];   // skill names mentioned/invoked
  const filesTouched  = new Set();
  const automations   = [];   // ::automation-update directives
  let   taskOutcome   = null; // 'complete' | 'started' | null

  let sessionId   = null;
  let sessionTs   = null;
  let cwd         = null;
  let model       = null;
  let originator  = null;
  let skillsAvail = [];       // skills listed in AGENTS.md injection

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }

    const { type, payload, timestamp } = event;
    if (!type || !payload) continue;

    // ── session_meta ──────────────────────────────────────────────────────────
    if (type === 'session_meta') {
      sessionId  = payload.id  || sessionId;
      sessionTs  = sessionTs   || new Date(payload.timestamp || timestamp);
      cwd        = payload.cwd || cwd;
      model      = payload.model_provider || model;
      originator = payload.originator     || originator;
      continue;
    }

    // ── event_msg — task lifecycle ────────────────────────────────────────────
    if (type === 'event_msg') {
      const evType = payload.type || '';
      if (evType === 'task_complete') taskOutcome = 'complete';
      else if (evType === 'task_started' && !taskOutcome) taskOutcome = 'started';
      continue;
    }

    // ── response_item ─────────────────────────────────────────────────────────
    if (type !== 'response_item') continue;

    const role    = payload.role;
    const content = Array.isArray(payload.content) ? payload.content : [];

    // ── Developer role: extract available skills from AGENTS.md injection ─────
    if (role === 'developer') {
      for (const item of content) {
        const text = item.text || item.content || '';
        if (!text) continue;

        // Extract skill names + descriptions from the structured skills list
        // Format: "- skill-name: Description text (file: /path/SKILL.md)"
        const skillMatches = text.matchAll(/^-\s+([\w-]+):\s+(.+?)(?:\s+\(file:[^)]+\))?$/gm);
        for (const m of skillMatches) {
          skillsAvail.push({ name: m[1], description: m[2].trim() });
        }
      }
      continue;
    }

    // ── Tool calls (function_call / tool_use) ─────────────────────────────────
    if (payload.type === 'function_call' || payload.type === 'tool_use') {
      const toolName  = payload.name || payload.function?.name || 'unknown_tool';
      const toolInput = payload.arguments || payload.input || {};

      // Extract file paths from tool input
      const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
      extractFilePaths(inputStr).forEach(p => filesTouched.add(p));

      toolCalls.push({
        tool:      toolName,
        input:     toolInput,
        timestamp: timestamp ? new Date(timestamp) : null,
      });
      continue;
    }

    // ── User and assistant message turns ──────────────────────────────────────
    if (role !== 'user' && role !== 'assistant') continue;

    const textParts = content
      .filter(item => item && ['input_text', 'output_text', 'text'].includes(item.type))
      .map(item => (item.text || item.content || '').trim())
      .filter(Boolean);

    if (textParts.length === 0) continue;

    const fullText = textParts.join('\n\n');

    // Skip massive system context injections (AGENTS.md, permissions blobs)
    if (
      role === 'user' &&
      fullText.length > 5000 &&
      (fullText.includes('# AGENTS.md instructions') ||
       fullText.includes('<permissions instructions>') ||
       fullText.includes('<environment_context>') ||
       fullText.includes('<app-context>'))
    ) {
      continue;
    }

    // Extract file paths mentioned in message content
    extractFilePaths(fullText).forEach(p => filesTouched.add(p));

    // Extract automation directives from assistant responses
    if (role === 'assistant') {
      const autoMatches = fullText.matchAll(/::automation-update\{([^}]+)\}/g);
      for (const m of autoMatches) {
        automations.push(parseAttributes(m[1]));
      }
    }

    // Detect skill invocations in user messages ($skill-name or explicit mentions)
    if (role === 'user') {
      const skillMentions = fullText.matchAll(/\$([a-z][a-z0-9-]+)/g);
      for (const m of skillMentions) {
        if (!skillsUsed.includes(m[1])) skillsUsed.push(m[1]);
      }
      // Also detect skill names from the available list that appear in the message
      for (const skill of skillsAvail) {
        if (
          !skillsUsed.includes(skill.name) &&
          fullText.toLowerCase().includes(skill.name.toLowerCase())
        ) {
          skillsUsed.push(skill.name);
        }
      }
    }

    messages.push({
      role:      role === 'user' ? 'human' : 'assistant',
      content:   fullText,
      timestamp: timestamp ? new Date(timestamp) : null,
    });
  }

  if (messages.length === 0) return null;

  // Apply since filter
  if (since && sessionTs && sessionTs < since) return null;

  // Build a rich content string that includes skills context for extraction
  // This lets the concept extractor treat skill names as first-class concepts
  const skillsContext = skillsUsed.length > 0
    ? `\n\n[Skills used in this session: ${skillsUsed.join(', ')}]`
    : '';

  const toolContext = toolCalls.length > 0
    ? `\n\n[Tools called: ${[...new Set(toolCalls.map(t => t.tool))].join(', ')}]`
    : '';

  // Inject enriched context into the last message so it flows through extraction
  if (skillsContext || toolContext) {
    messages.push({
      role:      'assistant',
      content:   `[Session metadata]${skillsContext}${toolContext}`,
      timestamp: null,
    });
  }

  // Title: first human message
  const firstHuman = messages.find(m => m.role === 'human');
  const title = firstHuman
    ? firstHuman.content.replace(/\s+/g, ' ').trim().slice(0, 80)
    : path.basename(filePath, '.jsonl');

  return {
    source:         'codex',
    id:             sessionId || hashPath(filePath),
    filePath,
    title:          title || 'Untitled Codex Session',
    timestamp:      sessionTs || fs.statSync(filePath).mtime,
    messages,
    turnCount:      messages.length,
    workspace:      cwd ? path.basename(cwd) : null,
    cwd,
    model,
    originator,
    // Rich metadata — used by obsidian writer for enhanced session notes
    skillsUsed,
    skillsAvailable: skillsAvail,
    toolCalls:       toolCalls.slice(0, 50), // cap at 50 to avoid bloat
    filesTouched:    [...filesTouched].slice(0, 30),
    automations,
    taskOutcome,
  };
}

// ── Legacy history.jsonl fallback ─────────────────────────────────────────────
async function mineHistoryFile(filePath, { since, verbose } = {}) {
  const sessions = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch (_) { continue; }

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

// ── Extract file paths from a string ─────────────────────────────────────────
function extractFilePaths(text) {
  const paths = [];
  // Absolute paths: /Users/... or /home/...
  const absMatches = text.matchAll(/(?:^|[\s"'`(])(\/(Users|home|var|tmp|opt)[^\s"'`)\]]+)/gm);
  for (const m of absMatches) {
    const p = m[1].replace(/[,;.]+$/, '');
    if (p.length > 5 && p.length < 300) paths.push(p);
  }
  return [...new Set(paths)];
}

// ── Parse HTML-style attributes from a string ─────────────────────────────────
// e.g. 'mode="view" id="123" name="Daily report"'
function parseAttributes(str) {
  const attrs = {};
  const matches = str.matchAll(/(\w+)="([^"]*)"/g);
  for (const m of matches) attrs[m[1]] = m[2];
  return attrs;
}

// ── FNV-1a hash for stable IDs ────────────────────────────────────────────────
function hashPath(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h  = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

module.exports = { mine };
