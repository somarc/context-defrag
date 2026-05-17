#!/usr/bin/env node
/**
 * sync.js — Discovery-only ETL entry point for context-defrag.
 *
 * Runs artifact discovery and fingerprinting against all configured source
 * roots, upserts results into the local SQLite database, and prints a summary.
 * No vault files are written — this is safe to run as a first step to evaluate
 * what the tool would process.
 *
 * Usage:
 *   node cli/sync.js [options]
 *
 * Options:
 *   --db <path>       Path to the SQLite database (default: ./defrag.db)
 *   --sources <list>  Comma-separated: claude,codex,cursor  (default: all)
 *   --since <date>    ISO date — skip artifacts older than this mtime
 *   --verbose         Verbose output (per-file detail)
 *   --help            Show this message
 */

'use strict';

const path = require('path');

const ALL_SOURCES = ['claude', 'codex', 'cursor'];
const DEFAULT_DB  = './defrag.db';

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Lazy-load db modules here so import errors give clear messages
  let initDb, discoverArtifacts;
  try {
    ({ initDb }            = require('./db/schema'));
    ({ discoverArtifacts } = require('./db/discovery'));
  } catch (err) {
    die(err.message);
  }

  const dbPath = path.resolve(opts.db);
  const t0     = Date.now();

  if (opts.verbose) {
    console.log(`[SYNC] Opening database: ${dbPath}`);
  }

  let db;
  try {
    db = initDb(dbPath);
  } catch (err) {
    die(`Failed to initialise database: ${err.message}`);
  }

  if (opts.verbose) {
    console.log(`[SYNC] Schema ready. Starting discovery…`);
    console.log(`[SYNC] Sources: ${opts.sources.join(', ')}`);
    if (opts.since) {
      console.log(`[SYNC] Since filter: ${opts.since.toISOString()}`);
    }
  }

  let manifest;
  try {
    manifest = await discoverArtifacts({
      db,
      sources: opts.sources,
      since:   opts.since,
      verbose: opts.verbose,
    });
  } catch (err) {
    die(`Discovery failed: ${err.message}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Count per-reason
  let countNew = 0, countChanged = 0, countUnchanged = 0;
  for (const item of manifest) {
    switch (item.reason) {
      case 'new':       countNew++;       break;
      case 'changed':   countChanged++;   break;
      case 'unchanged': countUnchanged++; break;
    }
  }

  // Count distinct source types that were actually scanned
  const scannedTypes = new Set(manifest.map((m) => m.sourceType));

  // ── Summary table ────────────────────────────────────────────────────────
  console.log('');
  console.log('[SYNC] Discovery complete');
  printStat('Sources scanned', scannedTypes.size);
  printStat('Artifacts total', manifest.length);
  printStat('New            ', countNew);
  printStat('Changed        ', countChanged);
  printStat('Unchanged      ', countUnchanged);
  printStat('Time           ', `${elapsed}s`);
  console.log('');

  if (opts.verbose && manifest.length > 0) {
    // Show new/changed items so the user can see what would be processed
    const interesting = manifest.filter((m) => m.reason !== 'unchanged');
    if (interesting.length > 0) {
      console.log(`[SYNC] New/changed artifacts (${interesting.length}):`);
      for (const item of interesting.slice(0, 50)) {
        console.log(`  [${item.reason.padEnd(9)}] [${item.sourceType}] ${item.artifactPath}`);
      }
      if (interesting.length > 50) {
        console.log(`  … and ${interesting.length - 50} more`);
      }
      console.log('');
    }
  }

  process.exit(0);
}

// ── Output helpers ─────────────────────────────────────────────────────────────
function printStat(label, value) {
  const paddedLabel = (label + ':').padEnd(22);
  console.log(`  ${paddedLabel} ${value}`);
}

function printHelp() {
  console.log(`
context-defrag sync — Discovery-only ETL command

Scans configured source roots (Claude, Codex, Cursor), fingerprints each
artifact, and upserts results into the local SQLite database.  No vault files
are written.  Fast (seconds) and safe to run repeatedly.

USAGE
  node cli/sync.js [options]

OPTIONS
  --db <path>       SQLite database path (default: ${DEFAULT_DB})
  --sources <list>  Comma-separated subset: claude,codex,cursor (default: all)
  --since <date>    Skip artifacts with mtime before this ISO date
  --verbose         Show per-file detail and new/changed artifact list
  --help            Show this message

EXAMPLES
  node cli/sync.js
  node cli/sync.js --verbose
  node cli/sync.js --db ~/llm-context/defrag.db --sources claude,codex
  node cli/sync.js --since 2025-01-01 --verbose

NOTES
  Run this command before 'node cli/defrag.js' to pre-populate the DB.
  On second run, all previously seen artifacts will appear as 'unchanged'.
  The --dry-run flag on defrag.js is much faster than a full run for
  testing without vault output.
`.trim());
}

function die(msg) {
  console.error(`[SYNC] ERROR: ${msg}`);
  process.exit(1);
}

// ── Argument parser ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    db:      DEFAULT_DB,
    sources: [...ALL_SOURCES],
    since:   null,
    verbose: false,
    help:    false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--db':
        opts.db = argv[++i];
        if (!opts.db) die('--db requires a path argument');
        break;

      case '--sources':
      case '-s': {
        const raw = argv[++i] || '';
        const parsed = raw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => ALL_SOURCES.includes(s));
        if (parsed.length === 0) {
          die(`--sources must be one or more of: ${ALL_SOURCES.join(', ')}`);
        }
        opts.sources = parsed;
        break;
      }

      case '--since': {
        const raw = argv[++i];
        if (!raw) die('--since requires an ISO date argument');
        const d = new Date(raw);
        if (isNaN(d.getTime())) die(`--since: invalid date "${raw}"`);
        opts.since = d;
        break;
      }

      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;

      case '--help':
      case '-h':
        opts.help = true;
        break;

      default:
        if (arg.startsWith('-')) {
          die(`Unknown option: ${arg}. Use --help for usage.`);
        }
    }
  }

  return opts;
}

// ── Run ────────────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error('');
  console.error(`[SYNC] Fatal: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
