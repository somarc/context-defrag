#!/usr/bin/env node
/**
 * defrag.js — context-defrag CLI entry point
 *
 * Usage:
 *   node cli/defrag.js [options]
 *
 * Options:
 *   --output <dir>     Output vault directory (default: ./vault)
 *   --sources <list>   Comma-separated: claude,codex,cursor (default: all)
 *   --dry-run          Show what would be extracted without writing
 *   --verbose          Show detailed progress
 *   --since <date>     Only process conversations after this date (ISO 8601)
 *   --help             Show this message
 */

'use strict';

const os   = require('os');
const path = require('path');

// ── Local modules ──────────────────────────────────────────────────────────
const claudeMiner  = require('./miners/claude');
const codexMiner   = require('./miners/codex');
const cursorMiner  = require('./miners/cursor');
const { extract }  = require('./extractor');
const { write }    = require('./writers/obsidian');
const { link }     = require('./writers/linker');

// ── Constants ──────────────────────────────────────────────────────────────
const VERSION       = '1.0';
const ALL_SOURCES   = ['claude', 'codex', 'cursor'];
const DEFAULT_OUT   = './vault';

const MINER_MAP = {
  claude: claudeMiner,
  codex:  codexMiner,
  cursor: cursorMiner,
};

// Source display paths — shown in the scan summary
const SOURCE_DISPLAY_PATHS = {
  claude: `~/.claude/projects/`,
  codex:  `~/.codex/`,
  cursor: `~/Library/Application Support/Cursor/`,
};

// ── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  printBanner();

  // ── Phase 1: Scan sources ───────────────────────────────────────────────
  print('Scanning sources...');

  const sinceDate  = opts.since ? new Date(opts.since) : null;
  const sources    = opts.sources || ALL_SOURCES;

  if (sinceDate && isNaN(sinceDate)) {
    die(`Invalid --since date: "${opts.since}"`);
  }

  const allSessions = [];       // { session, extracted }
  const scanResults = {};       // source → { count, skipped }

  for (const source of sources) {
    const miner = MINER_MAP[source];
    if (!miner) {
      printStatus('WARN', SOURCE_DISPLAY_PATHS[source] || source, `Unknown source, skipping`);
      continue;
    }

    let result;
    try {
      result = await miner.mine({ since: sinceDate, verbose: opts.verbose });
    } catch (err) {
      printStatus('ERR', SOURCE_DISPLAY_PATHS[source], err.message);
      continue;
    }

    const { sessions, skipped } = result;

    if (skipped && sessions.length === 0) {
      printStatus('--', SOURCE_DISPLAY_PATHS[source], 'Not found, skipping');
    } else {
      printStatus('OK', SOURCE_DISPLAY_PATHS[source], `${sessions.length} conversation${sessions.length !== 1 ? 's' : ''} found`);
    }

    scanResults[source] = { count: sessions.length };
    allSessions.push(...sessions);
  }

  const totalFound = allSessions.length;

  if (totalFound === 0) {
    print('');
    print('No conversations found. Nothing to do.');
    process.exit(0);
  }

  print('');

  // ── Phase 2: Deduplicate across sources ─────────────────────────────────
  const dedupedSessions = deduplicateSessions(allSessions);
  if (dedupedSessions.length < totalFound) {
    if (opts.verbose) {
      print(`Deduplication: ${totalFound - dedupedSessions.length} duplicate(s) removed`);
    }
  }

  // ── Phase 3: Extract concepts, decisions, snippets, URLs ────────────────
  print('Extracting concepts...');

  const enriched = [];         // { session, extracted }
  const conceptFreq = new Map(); // concept → total mention count (for summary)

  for (const session of dedupedSessions) {
    const extracted = extract(session);

    if (opts.verbose) {
      const conceptSample = extracted.concepts.slice(0, 5).join(', ');
      const moreCount     = Math.max(0, extracted.concepts.length - 5);
      const morePart      = moreCount > 0 ? ` [+${moreCount} more]` : '';
      print(`  Reading: '${truncate(session.title, 50)}' (${isoDate(session.timestamp)})`);
      if (extracted.concepts.length > 0) {
        print(`  Concepts: ${conceptSample}${morePart}`);
      }
      if (opts.sources && opts.sources.length <= 1 || opts.verbose) {
        print(`  Writing: ${opts.output}/sessions/${sessionSlug(session)}`);
      }
    }

    // Accumulate concept frequency for the final summary
    for (const c of extracted.concepts) {
      conceptFreq.set(c, (conceptFreq.get(c) || 0) + 1);
    }

    enriched.push({ session, extracted });
  }

  const totalConcepts = conceptFreq.size;
  const totalSnippets = enriched.reduce((n, { extracted }) => n + extracted.snippets.length, 0);
  const totalUrls     = enriched.reduce((n, { extracted }) => n + extracted.urls.length, 0);

  print('');

  // ── Phase 4: Write vault ────────────────────────────────────────────────
  if (!opts.dryRun) {
    print(`Writing vault to ${opts.output}...`);
  } else {
    print('Dry run — no files will be written');
  }

  let writeStats = { written: 0, skipped: 0 };
  try {
    writeStats = write({
      outputDir: opts.output,
      sessions:  enriched,
      dryRun:    opts.dryRun,
      verbose:   opts.verbose,
    });
  } catch (err) {
    die(`Write error: ${err.message}`);
  }

  print('');

  // ── Phase 5: Build wikilinks ────────────────────────────────────────────
  print('Building links...');

  let linkStats = { linksCreated: 0 };
  if (!opts.dryRun) {
    try {
      linkStats = link({
        vaultDir: opts.output,
        dryRun:   opts.dryRun,
        verbose:  opts.verbose,
      });
    } catch (err) {
      if (opts.verbose) print(`  [WARN] Linker error: ${err.message}`);
    }
  }

  // Print top linked concepts
  const topLinked = [...conceptFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  for (const [concept, count] of topLinked) {
    print(`  [[${titleCase(concept)}]] linked to ${count} note${count !== 1 ? 's' : ''}`);
  }

  print('');

  // ── Final summary ───────────────────────────────────────────────────────
  print('Complete!');
  printStat('Sessions processed', dedupedSessions.length);
  printStat('Concepts extracted', totalConcepts);
  printStat('Code snippets',      totalSnippets);
  printStat('URLs found',         totalUrls);
  printStat('Links created',      linkStats.linksCreated);
  printStat('Files written',      writeStats.written);
  if (writeStats.skipped > 0) {
    printStat('Files unchanged',  writeStats.skipped);
  }
  printStat('Output',             opts.output);
}

// ── Argument parser ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    output:  DEFAULT_OUT,
    sources: [...ALL_SOURCES],
    dryRun:  false,
    verbose: false,
    since:   null,
    help:    false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--output':
      case '-o':
        opts.output = argv[++i];
        break;

      case '--sources':
      case '-s': {
        const raw = argv[++i] || '';
        opts.sources = raw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => ALL_SOURCES.includes(s));
        if (opts.sources.length === 0) {
          die(`--sources must be one or more of: ${ALL_SOURCES.join(', ')}`);
        }
        break;
      }

      case '--dry-run':
      case '--dryrun':
        opts.dryRun = true;
        break;

      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;

      case '--since':
        opts.since = argv[++i];
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

  // Resolve output path
  opts.output = path.resolve(opts.output);

  return opts;
}

// ── Deduplication ────────────────────────────────────────────────────────────
/**
 * Remove sessions that are exact content duplicates (same source file read
 * via different paths, or same conversation appearing in multiple indexes).
 */
function deduplicateSessions(sessions) {
  const seen = new Set();
  return sessions.filter((session) => {
    const key = session.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Output helpers ────────────────────────────────────────────────────────────
function printBanner() {
  const line = '='.repeat(19);
  console.log('');
  console.log(`CONTEXT DEFRAG v${VERSION}`);
  console.log(line);
  console.log('');
}

function print(msg) {
  console.log(msg);
}

function printStatus(statusCode, label, description) {
  const code = statusCode.padEnd(2);
  console.log(`  [${code}] ${label.padEnd(30)} ${description}`);
}

function printStat(label, value) {
  const paddedLabel = (label + ':').padEnd(22);
  console.log(`  ${paddedLabel} ${value}`);
}

function printHelp() {
  console.log(`
context-defrag v${VERSION}
Mine LLM session context files and produce an Obsidian markdown vault.

USAGE
  node cli/defrag.js [options]

OPTIONS
  --output <dir>     Output vault directory (default: ${DEFAULT_OUT})
  --sources <list>   Comma-separated: ${ALL_SOURCES.join(',')} (default: all)
  --dry-run          Show what would be extracted without writing files
  --verbose          Show detailed progress
  --since <date>     Only process conversations after this date (e.g. 2025-01-01)
  --help             Show this help message

EXAMPLES
  node cli/defrag.js
  node cli/defrag.js --output ~/my-vault --sources claude,cursor
  node cli/defrag.js --since 2025-01-01 --verbose
  node cli/defrag.js --dry-run --verbose

SOURCES
  claude   ~/.claude/projects/  (JSONL conversation files)
  codex    ~/.codex/            (OpenAI Codex CLI history)
  cursor   ~/Library/Application Support/Cursor/  (SQLite chat history)
`.trim());
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ── Misc utilities ────────────────────────────────────────────────────────────
function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

function titleCase(str) {
  if (/[A-Z]/.test(str)) return str;
  return str.split(/[\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function sessionSlug(session) {
  const date  = isoDate(session.timestamp);
  const title = session.title
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 50)
    .replace(/-+$/, '');
  return `${session.source}-${date}-${title}.md`;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

// ── Run ──────────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error('');
  console.error(`Fatal error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
