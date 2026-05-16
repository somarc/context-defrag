/**
 * claude.js — Mines Claude AI conversation history
 *
 * Claude stores conversations in JSONL files under:
 *   ~/.claude/projects/<hash>/conversations.jsonl
 *   ~/.config/claude/projects/<hash>/*.jsonl
 *
 * Each line is a JSON object with fields like:
 *   { role: "human"|"assistant", content: "...", timestamp: "..." }
 * or the newer Projects format:
 *   { uuid, parentUuid, createdAt, type, message: { role, content } }
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const readline = require('readline');

// ── Candidate root directories to search ────────────────────────────────────
const SEARCH_ROOTS = [
  path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.config', 'claude'),
];

// ── Discover all JSONL conversation files ────────────────────────────────────
function findConversationFiles() {
  const found = [];

  for (const root of SEARCH_ROOTS) {
    if (!fs.existsSync(root)) continue;

    // Walk the directory tree looking for .jsonl files
    walkDir(root, (filePath) => {
      if (filePath.endsWith('.jsonl')) {
        found.push(filePath);
      }
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

// ── Parse a single JSONL conversation file ───────────────────────────────────
async function parseConversationFile(filePath) {
  const messages = [];

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_) {
      continue; // malformed line — skip
    }

    // Normalise into { role, content, timestamp }
    const msg = normaliseMessage(obj);
    if (msg) messages.push(msg);
  }

  return messages;
}

// ── Normalise diverse Claude JSON shapes into a common schema ────────────────
function normaliseMessage(obj) {
  // Shape A: { role, content, timestamp } (direct)
  if (obj.role && obj.content) {
    return {
      role:      obj.role,
      content:   flattenContent(obj.content),
      timestamp: obj.timestamp || obj.createdAt || null,
    };
  }

  // Shape B: Projects JSONL { type, message: { role, content }, createdAt }
  if (obj.message && obj.message.role && obj.message.content) {
    return {
      role:      obj.message.role,
      content:   flattenContent(obj.message.content),
      timestamp: obj.createdAt || obj.timestamp || null,
    };
  }

  // Shape C: { type: "human"|"assistant", text, ... }
  if ((obj.type === 'human' || obj.type === 'assistant') && obj.text) {
    return {
      role:      obj.type,
      content:   obj.text,
      timestamp: obj.createdAt || obj.timestamp || null,
    };
  }

  return null; // unrecognised shape
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
        return '';
      })
      .join('\n')
      .trim();
  }

  return String(content);
}

// ── Derive a human-readable title from the first human message ───────────────
function deriveTitle(messages) {
  const firstHuman = messages.find((m) => m.role === 'human' || m.role === 'user');
  if (!firstHuman) return 'Untitled Session';

  // Take first 80 chars of text, strip newlines
  const snippet = firstHuman.content.replace(/\s+/g, ' ').trim().slice(0, 80);
  return snippet || 'Untitled Session';
}

// ── Derive the earliest timestamp across all messages ────────────────────────
function deriveTimestamp(messages, filePath) {
  for (const msg of messages) {
    if (msg.timestamp) {
      const d = new Date(msg.timestamp);
      if (!isNaN(d)) return d;
    }
  }

  // Fall back to file mtime
  try {
    const stat = fs.statSync(filePath);
    return stat.mtime;
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
    let messages;
    try {
      messages = await parseConversationFile(filePath);
    } catch (err) {
      if (verbose) console.error(`  [WARN] claude: could not parse ${filePath}: ${err.message}`);
      continue;
    }

    if (messages.length === 0) continue;

    const timestamp = deriveTimestamp(messages, filePath);

    // Apply --since filter
    if (since && timestamp < since) continue;

    sessions.push({
      source:    'claude',
      id:        hashPath(filePath),
      filePath,
      title:     deriveTitle(messages),
      timestamp,
      messages,
      turnCount: messages.length,
    });
  }

  // Sort chronologically
  sessions.sort((a, b) => a.timestamp - b.timestamp);

  return { source: 'claude', sessions };
}

// ── Stable short hash from a file path (for dedup IDs) ───────────────────────
function hashPath(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

module.exports = { mine };
