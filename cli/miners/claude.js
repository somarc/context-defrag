/**
 * claude.js — Mines Claude AI conversation history
 *
 * Claude stores conversations in two distinct formats depending on the product:
 *
 * Claude Desktop (older):
 *   ~/.claude/projects/<hash>/conversations.jsonl
 *   Each line is a full conversation object:
 *     { "uuid": "...", "messages": [...] }
 *   Where each message is: { role: "human"|"assistant", content: "..." }
 *
 * Claude Code (newer, project-scoped):
 *   ~/.claude/projects/<urlencoded-path>/<uuid>.jsonl
 *   Each line is a single turn:
 *     { "type": "user"|"assistant", "message": { "role": "...", "content": "..." }, "timestamp": "..." }
 *   OR the older single-message shape:
 *     { "role": "human"|"assistant", "content": "...", "timestamp": "..." }
 *
 * Also checked on macOS:
 *   ~/Library/Application Support/Claude/  (Claude Desktop app storage)
 *   ~/.config/claude/                      (XDG config fallback)
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');

// ── Candidate root directories to search ────────────────────────────────────
const SEARCH_ROOTS = [
  path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.config', 'claude'),
  // macOS Claude Desktop application support
  path.join(os.homedir(), 'Library', 'Application Support', 'Claude'),
];

// ── Discover all JSONL conversation files ────────────────────────────────────
function findConversationFiles() {
  const found = [];
  const seen  = new Set(); // avoid double-counting via symlinks

  for (const root of SEARCH_ROOTS) {
    if (!fs.existsSync(root)) continue;

    walkDir(root, (filePath) => {
      if (!filePath.endsWith('.jsonl')) return;

      // Resolve symlinks to avoid counting the same file twice
      let realPath = filePath;
      try { realPath = fs.realpathSync(filePath); } catch (_) {}
      if (seen.has(realPath)) return;
      seen.add(realPath);

      found.push(filePath);
    });
  }

  return found;
}

// ── Synchronous recursive directory walker ───────────────────────────────────
function walkDir(dir, callback) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return; // permission error or broken symlink — skip
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, callback);
    } else if (entry.isFile()) {
      callback(fullPath);
    }
  }
}

// ── Detect which JSONL format a file uses ────────────────────────────────────
/**
 * Sniffs the first non-empty line to determine format.
 *
 * Returns:
 *   'desktop'  — line is { uuid, messages: [...] }  (Claude Desktop batch format)
 *   'code'     — line is a single turn              (Claude Code streaming format)
 *   'unknown'  — could not determine
 */
function detectFormat(firstLine) {
  let obj;
  try {
    obj = JSON.parse(firstLine);
  } catch (_) {
    return 'unknown';
  }

  // Desktop batch format: top-level uuid + messages array
  if (obj.uuid && Array.isArray(obj.messages)) {
    return 'desktop';
  }

  // Code streaming format: single turn with type + message wrapper
  if (obj.type && obj.message && (obj.message.role || obj.message.content)) {
    return 'code';
  }

  // Code streaming format (older variant): direct role + content
  if (obj.role && obj.content) {
    return 'code';
  }

  return 'unknown';
}

// ── Parse Claude Desktop format ──────────────────────────────────────────────
/**
 * Desktop JSONL: each line is a complete conversation.
 * Yields one session object per line that contains messages.
 */
async function parseDesktopFile(filePath) {
  const sessions = [];

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      continue; // malformed line — skip
    }

    // Must have a messages array
    if (!Array.isArray(obj.messages) || obj.messages.length === 0) continue;

    const messages = obj.messages
      .map(normaliseMessage)
      .filter(Boolean);

    if (messages.length === 0) continue;

    const timestamp = deriveTimestamp(messages, filePath);

    sessions.push({
      source:    'claude',
      // Use uuid from the object when available; fall back to a path+line hash
      id:        obj.uuid ? hashStr(obj.uuid) : hashPath(`${filePath}:${sessions.length}`),
      filePath,
      title:     obj.title || deriveTitle(messages),
      timestamp,
      messages,
      turnCount: messages.length,
      format:    'desktop',
    });
  }

  return sessions;
}

// ── Parse Claude Code format ─────────────────────────────────────────────────
/**
 * Code JSONL: each line is a single turn. The whole file = one conversation.
 * Returns at most one session.
 */
async function parseCodeFile(filePath) {
  const messages = [];

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      continue; // malformed line — skip
    }

    const msg = normaliseMessage(obj);
    if (msg) messages.push(msg);
  }

  if (messages.length === 0) return [];

  const timestamp = deriveTimestamp(messages, filePath);

  // Derive a human-readable title: use the filename's parent directory
  // (which is often the project path or a UUID), or the first message.
  const parentName = path.basename(path.dirname(filePath));
  const decodedParent = safeDecodeURIComponent(parentName);
  const titleFromPath = decodedParent.length > 5 && decodedParent !== parentName
    ? path.basename(decodedParent)   // last segment of the decoded path
    : null;

  return [{
    source:    'claude',
    id:        hashPath(filePath),
    filePath,
    title:     deriveTitle(messages) || titleFromPath || `Claude Session — ${path.basename(filePath, '.jsonl')}`,
    timestamp,
    messages,
    turnCount: messages.length,
    format:    'code',
  }];
}

// ── Dispatch to the correct parser based on detected format ──────────────────
async function parseConversationFile(filePath) {
  // Peek at the first non-empty line to detect format
  let firstLine = '';
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) { firstLine = trimmed; break; }
    }
  } catch (_) {
    return [];
  }

  if (!firstLine) return [];

  const format = detectFormat(firstLine);

  if (format === 'desktop') {
    return parseDesktopFile(filePath);
  }

  // Both 'code' and 'unknown' use the streaming/turn-by-turn parser.
  // Unknown format is likely a variant of Claude Code; it degrades gracefully.
  return parseCodeFile(filePath);
}

// ── Normalise diverse Claude JSON shapes into a common schema ────────────────
/**
 * Handles three known shapes:
 *
 * Shape A (direct turn):
 *   { role: "human"|"assistant"|"user", content: "..." }
 *
 * Shape B (wrapped turn — Claude Code):
 *   { type: "user"|"assistant", message: { role: "...", content: "..." }, timestamp: "..." }
 *
 * Shape C (legacy type field):
 *   { type: "human"|"assistant", text: "..." }
 */
function normaliseMessage(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Shape A: direct role + content
  if (obj.role && obj.content !== undefined) {
    const content = flattenContent(obj.content);
    if (!content) return null;
    return {
      role:      normaliseRole(obj.role),
      content,
      timestamp: obj.timestamp || obj.createdAt || null,
    };
  }

  // Shape B: Claude Code wrapped turn { type, message: { role, content } }
  if (obj.message && typeof obj.message === 'object') {
    const inner   = obj.message;
    const role    = inner.role || obj.type || null;
    const content = flattenContent(inner.content);
    if (!role || !content) return null;
    return {
      role:      normaliseRole(role),
      content,
      timestamp: obj.timestamp || obj.createdAt || inner.timestamp || null,
    };
  }

  // Shape C: legacy { type: "human"|"assistant", text: "..." }
  if ((obj.type === 'human' || obj.type === 'assistant') && obj.text) {
    return {
      role:      normaliseRole(obj.type),
      content:   obj.text,
      timestamp: obj.createdAt || obj.timestamp || null,
    };
  }

  return null; // unrecognised shape
}

/**
 * Normalise role strings to 'human' | 'assistant'.
 * Keeps the original string for unknown values so nothing is silently lost.
 */
function normaliseRole(role) {
  const r = String(role).toLowerCase();
  if (r === 'user' || r === 'human')          return 'human';
  if (r === 'assistant' || r === 'ai')        return 'assistant';
  return r; // preserve unexpected values (e.g. 'tool', 'system')
}

// ── Flatten content that may be a string or array of content blocks ──────────
function flattenContent(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block.type === 'text')     return block.text || '';
        if (block.type === 'code')     return '```\n' + (block.text || '') + '\n```';
        // tool_use / tool_result blocks — extract text if present, else skip
        if (block.type === 'tool_result' && block.content) {
          return flattenContent(block.content);
        }
        return '';
      })
      .join('\n')
      .trim();
  }

  if (content && typeof content === 'object') {
    // Some messages wrap content as { type: 'text', text: '...' }
    if (content.text) return content.text;
  }

  return typeof content === 'undefined' ? '' : String(content);
}

// ── Derive a human-readable title from the first human message ───────────────
function deriveTitle(messages) {
  const firstHuman = messages.find((m) => m.role === 'human' || m.role === 'user');
  if (!firstHuman || !firstHuman.content) return 'Untitled Session';

  // Take first 60 chars of text, strip newlines (per spec)
  const snippet = firstHuman.content.replace(/\s+/g, ' ').trim().slice(0, 60);
  return snippet || 'Untitled Session';
}

// ── Derive the earliest timestamp across all messages ────────────────────────
function deriveTimestamp(messages, filePath) {
  // Prefer the earliest explicit message timestamp
  let earliest = null;
  for (const msg of messages) {
    if (!msg.timestamp) continue;
    const d = new Date(msg.timestamp);
    if (isNaN(d)) continue;
    if (!earliest || d < earliest) earliest = d;
  }
  if (earliest) return earliest;

  // Fall back to file mtime
  try {
    return fs.statSync(filePath).mtime;
  } catch (_) {
    return new Date();
  }
}

// ── Main export: mine all Claude conversations ───────────────────────────────
async function mine({ since, verbose } = {}) {
  const files = findConversationFiles();

  if (files.length === 0) {
    return { source: 'claude', sessions: [], skipped: SEARCH_ROOTS };
  }

  const sessions = [];

  for (const filePath of files) {
    let parsed;
    try {
      parsed = await parseConversationFile(filePath);
    } catch (err) {
      if (verbose) console.error(`  [WARN] claude: could not parse ${filePath}: ${err.message}`);
      continue;
    }

    for (const session of parsed) {
      // Apply --since filter
      if (since && session.timestamp < since) continue;
      sessions.push(session);
    }
  }

  // Sort chronologically
  sessions.sort((a, b) => a.timestamp - b.timestamp);

  return { source: 'claude', sessions };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Stable FNV-1a hash from a file path string (for dedup IDs). */
function hashPath(str) {
  return hashStr(str);
}

function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Safely decode a URI-encoded path component without throwing. */
function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str.replace(/\+/g, ' '));
  } catch (_) {
    return str;
  }
}

module.exports = { mine };
