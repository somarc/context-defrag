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
 *   --log-file <path>     Write all log entries (plain text, timestamped) to a file
 *   --no-tui              Disable full-screen TUI; plain console output instead
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
const { extractAsync, computeSignalScore, computeSessionScore, sessionTier }  = require('./extractor');
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
  // --no-tui: disable the full-screen TUI, fall back to plain console.log()
  if (opts.noTui) {
    tui.disable();
  }

  printBanner();
  tui.init();

  // ── Log-file setup ──────────────────────────────────────────────────────
  // If --log-file was supplied, open a write stream and monkey-patch tui.log()
  // to also append each entry (stripped of ANSI codes) with an ISO timestamp.
  let logStream = null;
  if (opts.logFile) {
    try {
      logStream = fs.createWriteStream(opts.logFile, { flags: 'a' });
      const _origLog = tui.log.bind(tui);
      tui.log = function patchedLog(msg) {
        _origLog(msg);
        if (msg || msg === 0) {
          // Strip ANSI escape codes for the plain-text log file
          const plain = String(msg).replace(/\x1b\[[0-9;]*m/g, '');
          const ts    = new Date().toISOString();
          logStream.write(`${ts}  ${plain}\n`);
        }
      };
    } catch (err) {
      tui.log(`[WARN] Could not open log file ${opts.logFile}: ${err.message}`);
    }
  }

  // ── Phase 1: Scan sources (0–10%) ──────────────────────────────────────
  tui.update({ phase: 'SCANNING', pct: 0 });
  print('Scanning sources...');

  const sinceDate  = opts.since ? new Date(opts.since) : null;
  const sources    = opts.sources || ALL_SOURCES;

  if (sinceDate && isNaN(sinceDate)) {
    die(`Invalid --since date: "${opts.since}"`);
  }

  // Mark all requested sources as 'scanning'
  const initialSources = {};
  for (const src of ALL_SOURCES) {
    initialSources[src] = { status: 'pending', found: false, sessions: 0 };
  }
  tui.update({ sources: initialSources });

  const allSessions = [];       // { session, extracted }
  const scanResults = {};       // source → { found, sessions, path }

  for (let si = 0; si < sources.length; si++) {
    const source = sources[si];

    // Per-source progress within the 0-10% scanning band
    const scanPct = Math.floor((si / sources.length) * 10);
    tui.update({ phase: 'SCANNING', pct: scanPct });

    // Animate the source as "scanning" while we mine it
    const scanningPatch = {};
    for (const src of ALL_SOURCES) {
      const existing = scanResults[src];
      scanningPatch[src] = existing || { status: 'pending', found: false, sessions: 0, path: SOURCE_DISPLAY_PATHS[src] };
    }
    scanningPatch[source] = { ...(scanningPatch[source] || {}), status: 'scanning', found: false };
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
      scanResults[source] = { status: 'error', found: false, sessions: 0, path: SOURCE_DISPLAY_PATHS[source] };
      continue;
    }

    const { sessions, skipped } = result;

    if (skipped && sessions.length === 0) {
      printStatus('--', SOURCE_DISPLAY_PATHS[source], 'Not found, skipping');
      scanResults[source] = { status: 'missing', found: false, sessions: 0, path: SOURCE_DISPLAY_PATHS[source] };
    } else {
      printStatus('OK', SOURCE_DISPLAY_PATHS[source], `${sessions.length} conversation${sessions.length !== 1 ? 's' : ''} found`);
      scanResults[source] = { status: 'found', found: true, sessions: sessions.length, path: SOURCE_DISPLAY_PATHS[source] };
    }

    allSessions.push(...sessions);

    // Update TUI with accumulated scan state
    tui.update({
      phase:    'SCANNING',
      pct:      Math.floor(((si + 1) / sources.length) * 10),
      sessions: allSessions.length,
      sources:  scanResults,
    });
  }

  // Fill in any sources that weren't processed (filtered out via --sources)
  for (const source of ALL_SOURCES) {
    if (!(source in scanResults)) {
      scanResults[source] = { status: 'pending', found: false, sessions: 0, path: SOURCE_DISPLAY_PATHS[source] };
    }
  }

  const totalFound = allSessions.length;

  tui.update({
    phase:    'EXTRACTING',
    pct:      10,
    sessions: totalFound,
    sources:  scanResults,
  });
  tui.log(`[SCAN] Found ${totalFound} session${totalFound !== 1 ? 's' : ''} across ${sources.length} source${sources.length !== 1 ? 's' : ''}`);

  if (totalFound === 0) {
    print('');
    print('No conversations found. Nothing to do.');
    await tui.done();
    if (logStream) logStream.end();
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

  // ── Phase 3: Extract concepts, decisions, snippets, URLs (10–65%) ──────
  print('Extracting concepts...');
  tui.update({ phase: 'EXTRACTING', pct: 10 });

  const enriched = [];          // { session, extracted }
  const conceptFreq = new Map(); // concept → total mention count (for summary)
  const total = dedupedSessions.length;

  let tierCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const extractionHealth = {
    weakSessionCount: 0,
    metadataOnlyCursorSessions: 0,
    truncatedSessions: 0,
    weakSessions: [],
    sourceStats: {},
    continuity: {
      resumedSessions: 0,
      blockedSessions: 0,
      unfinishedSessions: 0,
      statusCounts: {},
      phaseCounts: {},
    },
  };

  for (let si = 0; si < total; si++) {
    const session = dedupedSessions[si];

    // ── Pre-extraction: show what we're working on BEFORE the blocking call ─
    const pctPre = 10 + Math.floor((si / total) * 55);
    const pctMax = 10 + Math.floor(((si + 1) / total) * 55);
    tui.update({
      phase: 'EXTRACTING', pct: pctPre, sessions: si,
      currentSession: `[${si + 1}/${total}] ${session.source} ${isoDate(session.timestamp)}`,
    });
    await new Promise(resolve => setImmediate(resolve));

    const extracted = await extractAsync(session, {
      onEvent: (event) => {
        const sessionSpan = Math.max(1, pctMax - pctPre);
        const stagePct = pctPre + Math.min(sessionSpan - 1, Math.floor(sessionSpan * Math.max(0, Math.min(0.98, event.progress || 0))));
        tui.update({
          phase: 'EXTRACTING',
          pct: stagePct,
          sessions: si,
          currentSession: `[${si + 1}/${total}] ${session.source} ${isoDate(session.timestamp)}`,
          currentStage: event.label || '',
          currentDetail: event.detail || '',
          currentFocus: event.focus || '',
          currentQuality: event.quality || '',
        });
      },
    });
    const obs = extracted.observability || null;
    const continuity = extracted.continuity || obs?.continuity || null;

    // ── Compute session signal score and tier ───────────────────────────
    const sessScore = computeSessionScore(session, extracted);
    const tier      = sessionTier(sessScore);
    tierCounts[tier]++;

    // Attach to the session object so the writer can use it
    session._sessionScore = sessScore;
    session._sessionTier  = tier;

    // ── Progress within the 10–65% extraction band ──────────────────────
    const pct = pctMax; // 10–65%

    // ── Always log a compact per-session line ───────────────────────────
    const decisionCount = extracted.decisions ? extracted.decisions.length : 0;
    const issueCount    = extracted.issues ? extracted.issues.length : 0;
    const actionCount   = extracted.actionItems ? extracted.actionItems.length : 0;
    const commitCount   = extracted.commits ? extracted.commits.length : 0;
    const tierTag       = tier === 'HIGH' ? '▲' : tier === 'MEDIUM' ? '●' : '·';
    const continuityTag = continuity ? `${continuity.status}/${continuity.phase}` : 'unknown';
    tui.log(
      `[EXTRACT] ${tierTag} ${session.source} ${isoDate(session.timestamp)} "${truncate(session.title, 36)}" — ${extracted.concepts.length}c ${decisionCount}d ${issueCount}i ${actionCount}a ${commitCount}g · ${continuityTag}`
    );

    if (obs) {
      const sourceBucket = extractionHealth.sourceStats[session.source] || {
        sessions: 0,
        weak: 0,
        concepts: 0,
        structured: 0,
        resumed: 0,
        blocked: 0,
        unfinished: 0,
      };
      sourceBucket.sessions++;
      sourceBucket.concepts += obs.conceptCount || 0;
      sourceBucket.structured += (obs.decisionCount || 0) + (obs.issueCount || 0) + (obs.actionItemCount || 0) + (obs.commitCount || 0);
      if (continuity?.resumed) sourceBucket.resumed++;
      if (continuity?.blocked) sourceBucket.blocked++;
      if (continuity?.unfinished) sourceBucket.unfinished++;

      if (obs.truncated) extractionHealth.truncatedSessions++;
      if (session.cursorMetaOnly) extractionHealth.metadataOnlyCursorSessions++;
      if (continuity?.resumed) extractionHealth.continuity.resumedSessions++;
      if (continuity?.blocked) extractionHealth.continuity.blockedSessions++;
      if (continuity?.unfinished) extractionHealth.continuity.unfinishedSessions++;
      if (continuity?.status) {
        extractionHealth.continuity.statusCounts[continuity.status] = (extractionHealth.continuity.statusCounts[continuity.status] || 0) + 1;
      }
      if (continuity?.phase) {
        extractionHealth.continuity.phaseCounts[continuity.phase] = (extractionHealth.continuity.phaseCounts[continuity.phase] || 0) + 1;
      }
      if (Array.isArray(obs.weakSignals) && obs.weakSignals.length > 0) {
        extractionHealth.weakSessionCount++;
        sourceBucket.weak++;
        if (extractionHealth.weakSessions.length < 20) {
          extractionHealth.weakSessions.push({
            id: session.id,
            title: session.title,
            source: session.source,
            date: isoDate(session.timestamp),
            weakSignals: obs.weakSignals,
            continuity: continuity ? {
              status: continuity.status,
              phase: continuity.phase,
              markers: continuity.markers,
            } : null,
          });
        }
        tui.log(`[WARN] Weak extraction ${session.source} "${truncate(session.title, 30)}" — ${obs.weakSignals.join(', ')}`);
      }
      extractionHealth.sourceStats[session.source] = sourceBucket;
    }

    // ── Verbose: extra concept detail ───────────────────────────────────
    if (opts.verbose) {
      const conceptSample = extracted.concepts.slice(0, 5).join(', ');
      const moreCount     = Math.max(0, extracted.concepts.length - 5);
      const morePart      = moreCount > 0 ? ` [+${moreCount} more]` : '';
      print(`  Reading: '${truncate(session.title, 50)}' (${isoDate(session.timestamp)}) [${tier}]`);
      if (extracted.concepts.length > 0) {
        print(`  Concepts: ${conceptSample}${morePart}`);
      }
    }

    // Accumulate concept frequency for the final summary
    for (const c of extracted.concepts) {
      conceptFreq.set(c, (conceptFreq.get(c) || 0) + 1);
    }

    enriched.push({ session, extracted });

    // ── Yield to event loop every session so TUI timer/spinner can fire ─
    tui.update({
      phase: 'EXTRACTING', pct, sessions: si + 1, concepts: conceptFreq.size,
      tiersHigh: tierCounts.HIGH, tiersMedium: tierCounts.MEDIUM, tiersLow: tierCounts.LOW,
      currentStage: continuity ? `Session state: ${continuity.status} · ${continuity.phase}` : '',
      currentDetail: continuity ? summarizeContinuityState(continuity) : '',
      currentFocus: continuity?.primaryThread || '',
      currentQuality: obs?.weakSignals?.length ? 'weak' : 'steady',
    });
    await new Promise(resolve => setImmediate(resolve));

    // ── Check if user requested exit (ESC / Ctrl-C / q) during extraction ─
    if (tui.exitRequested) {
      tui.log('[WARN] Interrupted by user — exiting gracefully');
      if (logStream) logStream.end();
      process.exit(0);
    }
  }

  tui.log(`[SCAN] Session tiers: ${tierCounts.HIGH} high, ${tierCounts.MEDIUM} medium, ${tierCounts.LOW} low`);
  tui.log(`[SCAN] Extraction health: ${extractionHealth.weakSessionCount} weak, ${extractionHealth.metadataOnlyCursorSessions} cursor-metadata-only, ${extractionHealth.truncatedSessions} truncated`);
  tui.log(`[SCAN] Continuity: ${extractionHealth.continuity.resumedSessions} resumed, ${extractionHealth.continuity.blockedSessions} blocked, ${extractionHealth.continuity.unfinishedSessions} unfinished`);

  const totalConcepts = conceptFreq.size;
  const totalSnippets = enriched.reduce((n, { extracted }) => n + extracted.snippets.length, 0);
  const totalUrls     = enriched.reduce((n, { extracted }) => n + extracted.urls.length, 0);
  const totalDecisions = enriched.reduce((n, { extracted }) => n + (extracted.decisions?.length || 0), 0);
  const totalIssues    = enriched.reduce((n, { extracted }) => n + (extracted.issues?.length || 0), 0);
  const totalActions   = enriched.reduce((n, { extracted }) => n + (extracted.actionItems?.length || 0), 0);
  const totalCommits   = enriched.reduce((n, { extracted }) => n + (extracted.commits?.length || 0), 0);
  const sessionSummaries = buildSessionSummaries(enriched);
  const conceptSummaries = buildConceptSummaries(enriched);
  const effectiveConceptCount = conceptSummaries.length || totalConcepts;

  tui.update({ phase: 'WRITING', pct: 65, concepts: effectiveConceptCount, currentStage: 'Writing structured vault', currentDetail: '', currentFocus: '', currentQuality: '' });
  tui.log(`[SCAN] Extracted ${effectiveConceptCount} concept${effectiveConceptCount !== 1 ? 's' : ''}, ${totalSnippets} snippet${totalSnippets !== 1 ? 's' : ''}`);

  print('');

  // ── Phase 4: Write vault (65–85%) ──────────────────────────────────────
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
        // Update file count regularly so TUI stays responsive — scale pct within 65–85%
        if (stats.written % 50 === 0) {
          const writePct = 65 + Math.min(20, Math.floor(stats.written / 250));
          tui.update({ files: stats.written, pct: writePct });
        }
      },
    });
  } catch (err) {
    die(`Write error: ${err.message}`);
  }

  tui.update({ phase: 'LINKING', pct: 85, files: writeStats.written, currentStage: 'Linking extracted concepts', currentDetail: '', currentFocus: '', currentQuality: '' });
  tui.log(`[WRITE] Vault written — ${writeStats.written} file${writeStats.written !== 1 ? 's' : ''}`);

  print('');

  // ── Phase 5: Build wikilinks (85–98%) ──────────────────────────────────
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
          // Scale link progress within 85–98%
          const linkPct = 85 + Math.min(13, Math.floor(currentLinkCount / 10));
          tui.update({ links: currentLinkCount, pct: linkPct });
        },
      });
    } catch (err) {
      if (opts.verbose) print(`  [WARN] Linker error: ${err.message}`);
    }
  }

  tui.update({ phase: 'LINKING', pct: 98, links: linkStats.linksCreated, currentStage: 'Link graph stabilized', currentDetail: '', currentFocus: '', currentQuality: '' });

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
  const topConceptsList = conceptSummaries
    .slice(0, 10)
    .map((concept) => concept.name);

  const manifest = {
    version:         '1.0',
    generated:       new Date().toISOString(),
    sources:         scanResults,
    stats: {
      sessions:     dedupedSessions.length,
      concepts:     effectiveConceptCount,
      snippets:     totalSnippets,
      urls:         totalUrls,
      decisions:    totalDecisions,
      issues:       totalIssues,
      actionItems:  totalActions,
      commits:      totalCommits,
      links:        linkStats.linksCreated,
      filesWritten: writeStats.written,
      weakSessions: extractionHealth.weakSessionCount,
    },
    sessions:        sessionSummaries,
    concepts:        conceptSummaries,
    observability:   buildObservabilitySummary(enriched, extractionHealth),
    topConcepts:     topConceptsList,
    vault:           opts.output,
    output:          opts.output,
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

  // ── Final summary (100%) ───────────────────────────────────────────────

  // Top promoted concepts for the completion screen
  const topPromoted = conceptSummaries
    .slice(0, 5)
    .map((concept) => concept.name);

  tui.update({
    phase: 'COMPLETE', pct: 100,
    links: linkStats.linksCreated,
    promoted:    writeStats.promoted    || 0,
    lowSignal:   writeStats.lowSignalCount || 0,
    topConcepts: topPromoted,
    currentStage: 'Vault complete',
    currentDetail: '',
    currentFocus: '',
    currentQuality: '',
  });

  // Inject summary lines into Activity log before the sign-off
  tui.log(`[DONE] ${dedupedSessions.length} sessions → ${writeStats.written} files (${elapsedDisplay()})`);
  tui.log(`[DONE] Tiers: ▲${tierCounts.HIGH} high  ●${tierCounts.MEDIUM} medium  ·${tierCounts.LOW} low`);
  tui.log(`[DONE] Concepts: ${writeStats.promoted || 0} promoted, ${writeStats.lowSignalCount || 0} low-signal`);
  if (topPromoted.length > 0) {
    tui.log(`[DONE] Top: ${topPromoted.join(' · ')}`);
  }
  tui.log('It is now safe to turn off your computer.');

  print('Complete!');
  printStat('Sessions processed', dedupedSessions.length);
  printStat('Session tiers',      `▲${tierCounts.HIGH} ●${tierCounts.MEDIUM} ·${tierCounts.LOW}`);
  printStat('Concepts extracted', effectiveConceptCount);
  printStat('Concepts promoted',  writeStats.promoted || 0);
  printStat('Low-signal terms',   writeStats.lowSignalCount || 0);
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

  // Close the log file stream if one was opened
  if (logStream) {
    logStream.end();
  }
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
    logFile:   null,
    noTui:     false,
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

      case '--log-file':
      case '--logfile':
        opts.logFile = argv[++i];
        break;

      case '--no-tui':
      case '--notui':
        opts.noTui = true;
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

  // Resolve log file path if supplied
  if (opts.logFile) {
    opts.logFile = path.resolve(opts.logFile);
  }

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

function buildSessionSummaries(enriched) {
  return enriched.map(({ session, extracted }) => ({
    id: session.id,
    title: session.title,
    source: session.source,
    date: isoDate(session.timestamp),
    timestamp: session.timestamp.toISOString(),
    turnCount: session.turnCount,
    tier: session._sessionTier || 'LOW',
    signal: Math.round((session._sessionScore || 0) * 10) / 10,
    conceptCount: extracted.concepts?.length || 0,
    decisionCount: extracted.decisions?.length || 0,
    issueCount: extracted.issues?.length || 0,
    actionItemCount: extracted.actionItems?.length || 0,
    commitCount: extracted.commits?.length || 0,
    snippetCount: extracted.snippets?.length || 0,
    workspace: session.workspace || session.workspaceName || null,
    workspacePath: session.workspacePath || null,
    format: session.format || session.cursorFormat || null,
    topConcepts: (extracted.concepts || []).slice(0, 5),
    weakSignals: extracted.observability?.weakSignals || [],
    continuity: extracted.continuity || null,
  }));
}

function buildConceptSummaries(enriched) {
  const conceptMap = new Map();

  for (const { session, extracted } of enriched) {
    const conceptObjects = Array.isArray(extracted.conceptObjects) && extracted.conceptObjects.length > 0
      ? extracted.conceptObjects
      : (extracted.concepts || []).map((name) => ({ key: name.toLowerCase(), name, kind: 'topic', aliases: [], sourceTypes: [], files: [], tools: [], workspaces: [], relatedConcepts: [] }));

    for (const concept of conceptObjects) {
      const key = concept.key || concept.name.toLowerCase();
      let summary = conceptMap.get(key);
      if (!summary) {
        summary = {
          key,
          name: concept.name,
          kind: concept.kind || 'topic',
          aliases: new Set(),
          sources: new Set(),
          sessions: new Set(),
          files: new Set(),
          tools: new Set(),
          workspaces: new Set(),
          related: new Map(),
          decisionCount: 0,
          issueCount: 0,
          actionItemCount: 0,
          commitCount: 0,
          mentionCount: 0,
          scoreHint: 0,
        };
        conceptMap.set(key, summary);
      }

      summary.name = concept.name || summary.name;
      summary.kind = concept.kind || summary.kind;
      summary.sources.add(session.source);
      summary.sessions.add(session.id);
      summary.mentionCount += concept.mentionCount || 1;
      summary.scoreHint += concept.score || 0;
      summary.decisionCount += concept.decisionCount || 0;
      summary.issueCount += concept.issueCount || 0;
      summary.actionItemCount += concept.actionItemCount || 0;
      summary.commitCount += concept.commitCount || 0;
      for (const alias of (concept.aliases || [])) summary.aliases.add(alias);
      for (const file of (concept.files || [])) summary.files.add(file);
      for (const tool of (concept.tools || [])) summary.tools.add(tool);
      for (const workspace of (concept.workspaces || [])) summary.workspaces.add(workspace);
      for (const rel of (concept.relatedConcepts || [])) {
        if (!rel || !rel.key) continue;
        summary.related.set(rel.key, (summary.related.get(rel.key) || 0) + (rel.count || 1));
      }
    }
  }

  const summaries = [...conceptMap.values()].map((summary) => {
    const signal = computeSignalScore(summary.name, enriched, enriched);
    return {
      key: summary.key,
      name: summary.name,
      kind: summary.kind,
      signal: Math.round(signal * 10) / 10,
      sessionCount: summary.sessions.size,
      decisionCount: summary.decisionCount,
      issueCount: summary.issueCount,
      actionItemCount: summary.actionItemCount,
      commitCount: summary.commitCount,
      mentionCount: summary.mentionCount,
      aliases: [...summary.aliases].slice(0, 8),
      sources: [...summary.sources],
      files: [...summary.files].slice(0, 8),
      tools: [...summary.tools].slice(0, 8),
      workspaces: [...summary.workspaces].slice(0, 8),
      relatedConcepts: [...summary.related.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([key, count]) => ({ key, count })),
    };
  });

  return summaries.sort((a, b) =>
    b.signal - a.signal ||
    b.sessionCount - a.sessionCount ||
    a.name.localeCompare(b.name)
  );
}

function buildObservabilitySummary(enriched, extractionHealth) {
  const sessionSummaries = buildSessionSummaries(enriched);
  const topSignalSessions = [...sessionSummaries]
    .sort((a, b) => b.signal - a.signal)
    .slice(0, 12);

  return {
    extractionHealth: {
      weakSessionCount: extractionHealth.weakSessionCount,
      metadataOnlyCursorSessions: extractionHealth.metadataOnlyCursorSessions,
      truncatedSessions: extractionHealth.truncatedSessions,
      sourceStats: extractionHealth.sourceStats,
      weakSessions: extractionHealth.weakSessions,
    },
    continuity: extractionHealth.continuity,
    topSignalSessions,
  };
}

function summarizeContinuityState(continuity) {
  if (!continuity) return '';
  const parts = [];
  if (continuity.resumed) parts.push('resumed');
  if (continuity.pivoted) parts.push('pivoted');
  if (continuity.blocked) parts.push('blocked');
  if (continuity.unfinished && !continuity.blocked) parts.push('unfinished');
  if (continuity.openLoops?.length) parts.push(`${continuity.openLoops.length} open loop${continuity.openLoops.length !== 1 ? 's' : ''}`);
  return parts.join(' · ');
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
                        Score favors recurring, decision-heavy, issue-rich concepts with
                        code/context evidence across sessions and workspaces.
  --log-file <path>     Append all activity log entries to a plain-text file
  --no-tui              Disable the full-screen TUI; use plain console output instead.
                        Useful for CI, piping to a file, or debugging.
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
  npx context-defrag --log-file defrag.log --verbose

SOURCES
  claude   ~/.claude/projects/  (JSONL conversation files — Desktop & Code)
  codex    ~/.codex/            (OpenAI Codex CLI history)
  cursor   ~/Library/Application Support/Cursor/  (SQLite chat history)

SIGNAL SCORING
  Each concept earns signal points based on how it appears across sessions:
    sessions   ×2  — number of sessions the concept appeared in
    decisions  ×5  — decision sentences that explicitly mention it
    issues     ×4  — bugs/problems explicitly tied to the concept
    actions    ×4  — follow-ups and next steps anchored to the concept
    commits    ×3  — commit/PR/change signals mentioning the concept
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

function elapsedDisplay() {
  // Note: tui tracks startTime internally; we approximate from process uptime
  const sec = Math.floor(process.uptime());
  const min = Math.floor(sec / 60);
  const s   = sec % 60;
  return min > 0 ? `${min}m ${s}s` : `${s}s`;
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
