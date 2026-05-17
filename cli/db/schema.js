'use strict';
/**
 * schema.js — SQLite schema initialisation for the context-defrag ETL spine.
 *
 * Uses node:sqlite (built-in Node 22+).  Throws a clear error on older runtimes
 * so users get an actionable message rather than a cryptic module-not-found.
 *
 * Usage:
 *   const { initDb } = require('./schema');
 *   const db = initDb('/path/to/defrag.db');
 */

// ── Runtime capability check ─────────────────────────────────────────────────
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  throw new Error(
    '[context-defrag] node:sqlite is not available.\n' +
    'The ETL spine requires Node.js 22 or later (built-in SQLite support).\n' +
    `Your runtime: ${process.version}\n` +
    'Upgrade to Node 22+: https://nodejs.org/en/download'
  );
}

// ── Migration definitions ─────────────────────────────────────────────────────
// Each migration is an object { version, up: string[] }.
// Migrations are applied in ascending version order and are idempotent —
// already-applied versions are skipped based on the schema_migrations table.

const MIGRATIONS = [
  {
    version: 1,
    up: [
      // Source roots (configured scan directories)
      `CREATE TABLE IF NOT EXISTS sources (
        id          INTEGER PRIMARY KEY,
        type        TEXT NOT NULL,
        root_path   TEXT NOT NULL UNIQUE,
        last_scan   INTEGER,
        created_at  INTEGER DEFAULT (unixepoch() * 1000)
      )`,

      // Raw artifacts (individual files / DB rows discovered)
      `CREATE TABLE IF NOT EXISTS artifacts (
        id            INTEGER PRIMARY KEY,
        source_id     INTEGER NOT NULL REFERENCES sources(id),
        artifact_path TEXT NOT NULL,
        mtime         INTEGER,
        size_bytes    INTEGER,
        content_hash  TEXT,
        last_seen     INTEGER,
        created_at    INTEGER DEFAULT (unixepoch() * 1000),
        UNIQUE(source_id, artifact_path)
      )`,

      // Normalized conversation threads (one per session/file)
      `CREATE TABLE IF NOT EXISTS threads (
        id          INTEGER PRIMARY KEY,
        artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
        thread_key  TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        title       TEXT,
        started_at  INTEGER,
        ended_at    INTEGER,
        turn_count  INTEGER DEFAULT 0,
        workspace   TEXT,
        metadata    TEXT,
        created_at  INTEGER DEFAULT (unixepoch() * 1000)
      )`,

      // Individual messages within threads
      `CREATE TABLE IF NOT EXISTS messages (
        id           INTEGER PRIMARY KEY,
        thread_id    INTEGER NOT NULL REFERENCES threads(id),
        seq          INTEGER NOT NULL,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        ts           INTEGER,
        content_hash TEXT,
        created_at   INTEGER DEFAULT (unixepoch() * 1000)
      )`,

      // Episode groupings (stub for Phase 1 — fields TBD)
      `CREATE TABLE IF NOT EXISTS episodes (
        id           INTEGER PRIMARY KEY,
        title        TEXT,
        workspace    TEXT,
        started_at   INTEGER,
        ended_at     INTEGER,
        thread_ids   TEXT,
        signal_score REAL DEFAULT 0,
        metadata     TEXT,
        created_at   INTEGER DEFAULT (unixepoch() * 1000)
      )`,

      // Render state: tracks what has been materialised to disk
      `CREATE TABLE IF NOT EXISTS render_state (
        id           INTEGER PRIMARY KEY,
        note_path    TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        source_type  TEXT,
        thread_id    INTEGER REFERENCES threads(id),
        episode_id   INTEGER REFERENCES episodes(id),
        written_at   INTEGER DEFAULT (unixepoch() * 1000),
        updated_at   INTEGER
      )`,
    ],
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open (or create) a SQLite database at dbPath, enable WAL + FK, apply
 * pending schema migrations, and return the open db handle.
 *
 * @param {string} dbPath  Absolute or relative path to the .db file.
 * @returns {import('node:sqlite').DatabaseSync}
 */
function initDb(dbPath) {
  const db = new DatabaseSync(dbPath);

  // Performance / correctness pragmas — must be set before any table access
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');

  // Migration bookkeeping table — always exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch() * 1000)
    )
  `);

  // Determine which versions are already applied
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    // Wrap each migration in a transaction so partial failures are rolled back
    const applyMigration = db.transaction(() => {
      for (const sql of migration.up) {
        db.exec(sql);
      }
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    });

    applyMigration();
  }

  return db;
}

module.exports = { initDb };
