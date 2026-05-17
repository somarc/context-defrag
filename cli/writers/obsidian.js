/**
 * obsidian.js — Writes an Obsidian markdown vault from extracted session data
 *
 * Output structure:
 *   vault/
 *     _index.md           — root Map of Content
 *     _timeline.md        — chronological session list
 *     _low-signal.md      — terms below the signal threshold (alphabetical index)
 *     concepts/           — one note per concept (signal >= threshold)
 *     sessions/           — one note per source session
 *     code/               — extracted code snippets
 *     links.md            — all URLs grouped by domain
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  computeSignalScore,
  classifyDecisionPattern,
  computeDecisionPatternDiversity,
  computeRecencyBonus,
  extractConceptDecisions,
  extractConceptExcerpts,
  extractSessionNarrative,
} = require('../extractor');

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_SIGNAL_THRESHOLD = 8;

// ── Main write function ──────────────────────────────────────────────────────
/**
 * @param {Object}  opts
 * @param {string}  opts.outputDir        - Root vault directory
 * @param {Array}   opts.sessions         - Array of { session, extracted } objects
 * @param {Array}   [opts.allSessions]    - Full session list (for recency scoring); falls back to sessions
 * @param {boolean} opts.dryRun           - If true, log what would be written
 * @param {boolean} opts.verbose
 * @param {number}  [opts.signalThreshold] - Minimum signal score for a standalone concept note (default: 8)
 * @param {Map}     [opts.signalIndex]    - Pre-built signal index from buildSignalIndex() (fast path)
 * @returns {Promise<{ written: number, skipped: number }>}
 */
async function write({ outputDir, sessions, allSessions, dryRun, verbose, signalThreshold, onProgress, signalIndex, debug }) {
  const stats        = { written: 0, skipped: 0, promoted: 0, lowSignalCount: 0 };
  const threshold    = (typeof signalThreshold === 'number' && isFinite(signalThreshold))
    ? signalThreshold
    : DEFAULT_SIGNAL_THRESHOLD;
  // allSessions: the full enriched list used for cross-session recency scoring.
  // Falls back to the sessions array itself for backward compatibility.
  const fullSessions = Array.isArray(allSessions) ? allSessions : sessions;

  // Fresh vault detection — if sessions/ dir doesn't exist yet, skip idempotency
  // reads entirely (no files to compare against). This eliminates the 380×
  // synchronous readFileSync calls that blocked the event loop on re-runs.
  const sessionsDir = path.join(outputDir, 'sessions');
  const isFreshVault = !fs.existsSync(sessionsDir);
  const skipIdempotency = isFreshVault;
  if (onProgress) {
    onProgress(isFreshVault
      ? '[WRITE] Fresh vault — skipping idempotency reads'
      : '[WRITE] Re-run detected — idempotency checks active (user edits preserved)', stats);
  }

  if (!dryRun) {
    ensureDir(outputDir);
    ensureDir(path.join(outputDir, 'concepts'));
    ensureDir(sessionsDir);
    ensureDir(path.join(outputDir, 'code'));
  }

  // ── 1. Session notes ─────────────────────────────────────────────────────
  for (let si = 0; si < sessions.length; si++) {
    const { session, extracted } = sessions[si];

    // Yield every 25 sessions — same pattern as concept loop
    if (si > 0 && si % 25 === 0) {
      await new Promise(r => setImmediate(r));
    }

    const t0 = debug ? Date.now() : 0;
    const fileName = sessionFileName(session);
    const filePath = path.join(outputDir, 'sessions', fileName);
    const content  = renderSessionNote(session, extracted);
    writeNote(filePath, content, { dryRun, verbose, stats, skipIdempotency });

    if (debug) {
      const ms = Date.now() - t0;
      if (ms > 50) {
        // Slow session — log it
        if (onProgress) onProgress(`[DEBUG] slow session render: ${ms}ms — ${path.basename(filePath)}`, stats);
      }
    }

    if (onProgress) onProgress(path.relative(outputDir, filePath), stats);
  }

  // ── 2. Concept notes (tiered) ─────────────────────────────────────────────
  // Build concept → sessions map
  const conceptMap = buildConceptMap(sessions);

  // Separate concepts into high-signal (standalone notes) and low-signal (index)
  const lowSignalConcepts = [];  // { concept, sessionCount }

  let conceptIdx = 0;
  for (const [concept, mentionedIn] of conceptMap.entries()) {
    conceptIdx++;
    // Yield to the event loop every 25 concepts so TUI timer/spinner can fire
    if (conceptIdx % 25 === 0) {
      await new Promise(r => setImmediate(r));
    }

    const key = concept.toLowerCase().trim();
    // Use pre-built signal index if available (fast path), else compute on demand (legacy path)
    const prebuilt = signalIndex?.get(key);
    const score = prebuilt ? prebuilt.score : computeSignalScore(concept, sessions, fullSessions);

    if (score >= threshold) {
      const fileName = slugify(concept) + '.md';
      const filePath = path.join(outputDir, 'concepts', fileName);
      const t0 = debug ? Date.now() : 0;
      const content  = renderConceptNote(concept, mentionedIn, sessions, score, fullSessions, prebuilt);
      writeNote(filePath, content, { dryRun, verbose, stats, skipIdempotency });
      if (debug) {
        const ms = Date.now() - t0;
        if (ms > 30) {
          if (onProgress) onProgress(`[DEBUG] slow concept render: ${ms}ms — ${concept}`, stats);
        }
      }
      stats.promoted++;
    } else {
      lowSignalConcepts.push({ concept, sessionCount: mentionedIn.length });
      stats.lowSignalCount++;
    }
  }

  // ── 3. _low-signal.md ────────────────────────────────────────────────────
  const lowSignalContent = renderLowSignalNote(lowSignalConcepts);
  writeNote(path.join(outputDir, '_low-signal.md'), lowSignalContent, { dryRun, verbose, stats, skipIdempotency });

  // ── 4. Code snippet notes ────────────────────────────────────────────────
  let snippetIndex = 1;
  for (const { session, extracted } of sessions) {
    for (const snippet of extracted.snippets) {
      snippet._globalIndex = snippetIndex;
      const paddedIdx = String(snippetIndex).padStart(3, '0');
      const fileName  = `snippet-${paddedIdx}.md`;
      const filePath  = path.join(outputDir, 'code', fileName);
      const content   = renderSnippetNote(snippet, snippetIndex, session);
      writeNote(filePath, content, { dryRun, verbose, stats, skipIdempotency });
      snippetIndex++;
    }
  }

  // ── 5. Links index ───────────────────────────────────────────────────────
  const allUrls = sessions.flatMap(({ session, extracted }) =>
    extracted.urls.map((url) => ({ url, session }))
  );
  const linksContent = renderLinksNote(allUrls);
  writeNote(path.join(outputDir, 'links.md'), linksContent, { dryRun, verbose, stats, skipIdempotency });

  // ── 6. Timeline ──────────────────────────────────────────────────────────
  const timelineContent = renderTimeline(sessions);
  writeNote(path.join(outputDir, '_timeline.md'), timelineContent, { dryRun, verbose, stats, skipIdempotency });

  // ── 7. Root index ────────────────────────────────────────────────────────
  const indexContent = renderIndex(sessions, conceptMap);
  writeNote(path.join(outputDir, '_index.md'), indexContent, { dryRun, verbose, stats, skipIdempotency });

  return stats;
}

// ── Note renderers ────────────────────────────────────────────────────────────

function getConceptNames(extracted, limit = Infinity) {
  const names = Array.isArray(extracted?.conceptObjects) && extracted.conceptObjects.length > 0
    ? extracted.conceptObjects.map((concept) => concept.name)
    : (extracted?.concepts || []);
  return names.slice(0, limit);
}

function getStructuredItems(items, fallback = []) {
  if (Array.isArray(items) && items.length > 0) return items;
  return fallback.map((text) => ({ text }));
}

function renderStructuredList(items, emptyText) {
  const source = getStructuredItems(items);
  if (!source.length) return emptyText;
  return source
    .slice(0, 10)
    .map((item) => `- ${item.text || item}`)
    .join('\n');
}

function renderContinuitySection(continuity) {
  if (!continuity) return '_No continuity data captured_';
  const lines = [
    `- Status: \`${continuity.status}\``,
    `- Phase: \`${continuity.phase}\``,
  ];
  if (continuity.resumed) lines.push('- Resumed prior thread');
  if (continuity.pivoted) lines.push('- Scope or approach pivot detected');
  if (continuity.blocked) lines.push('- Blocked state detected');
  if (continuity.unfinished) lines.push('- Unfinished work remains');
  if (continuity.primaryThread) lines.push(`- Primary thread: \`${continuity.primaryThread}\``);
  if (Array.isArray(continuity.activeThreads) && continuity.activeThreads.length > 0) {
    lines.push(`- Active threads: ${continuity.activeThreads.map((name) => `\`${name}\``).join(', ')}`);
  }
  if (Array.isArray(continuity.openLoops) && continuity.openLoops.length > 0) {
    lines.push(`- Open loops: ${continuity.openLoops.length}`);
  }
  return lines.join('\n');
}

function conceptRegex(concept) {
  const raw = String(concept || '');
  const escaped = escapeRegex(raw.toLowerCase());
  return /[.+#/\- ]/.test(raw)
    ? new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'i')
    : new RegExp(`\\b${escaped}\\b`, 'i');
}

function findConceptRecord(extracted, concept) {
  const key = String(concept || '').toLowerCase();
  const conceptObjects = Array.isArray(extracted?.conceptObjects) ? extracted.conceptObjects : [];
  return conceptObjects.find((item) =>
    item.key === key ||
    item.name.toLowerCase() === key ||
    (item.aliases || []).some((alias) => String(alias).toLowerCase() === key)
  ) || null;
}

function aggregateConceptRecord(concept, sessionEntries) {
  const files = new Set();
  const tools = new Set();
  const workspaces = new Set();
  const aliases = new Set();
  const sourceTypes = new Set();
  const related = new Map();
  let record = null;

  for (const entry of sessionEntries) {
    const conceptRecord = findConceptRecord(entry.extracted, concept);
    if (!conceptRecord) continue;
    record = record || conceptRecord;
    for (const alias of (conceptRecord.aliases || [])) aliases.add(alias);
    for (const file of (conceptRecord.files || [])) files.add(file);
    for (const tool of (conceptRecord.tools || [])) tools.add(tool);
    for (const workspace of (conceptRecord.workspaces || [])) workspaces.add(workspace);
    for (const type of (conceptRecord.sourceTypes || [])) sourceTypes.add(type);
    for (const rel of (conceptRecord.relatedConcepts || [])) {
      if (!rel || !rel.key || rel.key === concept.toLowerCase()) continue;
      related.set(rel.key, (related.get(rel.key) || 0) + (rel.count || 1));
    }
  }

  return {
    kind: record?.kind || 'topic',
    aliases: [...aliases].slice(0, 8),
    files: [...files].slice(0, 12),
    tools: [...tools].slice(0, 12),
    workspaces: [...workspaces].slice(0, 8),
    sourceTypes: [...sourceTypes].slice(0, 8),
    related: [...related.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key]) => key),
  };
}

/**
 * Render a session note with content depth determined by session signal tier.
 *
 *   HIGH   (≥12): Full — narrative + decisions + concepts + code + URLs + Codex context
 *   MEDIUM (5–11): Focused — narrative + decisions + concepts (skip code/URL/entity detail)
 *   LOW    (<5):  Minimal — title, date, source, top 3 concepts inline (~10 lines)
 *
 * Codex sessions carry extra fields: skillsUsed, toolCalls, filesTouched,
 * automations, taskOutcome, cwd, model, originator.
 */
function renderSessionNote(session, extracted) {
  const date      = isoDate(session.timestamp);
  const isoFull   = session.timestamp.toISOString();
  const sourceTag = session.source;
  const tier      = session._sessionTier  || 'HIGH';
  const sessScore = session._sessionScore || 0;
  const topConceptNames = getConceptNames(extracted, 12);
  const decisionItems = getStructuredItems(extracted.decisionItems, extracted.decisions || []);
  const issueItems    = getStructuredItems(extracted.issues || []);
  const actionItems   = getStructuredItems(extracted.actionItems || []);
  const commitItems   = getStructuredItems(extracted.commits || []);
  const continuity    = extracted.continuity || null;

  // ── Frontmatter extras (shared across all tiers) ──────────────────────────
  const fmExtras = [];
  fmExtras.push(`session-signal: ${Math.round(sessScore * 10) / 10}`);
  fmExtras.push(`tier: ${tier.toLowerCase()}`);
  if (session.model)      fmExtras.push(`model: ${session.model}`);
  if (session.originator) fmExtras.push(`originator: ${session.originator}`);
  if (session.workspace)  fmExtras.push(`workspace: ${session.workspace}`);
  if (session.skillsUsed && session.skillsUsed.length > 0) {
    fmExtras.push(`skills: [${session.skillsUsed.join(', ')}]`);
  }
  if (session.workspacePath) fmExtras.push(`workspace-path: "${escYaml(session.workspacePath)}"`);
  if (session.cursorFormat)  fmExtras.push(`cursor-format: ${session.cursorFormat}`);
  if (session.taskOutcome) fmExtras.push(`task-outcome: ${session.taskOutcome}`);
  if (continuity?.status) fmExtras.push(`continuity-status: ${continuity.status}`);
  if (continuity?.phase) fmExtras.push(`continuity-phase: ${continuity.phase}`);
  if (continuity?.resumed) fmExtras.push('resumed: true');
  if (continuity?.blocked) fmExtras.push('blocked: true');
  if (continuity?.unfinished) fmExtras.push('unfinished: true');
  fmExtras.push(`issues: ${issueItems.length}`);
  fmExtras.push(`actions: ${actionItems.length}`);
  fmExtras.push(`commits: ${commitItems.length}`);
  const fmExtrasStr = fmExtras.length ? '\n' + fmExtras.join('\n') : '';

  // ── LOW tier: minimal note (~10 lines) ────────────────────────────────────
  if (tier === 'LOW') {
    const topConcepts = topConceptNames.slice(0, 3).map((c) =>
      `[[concepts/${slugify(c)}|${c}]]`
    ).join(' · ') || '_None_';

    return `---
title: "${escYaml(session.title)}"
source: ${sourceTag}
date: ${isoFull}
turns: ${session.turnCount}
concepts: ${topConceptNames.length}
tags: [session, ${sourceTag}, low-signal]${fmExtrasStr}
---

# ${session.title}

> **${sourceTag}** | ${date} | ${session.turnCount} turns

${topConcepts}

<!-- defrag:end -->
`;
  }

  // ── MEDIUM + HIGH: compute shared sections ────────────────────────────────

  // Summary narrative — only for MEDIUM+ (skipped for LOW above, saving compute)
  const narrative = extractSessionNarrative(session, extracted);
  const summarySection = narrative
    ? `## Summary\n${narrative}\n`
    : '';

  // Key Decisions
  const decisionsSection = renderStructuredList(decisionItems, '_None detected_');
  const issuesSection    = renderStructuredList(issueItems, '_None detected_');
  const actionsSection   = renderStructuredList(actionItems, '_None detected_');
  const commitsSection   = renderStructuredList(commitItems, '_None detected_');
  const continuitySection = renderContinuitySection(continuity);

  // Top Concepts — inline pill style
  const topConceptLinks = topConceptNames.slice(0, 12).map((c) =>
    `[[concepts/${slugify(c)}|${c}]]`
  ).join(' · ') || '_None extracted_';

  // ── Signal score for this session ────────────────────────────────────────
  const sessionSignal = Math.round(sessScore * 10) / 10;

  let sourceContextSection = '';
  if (session.source === 'codex') {
    const parts = [];

    if (session.skillsUsed && session.skillsUsed.length > 0) {
      const skillLinks = session.skillsUsed
        .map(s => `[[concepts/${slugify(s)}|${s}]]`)
        .join(' · ');
      parts.push(`### Skills Invoked\n${skillLinks}`);
    }

    if (session.toolCalls && session.toolCalls.length > 0) {
      const uniqueTools = [...new Set(session.toolCalls.map(t => t.tool))];
      const toolLines = uniqueTools.map(tool => {
        const count = session.toolCalls.filter(t => t.tool === tool).length;
        return `- \`${tool}\`${count > 1 ? ` (×${count})` : ''}`;
      }).join('\n');
      parts.push(`### Tools Called\n${toolLines}`);
    }

    if (session.filesTouched && session.filesTouched.length > 0) {
      const fileLines = session.filesTouched
        .slice(0, 20)
        .map(f => `- \`${f}\``)
        .join('\n');
      parts.push(`### Files Touched\n${fileLines}`);
    }

    if (session.automations && session.automations.length > 0) {
      const autoLines = session.automations.map(a => {
        const attrs = Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(' ');
        return `- \`::automation-update{${attrs}}\``;
      }).join('\n');
      parts.push(`### Automation Directives\n${autoLines}`);
    }

    if (session.taskOutcome) {
      const icon = session.taskOutcome === 'complete' ? '✓' : '↻';
      parts.push(`### Task Outcome\n${icon} ${session.taskOutcome}`);
    }

    if (session.cwd) {
      parts.push(`### Project\n\`${session.cwd}\``);
    }

    if (parts.length > 0) {
      sourceContextSection = `\n## Codex Context\n${parts.join('\n\n')}\n`;
    }
  }

  if (session.source === 'cursor') {
    const parts = [];
    if (session.workspacePath || session.workspace) {
      parts.push(`### Workspace\n\`${session.workspacePath || session.workspace}\``);
    }
    if (session.cursorFormat) {
      parts.push(`### Cursor Storage\n- Format: \`${session.cursorFormat}\`\n- Key: \`${session.cursorChatKey || 'unknown'}\``);
    }
    if (session.cursorMetaOnly) {
      parts.push('### Coverage\n- Metadata-only Cursor session; body transcript was not recoverable from storage.');
    }
    if (session.cursorMeta) {
      const metaLines = [];
      if (session.cursorMeta.unifiedMode) metaLines.push(`- Mode: \`${session.cursorMeta.unifiedMode}\``);
      if (session.cursorMeta.forceMode) metaLines.push(`- Force mode: \`${session.cursorMeta.forceMode}\``);
      if (Number.isFinite(session.cursorMeta.contextUsagePercent)) metaLines.push(`- Context usage: ${session.cursorMeta.contextUsagePercent}%`);
      if (session.cursorMeta.isWorktree) metaLines.push('- Worktree session');
      if (session.cursorMeta.isSpec) metaLines.push('- Spec session');
      if (session.cursorMeta.hasBlockingPendingActions) metaLines.push('- Blocking actions pending');
      if (metaLines.length > 0) parts.push(`### Composer Metadata\n${metaLines.join('\n')}`);
    }
    if ((extracted.files || []).length > 0) {
      parts.push(`### Files Mentioned\n${extracted.files.slice(0, 15).map((file) => `- \`${file}\``).join('\n')}`);
    }
    if ((extracted.tools || []).length > 0) {
      parts.push(`### Tools Mentioned\n${extracted.tools.slice(0, 15).map((tool) => `- \`${tool}\``).join('\n')}`);
    }
    if (parts.length > 0) {
      sourceContextSection = `\n## Cursor Context\n${parts.join('\n\n')}\n`;
    }
  }

  // ── MEDIUM tier: focused note ─────────────────────────────────────────────
  if (tier === 'MEDIUM') {
    return `---
title: "${escYaml(session.title)}"
source: ${sourceTag}
date: ${isoFull}
turns: ${session.turnCount}
signal: ${sessionSignal}
concepts: ${topConceptNames.length}
tags: [session, ${sourceTag}]${fmExtrasStr}
---

# ${session.title}

> Source: **${sourceTag}** | ${date} | ${session.turnCount} turns

${summarySection}
## Key Decisions
${decisionsSection}

## Key Issues
${issuesSection}

## Action Items
${actionsSection}

## Session Continuity
${continuitySection}

## Top Concepts
${topConceptLinks}

<!-- defrag:end -->
`;
  }

  // ── HIGH tier: full treatment ─────────────────────────────────────────────

  // Code snippets
  const snippetLinks = extracted.snippets.length
    ? extracted.snippets.map((s, i) => {
        const paddedIdx = String(s._globalIndex || (i + 1)).padStart(3, '0');
        const label     = deriveSnippetLabel(s.code);
        return `- [[code/snippet-${paddedIdx}]] — ${s.lang || 'text'}${label ? ` — ${label}` : ''}`;
      }).join('\n')
    : '_None_';

  // URLs
  const urlSection = extracted.urls.length
    ? extracted.urls.slice(0, 20).map((u) => `- ${u}`).join('\n')
    : '_None_';

  // Technologies Mentioned
  const entitySection = extracted.entities.length
    ? extracted.entities.slice(0, 15).join(', ')
    : '_None detected_';

  return `---
title: "${escYaml(session.title)}"
source: ${sourceTag}
date: ${isoFull}
turns: ${session.turnCount}
signal: ${sessionSignal}
concepts: ${topConceptNames.length}
tags: [session, ${sourceTag}]${fmExtrasStr}
---

# ${session.title}

> Source: **${sourceTag}** | ${date} | ${session.turnCount} turns

${summarySection}
## Key Decisions
${decisionsSection}

## Key Issues
${issuesSection}

## Action Items
${actionsSection}

## Session Continuity
${continuitySection}

## Change Signals
${commitsSection}

## Top Concepts
${topConceptLinks}
${sourceContextSection}
## Code Snippets
${snippetLinks}

## URLs Referenced
${urlSection}

## Technologies Mentioned
${entitySection}

<!-- defrag:end -->
`;
}

/**
 * Render an upgraded concept note with signal score, Key Decisions,
 * Context & Excerpts, Code Context, and sorted session list.
 *
 * @param {string}  concept           - Concept key (lowercase / canonical)
 * @param {Array}   mentionedIn       - Array of session IDs that mention this concept
 * @param {Array}   allSessions       - Array of { session, extracted } for sessions mentioning this concept
 * @param {number}  signalScore       - Pre-computed signal score
 * @param {Array}   [allSessionsFull] - Full session list (for recency bonus); falls back to allSessions
 * @param {Object}  [prebuilt]        - Pre-built signal record from buildSignalIndex (optional fast path)
 */
function renderConceptNote(concept, mentionedIn, allSessions, signalScore, allSessionsFull, prebuilt) {
  const score           = (typeof signalScore === 'number') ? signalScore : 0;
  const fullSessions    = Array.isArray(allSessionsFull) ? allSessionsFull : allSessions;

  // ── Gather sessions in scope ──────────────────────────────────────────────
  // NEW: use pre-built sessionItems if available (already filtered to concept's sessions)
  const sessionEntries = prebuilt?.sessionItems
    ? [...prebuilt.sessionItems].sort((a, b) => b.session.timestamp - a.session.timestamp)
    : mentionedIn
        .map((sessionId) => allSessions.find(({ session }) => session.id === sessionId))
        .filter(Boolean)
        .sort((a, b) => b.session.timestamp - a.session.timestamp);

  const firstEntry = sessionEntries[sessionEntries.length - 1]; // oldest
  const lastEntry  = sessionEntries[0];                         // newest

  const firstDate  = firstEntry ? isoDate(firstEntry.session.timestamp) : '';
  const lastDate   = lastEntry  ? isoDate(lastEntry.session.timestamp)  : '';

  // Source tags — unique sources across all mentioning sessions
  const sources = [...new Set(sessionEntries.map(({ session }) => session.source))];

  const displayName = titleCase(concept);
  const conceptMeta = aggregateConceptRecord(concept, sessionEntries);

  // ── New signal enhancement fields ─────────────────────────────────────────

  // Recency bonus (uses full session list for p75 calculation)
  const recencyBoost = computeRecencyBonus(concept, sessionEntries, fullSessions);
  const recentlyActive = recencyBoost > 0;

  // Decision pattern diversity
  const re = conceptRegex(concept);
  const foundPatternTypes = new Set();
  for (const item of sessionEntries) {
    if (!item || !item.extracted) continue;
    for (const decision of getStructuredItems(item.extracted.decisionItems, item.extracted.decisions || [])) {
      const text = decision.text || decision;
      if (!re.test(text)) continue;
      const type = classifyDecisionPattern(text);
      if (type) foundPatternTypes.add(type);
    }
  }
  const decisionPatternDiversity = foundPatternTypes.size;
  const patternList = [...foundPatternTypes]; // e.g. ['CHOICE', 'AVOIDANCE']

  // ── YAML frontmatter ─────────────────────────────────────────────────────
  const tagList = ['concept', ...sources].join(', ');

  // ── Key Decisions ─────────────────────────────────────────────────────────
  // NEW: use pre-computed decisions if available; fall back to full scan for legacy callers
  const conceptDecisions = prebuilt?.decisions ?? extractConceptDecisions(concept, allSessions);
  let decisionsSection = '';
  if (conceptDecisions.length > 0) {
    decisionsSection = conceptDecisions
      .slice(0, 10)
      .map((d) => {
        const detail = d.sessionDate
          ? `${d.sessionDate}, [[sessions/${d.sessionSlug}|${escYaml(d.sessionTitle)}]]`
          : `[[sessions/${d.sessionSlug}|${escYaml(d.sessionTitle)}]]`;
        return `- ${d.sentence} (${detail})`;
      })
      .join('\n');
  }

  // ── Context & Excerpts ────────────────────────────────────────────────────
  // NEW: use pre-computed excerpts if available; fall back to full scan for legacy callers
  const excerpts = prebuilt?.excerpts ?? extractConceptExcerpts(concept, allSessions, 5);
  let excerptsSection = '';
  if (excerpts.length > 0) {
    excerptsSection = excerpts
      .map((e) =>
        `> "${e.text}"\n> — [[sessions/${e.sessionSlug}|${escYaml(e.sessionTitle)}]], ${e.sessionDate}`
      )
      .join('\n\n');
  }

  // ── Code Context — snippets whose code body mentions this concept ─────────
  const codeEntries = [];
  for (const { session, extracted } of allSessions) {
    if (!mentionedIn.includes(session.id)) continue;
    const codeRe = conceptRegex(concept);
    for (const snippet of (extracted.snippets || [])) {
      if (snippet && snippet.code && codeRe.test(snippet.code)) {
        const paddedIdx = String(snippet._globalIndex || (snippet.index + 1)).padStart(3, '0');
        const label     = deriveSnippetLabel(snippet.code);
        codeEntries.push(`- [[code/snippet-${paddedIdx}]] — ${snippet.lang || 'text'}${label ? ` — ${label}` : ''}`);
      }
    }
  }
  let codeSection = '';
  if (codeEntries.length > 0) {
    codeSection = codeEntries.slice(0, 10).join('\n');
  }

  // ── Related concepts ─────────────────────────────────────────────────────
  // NEW: scope related-concept scan to sessions where this concept appears
  const conceptSessions = prebuilt?.sessionItems ?? allSessions;
  const related = [...new Set([
    ...conceptMeta.related,
    ...findRelatedConcepts(concept, mentionedIn, conceptSessions),
  ])];
  const relatedLinks = related.slice(0, 8).map((c) =>
    `- [[concepts/${slugify(c)}|${c}]]`
  ).join('\n') || '_None_';

  // ── Sessions list (most recent first, capped at 20) ───────────────────────
  const sessionLines = sessionEntries
    .slice(0, 20)
    .map(({ session }) => {
      const slug = sessionFileName(session).replace('.md', '');
      const date = isoDate(session.timestamp);
      return `- [[sessions/${slug}|${escYaml(session.title)}]] — ${date}`;
    })
    .join('\n') || '_No sessions found_';

  // ── Signal breakdown comment ──────────────────────────────────────────────
  // Decompose the score back into its components for the breakdown string.
  // We recompute sessionCount/decisionCount/codeCount locally rather than
  // re-running computeSignalScore so we can surface the raw numbers cheaply.
  let _sessionCount  = 0;
  let _decisionCount = 0;
  let _codeCount     = 0;
  for (const item of sessionEntries) {
    if (!item || !item.extracted) continue;
    _sessionCount++;
    for (const d of getStructuredItems(item.extracted.decisionItems, item.extracted.decisions || [])) {
      const text = d.text || d;
      if (re.test(text)) _decisionCount++;
    }
    for (const snippet of (item.extracted.snippets || [])) {
      if (snippet && snippet.code && re.test(snippet.code)) _codeCount++;
    }
  }
  const signalBreakdown = `s:${_sessionCount} d:${_decisionCount} c:${_codeCount} p:${decisionPatternDiversity} r:${recencyBoost}`;

  // ── Skill provenance — check whether this concept is a known Codex skill ────
  // Collect all skill descriptions across sessions where this concept is a skill
  const skillDescriptions = [];
  const skillSessionSlugs = [];
  for (const entry of sessionEntries) {
    if (!entry || !entry.session) continue;
    const skills  = entry.session.skillsUsed      || [];
    const avail   = entry.session.skillsAvailable || [];
    const cLower  = concept.toLowerCase();
    if (skills.some(s => s.toLowerCase() === cLower)) {
      const slug = sessionFileName(entry.session).replace('.md', '');
      skillSessionSlugs.push(`[[sessions/${slug}|${isoDate(entry.session.timestamp)}]]`);
      // Find the description for this skill from skillsAvailable
      const def = avail.find(a => a.name && a.name.toLowerCase() === cLower);
      if (def && def.description && !skillDescriptions.includes(def.description)) {
        skillDescriptions.push(def.description);
      }
    }
  }
  const isSkill = skillDescriptions.length > 0 || skillSessionSlugs.length > 0;

  // ── Badge line (shown under H1 in promoted notes) ─────────────────────────
  let badgeParts = [];
  if (isSkill) {
    badgeParts.push('Codex Skill');
  }
  if (patternList.length > 0) {
    badgeParts.push(`Decision patterns: ${patternList.join(' · ')}`);
  }
  if (recentlyActive) {
    badgeParts.push('Recently active');
  }
  const badgeLine = badgeParts.length > 0
    ? `> ${badgeParts.join('  |  ')}\n`
    : '';

  // ── Assemble note ─────────────────────────────────────────────────────────
  const parts = [];

  // Build frontmatter lines, omitting empty optional fields cleanly
  const tagListWithSkill = isSkill
    ? tagList.replace('concept', 'concept, skill')
    : tagList;

  const fmLines = [
    `title: "${escYaml(displayName)}"`,
    `tags: [${tagListWithSkill}]`,
    `signal: ${score}`,
    `sessions: ${mentionedIn.length}`,
    `decisions: ${conceptDecisions.length}`,
    `kind: ${conceptMeta.kind}`,
    conceptMeta.aliases.length > 0
      ? `aliases: [${conceptMeta.aliases.map((alias) => `"${escYaml(alias)}"`).join(', ')}]`
      : '',
    firstDate ? `first-seen: ${firstDate}` : '',
    lastDate  ? `last-seen: ${lastDate}`   : '',
    `recently-active: ${recentlyActive}`,
    isSkill ? 'is-skill: true' : '',
    patternList.length > 0
      ? `decision-patterns: [${patternList.join(', ')}]`
      : 'decision-patterns: []',
    `signal-breakdown: "${signalBreakdown}"`,
  ].filter(Boolean).join('\n');

  parts.push(`---\n${fmLines}\n---\n\n# ${displayName}\n`);

  if (badgeLine) {
    parts.push(badgeLine);
  }

  if (isSkill) {
    const skillParts = [];
    if (skillDescriptions.length > 0) {
      skillParts.push(skillDescriptions.map(d => `> ${d}`).join('\n'));
    }
    if (skillSessionSlugs.length > 0) {
      const uniqueSlugs = [...new Set(skillSessionSlugs)];
      skillParts.push(`Invoked in: ${uniqueSlugs.join(', ')}`);
    }
    parts.push(`## Skill Definition\n${skillParts.join('\n\n')}\n`);
  }

  if (conceptMeta.aliases.length > 0 || conceptMeta.files.length > 0 || conceptMeta.tools.length > 0 || conceptMeta.workspaces.length > 0) {
    const hintParts = [];
    if (conceptMeta.aliases.length > 0) {
      hintParts.push(`- Aliases: ${conceptMeta.aliases.map((alias) => `\`${alias}\``).join(', ')}`);
    }
    if (conceptMeta.files.length > 0) {
      hintParts.push(`- Files: ${conceptMeta.files.slice(0, 8).map((file) => `\`${file}\``).join(', ')}`);
    }
    if (conceptMeta.tools.length > 0) {
      hintParts.push(`- Tools: ${conceptMeta.tools.slice(0, 8).map((tool) => `\`${tool}\``).join(', ')}`);
    }
    if (conceptMeta.workspaces.length > 0) {
      hintParts.push(`- Workspaces: ${conceptMeta.workspaces.map((workspace) => `\`${workspace}\``).join(', ')}`);
    }
    if (conceptMeta.sourceTypes.length > 0) {
      hintParts.push(`- Evidence: ${conceptMeta.sourceTypes.join(', ')}`);
    }
    parts.push(`## Link Hints\n${hintParts.join('\n')}\n`);
  }

  if (decisionsSection) {
    parts.push(`## Key Decisions\n${decisionsSection}\n`);
  }

  if (excerptsSection) {
    parts.push(`## Context & Excerpts\n${excerptsSection}\n`);
  }

  if (codeSection) {
    parts.push(`## Code Context\nLinks to code snippets where this concept appears:\n${codeSection}\n`);
  }

  parts.push(`## Sessions (${mentionedIn.length})\n${sessionLines}\n`);

  parts.push(`## Related\n${relatedLinks}\n`);

  parts.push('<!-- defrag:end -->\n');

  return parts.join('\n');
}

/**
 * Render the _low-signal.md terms index.
 * Groups terms alphabetically; each entry shows mention count.
 */
function renderLowSignalNote(lowSignalConcepts) {
  // Sort alphabetically by concept name
  const sorted = [...lowSignalConcepts].sort((a, b) =>
    a.concept.localeCompare(b.concept)
  );

  // Group by first letter
  const byLetter = new Map();
  for (const { concept, sessionCount } of sorted) {
    const letter = concept.charAt(0).toUpperCase();
    const key    = /^[A-Z]$/.test(letter) ? letter : '#';
    if (!byLetter.has(key)) byLetter.set(key, []);
    byLetter.get(key).push({ concept, sessionCount });
  }

  // Sort letter keys; '#' goes at the end
  const sortedKeys = [...byLetter.keys()].sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  const sections = sortedKeys.map((letter) => {
    const items = byLetter.get(letter).map(({ concept, sessionCount }) =>
      `- ${concept} (${sessionCount} mention${sessionCount !== 1 ? 's' : ''})`
    ).join('\n');
    return `## ${letter}\n${items}`;
  }).join('\n\n');

  return `---
title: "Low-Signal Terms"
tags: [index, low-signal]
---

# Low-Signal Terms

Terms that appeared but didn't meet the signal threshold for standalone notes.
These are still indexed — use QMD to search for them.

${sections || '_No low-signal terms_'}

<!-- defrag:end -->
`;
}

function renderSnippetNote(snippet, globalIndex, session) {
  const paddedIdx  = String(globalIndex).padStart(3, '0');
  const sessionSlug = sessionFileName(session).replace('.md', '');
  const date        = isoDate(session.timestamp);

  return `---
title: "Code Snippet ${paddedIdx}"
tags: [code, ${snippet.lang || 'text'}, ${session.source}]
source: ${session.source}
date: ${date}
language: ${snippet.lang || 'text'}
---

# Code Snippet ${paddedIdx}

> From: [[sessions/${sessionSlug}|${session.title}]]
> Language: \`${snippet.lang || 'text'}\`

\`\`\`${snippet.lang || ''}
${snippet.code}
\`\`\`
`;
}

function renderLinksNote(allUrls) {
  // Group by domain
  const byDomain = new Map();

  for (const { url, session } of allUrls) {
    let domain;
    try {
      domain = new URL(url).hostname;
    } catch (_) {
      domain = 'other';
    }

    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push({ url, session });
  }

  const sections = [...byDomain.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, items]) => {
      const lines = items.map(({ url, session }) => {
        const slug = sessionFileName(session).replace('.md', '');
        return `- [${url}](${url}) — [[sessions/${slug}|${session.title}]]`;
      }).join('\n');
      return `## ${domain}\n${lines}`;
    })
    .join('\n\n');

  return `---
title: "External Links"
tags: [links, reference]
---

# External Links

${sections || '_No URLs found_'}
`;
}

function renderTimeline(sessions) {
  const sorted = [...sessions].sort(
    (a, b) => a.session.timestamp - b.session.timestamp
  );

  const sourceEmoji = { claude: '🟠', codex: '🟢', cursor: '🔵' };

  const tierIcon = { HIGH: '\u25B2', MEDIUM: '\u25CF', LOW: '\u00B7' };

  const lines = sorted.map(({ session }) => {
    const slug   = sessionFileName(session).replace('.md', '');
    const date   = isoDate(session.timestamp);
    const icon   = sourceEmoji[session.source] || '\u26AA';
    const tier   = session._sessionTier || 'HIGH';
    const tIcon  = tierIcon[tier] || '';
    return `- ${date} ${icon} ${tIcon} [[sessions/${slug}|${session.title}]] _(${session.source}, ${session.turnCount} turns)_`;
  }).join('\n');

  const bySource = {};
  const byTier   = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const { session } of sessions) {
    bySource[session.source] = (bySource[session.source] || 0) + 1;
    const t = session._sessionTier || 'HIGH';
    byTier[t] = (byTier[t] || 0) + 1;
  }
  const sourceSummary = Object.entries(bySource)
    .map(([s, n]) => `  - ${s}: ${n}`)
    .join('\n');
  const tierSummary = `  - \u25B2 high: ${byTier.HIGH}  \u25CF medium: ${byTier.MEDIUM}  \u00B7 low: ${byTier.LOW}`;

  return `---
title: "Session Timeline"
tags: [timeline, index]
---

# Session Timeline

${sessions.length} sessions across ${Object.keys(bySource).length} source(s):
${sourceSummary}

Signal tiers:
${tierSummary}

---

${lines || '_No sessions_'}
`;
}

function renderIndex(sessions, conceptMap) {
  const totalSessions  = sessions.length;
  const totalConcepts  = conceptMap.size;
  const totalSnippets  = sessions.reduce((n, { extracted }) => n + extracted.snippets.length, 0);
  const totalUrls      = sessions.reduce((n, { extracted }) => n + extracted.urls.length, 0);

  // Tier distribution
  const byTier = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const { session } of sessions) {
    const t = session._sessionTier || 'HIGH';
    byTier[t] = (byTier[t] || 0) + 1;
  }

  const topConcepts = [...conceptMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([c, mentions]) =>
      `- [[concepts/${slugify(c)}|${titleCase(c)}]] _(${mentions.length} session${mentions.length > 1 ? 's' : ''})_`
    )
    .join('\n');

  const recentSessions = [...sessions]
    .sort((a, b) => b.session.timestamp - a.session.timestamp)
    .slice(0, 10)
    .map(({ session }) => {
      const slug  = sessionFileName(session).replace('.md', '');
      const tier  = session._sessionTier || 'HIGH';
      const tIcon = tier === 'HIGH' ? '\u25B2' : tier === 'MEDIUM' ? '\u25CF' : '\u00B7';
      return `- ${tIcon} [[sessions/${slug}|${session.title}]] _(${session.source}, ${isoDate(session.timestamp)})_`;
    })
    .join('\n');

  return `---
title: "Context Defrag \u2014 Map of Content"
tags: [index, moc]
---

# Context Defrag \u2014 Map of Content

Generated by [context-defrag](https://github.com/somarc/context-defrag) on ${new Date().toISOString().slice(0, 10)}.

## Summary

| Metric | Count |
|--------|-------|
| Sessions | ${totalSessions} |
| \u25B2 High signal | ${byTier.HIGH} |
| \u25CF Medium signal | ${byTier.MEDIUM} |
| \u00B7 Low signal | ${byTier.LOW} |
| Concepts | ${totalConcepts} |
| Code Snippets | ${totalSnippets} |
| URLs | ${totalUrls} |

## Navigation

- [[_timeline]] \u2014 Chronological session list
- [[_low-signal]] \u2014 Low-signal terms index
- [[links]] \u2014 All URLs grouped by domain
- [concepts/](concepts/) \u2014 All extracted concepts
- [sessions/](sessions/) \u2014 All session notes
- [code/](code/) \u2014 All code snippets

## Top Concepts
${topConcepts || '_No concepts extracted_'}

## Recent Sessions
${recentSessions || '_No sessions_'}
`;
}

// ── Concept → session relationship utilities ──────────────────────────────────

/**
 * Returns a Map<conceptName, sessionId[]> across all sessions.
 */
function buildConceptMap(sessions) {
  const map = new Map();

  for (const { session, extracted } of sessions) {
    for (const concept of getConceptNames(extracted)) {
      const key = concept.toLowerCase();
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(session.id)) {
        map.get(key).push(session.id);
      }
    }
  }

  return map;
}

/**
 * Finds concepts that frequently co-occur with the given concept.
 */
function findRelatedConcepts(concept, mentionedIn, allSessions) {
  const cooccur = new Map();

  for (const { session, extracted } of allSessions) {
    if (!mentionedIn.includes(session.id)) continue;

    for (const c of getConceptNames(extracted)) {
      if (c.toLowerCase() === concept.toLowerCase()) continue;
      cooccur.set(c, (cooccur.get(c) || 0) + 1);
    }
  }

  return [...cooccur.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);
}

/**
 * Builds a 2-3 sentence context summary by finding the first paragraph
 * in any message that mentions the concept.
 * Retained for backward compatibility; new code uses extractConceptExcerpts.
 */
function buildContextSummary(concept, messages) {
  const re = new RegExp(`\\b${escapeRegex(concept)}\\b`, 'i');

  for (const msg of messages) {
    const paras = msg.content.split(/\n{2,}/);
    for (const para of paras) {
      if (!re.test(para)) continue;
      const sentences = para
        .replace(/\n/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .filter((s) => s.trim().length > 10);

      // Find the sentence containing the concept, return it + neighbours
      const idx = sentences.findIndex((s) => re.test(s));
      if (idx === -1) continue;

      const slice = sentences.slice(Math.max(0, idx - 1), idx + 3);
      return slice.join(' ').slice(0, 400);
    }
  }

  return '';
}

// ── Snippet label heuristic ───────────────────────────────────────────────────
/**
 * Try to derive a short descriptive label from the first meaningful line
 * of a code snippet (e.g. function/class name, comment, etc.).
 * Returns an empty string if nothing useful can be extracted.
 */
function deriveSnippetLabel(code) {
  if (!code) return '';

  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines.slice(0, 5)) {
    // Skip blank or trivially short lines
    if (line.length < 3) continue;

    // Extract comment content (// ... or # ...)
    const commentMatch = line.match(/^(?:\/\/|#)\s*(.{4,60})/);
    if (commentMatch) return commentMatch[1].trim().slice(0, 50);

    // Extract function/class/def name
    const fnMatch = line.match(
      /^(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|class\s+(\w+)|def\s+(\w+)|const\s+(\w+)\s*=)/
    );
    if (fnMatch) {
      const name = fnMatch[1] || fnMatch[2] || fnMatch[3] || fnMatch[4];
      if (name) return name;
    }
  }

  return '';
}

// ── File system utilities ────────────────────────────────────────────────────

function writeNote(filePath, content, { dryRun, verbose, stats, skipIdempotency }) {
  if (dryRun) {
    if (verbose) console.log(`  [DRY] Would write: ${filePath}`);
    stats.written++;
    return;
  }

  // Idempotency check — reads the existing file to preserve user edits below
  // <!-- defrag:end --> and skip unchanged files. Skip on fresh runs to avoid
  // blocking synchronous reads across hundreds of pre-existing files.
  if (!skipIdempotency && fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');

    // Preserve anything the user wrote after <!-- defrag:end -->
    const SENTINEL = '<!-- defrag:end -->';
    const existingEnd = existing.indexOf(SENTINEL);
    const newEnd      = content.indexOf(SENTINEL);

    if (existingEnd !== -1 && newEnd !== -1) {
      const existingTail = existing.slice(existingEnd + SENTINEL.length);
      const newHead      = content.slice(0, newEnd + SENTINEL.length);
      const merged       = newHead + existingTail;

      if (merged === existing) {
        stats.skipped++;
        return;
      }

      fs.writeFileSync(filePath, merged, 'utf8');
      stats.written++;
      if (verbose) console.log(`  [WRITE] ${filePath}`);
      return;
    }

    // No sentinel — fall back to exact-match idempotency
    if (existing === content) {
      stats.skipped++;
      return;
    }
  }

  fs.writeFileSync(filePath, content, 'utf8');
  stats.written++;

  if (verbose) {
    console.log(`  [WRITE] ${filePath}`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── String utilities ──────────────────────────────────────────────────────────

/**
 * Convert a concept name to a filesystem-safe slug.
 */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Convert concept to display Title Case.
 */
function titleCase(str) {
  // If already has uppercase, preserve it
  if (/[A-Z]/.test(str)) return str;
  return str
    .split(/[\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Build a unique filename for a session note.
 * Format: {source}-{YYYY-MM-DD}-{title-slug}.md
 */
function sessionFileName(session) {
  const date  = isoDate(session.timestamp);
  const title = session.title
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 50)
    .replace(/-+$/, '');

  return `${session.source}-${date}-${title}.md`;
}

function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

function escYaml(str) {
  return str.replace(/"/g, '\\"');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  write,
  sessionFileName,
  slugify,
  buildConceptMap,
  renderConceptNote,
  renderSessionNote,
  renderLowSignalNote,
};
