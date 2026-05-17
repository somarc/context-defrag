'use strict';
/**
 * discovery.js — Artifact discovery runner for the context-defrag ETL spine.
 *
 * Scans configured source roots, fingerprints every relevant artifact (file),
 * upserts into the DB, and returns a WorkManifest describing what changed.
 *
 * No subprocess spawning — uses fs APIs only.
 * No external npm dependencies.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { fingerprintFile, upsertArtifact } = require('./fingerprint');

// ── Source root definitions ────────────────────────────────────────────────────

/**
 * Return the canonical source directories for each requested source type.
 * Filters out roots that don't exist on the current machine.
 *
 * @param {string[]} sourceTypes  e.g. ['claude','codex','cursor']
 * @returns {{ type: string, rootPath: string }[]}
 */
function getSourceRoots(sourceTypes) {
  const home = os.homedir();
  const ALL_ROOTS = {
    claude: [
      path.join(home, '.claude', 'projects'),
      path.join(home, '.claude'),
      path.join(home, '.config', 'claude'),
      path.join(home, 'Library', 'Application Support', 'Claude'),
    ],
    codex: [
      path.join(home, '.codex', 'sessions'),
    ],
    cursor: [
      path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
    ],
  };

  const result = [];
  for (const type of sourceTypes) {
    const candidates = ALL_ROOTS[type] || [];
    for (const rootPath of candidates) {
      if (dirExists(rootPath)) {
        result.push({ type, rootPath });
        break; // use first found root per type (prefer most-specific)
      }
    }
  }
  return result;
}

// ── File filters ──────────────────────────────────────────────────────────────

/**
 * Decide whether a file path is a relevant artifact for the given source type.
 * Returns true if the file should be fingerprinted.
 */
function isRelevantFile(sourceType, filePath) {
  const name = path.basename(filePath);
  switch (sourceType) {
    case 'claude':
      return name.endsWith('.jsonl');
    case 'codex':
      // Only rollout-* JSONL files in the date-nested sessions tree
      return name.endsWith('.jsonl') && name.startsWith('rollout-');
    case 'cursor':
      return name === 'state.vscdb';
    default:
      return false;
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Scan all configured source roots, fingerprint each artifact, upsert into DB,
 * and return a WorkManifest.
 *
 * opts:
 *   db        — open db handle from initDb()
 *   sources   — string[]  e.g. ['claude','codex','cursor']  (default: all)
 *   since     — Date | null  skip artifacts with mtime older than this
 *   verbose   — boolean
 *
 * @returns {Promise<WorkManifest[]>}
 *
 * WorkManifest item: { artifactId, artifactPath, sourceType, reason }
 * reason: 'new' | 'changed' | 'unchanged'
 */
async function discoverArtifacts({ db, sources, since, verbose } = {}) {
  const sourceTypes = sources || ['claude', 'codex', 'cursor'];
  const sinceMs     = since instanceof Date ? since.getTime() : null;

  const t0       = Date.now();
  const manifest = [];
  let countNew = 0, countChanged = 0, countUnchanged = 0;

  const roots = getSourceRoots(sourceTypes);

  if (roots.length === 0) {
    log(verbose, '[DISCOVERY] No source roots found — nothing to scan');
  }

  for (const { type, rootPath } of roots) {
    // Ensure a sources row exists for this root
    const sourceId = upsertSource(db, type, rootPath);

    const files = walkForType(rootPath, type);
    if (verbose) {
      log(verbose, `[DISCOVERY] ${type}: found ${files.length} candidate file(s) under ${rootPath}`);
    }

    for (const filePath of files) {
      // since filter: skip files whose mtime is before the cutoff
      if (sinceMs !== null) {
        let mtime;
        try {
          mtime = fs.statSync(filePath).mtimeMs;
        } catch (_) {
          continue; // can't stat — skip
        }
        if (mtime < sinceMs) {
          continue;
        }
      }

      let fp;
      try {
        fp = await fingerprintFile(filePath);
      } catch (err) {
        if (verbose) {
          log(verbose, `[DISCOVERY] WARN could not fingerprint ${filePath}: ${err.message}`);
        }
        continue;
      }

      const { id: artifactId, changed } = upsertArtifact(db, sourceId, filePath, fp);

      // Determine reason: need to check if it was already in DB before upsert
      // upsertArtifact returns changed=true for BOTH new rows AND updated rows.
      // Distinguish them by checking if the row existed before — we do this by
      // looking at the created_at vs last_seen proximity, but simpler: track
      // whether the artifact was 'new' by checking if id was freshly inserted.
      // Since upsertArtifact already distinguishes internally, we use a tiny
      // wrapper to surface the distinction.
      const { reason } = resolveReason(db, artifactId, changed);

      switch (reason) {
        case 'new':       countNew++;       break;
        case 'changed':   countChanged++;   break;
        case 'unchanged': countUnchanged++; break;
      }

      manifest.push({ artifactId, artifactPath: filePath, sourceType: type, reason });
    }

    // Update last_scan on the source row
    db.prepare('UPDATE sources SET last_scan = ? WHERE id = ?').run(Date.now(), sourceId);
  }

  const elapsed = Date.now() - t0;
  const total   = manifest.length;

  log(true,
    `[DISCOVERY] Scanned ${total} artifact${total !== 1 ? 's' : ''} in ${elapsed}ms` +
    ` (new: ${countNew}, changed: ${countChanged}, unchanged: ${countUnchanged})`
  );

  return manifest;
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Ensure a row exists in sources for (type, rootPath) and return its id.
 * Uses INSERT OR IGNORE so it is idempotent across runs.
 */
function upsertSource(db, type, rootPath) {
  db.prepare(`
    INSERT OR IGNORE INTO sources (type, root_path) VALUES (?, ?)
  `).run(type, rootPath);

  return db.prepare('SELECT id FROM sources WHERE root_path = ?').get(rootPath).id;
}

/**
 * Determine the discovery reason for an artifact after upsert.
 * We read created_at and last_seen: if they are within 1 second of each other
 * and of now, the row was just created (reason = 'new').
 */
function resolveReason(db, artifactId, changed) {
  if (!changed) {
    return { reason: 'unchanged' };
  }

  const row = db.prepare('SELECT created_at, last_seen FROM artifacts WHERE id = ?').get(artifactId);
  if (!row) return { reason: 'changed' };

  const age = Math.abs((row.last_seen || 0) - (row.created_at || 0));
  // If created_at and last_seen are within 2 seconds, it's a brand-new insert
  const reason = age < 2000 ? 'new' : 'changed';
  return { reason };
}

/**
 * Recursively walk a directory tree and return all files relevant to sourceType.
 * Uses fs.readdirSync — no subprocess, no glob library.
 */
function walkForType(dir, sourceType) {
  const results = [];
  _walk(dir, sourceType, results);
  return results;
}

function _walk(dir, sourceType, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return; // permission error, broken symlink — skip silently
  }

  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      _walk(fullPath, sourceType, results);
    } else if (entry.isFile()) {
      if (isRelevantFile(sourceType, fullPath)) {
        results.push(fullPath);
      }
    }
  }
}

/** Returns true if path exists and is a directory. */
function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

function log(_verbose, msg) {
  // We always print DISCOVERY log lines regardless of verbose flag so users
  // can see timing info.  Callers pass verbose for conditional detail lines.
  console.log(msg);
}

module.exports = { discoverArtifacts, getSourceRoots };
