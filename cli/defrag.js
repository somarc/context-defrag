#!/usr/bin/env node
/**
 * defrag.js — context-defrag CLI entry point
 *
 * Usage:
 *   npx context-defrag [options]
 *   node cli/defrag.js [options]
 *
 * Options:
 *   --output <dir>        Output vault directory (default: ./vault)
 *   --sources <list>      Comma-separated: claude,codex,cursor (default: all)
 *   --dry-run             Show what would be extracted without writing
 *   --verbose             Show detailed progress
 *   --since <date>        Only process conversations after this date (ISO 8601)
 *   --watch               Re-run whenever source files change (2 s debounce)
 *   --model <name>        LLM model hint stored in defrag.json (informational)
 *   --gpt-ko              Print QMD integration instructions after writing vault
 *   --min-signal <number> Minimum signal score for standalone concept notes (default: 8)
 *   --help                Show this message
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { execFile }  = require('child_process');

// ── Local modules ──────────────────────────────────────────────────────────
const claudeMiner  = require('./miners/claude');
const codexMiner   = require('./miners/codex');
const cursorMiner  = require('./miners/cursor');
const { extract }  = require('./extractor');
const { write }    = require('./writers/obsidian');
const { link }     = require('./writers/linker');
const tui          = require('./tui');

// ── Constants ──────────────────────────────────────────────────────────────
const VERSION              = '1.0';
const ALL_SOURCES          = ['claude', 'codex', 'cursor'];
const DEFAULT_OUT          = './vault';
const DEFAULT_MIN_SIGNAL   = 8;

const MINER_MAP = {
  claude: claudeMiner,
  codex:  codexMiner,
  cursor: cursorMiner,
};

// Source display paths — shown in the scan summary and written to defrag.json
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

  // Run the pipeline once, then set up watch mode if requested
  await runPipeline(opts);

  if (opts.watch) {
    setupWatchMode(opts);
  }
}

// ── Core pipeline — scan, extract, write ─────────────────────────────────────
async function runPipeline(opts) {
  printBanner();
  tui.init();

  // ── Phase 1: Scan sources ───────────────────────────────────────────────
  tui.update({ phase: 'SCANNING', pct: 5 });
  print('Scanning sources...');

  const sinceDate  = opts.since ? new Date(opts.since) : null;
  const sources    = opts.sources || ALL_SOURCES;

  if (sinceDate && isNaN(sinceDate)) {
    die(`Invalid --since date: "${opts.since}"`);
  }

  // Mark all requested sources as 'scanning'
  const initialSources = {};
  for (const src of ALL_SOURCES) {
    initialSources[src] = { found: false, sessions: 0 };
  }
  tui.update({ sources: initialSources });

  const allSessions = [];       // { session, extracted }
  const scanResults = {};       // source → { found, sessions, path }

  for (const source of sources) {
    // Animate the source as "scanning" while we mine it
    const scanningPatch = {};
    for (const src of ALL_SOURCES) {
      scanningPatch[src] = { found: false, sessions: 0 };
    }
    // Mark this source as scanning (will show animated dots)
    tui.update({ sources: scanningPatch });

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
      scanResults[source] = { found: false, sessions: 0, path: SOURCE_DISPLAY_PATHS[source] };
      continue;
    }

    const { sessions, skipped } = result;

    if (skipped && sessions.length === 0) {
      printStatus('--', SOURCE_DISPLAY_PATHS[source], 'Not found, skipping');
      scanResults[source] = { found: false, sessions: 0, path: SOURCE_DISPLAY_PATHS[source] };
    } else {
      printStatus('OK', SOURCE_DISPLAY_PATHS[source], `${sessions.length} conversation${sessions.length !== 1 ? 's' : ''} found`);
      scanResults[source] = { found: true, sessions: sessions.length, path: SOURCE_DISPLAY_PATHS[source] };
    }

    allSessions.push(...sessions);

    // Update TUI with accumulated scan state
    tui.update({
      phase:    'SCANNING',
      pct:      10,
      sessions: allSessions.length,
      sources:  scanResults,
    });
  }

  // Fill in any sources that weren't processed (filtered out via --sources)
  for (const source of ALL_SOURCES) {
    if (!(source in scanResults)) {
      scanResults[source] = { found: false, sessions: 0, path: SOURCE_DISPLAY_PATHS[source] };
    }
  }

  const totalFound = allSessions.length;

  tui.update({
    phase:    'EXTRACTING',
    pct:      20,
    sessions: totalFound,
    sources:  scanResults,
  });
  tui.log(`[SCAN] Found ${totalFound} session${totalFound !== 1 ? 's' : ''} across ${sources.length} source${sources.length !== 1 ? 's' : ''}`);

  if (totalFound === 0) {
    print('');
    print('No conversations found. Nothing to do.');
    await tui.done();
    return;
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
  tui.update({ phase: 'EXTRACTING', pct: 25 });

  const enriched = [];          // { session, extracted }
  const conceptFreq = new Map(); // concept → total mention count (for summary)
  const total = dedupedSessions.length;

  for (let si = 0; si < total; si++) {
    const session   = dedupedSessions[si];
    const extracted = extract(session);
    const pct       = 25 + Math.floor((si / total) * 20); // 25–45%

    if (opts.verbose) {
      const conceptSample = extracted.concepts.slice(0, 5).join(', ');
      const moreCount     = Math.max(0, extracted.concepts.length - 5);
      const morePart      = moreCount > 0 ? ` [+${moreCount} more]` : '';
      print(`  Reading: '${truncate(session.title, 50)}' (${isoDate(session.timestamp)})`);
      if (extracted.concepts.length > 0) {
        print(`  Concepts: ${conceptSample}${morePart}`);
      }
    }

    // Accumulate concept frequency for the final summary
    for (const c of extracted.concepts) {
      conceptFreq.set(c, (conceptFreq.get(c) || 0) + 1);
    }

    enriched.push({ session, extracted });

    // Yield to event loop every 5 sessions so the TUI render timer can fire
    if (si % 5 === 0 || si === total - 1) {
      tui.update({ phase: 'EXTRACTING', pct, sessions: si + 1 });
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  const totalConcepts = conceptFreq.size;
  const totalSnippets = enriched.reduce((n, { extracted }) => n + extracted.snippets.length, 0);
  const totalUrls     = enriched.reduce((n, { extracted }) => n + extracted.urls.length, 0);

  tui.update({ phase: 'WRITING', pct: 45, concepts: totalConcepts });
  tui.log(`[SCAN] Extracted ${totalConcepts} concept${totalConcepts !== 1 ? 's' : ''}, ${totalSnippets} snippet${totalSnippets !== 1 ? 's' : ''}`);

  print('');

  // ── Phase 4: Write vault ────────────────────────────────────────────────
  if (!opts.dryRun) {
    print(`Writing vault to ${opts.output}...`);
    tui.log(`[WRITE] Writing vault to ${opts.output}`);
    if (opts.minSignal !== DEFAULT_MIN_SIGNAL) {
      print(`  Signal threshold: ${opts.minSignal} (default: ${DEFAULT_MIN_SIGNAL})`);
    }
  } else {
    print('Dry run — no files will be written');
    tui.log('[DRY] Dry run — no files will be written');
  }

  let writeStats = { written: 0, skipped: 0 };
  try {
    writeStats = write({
      outputDir:       opts.output,
      sessions:        enriched,
      allSessions:     enriched,   // full enriched list passed for recency scoring
      dryRun:          opts.dryRun,
      verbose:         opts.verbose,
      signalThreshold: opts.minSignal,
      onProgress: (msg, stats) => {
        tui.log(`[WRITE] ${msg}`);
        // Update file count every 50 writes so TUI stays responsive
        if (stats.written % 50 === 0) {
          tui.update({ files: stats.written, pct: 45 + Math.min(24, Math.floor(stats.written / 250)) });
        }
      },
    });
  } catch (err) {
    die(`Write error: ${err.message}`);
  }

  tui.update({ phase: 'LINKING', pct: 70, files: writeStats.written });
  tui.log(`[WRITE] Vault written — ${writeStats.written} file${writeStats.written !== 1 ? 's' : ''}`);

  print('');

  // ── Phase 5: Build wikilinks ────────────────────────────────────────────
  print('Building links...');
  tui.log('[LINK] Building wikilinks...');

  let linkStats   = { linksCreated: 0 };
  let currentLinkCount = 0;

  if (!opts.dryRun) {
    try {
      linkStats = link({
        vaultDir:   opts.output,
        dryRun:     opts.dryRun,
        verbose:    opts.verbose,
        onProgress: (msg) => {
          currentLinkCount++;
          tui.log(`[LINK] ${msg}`);
          tui.update({ links: currentLinkCount });
        },
      });
    } catch (err) {
      if (opts.verbose) print(`  [WARN] Linker error: ${err.message}`);
    }
  }

  tui.update({ phase: 'LINKING', pct: 90, links: linkStats.linksCreated });

  // Print top linked concepts
  const topLinked = [...conceptFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  for (const [concept, count] of topLinked) {
    print(`  [[${titleCase(concept)}]] linked to ${count} note${count !== 1 ? 's' : ''}`);
    tui.log(`[LINK] [[${titleCase(concept)}]] → ${count} note${count !== 1 ? 's' : ''}`);
  }

  print('');

  // ── Phase 6: Write defrag.json manifest ─────────────────────────────────
  const topConceptsList = [...conceptFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([c]) => titleCase(c));

  const manifest = {
    version:         '1.0',
    generated:       new Date().toISOString(),
    sources:         scanResults,
    stats: {
      sessions:     dedupedSessions.length,
      concepts:     totalConcepts,
      snippets:     totalSnippets,
      urls:         totalUrls,
      links:        linkStats.linksCreated,
      filesWritten: writeStats.written,
    },
    topConcepts:     topConceptsList,
    vault:           opts.output,
    signalThreshold: opts.minSignal,
    ...(opts.model ? { model: opts.model } : {}),
  };

  if (!opts.dryRun) {
    try {
      const manifestPath = path.join(opts.output, 'defrag.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      if (opts.verbose) {
        print(`  Manifest written: ${manifestPath}`);
      }
    } catch (err) {
      if (opts.verbose) print(`  [WARN] Could not write defrag.json: ${err.message}`);
    }
  }

  // ── Final summary ───────────────────────────────────────────────────────
  tui.update({ phase: 'COMPLETE', pct: 100, links: linkStats.linksCreated });

  tui.log('It is now safe to turn off your computer.');

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
  printStat('Signal threshold',   opts.minSignal);
  printStat('Output',             opts.output);

  // ── Phase 7: QMD integration ────────────────────────────────────────────
  if (opts.gptKo) {
    await runQmdIntegration(opts.output, opts.verbose);
  }

  await tui.done();
}

// ── QMD integration ──────────────────────────────────────────────────────────
/**
 * If the `qmd` binary is in PATH, auto-run `qmd collection add`.
 * Either way, print the instructions for manual use.
 */
async function runQmdIntegration(vaultPath, verbose) {
  print('');
  print('QMD Integration');

  // Check if qmd binary is available
  const qmdBin = await findBinary('qmd');

  if (qmdBin) {
    print(`  Found qmd at: ${qmdBin}`);
    print(`  Running: qmd collection add "${vaultPath}" --name llm-context`);
    print('');

    try {
      const output = await execFilePromise(qmdBin, ['collection', 'add', vaultPath, '--name', 'llm-context']);
      if (output.stdout) print(output.stdout.trim());
      if (output.stderr && verbose) print(output.stderr.trim());
    } catch (err) {
      print(`  [WARN] qmd collection add failed: ${err.message}`);
    }
  }

  // Always print the manual instructions
  print(`  Run: qmd collection add ${vaultPath} --name llm-context`);
  print(`       qmd embed`);
  print(`       qmd query "your question"`);
}

/**
 * Locate a binary using the system PATH (cross-platform).
 * Returns the full path string, or null if not found.
 */
function findBinary(name) {
  return new Promise((resolve) => {
    // `which` on Unix/macOS; `where` on Windows
    const cmd     = process.platform === 'win32' ? 'where' : 'which';
    const cmdArgs = [name];

    execFile(cmd, cmdArgs, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      resolve(stdout.trim().split('\n')[0].trim());
    });
  });
}

/**
 * Promisified execFile wrapper.
 */
function execFilePromise(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

// ── Watch mode ────────────────────────────────────────────────────────────────
/**
 * Watch all known source directories for changes.
 * Re-run the full pipeline after a 2-second debounce.
 */
function setupWatchMode(opts) {
  const os = require('os');

  // Directories to watch — all known Claude/Codex/Cursor roots
  const watchRoots = [
    path.join(os.homedir(), '.claude'),
    path.join(os.homedir(), '.config', 'claude'),
    path.join(os.homedir(), '.codex'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
  ].filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
  });

  if (watchRoots.length === 0) {
    print('[watch] No source directories found to watch.');
    return;
  }

  print(`[watch] Watching for changes in: ${watchRoots.join(', ')}`);

  let debounceTimer = null;

  for (const root of watchRoots) {
    try {
      fs.watch(root, { recursive: true }, (_event, filename) => {
        // Ignore non-data files (e.g. lock files, .DS_Store)
        if (filename && (filename.endsWith('.lock') || filename.endsWith('.DS_Store'))) {
          return;
        }

        // Debounce: wait 2 seconds after the last change before re-running
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          debounceTimer = null;
          print('');
          print('[watch] Re-running defrag...');
          try {
            await runPipeline(opts);
          } catch (err) {
            print(`[watch] Pipeline error: ${err.message}`);
          }
        }, 2000);
      });
    } catch (err) {
      if (opts.verbose) {
        print(`[watch] Could not watch ${root}: ${err.message}`);
      }
    }
  }
}

// ── Argument parser ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    output:    DEFAULT_OUT,
    sources:   [...ALL_SOURCES],
    dryRun:    false,
    verbose:   false,
    since:     null,
    watch:     false,
    model:     null,
    gptKo:     false,
    help:      false,
    minSignal: DEFAULT_MIN_SIGNAL,
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

      case '--watch':
      case '-w':
        opts.watch = true;
        break;

      case '--model':
        opts.model = argv[++i];
        break;

      case '--gpt-ko':
      case '--gptko':
        opts.gptKo = true;
        break;

      case '--min-signal': {
        const raw = argv[++i];
        const n   = Number(raw);
        if (!isFinite(n) || n < 0) {
          die(`--min-signal must be a non-negative number (got: "${raw}")`);
        }
        opts.minSignal = n;
        break;
      }

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
  // In TUI mode the banner is rendered inside the header — keep plain output quiet
  if (tui.ENABLED) return;

  const line = '='.repeat(19);
  console.log('');
  console.log(`CONTEXT DEFRAG v${VERSION}`);
  console.log(line);
  console.log('');
}

function print(msg) {
  tui.log(msg);
}

function printStatus(statusCode, label, description) {
  const code = statusCode.padEnd(2);
  const msg  = `[${code}] ${label.padEnd(30)} ${description}`;
  tui.log(msg);
}

function printStat(label, value) {
  const paddedLabel = (label + ':').padEnd(22);
  const msg = `  ${paddedLabel} ${value}`;
  tui.log(msg);
}

function printHelp() {
  console.log(`
context-defrag v${VERSION}
Mine LLM session context files and produce an Obsidian markdown vault.

USAGE
  npx context-defrag [options]
  node cli/defrag.js [options]

OPTIONS
  --output <dir>        Output vault directory (default: ${DEFAULT_OUT})
  --sources <list>      Comma-separated: ${ALL_SOURCES.join(',')} (default: all)
  --dry-run             Show what would be extracted without writing files
  --verbose             Show detailed progress
  --since <date>        Only process conversations after this date (e.g. 2025-01-01)
  --watch               Re-run automatically when source files change (2 s debounce)
  --model <name>        Store a model hint in defrag.json (informational)
  --gpt-ko              Print QMD indexing instructions; auto-run if qmd is in PATH
  --min-signal <number> Minimum signal score for a standalone concept note (default: ${DEFAULT_MIN_SIGNAL})
                        Concepts below threshold are listed in _low-signal.md instead.
                        Score = (sessions×2) + (decisions×5) + (code×3) + (cross-project×4)
  --help                Show this help message

EXAMPLES
  npx context-defrag
  npx context-defrag --output ~/my-vault --sources claude,cursor
  npx context-defrag --since 2025-01-01 --verbose
  npx context-defrag --dry-run --verbose
  npx context-defrag --watch --output ~/my-vault
  npx context-defrag --gpt-ko
  npx context-defrag --min-signal 12
  npx context-defrag --min-signal 0     # every concept gets its own note

SOURCES
  claude   ~/.claude/projects/  (JSONL conversation files — Desktop & Code)
  codex    ~/.codex/            (OpenAI Codex CLI history)
  cursor   ~/Library/Application Support/Cursor/  (SQLite chat history)

SIGNAL SCORING
  Each concept earns signal points based on how it appears across sessions:
    sessions   ×2  — number of sessions the concept appeared in
    decisions  ×5  — decision sentences that explicitly mention it
    code       ×3  — code snippets whose body references it
    projects   ×4  — distinct workspace/source paths where it appeared

  Concepts scoring below --min-signal are collected in vault/_low-signal.md.

OUTPUT
  After each run, <vault>/defrag.json is written with session counts, top
  concepts, and source metadata — usable by the web visualizer and QMD.
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
