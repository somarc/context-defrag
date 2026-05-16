/**
 * codex.js — Mines OpenAI Codex CLI conversation history
 *
 * Codex CLI (https://github.com/openai/openai-codex) stores sessions in:
 *   ~/.codex/history          — plain text or JSONL history log
 *   ~/.codex/sessions/        — per-session JSON files
 *   ~/.codex/sessions/*.json  — individual session objects
 *
 * Some builds also write SQLite at ~/.codex/codex.db
 * We try all known layouts and degrade gracefully.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const readline = require('readline');

const CODEX_ROOT = path.join(os.homedir(), '.codex');

// ── Attempt to load better-sqlite3 (optional dependency) ────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  Database = null;
}

// ── Main export: mine all Codex sessions ────────────────────────────────────
async function mine({ since, verbose } = {}) {
  if (!fs.existsSync(CODEX_ROOT)) {
    return { source: 'codex', sessions: [], skipped: [CODEX_ROOT] };
  }

  const sessions = [];

  // Strategy 1: per-session JSON files in ~/.codex/sessions/
  const sessionsDir = path.join(CODEX_ROOT, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const jsonSessions = await mineSessionsDir(sessionsDir, { since, verbose });
    sessions.push(...jsonSessions);
  }

  // Strategy 2: ~/.codex/history (JSONL or plain text)
  const historyFile = path.join(CODEX_ROOT, 'history');
  if (fs.existsSync(historyFile)) {
    const historySessions = await mineHistoryFile(historyFile, { since, verbose });
    sessions.push(...historySessions);
  }

  // Strategy 3: SQLite database
  const dbFile = path.join(CODEX_ROOT, 'codex.db');
  if (fs.existsSync(dbFile) && Database) {
    const dbSessions = mineDatabase(dbFile, { since, verbose });
    sessions.push(...dbSessions);
  }

  // Deduplicate by session ID
  const seen = new Set();
  const unique = sessions.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  unique.sort((a, b) => a.timestamp - b.timestamp);
  return { source: 'codex', sessions: unique };
}

// ── Mine individual JSON session files ───────────────────────────────────────
async function mineSessionsDir(dir, { since, verbose }) {
  const sessions = [];
  let entries;

  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return sessions;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.json' && ext !== '.jsonl') continue;

    const filePath = path.join(dir, entry.name);
    let session;

    try {
      if (ext === '.jsonl') {
        session = await parseJsonlSession(filePath);
      } else {
        session = parseJsonSession(filePath);
      }
    } catch (err) {
      if (verbose) console.error(`  [WARN] codex: could not parse ${filePath}: ${err.message}`);
      continue;
    }

    if (!session || session.messages.length === 0) continue;
    if (since && session.timestamp < since) continue;

    sessions.push(session);
  }

  return sessions;
}

// ── Parse a JSON session file (single object or array of messages) ───────────
function parseJsonSession(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (_) {
    return null;
  }

  const messages = [];

  // Shape A: { messages: [...] }
  if (obj.messages && Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      const msg = normaliseCodexMessage(m);
      if (msg) messages.push(msg);
    }
  }

  // Shape B: root-level array of messages
  if (Array.isArray(obj)) {
    for (const m of obj) {
      const msg = normaliseCodexMessage(m);
      if (msg) messages.push(msg);
    }
  }

  if (messages.length === 0) return null;

  const timestamp = deriveTimestamp(obj, filePath);

  return {
    source:    'codex',
    id:        hashPath(filePath),
    filePath,
    title:     obj.title || obj.name || deriveTitle(messages),
    timestamp,
    messages,
    turnCount: messages.length,
  };
}

// ── Parse a JSONL session file (one message per line) ────────────────────────
async function parseJsonlSession(filePath) {
  const messages = [];

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch (_) { continue; }
    const msg = normaliseCodexMessage(obj);
    if (msg) messages.push(msg);
  }

  if (messages.length === 0) return null;

  const timestamp = deriveTimestamp({}, filePath);

  return {
    source:    'codex',
    id:        hashPath(filePath),
    filePath,
    title:     deriveTitle(messages),
    timestamp,
    messages,
    turnCount: messages.length,
  };
}

// ── Mine the flat history file (JSONL or line-delimited commands) ─────────────
async function mineHistoryFile(filePath, { since, verbose }) {
  const messages = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try JSONL first
    try {
      const obj = JSON.parse(trimmed);
      const msg = normaliseCodexMessage(obj);
      if (msg) { messages.push(msg); continue; }
    } catch (_) { /* fall through to plain text */ }

    // Plain text lines — treat as user commands
    messages.push({ role: 'user', content: trimmed, timestamp: null });
  }

  if (messages.length === 0) return [];

  // Group into a single synthetic session
  const timestamp = deriveTimestamp({}, filePath);
  if (since && timestamp < since) return [];

  return [{
    source:    'codex',
    id:        hashPath(filePath),
    filePath,
    title:     'Codex CLI History',
    timestamp,
    messages,
    turnCount: messages.length,
  }];
}

// ── Mine an SQLite database ──────────────────────────────────────────────────
function mineDatabase(dbFile, { since, verbose }) {
  const sessions = [];
  let db;

  try {
    db = new Database(dbFile, { readonly: true });
  } catch (err) {
    if (verbose) console.error(`  [WARN] codex: could not open ${dbFile}: ${err.message}`);
    return sessions;
  }

  try {
    // Try common table/column layouts
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r) => r.name);

    for (const table of tables) {
      try {
        const rows = db.prepare(`SELECT * FROM "${table}" LIMIT 1000`).all();
        for (const row of rows) {
          const session = rowToSession(row, table);
          if (session && session.messages.length > 0) {
            if (!since || session.timestamp >= since) {
              sessions.push(session);
            }
          }
        }
      } catch (_) { /* skip unreadable table */ }
    }
  } finally {
    db.close();
  }

  return sessions;
}

// ── Convert a DB row to a session (best-effort) ──────────────────────────────
function rowToSession(row, table) {
  // Look for a JSON blob in any column
  for (const [key, val] of Object.entries(row)) {
    if (typeof val !== 'string') continue;
    try {
      const obj = JSON.parse(val);
      if (obj.messages || Array.isArray(obj)) {
        const msgs = Array.isArray(obj) ? obj : obj.messages;
        const messages = msgs.map(normaliseCodexMessage).filter(Boolean);
        if (messages.length === 0) continue;

        const ts = row.createdAt || row.timestamp || row.created_at;
        return {
          source:    'codex',
          id:        hashPath(`${table}-${row.id || key}-${val.slice(0, 20)}`),
          filePath:  `db:${table}`,
          title:     obj.title || deriveTitle(messages),
          timestamp: ts ? new Date(ts) : new Date(),
          messages,
          turnCount: messages.length,
        };
      }
    } catch (_) { /* not JSON */ }
  }
  return null;
}

// ── Normalise a Codex message into { role, content, timestamp } ──────────────
function normaliseCodexMessage(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const role    = obj.role || obj.type || null;
  const content = obj.content || obj.text || obj.message || obj.output || null;

  if (!role || !content) return null;

  return {
    role:      String(role).toLowerCase(),
    content:   typeof content === 'string' ? content : JSON.stringify(content),
    timestamp: obj.timestamp || obj.createdAt || obj.created_at || null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function deriveTitle(messages) {
  const first = messages.find((m) => m.role === 'user' || m.role === 'human');
  if (!first) return 'Untitled Codex Session';
  return first.content.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled Codex Session';
}

function deriveTimestamp(obj, filePath) {
  const raw = obj.createdAt || obj.timestamp || obj.created_at;
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d)) return d;
  }
  try {
    return fs.statSync(filePath).mtime;
  } catch (_) {
    return new Date();
  }
}

function hashPath(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

module.exports = { mine };
