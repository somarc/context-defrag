/**
 * cursor.js — Mines Cursor editor AI chat history
 *
 * Cursor's storage layout is version-fragile. The important practical point is
 * that newer Cursor builds often store the richest chat metadata in
 * `composer.composerData`, while prompts/generation history may sit in separate
 * arrays. We therefore mine all known payloads, treat prompt/generation arrays
 * as collections of individual sessions rather than one giant transcript, and
 * attach enough metadata for the extractor to reason about weak vs strong
 * Cursor-derived sessions later.
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

const EXACT_CHAT_KEYS = [
  'workbench.panel.aichat.view.aichat.chatdata',
  'aiService.prompts',
  'aiService.generations',
  'composer.composerData',
  'aiService.chatHistory',
  'cursor.chatHistory',
];

const DYNAMIC_CHAT_KEY_PATTERNS = [
  'workbench.panel.aichat.view.%',
  'workbench.panel.composerChatViewPane.%',
];

const FILE_NAME_RE = /\b[A-Za-z0-9_.-]+\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|json|jsx|mjs|cjs|md|py|rb|rs|sh|sql|ts|tsx|txt|xml|ya?ml)\b/g;

function openDatabase(dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, { allowExtension: false });
  } catch (_) {}
  try {
    const BetterSqlite = require('better-sqlite3');
    return new BetterSqlite(dbPath, { readonly: true });
  } catch (_) {}
  return null;
}

async function mine({ since, verbose } = {}) {
  if (!fs.existsSync(CURSOR_ROOT)) {
    return { source: 'cursor', sessions: [], skipped: [CURSOR_ROOT] };
  }

  const sessions = [];

  if (fs.existsSync(WORKSPACE_STORAGE)) {
    sessions.push(...mineWorkspaceStorage({ since, verbose }));
  }

  if (fs.existsSync(LOGS_DIR)) {
    sessions.push(...mineLogFiles({ since, verbose }));
  }

  const seen = new Set();
  const unique = sessions.filter((session) => {
    if (!session || !session.id) return false;
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });

  unique.sort((a, b) => a.timestamp - b.timestamp);
  const dropped = process._cursorMetaOnlyDropped || 0;
  process._cursorMetaOnlyDropped = 0;
  return { source: 'cursor', sessions: unique, metaOnlyDropped: dropped };
}

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

    const workspaceDir = path.join(WORKSPACE_STORAGE, entry.name);
    const dbPath       = path.join(workspaceDir, 'state.vscdb');
    if (!fs.existsSync(dbPath)) continue;

    const workspaceInfo = resolveWorkspaceInfo(workspaceDir, entry.name);
    const found = mineVscdb(dbPath, workspaceInfo, { since, verbose });
    sessions.push(...found);
  }

  return sessions;
}

function mineVscdb(dbPath, workspaceInfo, { since, verbose }) {
  const sessions = [];
  const db = openDatabase(dbPath);

  if (!db) {
    if (verbose) console.error(`  [WARN] cursor: no SQLite driver available to open ${dbPath}`);
    return sessions;
  }

  try {
    const tableRows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all();
    const tables = tableRows.map((row) => row.name);

    if (!tables.includes('ItemTable')) return sessions;

    for (const key of listChatKeys(db)) {
      let row;
      try {
        row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
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

      const extracted = extractSessionsFromPayload(payload, key, dbPath, workspaceInfo);
      for (const session of extracted) {
        if (!session) continue;
        if (since && session.timestamp < since) continue;
        sessions.push(session);
      }
    }
  } finally {
    try { db.close(); } catch (_) {}
  }

  return mergeCursorSessionCandidates(sessions);
}

function listChatKeys(db) {
  const keys = new Set(EXACT_CHAT_KEYS);

  for (const pattern of DYNAMIC_CHAT_KEY_PATTERNS) {
    let rows = [];
    try {
      rows = db.prepare('SELECT key FROM ItemTable WHERE key LIKE ?').all(pattern);
    } catch (_) {
      rows = [];
    }
    for (const row of rows) {
      if (row && row.key) keys.add(row.key);
    }
  }

  return [...keys];
}

function resolveWorkspaceInfo(workspaceDir, workspaceHash) {
  const info = {
    workspace: workspaceHash,
    workspaceHash,
    workspacePath: null,
    workspaceName: null,
  };

  const workspaceJson = path.join(workspaceDir, 'workspace.json');
  if (!fs.existsSync(workspaceJson)) return info;

  try {
    const payload = JSON.parse(fs.readFileSync(workspaceJson, 'utf8'));
    const folderUri = payload.folder || payload.workspace || payload.path || null;
    if (typeof folderUri === 'string' && folderUri.startsWith('file://')) {
      info.workspacePath = decodeURIComponent(folderUri.replace(/^file:\/\//, ''));
    } else if (typeof folderUri === 'string' && folderUri) {
      info.workspacePath = folderUri;
    }
    if (info.workspacePath) {
      info.workspaceName = path.basename(info.workspacePath);
    }
  } catch (_) {}

  return info;
}

function extractSessionsFromPayload(payload, key, dbPath, workspaceInfo) {
  if (!payload) return [];

  if (key === 'composer.composerData') {
    return extractComposerSessions(payload, key, dbPath, workspaceInfo);
  }

  if (key === 'aiService.prompts') {
    return extractPromptSessions(payload, key, dbPath, workspaceInfo);
  }

  if (key === 'aiService.generations') {
    return extractGenerationSessions(payload, key, dbPath, workspaceInfo);
  }

  const sessions = [];

  if (payload.tabs && Array.isArray(payload.tabs)) {
    for (const tab of payload.tabs) {
      const messages = extractMessagesFromTab(tab);
      if (messages.length === 0) continue;

      sessions.push(buildCursorSession({
        dbPath,
        key,
        workspaceInfo,
        seed: tab.tabId || tab.chatTitle || firstMessageSnippet(messages),
        title: tab.chatTitle || deriveTitle(messages),
        timestamp: tab.lastSendTime || tab.updatedAt || null,
        messages,
        cursorFormat: 'tab-chat',
        cursorChatKey: key,
      }));
    }
    return sessions;
  }

  if (payload.conversations && Array.isArray(payload.conversations)) {
    for (const conv of payload.conversations) {
      const messages = extractMessagesFromConversation(conv);
      if (messages.length === 0) continue;

      sessions.push(buildCursorSession({
        dbPath,
        key,
        workspaceInfo,
        seed: conv.id || conv.title || firstMessageSnippet(messages),
        title: conv.title || deriveTitle(messages),
        timestamp: conv.lastUpdatedAt || conv.updatedAt || null,
        messages,
        cursorFormat: 'conversation-list',
        cursorChatKey: key,
      }));
    }
    return sessions;
  }

  if (Array.isArray(payload)) {
    return extractLooseArraySessions(payload, key, dbPath, workspaceInfo);
  }

  const nestedMessages = extractMessagesFromConversation(payload);
  if (nestedMessages.length > 0) {
    sessions.push(buildCursorSession({
      dbPath,
      key,
      workspaceInfo,
      seed: payload.id || payload.title || firstMessageSnippet(nestedMessages),
      title: payload.title || deriveTitle(nestedMessages),
      timestamp: payload.timestamp || payload.updatedAt || payload.lastUpdatedAt || null,
      messages: nestedMessages,
      cursorFormat: 'nested-object',
      cursorChatKey: key,
    }));
  }

  return sessions;
}

function extractComposerSessions(payload, key, dbPath, workspaceInfo) {
  const sessions = [];
  const composers = Array.isArray(payload.allComposers) ? payload.allComposers : [];

  for (const composer of composers) {
    if (!composer || composer.type !== 'head') continue;
    const title = composer.name || composer.subtitle || 'Untitled Cursor Composer';
    const contextLines = [
      composer.name || '',
      composer.subtitle || '',
      composer.unifiedMode ? `Mode: ${composer.unifiedMode}` : '',
      composer.forceMode ? `Force mode: ${composer.forceMode}` : '',
      Number.isFinite(composer.contextUsagePercent) ? `Context usage: ${composer.contextUsagePercent}%` : '',
      composer.isWorktree ? 'Worktree: true' : '',
      composer.isSpec ? 'Spec: true' : '',
      composer.hasBlockingPendingActions ? 'Blocking actions pending' : '',
    ].filter(Boolean);

    if (contextLines.length === 0) continue;

    sessions.push(buildCursorSession({
      dbPath,
      key,
      workspaceInfo,
      seed: composer.composerId || composer.name || composer.subtitle,
      title,
      timestamp: composer.lastUpdatedAt || composer.createdAt || null,
      messages: [{ role: 'human', content: contextLines.join('\n'), timestamp: composer.lastUpdatedAt || composer.createdAt || null }],
      cursorFormat: 'composer-head',
      cursorChatKey: key,
      cursorMetaOnly: true,
      cursorComposerId: composer.composerId || null,
      cursorMeta: {
        unifiedMode: composer.unifiedMode || null,
        forceMode: composer.forceMode || null,
        contextUsagePercent: composer.contextUsagePercent ?? null,
        totalLinesAdded: composer.totalLinesAdded ?? null,
        totalLinesRemoved: composer.totalLinesRemoved ?? null,
        isWorktree: Boolean(composer.isWorktree),
        isSpec: Boolean(composer.isSpec),
        hasBlockingPendingActions: Boolean(composer.hasBlockingPendingActions),
      },
    }));
  }

  return sessions;
}

function extractPromptSessions(payload, key, dbPath, workspaceInfo) {
  const sessions = [];
  const items = Array.isArray(payload) ? payload : [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;

    const prompt = flattenCursorContent(item.prompt || item.text || item.question || item.input || item.query || '');
    const response = flattenCursorContent(item.response || item.answer || item.completion || item.output || '');
    if (!prompt && !response) continue;

    const messages = [];
    if (prompt) {
      messages.push({
        role: 'human',
        content: prompt,
        timestamp: item.timestamp || item.createdAt || item.unixMs || null,
      });
    }
    if (response) {
      messages.push({
        role: 'assistant',
        content: response,
        timestamp: item.timestamp || item.createdAt || item.unixMs || null,
      });
    }

    sessions.push(buildCursorSession({
      dbPath,
      key,
      workspaceInfo,
      seed: item.id || item.promptId || item.uuid || `${i}-${prompt.slice(0, 32)}`,
      title: deriveTitle(messages),
      timestamp: item.timestamp || item.createdAt || item.unixMs || null,
      messages,
      cursorFormat: 'prompt-record',
      cursorChatKey: key,
      cursorCommandType: item.commandType ?? null,
    }));
  }

  return sessions;
}

function extractGenerationSessions(payload, key, dbPath, workspaceInfo) {
  const sessions = [];
  const items = Array.isArray(payload) ? payload : [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;

    const description = flattenCursorContent(
      item.textDescription || item.prompt || item.text || item.description || item.summary || ''
    );
    const resultText = flattenCursorContent(item.response || item.completion || item.output || '');
    if (!description && !resultText) continue;

    const messages = [];
    if (description) {
      messages.push({
        role: 'human',
        content: description,
        timestamp: item.unixMs || item.timestamp || item.createdAt || null,
      });
    }
    if (resultText) {
      messages.push({
        role: 'assistant',
        content: resultText,
        timestamp: item.unixMs || item.timestamp || item.createdAt || null,
      });
    }

    sessions.push(buildCursorSession({
      dbPath,
      key,
      workspaceInfo,
      seed: item.generationUUID || item.id || `${i}-${description.slice(0, 32)}`,
      title: deriveTitle(messages),
      timestamp: item.unixMs || item.timestamp || item.createdAt || null,
      messages,
      cursorFormat: 'generation-record',
      cursorChatKey: key,
      cursorGenerationType: item.type || null,
      cursorGenerationUUID: item.generationUUID || null,
    }));
  }

  return sessions;
}

function extractLooseArraySessions(payload, key, dbPath, workspaceInfo) {
  const sessions = [];
  const items = Array.isArray(payload) ? payload : [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') continue;

    const messages = extractMessagesFromConversation(item);
    if (messages.length === 0) continue;

    sessions.push(buildCursorSession({
      dbPath,
      key,
      workspaceInfo,
      seed: item.id || item.uuid || `${i}-${firstMessageSnippet(messages)}`,
      title: item.title || deriveTitle(messages),
      timestamp: item.timestamp || item.createdAt || item.updatedAt || item.unixMs || null,
      messages,
      cursorFormat: 'array-record',
      cursorChatKey: key,
    }));
  }

  return sessions;
}

function mergeCursorSessionCandidates(sessions) {
  const merged = [];
  const byFingerprint = new Map();

  for (const session of sessions) {
    const timeBucket = Math.floor(session.timestamp.getTime() / (5 * 60 * 1000));
    const fingerprint = `${session.workspacePath || session.workspace || 'unknown'}::${normaliseText(session.title)}::${timeBucket}`;
    const existing = byFingerprint.get(fingerprint);
    if (!existing) {
      byFingerprint.set(fingerprint, session);
      merged.push(session);
      continue;
    }

    if (existing.cursorMetaOnly && !session.cursorMetaOnly && session.messages.length >= existing.messages.length) {
      copyCursorMetadata(session, existing);
      byFingerprint.set(fingerprint, session);
      const idx = merged.findIndex((item) => item.id === existing.id);
      if (idx !== -1) merged[idx] = session;
      continue;
    }

    if (!existing.cursorMetaOnly && session.cursorMetaOnly) {
      copyCursorMetadata(existing, session);
      continue;
    }

    if (session.messages.length > existing.messages.length) {
      copyCursorMetadata(session, existing);
      byFingerprint.set(fingerprint, session);
      const idx = merged.findIndex((item) => item.id === existing.id);
      if (idx !== -1) merged[idx] = session;
    }
  }

  // Drop any cursorMetaOnly sessions that were never upgraded to a real session.
  // These are composer metadata entries with no corresponding chat transcript —
  // they produce empty notes with zero signal. The scan logs 84 workspaces but
  // each may contain hundreds of stale composer entries = ~5000 ghost sessions.
  const realSessions = merged.filter(s => !s.cursorMetaOnly);
  const metaOnly     = merged.length - realSessions.length;
  if (metaOnly > 0 && typeof process !== 'undefined') {
    // Emit a suppressible warning — picked up by the caller's verbose path
    process._cursorMetaOnlyDropped = (process._cursorMetaOnlyDropped || 0) + metaOnly;
  }
  return realSessions;
}

function copyCursorMetadata(target, source) {
  if (!target || !source) return;
  if (!target.cursorMeta && source.cursorMeta) target.cursorMeta = source.cursorMeta;
  if (!target.cursorComposerId && source.cursorComposerId) target.cursorComposerId = source.cursorComposerId;
  if (!target.cursorCommandType && source.cursorCommandType !== undefined) target.cursorCommandType = source.cursorCommandType;
  if (!target.cursorGenerationType && source.cursorGenerationType) target.cursorGenerationType = source.cursorGenerationType;
  if (!target.cursorGenerationUUID && source.cursorGenerationUUID) target.cursorGenerationUUID = source.cursorGenerationUUID;
  if (!target.workspacePath && source.workspacePath) target.workspacePath = source.workspacePath;
  if (!target.workspaceName && source.workspaceName) target.workspaceName = source.workspaceName;
}

function buildCursorSession({
  dbPath,
  key,
  workspaceInfo,
  seed,
  title,
  timestamp,
  messages,
  cursorFormat,
  cursorChatKey,
  cursorMetaOnly = false,
  cursorComposerId = null,
  cursorMeta = null,
  cursorCommandType = null,
  cursorGenerationType = null,
  cursorGenerationUUID = null,
}) {
  const ts = (timestamp !== null && timestamp !== undefined)
    ? parseCursorTimestamp(timestamp, dbPath)
    : deriveTimestampFromMessages(messages, dbPath);
  const filesTouched = extractFilePaths(messages.map((msg) => msg.content).join('\n\n'));
  const workspace = workspaceInfo.workspaceName || workspaceInfo.workspace;

  return {
    source: 'cursor',
    id: hashPath(`${dbPath}-${cursorChatKey}-${seed}`),
    filePath: dbPath,
    title: title || deriveTitle(messages),
    timestamp: ts,
    messages,
    turnCount: messages.length,
    workspace,
    workspacePath: workspaceInfo.workspacePath || null,
    workspaceName: workspaceInfo.workspaceName || null,
    cursorFormat,
    cursorChatKey,
    cursorMetaOnly,
    cursorComposerId,
    cursorMeta,
    cursorCommandType,
    cursorGenerationType,
    cursorGenerationUUID,
    filesTouched,
  };
}

function extractMessagesFromTab(tab) {
  const messages = [];
  const bubbles = tab.bubbles || tab.messages || tab.turns || [];

  for (const bubble of bubbles) {
    const msg = normaliseCursorMessage(bubble);
    if (msg) messages.push(msg);
  }

  return messages;
}

function extractMessagesFromConversation(conv) {
  const messages = [];

  const raw = []
    .concat(Array.isArray(conv.messages) ? conv.messages : [])
    .concat(Array.isArray(conv.turns) ? conv.turns : [])
    .concat(Array.isArray(conv.exchanges) ? conv.exchanges : [])
    .concat(Array.isArray(conv.bubbles) ? conv.bubbles : []);

  for (const item of raw) {
    const msg = normaliseCursorMessage(item);
    if (msg) messages.push(msg);
  }

  return messages;
}

function normaliseCursorMessage(item) {
  if (!item || typeof item !== 'object') return null;

  const role = normaliseRole(
    item.role ||
    item.type ||
    item.sender ||
    item.messageType ||
    item.author ||
    item.kind
  );

  const content = flattenCursorContent(
    item.text ||
    item.rawText ||
    item.content ||
    item.message ||
    item.markdown ||
    item.response ||
    item.prompt ||
    item.body ||
    item.parts ||
    item.richText ||
    ''
  );

  if (!role || !content) return null;

  return {
    role,
    content,
    timestamp: item.timestamp || item.createdAt || item.updatedAt || item.unixMs || null,
  };
}

function flattenCursorContent(value, depth = 0) {
  if (!value || depth > 4) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    return value
      .map((entry) => flattenCursorContent(entry, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.markdown === 'string') return value.markdown.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (Array.isArray(value.content)) return flattenCursorContent(value.content, depth + 1);
    if (typeof value.message === 'string') return value.message.trim();
    if (value.message && typeof value.message === 'object') return flattenCursorContent(value.message, depth + 1);
    if (Array.isArray(value.parts)) return flattenCursorContent(value.parts, depth + 1);
    if (Array.isArray(value.lines)) return flattenCursorContent(value.lines, depth + 1);
    if (value.value !== undefined) return flattenCursorContent(value.value, depth + 1);
  }

  return '';
}

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

      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (_) {
        continue;
      }

      if (!content.includes('aiService') && !content.includes('copilot') && !content.includes('chat')) {
        continue;
      }

      const stat = fs.statSync(filePath);
      if (since && stat.mtime < since) continue;

      const messages = [];
      for (const line of content.split('\n')) {
        try {
          const obj = JSON.parse(line.trim());
          const prompt = flattenCursorContent(obj.prompt || obj.input || obj.text || '');
          const response = flattenCursorContent(obj.completion || obj.response || obj.output || '');
          if (prompt) messages.push({ role: 'human', content: prompt, timestamp: null });
          if (response) messages.push({ role: 'assistant', content: response, timestamp: null });
        } catch (_) {}
      }

      if (messages.length === 0) continue;

      sessions.push({
        source: 'cursor',
        id: hashPath(filePath),
        filePath,
        title: `Cursor Log — ${fileName}`,
        timestamp: stat.mtime,
        messages,
        turnCount: messages.length,
        workspace: null,
        workspacePath: null,
        cursorFormat: 'log-fallback',
        cursorChatKey: 'logs',
        cursorMetaOnly: false,
        filesTouched: extractFilePaths(messages.map((msg) => msg.content).join('\n\n')),
      });
    }
  }

  return sessions;
}

function normaliseRole(role) {
  if (!role) return null;
  const value = String(role).toLowerCase();
  if (value === 'user' || value === 'human') return 'human';
  if (value === 'assistant' || value === 'ai' || value === 'bot') return 'assistant';
  if (value.includes('tool')) return 'tool';
  if (value === 'system') return 'system';
  return value;
}

function deriveTitle(messages) {
  const first = messages.find((msg) => msg.role === 'human' || msg.role === 'user');
  if (!first) return 'Untitled Cursor Session';
  return normaliseInlineText(first.content).slice(0, 80) || 'Untitled Cursor Session';
}

function deriveTimestampFromMessages(messages, filePath) {
  for (const msg of messages) {
    if (!msg.timestamp) continue;
    const date = new Date(msg.timestamp);
    if (!Number.isNaN(date.getTime())) return date;
  }
  try {
    return fs.statSync(filePath).mtime;
  } catch (_) {
    return new Date();
  }
}

function parseCursorTimestamp(value, filePath) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof value === 'string' && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return deriveTimestampFromMessages([], filePath);
}

function extractFilePaths(text) {
  const found = new Set();
  if (!text) return [];

  const absoluteMatches = text.matchAll(/(?:^|[\s"'`(])((?:\/(?:Users|home|var|tmp|opt)\/[^\s"'`)\]]+))/gm);
  for (const match of absoluteMatches) {
    const filePath = match[1].replace(/[,;.]+$/, '');
    if (filePath.length > 5 && filePath.length < 320) found.add(filePath);
  }

  const relativeMatches = text.matchAll(/(?:^|[\s"'`(])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@~-]+\/)+[A-Za-z0-9_.@~-]+\.[A-Za-z0-9]{1,8})(?=$|[\s)"'`,;:])/gm);
  for (const match of relativeMatches) {
    const filePath = match[1].replace(/[,;.]+$/, '');
    if (filePath.length > 3 && filePath.length < 320) found.add(filePath);
  }

  const fileMatches = text.matchAll(FILE_NAME_RE);
  for (const match of fileMatches) {
    found.add(match[0]);
  }

  return [...found].slice(0, 30);
}

function firstMessageSnippet(messages) {
  const first = messages.find((msg) => msg && msg.content);
  return first ? first.content.slice(0, 32) : 'cursor-session';
}

function normaliseInlineText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normaliseText(text) {
  return normaliseInlineText(text).toLowerCase();
}

function hashPath(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

module.exports = {
  mine,
  _test: {
    extractSessionsFromPayload,
    extractComposerSessions,
    extractPromptSessions,
    extractGenerationSessions,
    extractMessagesFromTab,
    extractMessagesFromConversation,
    flattenCursorContent,
    mergeCursorSessionCandidates,
    resolveWorkspaceInfo,
  },
};
