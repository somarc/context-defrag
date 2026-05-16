/**
 * obsidian.js — Writes an Obsidian markdown vault from extracted session data
 *
 * Output structure:
 *   vault/
 *     _index.md           — root Map of Content
 *     _timeline.md        — chronological session list
 *     concepts/           — one note per concept
 *     sessions/           — one note per source session
 *     code/               — extracted code snippets
 *     links.md            — all URLs grouped by domain
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Main write function ──────────────────────────────────────────────────────
/**
 * @param {Object}  opts
 * @param {string}  opts.outputDir     - Root vault directory
 * @param {Array}   opts.sessions      - Array of { session, extracted } objects
 * @param {boolean} opts.dryRun        - If true, log what would be written
 * @param {boolean} opts.verbose
 * @returns {{ written: number, skipped: number }}
 */
function write({ outputDir, sessions, dryRun, verbose }) {
  const stats = { written: 0, skipped: 0 };

  if (!dryRun) {
    ensureDir(outputDir);
    ensureDir(path.join(outputDir, 'concepts'));
    ensureDir(path.join(outputDir, 'sessions'));
    ensureDir(path.join(outputDir, 'code'));
  }

  // ── 1. Session notes ─────────────────────────────────────────────────────
  for (const { session, extracted } of sessions) {
    const fileName = sessionFileName(session);
    const filePath = path.join(outputDir, 'sessions', fileName);
    const content  = renderSessionNote(session, extracted);
    writeNote(filePath, content, { dryRun, verbose, stats });
  }

  // ── 2. Concept notes ─────────────────────────────────────────────────────
  // Build concept → sessions map
  const conceptMap = buildConceptMap(sessions);

  for (const [concept, mentionedIn] of conceptMap.entries()) {
    const fileName = slugify(concept) + '.md';
    const filePath = path.join(outputDir, 'concepts', fileName);
    const content  = renderConceptNote(concept, mentionedIn, sessions);
    writeNote(filePath, content, { dryRun, verbose, stats });
  }

  // ── 3. Code snippet notes ────────────────────────────────────────────────
  let snippetIndex = 1;
  for (const { session, extracted } of sessions) {
    for (const snippet of extracted.snippets) {
      const paddedIdx = String(snippetIndex).padStart(3, '0');
      const fileName  = `snippet-${paddedIdx}.md`;
      const filePath  = path.join(outputDir, 'code', fileName);
      const content   = renderSnippetNote(snippet, snippetIndex, session);
      writeNote(filePath, content, { dryRun, verbose, stats });
      snippetIndex++;
    }
  }

  // ── 4. Links index ───────────────────────────────────────────────────────
  const allUrls = sessions.flatMap(({ session, extracted }) =>
    extracted.urls.map((url) => ({ url, session }))
  );
  const linksContent = renderLinksNote(allUrls);
  writeNote(path.join(outputDir, 'links.md'), linksContent, { dryRun, verbose, stats });

  // ── 5. Timeline ──────────────────────────────────────────────────────────
  const timelineContent = renderTimeline(sessions);
  writeNote(path.join(outputDir, '_timeline.md'), timelineContent, { dryRun, verbose, stats });

  // ── 6. Root index ────────────────────────────────────────────────────────
  const indexContent = renderIndex(sessions, conceptMap);
  writeNote(path.join(outputDir, '_index.md'), indexContent, { dryRun, verbose, stats });

  return stats;
}

// ── Note renderers ────────────────────────────────────────────────────────────

function renderSessionNote(session, extracted) {
  const date      = isoDate(session.timestamp);
  const isoFull   = session.timestamp.toISOString();
  const sourceTag = session.source;
  const sessionId = sessionFileName(session).replace('.md', '');

  const topicLinks = extracted.concepts.slice(0, 10).map((c) =>
    `- [[concepts/${slugify(c)}|${c}]]`
  ).join('\n') || '_None extracted_';

  const decisionsSection = extracted.decisions.length
    ? extracted.decisions.map((d) => `- ${d}`).join('\n')
    : '_None detected_';

  const snippetLinks = extracted.snippets.map((_, i) => {
    // We need the global snippet index, but we only have the local one here.
    // Use the session id as a prefix for readability.
    const label = extracted.snippets[i].lang || 'code';
    return `- [[code/snippet-TBD]] — ${label} snippet`;
  }).join('\n') || '_None_';

  const urlSection = extracted.urls.length
    ? extracted.urls.slice(0, 20).map((u) => `- ${u}`).join('\n')
    : '_None_';

  const entitySection = extracted.entities.length
    ? extracted.entities.slice(0, 15).join(', ')
    : '_None detected_';

  return `---
title: "${escYaml(session.title)}"
source: ${sourceTag}
date: ${isoFull}
turns: ${session.turnCount}
tags: [session, ${sourceTag}]
---

# ${session.title}

> Source: **${sourceTag}** | ${date} | ${session.turnCount} turns

## Key Topics
${topicLinks}

## Decisions
${decisionsSection}

## Code Snippets
${snippetLinks}

## URLs
${urlSection}

## Technologies Mentioned
${entitySection}
`;
}

function renderConceptNote(concept, mentionedIn, allSessions) {
  // Find sessions where this concept appears
  const sessionLinks = mentionedIn.map((sessionId) => {
    const entry = allSessions.find(
      ({ session }) => session.id === sessionId
    );
    if (!entry) return null;
    const slug = sessionFileName(entry.session).replace('.md', '');
    return `- [[sessions/${slug}|${entry.session.title}]]`;
  }).filter(Boolean).join('\n');

  // Find related concepts (concepts that co-appear in the same sessions)
  const related = findRelatedConcepts(concept, mentionedIn, allSessions);
  const relatedLinks = related.slice(0, 8).map((c) =>
    `- [[concepts/${slugify(c)}|${c}]]`
  ).join('\n') || '_None_';

  // Build a context summary from the first session
  const firstEntry = allSessions.find(
    ({ session }) => mentionedIn.includes(session.id)
  );
  const contextSummary = firstEntry
    ? buildContextSummary(concept, firstEntry.session.messages)
    : '';

  const firstSource = firstEntry ? firstEntry.session.source : 'unknown';
  const firstDate   = firstEntry ? isoDate(firstEntry.session.timestamp) : '';

  const displayName = titleCase(concept);

  return `---
title: "${escYaml(displayName)}"
tags: [concept, ${firstSource}]
source: ${firstSource}
date: ${firstDate}
---

# ${displayName}

> Extracted from: [[sessions/${firstEntry ? sessionFileName(firstEntry.session).replace('.md', '') : 'unknown'}|${firstEntry ? firstEntry.session.title : 'unknown'}]]

## Context
${contextSummary || `_${displayName} was mentioned across ${mentionedIn.length} session(s)._`}

## Related
${relatedLinks}

## Mentions
${sessionLinks || '_No sessions found_'}
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

  const lines = sorted.map(({ session }) => {
    const slug   = sessionFileName(session).replace('.md', '');
    const date   = isoDate(session.timestamp);
    const icon   = sourceEmoji[session.source] || '⚪';
    return `- ${date} ${icon} [[sessions/${slug}|${session.title}]] _(${session.source}, ${session.turnCount} turns)_`;
  }).join('\n');

  const bySource = {};
  for (const { session } of sessions) {
    bySource[session.source] = (bySource[session.source] || 0) + 1;
  }
  const sourceSummary = Object.entries(bySource)
    .map(([s, n]) => `  - ${s}: ${n}`)
    .join('\n');

  return `---
title: "Session Timeline"
tags: [timeline, index]
---

# Session Timeline

${sessions.length} sessions across ${Object.keys(bySource).length} source(s):
${sourceSummary}

---

${lines || '_No sessions_'}
`;
}

function renderIndex(sessions, conceptMap) {
  const totalSessions  = sessions.length;
  const totalConcepts  = conceptMap.size;
  const totalSnippets  = sessions.reduce((n, { extracted }) => n + extracted.snippets.length, 0);
  const totalUrls      = sessions.reduce((n, { extracted }) => n + extracted.urls.length, 0);

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
      const slug = sessionFileName(session).replace('.md', '');
      return `- [[sessions/${slug}|${session.title}]] _(${session.source}, ${isoDate(session.timestamp)})_`;
    })
    .join('\n');

  return `---
title: "Context Defrag — Map of Content"
tags: [index, moc]
---

# Context Defrag — Map of Content

Generated by [context-defrag](https://github.com/you/context-defrag) on ${new Date().toISOString().slice(0, 10)}.

## Summary

| Metric | Count |
|--------|-------|
| Sessions | ${totalSessions} |
| Concepts | ${totalConcepts} |
| Code Snippets | ${totalSnippets} |
| URLs | ${totalUrls} |

## Navigation

- [[_timeline]] — Chronological session list
- [[links]] — All URLs grouped by domain
- [concepts/](concepts/) — All extracted concepts
- [sessions/](sessions/) — All session notes
- [code/](code/) — All code snippets

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
    for (const concept of extracted.concepts) {
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

    for (const c of extracted.concepts) {
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

// ── File system utilities ────────────────────────────────────────────────────

function writeNote(filePath, content, { dryRun, verbose, stats }) {
  if (dryRun) {
    if (verbose) console.log(`  [DRY] Would write: ${filePath}`);
    stats.written++;
    return;
  }

  // Idempotent: only write if content changed
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
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

module.exports = { write, sessionFileName, slugify, buildConceptMap };
