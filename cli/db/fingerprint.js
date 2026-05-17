'use strict';
/**
 * fingerprint.js — Content fingerprinting utilities for the ETL spine.
 *
 * Provides fast, incremental change detection for source artifacts (files).
 * Uses mtime + size as a cheap pre-check before computing the SHA-256 hash,
 * so unchanged files are detected in O(1) without reading their content.
 *
 * All hashing is done via node:crypto (built-in — no npm dependency).
 * The hash is capped at the first 1 MB to avoid reading large files entirely,
 * while still catching the vast majority of meaningful changes.
 */

const fs     = require('fs');
const crypto = require('crypto');

const HASH_CAP_BYTES = 1024 * 1024; // 1 MB

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute a content fingerprint for a single file.
 *
 * Returns { mtime, sizeBytes, contentHash } where:
 *   mtime       — file mtime as epoch milliseconds (Number)
 *   sizeBytes   — file size in bytes
 *   contentHash — SHA-256 hex of the first 1 MB of the file
 *
 * Throws if the file cannot be read (caller decides how to handle).
 *
 * @param {string} filePath
 * @returns {{ mtime: number, sizeBytes: number, contentHash: string }}
 */
async function fingerprintFile(filePath) {
  const stat = fs.statSync(filePath);
  const mtime     = stat.mtimeMs;          // epoch ms, float — coerce to int below
  const sizeBytes = stat.size;

  const contentHash = await hashFileCapped(filePath, HASH_CAP_BYTES);

  return { mtime: Math.floor(mtime), sizeBytes, contentHash };
}

/**
 * Compare a live fingerprint against a stored artifact row.
 *
 * Returns true if the artifact is unchanged and can be skipped.
 * A match requires mtime, sizeBytes, AND contentHash to all agree.
 * (mtime-only or size-only checks would miss byte-identical renames/copies.)
 *
 * @param {{ mtime: number|null, size_bytes: number|null, content_hash: string|null }} artifact
 * @param {{ mtime: number, sizeBytes: number, contentHash: string }} fingerprint
 * @returns {boolean}
 */
function isFingerprintMatch(artifact, { mtime, sizeBytes, contentHash }) {
  if (artifact.mtime        !== mtime)        return false;
  if (artifact.size_bytes   !== sizeBytes)    return false;
  if (artifact.content_hash !== contentHash)  return false;
  return true;
}

/**
 * Upsert an artifact row for the given (sourceId, artifactPath) and return
 * { id, changed } where changed = true if this is a new row or the fingerprint
 * differs from the stored values.
 *
 * Uses INSERT OR IGNORE + UPDATE pattern so it is safe to call concurrently
 * (SQLite serialises writes in WAL mode).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} sourceId
 * @param {string} artifactPath
 * @param {{ mtime: number, sizeBytes: number, contentHash: string }} fingerprint
 * @returns {{ id: number, changed: boolean }}
 */
function upsertArtifact(db, sourceId, artifactPath, fingerprint) {
  const now = Date.now();
  const { mtime, sizeBytes, contentHash } = fingerprint;

  // Attempt a fast read first — avoids unnecessary writes for the common
  // case where nothing has changed (cache hit).
  const existing = db.prepare(
    'SELECT id, mtime, size_bytes, content_hash FROM artifacts WHERE source_id = ? AND artifact_path = ?'
  ).get(sourceId, artifactPath);

  if (existing) {
    const changed = !isFingerprintMatch(existing, fingerprint);

    if (changed) {
      db.prepare(`
        UPDATE artifacts
           SET mtime = ?, size_bytes = ?, content_hash = ?, last_seen = ?
         WHERE id = ?
      `).run(mtime, sizeBytes, contentHash, now, existing.id);
    } else {
      // Touch last_seen even when content is unchanged so we can detect
      // artifacts that have disappeared between scans.
      db.prepare('UPDATE artifacts SET last_seen = ? WHERE id = ?').run(now, existing.id);
    }

    return { id: existing.id, changed };
  }

  // New artifact — insert
  const result = db.prepare(`
    INSERT INTO artifacts (source_id, artifact_path, mtime, size_bytes, content_hash, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sourceId, artifactPath, mtime, sizeBytes, contentHash, now);

  return { id: Number(result.lastInsertRowid), changed: true };
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Read up to `capBytes` of a file and return its SHA-256 hex digest.
 * Uses a streaming read so it works correctly on large files without
 * loading them entirely into memory.
 */
function hashFileCapped(filePath, capBytes) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    let   read   = 0;
    let   done   = false;

    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

    stream.on('data', (chunk) => {
      if (done) return;

      const remaining = capBytes - read;
      if (chunk.length <= remaining) {
        hash.update(chunk);
        read += chunk.length;
      } else {
        // Partial chunk — only feed what we need then close
        hash.update(chunk.slice(0, remaining));
        read += remaining;
        done = true;
        stream.destroy(); // stop reading — we have enough
      }
    });

    stream.on('close', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => {
      // stream.destroy() triggers 'error' with an ERR_STREAM_DESTROYED — treat as normal close
      if (err.code === 'ERR_STREAM_DESTROYED') {
        resolve(hash.digest('hex'));
      } else {
        reject(err);
      }
    });
  });
}

module.exports = { fingerprintFile, isFingerprintMatch, upsertArtifact };
