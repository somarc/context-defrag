/**
 * cursor.js — Mines Cursor editor AI chat history
 *
 * Cursor stores chat history in SQLite databases under:
 *   ~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb
 *
 * Relevant keys in the ItemTable:
 *   "aiService.prompts"           — array of prompt objects
 *   "workbench.panel.aichat.view.aichat.chatdata" — full chat sessions
 *   "composer.composerData"       — Composer sessions (multi-file edits)
 *   "aiService.generations"       — code generation records
 *
 * Also checks:
 *   ~/Library/Application Support/Cursor/logs/ — plain-text log fallback
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CURSOR_ROOT = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Cursor'
);
const WORKSPACE_STORAGE = path.join(CURSOR_ROOT, 'User', 'workspaceStorage');
const LOGS_DIR          = path.join(CURSOR_ROOT, 'logs');

// Keys inside ItemTable that may contain chat data
const CHAT_KEYS = [
  'workbench.panel.aichat.view.aichat.chatdata',
  'aiService.prompts',
  'aiService.generations',
  'composer.composerData',
  'aiService.chatHistory',
  'cursor.chatHistory',
];

// ── Attempt to load better-sqlite3 ──────────────────────────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  Database = null;
}

// ── Main export ──────────────────────────────────────────────────────────────
async function mine({ since, verbose } = {}) {
  if (!fs.existsSync(CURSOR_ROOT)) {
    return { source: 'cursor', sessions: [], skipped: [CURSOR_ROOT] };
  }

  if (!Database) {
    if (verbose) {
      console.error('  [WARN] cursor: better-sqlite3 not available — SQLite sources skipped');
    }
    return { source: 'cursor', sessions: [], skipped: ['better-sqlite3 missing'] };
  }

  const sessions = [];

  // Mine workspace storage databases
  if (fs.existsSync(WORKSPACE_STORAGE)) {
    const wsSessions = mineWorkspaceStorage({ since, verbose });
    sessions.push(...wsSessions);
  }

  // Mine log files as a fallback
  if (fs.existsSync(LOGS_DIR)) {
    const logSessions = mineLogFiles({ since, verbose });
    sessions.push(...logSessions);
  }

  // Deduplicate
  const seen = new Set();
  const unique = sessions.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  unique.sort((a, b) => a.timestamp - b.timestamp);
  return { source: 'cursor', sessions: unique };
}

// ── Mine all workspace storage SQLite databases ──────────────────────────────
function mineWorkspaceStorage({ since, verbose }) {
  const sessions = [];
  let workspaces;

  try {
    workspaces = fs.readdirSync(WORKSPACE_STORAGE, { withFileTypes: true });
  } catch (_) {
    return sessions;
  }

  for (const entry of workspaces) {
    if (!entry.isDirectory()) continue;
    const dbPath = path.join(WORKSPACE_STORAGE, entry.name, 'state.vscdb');
    if (!fs.existsSync(dbPath)) continue;

    const ws = mineVscdb(dbPath, entry.name, { since, verbose });
    sessions.push(...ws);
  }

  return sessions;
}

// ── Mine a single state.vscdb file ───────────────────────────────────────────
function mineVscdb(dbPath, workspaceHash, { since, verbose }) {
  const sessions = [];
  let db;

  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    if (verbose) console.error(`  [WARN] cursor: cannot open ${dbPath}: ${err.message}`);
    return sessions;
  }

  try {
    // Verify ItemTable exists
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r) => r.name);

    if (!tables.includes('ItemTable')) {
      db.close();
      return sessions;
    }

    for (const chatKey of CHAT_KEYS) {
      let row;
      try {
        row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(chatKey);
      } catch (_) {
        continue;
      }

      if (!row || !row.value) continue;

      let payload;
      try {
        payload = JSON.parse(row.value);
      } catch (_) {
        continue;
      }

      const extracted = extractSessionsFromPayload(payload, chatKey, dbPath, workspaceHash);
      for (const s of extracted) {
        if (!since || s.timestamp >= since) {
          sessions.push(s);
        }
      }
    }
  } finally {
    try { db.close(); } catch (_) {}
  }

  return sessions;
}

// ── Extract sessions from a parsed JSON payload ──────────────────────────────
function extractSessionsFromPayload(payload, key, dbPath, workspaceHash) {
  const sessions = [];

  // Shape A: { tabs: [{ chatTitle, lastSendTime, bubbles: [...] }] }
  if (payload.tabs && Array.isArray(payload.tabs)) {
    for (const tab of payload.tabs) {
      const messages = extractMessagesFromTab(tab);
      if (messages.length === 0) continue;

      const ts = tab.lastSendTime
        ? new Date(tab.lastSendTime)
        : new Date();

      sessions.push({
        source:    'cursor',
        id:        hashPath(`${dbPath}-${key}-${tab.tabId || tab.chatTitle || messages[0].content.slice(0, 20)}`),
        filePath:  dbPath,
        title:     tab.chatTitle || deriveTitle(messages),
        timestamp: ts,
        messages,
        turnCount: messages.length,
        workspace: workspaceHash,
      });
    }
    return sessions;
  }

  // Shape B: array of prompt objects [{ prompt, response, timestamp }]
  if (Array.isArray(payload)) {
    const messages = [];
    for (const item of payload) {
      if (item.prompt || item.text || item.question) {
        messages.push({
          role:      'user',
          content:   item.prompt || item.text || item.question,
          timestamp: item.timestamp || item.createdAt || null,
        });
      }
      if (item.response || item.answer || item.completion) {
        messages.push({
          role:      'assistant',
          content:   item.response || item.answer || item.completion,
          timestamp: item.timestamp || item.createdAt || null,
        });
      }
    }

    if (messages.length > 0) {
      sessions.push({
        source:    'cursor',
        id:        hashPath(`${dbPath}-${key}`),
        filePath:  dbPath,
        title:     deriveTitle(messages),
        timestamp: deriveTimestampFromMessages(messages, dbPath),
        messages,
        turnCount: messages.length,
        workspace: workspaceHash,
      });
    }
    return sessions;
  }

  // Shape C: { conversations: [...] }
  if (payload.conversations && Array.isArray(payload.conversations)) {
    for (const conv of payload.conversations) {
      const messages = extractMessagesFromConversation(conv);
      if (messages.length === 0) continue;

      sessions.push({
        source:    'cursor',
        id:        hashPath(`${dbPath}-${key}-${conv.id || conv.title || messages[0].content.slice(0, 20)}`),
        filePath:  dbPath,
        title:     conv.title || deriveTitle(messages),
        timestamp: deriveTimestampFromMessages(messages, dbPath),
        messages,
        turnCount: messages.length,
        workspace: workspaceHash,
      });
    }
    return sessions;
  }

  return sessions;
}

// ── Extract messages from a Cursor "tab" object ──────────────────────────────
function extractMessagesFromTab(tab) {
  const messages = [];
  const bubbles = tab.bubbles || tab.messages || [];

  for (const bubble of bubbles) {
    // Cursor uses "type": "user" | "ai"
    const role = bubble.type === 'ai' ? 'assistant'
               : bubble.type === 'user' ? 'user'
               : bubble.role || null;

    const content = bubble.text || bubble.rawText || bubble.content || bubble.message || null;

    if (role && content) {
      messages.push({
        role,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        timestamp: bubble.timestamp || bubble.createdAt || null,
      });
    }
  }

  return messages;
}

// ── Extract messages from a generic conversation object ──────────────────────
function extractMessagesFromConversation(conv) {
  const messages = [];
  const raw = conv.messages || conv.turns || conv.exchanges || [];

  for (const m of raw) {
    const role    = m.role || m.type || m.sender || null;
    const content = m.content || m.text || m.message || null;
    if (role && content) {
      messages.push({
        role:      String(role).toLowerCase(),
        content:   typeof content === 'string' ? content : JSON.stringify(content),
        timestamp: m.timestamp || m.createdAt || null,
      });
    }
  }

  return messages;
}

// ── Mine Cursor log files as a last resort ───────────────────────────────────
function mineLogFiles({ since, verbose }) {
  const sessions = [];
  let entries;

  try {
    entries = fs.readdirSync(LOGS_DIR, { withFileTypes: true });
  } catch (_) {
    return sessions;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const logDir = path.join(LOGS_DIR, entry.name);
    let files;
    try {
      files = fs.readdirSync(logDir);
    } catch (_) {
      continue;
    }

    for (const fileName of files) {
      if (!fileName.endsWith('.log')) continue;
      const filePath = path.join(logDir, fileName);

      // Only scan logs that mention AI/chat activity
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (_) {
        continue;
      }

      if (!content.includes('aiService') && !content.includes('copilot') && !content.includes('chat')) {
        continue;
      }

      const stat   = fs.statSync(filePath);
      const ts     = stat.mtime;
      if (since && ts < since) continue;

      // Extract JSON-like lines that contain chat data
      const messages = [];
      for (const line of content.split('\n')) {
        try {
          const obj = JSON.parse(line.trim());
          if (obj.prompt || obj.completion || obj.response) {
            if (obj.prompt) messages.push({ role: 'user', content: obj.prompt, timestamp: null });
            const resp = obj.completion || obj.response;
            if (resp)       messages.push({ role: 'assistant', content: resp, timestamp: null });
          }
        } catch (_) { /* not JSON */ }
      }

      if (messages.length > 0) {
        sessions.push({
          source:    'cursor',
          id:        hashPath(filePath),
          filePath,
          title:     `Cursor Log — ${fileName}`,
          timestamp: ts,
          messages,
          turnCount: messages.length,
        });
      }
    }
  }

  return sessions;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function deriveTitle(messages) {
  const first = messages.find((m) => m.role === 'user' || m.role === 'human');
  if (!first) return 'Untitled Cursor Session';
  return first.content.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled Cursor Session';
}

function deriveTimestampFromMessages(messages, filePath) {
  for (const m of messages) {
    if (m.timestamp) {
      const d = new Date(m.timestamp);
      if (!isNaN(d)) return d;
    }
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
