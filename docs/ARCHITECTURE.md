# Context Defrag — Architecture

> Technical reference for contributors and the curious.
> For usage, see the [README](../README.md).

---

## Table of Contents

1. [Philosophy](#1-philosophy)
2. [Pipeline Overview](#2-pipeline-overview)
3. [Signal Scoring](#3-signal-scoring)
4. [Excerpt Ranking](#4-excerpt-ranking)
5. [Session Narrative Construction](#5-session-narrative-construction)
6. [Tiered Note Creation](#6-tiered-note-creation)
7. [The Linker](#7-the-linker)
8. [Source Formats](#8-source-formats)
   - [Claude Miner](#claude-miner)
   - [Cursor Miner](#cursor-miner)
   - [Codex CLI Miner](#codex-cli-miner)
9. [Idempotency](#9-idempotency)
10. [The `defrag.json` Manifest](#10-the-defragjson-manifest)
11. [Vault Structure Decisions](#11-vault-structure-decisions)
12. [QMD Integration](#12-qmd-integration)
13. [Extension Points](#13-extension-points)

---

## 1. Philosophy

### The core problem

LLM conversations are ephemeral by design. Claude, Cursor, Codex — they all persist their history to disk in structured formats. The raw data exists. But it is fragmented: hundreds of sessions scattered across different storage locations, different formats, different naming schemes. Each session is an island. The knowledge inside them does not accumulate.

If you spent three hours working through why AEM's replication transport needs a custom retry policy, that reasoning lives in one JSONL file under an opaque UUID directory. It doesn't connect to the Cursor session from two weeks later where you ran into the same retry problem in a different project. It doesn't connect to the code snippet you extracted at the time. It doesn't surface when you search your notes. It evaporates.

**Context Defrag's job is defragmentation**: finding signal scattered across hundreds of sessions and consolidating it into a form that persists and compounds. The raw JSONL files are like a fragmented disk — all the data is there, but reading it requires seeking everywhere. The vault is the defragmented disk — knowledge laid out contiguously so it can actually be read.

### The two-layer output model

The tool produces two distinct layers, each optimized for a different access pattern:

**Vault layer** (`concepts/`, `sessions/`, `code/`, `links.md`, `_timeline.md`): structured, human-readable Markdown optimized for Obsidian's graph navigation and manual curation. A human can open this vault, browse the graph, click into a concept note, and immediately see every session where that concept was discussed, every decision made about it, and every related concept. The vault is the primary interface. It is designed for exploration, not just search.

**Search layer** (QMD): a semantic index over the vault, consumed programmatically. QMD reads `defrag.json` to discover the vault contents, indexes the structured body text, and exposes filtered queries like `qmd query "replication retry" --source claude --since 30d`. The search layer is for retrieval when you know roughly what you're looking for but don't want to browse.

These layers complement each other. The vault is for discovery and serendipitous connection. QMD is for targeted lookup. Neither alone is sufficient.

### Why heuristic extraction, not LLM summarization

The extraction pipeline is entirely heuristic — regex patterns, keyword matching, frequency analysis, sentence windowing. No LLM is called during a standard run. This was a deliberate architectural choice with specific tradeoffs:

**Speed**: heuristic extraction runs a full corpus of 200 sessions in 3–5 seconds. An LLM summarization pass at one call per session would take 10–20 minutes, even with parallelism.

**Privacy**: the user's conversation history stays on their machine. No bytes of chat history leave the local process. Many users run this tool on codebases that contain proprietary logic, credentials in prompts, and unreleased product details.

**Reproducibility**: heuristics are deterministic. The same input always produces the same output. This makes re-runs predictable and diffing meaningful — if a note changed between runs, it's because the source data changed, not because an LLM chose different phrasing.

**Cost**: zero API calls means zero cost, no rate limits, and no dependency on external service availability.

**The tradeoff accepted**: heuristic extraction has lower semantic understanding than a language model. It will miss metaphors, indirect references, and nuanced reasoning. The decision sentences it finds are pattern-matched, not understood. This is acceptable because:

1. The heuristics are tuned for *recall* over *precision* — it is better to include a borderline sentence than to miss a real decision.
2. The vault is designed to be curated by the user, not consumed blindly.
3. LLM summarization is available as an opt-in `--synthesize` flag (planned) for users who want to upgrade specific concept notes after initial extraction.

The philosophy: run the cheap pass first, get 80% of the value immediately, and let users opt into the expensive pass for the notes that matter most.

---

## 2. Pipeline Overview

Context Defrag is a seven-phase pipeline: **scan → deduplicate → extract → write → link → manifest → QMD**.

Each phase is independently scoped. Miners produce a normalized intermediate representation. The extraction engine operates only on that normalized form — it has no knowledge of source formats. The writer consumes extracted data. The linker runs as a post-processing pass over the written vault. This separation of concerns means each component can be tested, replaced, or extended in isolation.

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                      CLI  (defrag.js)                           │
  │   parseArgs → runPipeline → [optional] setupWatchMode           │
  └──────────────────────────┬──────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
        ClaudeMiner      CodexMiner      CursorMiner
        (.jsonl files)   (JSON/SQLite)   (SQLite .vscdb)
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                    Session[]                        ← normalized objects
                  { source, id, title,
                    timestamp, messages[],
                    turnCount, filePath }
                              │
                              ▼
                    deduplicateSessions()            ← FNV-1a ID-based dedup
                              │
                              ▼
                    extract(session)                 ← per-session, pure function
                  { concepts[], decisions[],
                    snippets[], urls[],
                    entities[] }
                              │
                              ▼
                    enriched[]                       ← { session, extracted }
                              │
              ┌───────────────┼──────────────────────────────────┐
              │               │                                  │
              ▼               ▼                                  ▼
      sessions/*.md    concepts/*.md               _low-signal.md
                        (score ≥ threshold)         (score < threshold)
              │               │                                  │
              └───────────────┼──────────────────────────────────┘
                              │
                    code/*.md  links.md  _timeline.md  _index.md
                              │
                              ▼
                    writeNote()                      ← idempotent, sentinel-aware
                              │
                              ▼
                    link({ vaultDir })               ← post-processing pass
                    buildRegistry() → injectLinks()
                              │
                              ▼
                    defrag.json                      ← manifest
                              │
                              ▼
                    [optional] qmd collection add    ← if --gpt-ko
```

### Phase 1 — Scan

`defrag.js` iterates over the requested source names (`claude`, `codex`, `cursor`), calls `miner.mine({ since, verbose })` on each, and accumulates results. Errors are caught per-miner — a broken Cursor installation does not abort Claude mining. The `--since <date>` flag is passed to miners at this stage; miners apply date filtering before returning, so the extraction phase never sees stale data.

### Phase 2 — Deduplicate

After all miners return, `deduplicateSessions()` filters by `session.id`. Each miner computes IDs deterministically using FNV-1a hashes of file paths, so the same conversation file discovered through multiple search roots (e.g. via symlinks or both `.claude/` and `Library/Application Support/Claude/`) produces a single session object.

```js
function deduplicateSessions(sessions) {
  const seen = new Set();
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}
```

### Phase 3 — Extract

`extract(session)` in `extractor.js` runs on each deduplicated session. It operates on the full concatenated message text and produces a flat extracted object. The function is a pure data transformation — no I/O, no side effects. This makes it trivially testable and safely runnable in parallel (if a future version opts to parallelize).

```js
function extract(session) {
  const fullText = session.messages.map((m) => m.content).join('\n\n');
  return {
    concepts:  extractConcepts(fullText),
    decisions: extractDecisions(session.messages),
    snippets:  extractSnippets(fullText),
    urls:      extractUrls(fullText),
    entities:  extractEntities(fullText),
  };
}
```

Per-session extracted results are accumulated into `conceptFreq` — a `Map` used to build the final manifest's `topConcepts` list.

### Phase 4 — Write (vault)

`write({ outputDir, sessions, dryRun, verbose, signalThreshold })` in `obsidian.js` creates all output files. It owns the vault's directory structure and renders all note content. The `writeNote()` helper is idempotent: if a file already exists, it checks for the `<!-- defrag:end -->` sentinel and merges user-authored content below it with freshly generated content above it (see [Idempotency](#9-idempotency)).

Write order matters: session notes are written first (they don't reference concept notes), then concept notes (which reference sessions), then structural files (_low-signal, code snippets, links, timeline, index).

### Phase 5 — Link

`link({ vaultDir, dryRun, verbose })` in `linker.js` runs as a separate post-processing pass over the completed vault. It builds a registry of all note titles, then injects `[[wikilinks]]` into the text zones of each note. Running this as a separate pass — not inline during write — means notes can reference each other without needing to know during write time whether the target note will exist.

### Phase 6 — Manifest

`defrag.json` is written to the vault root with aggregate statistics, source metadata, and the top concepts list. This file is the handshake between the CLI, the web visualizer, and QMD (see [The defrag.json Manifest](#10-the-defragjson-manifest)).

### Phase 7 — QMD Integration (optional)

If `--gpt-ko` is passed, the CLI attempts to auto-invoke `qmd collection add` if the `qmd` binary is in `PATH`. Whether or not the binary is found, it prints manual QMD integration instructions.

### Watch mode

`--watch` keeps the process running after the first pipeline completion. It uses `fs.watch()` with `{ recursive: true }` on all detected source directories and re-runs the full pipeline after a 2-second debounce. The debounce prevents thrashing when an LLM client writes multiple files in rapid succession (common when Claude Code streams a long session). `.lock` and `.DS_Store` changes are filtered at the watch event handler level before the debounce timer is started.

---

## 3. Signal Scoring

Signal scoring is the most architecturally important part of the extraction system. It is the mechanism that separates meaningful concepts from noise.

### The problem signal scoring solves

A naive implementation would create a concept note for every term that appears in any session. But "JSON" appears in hundreds of sessions. "null" appears in thousands of code snippets. Creating individual notes for these terms pollutes the Obsidian graph: instead of a knowledge map showing the concepts you actually think about, you get a frequency distribution of your vocabulary.

Signal scoring answers the question: **of all the concepts that appear across your sessions, which ones represent genuine crystallized knowledge worth a dedicated note?**

### The formula

```
signalScore = (sessionCount × 2) + (decisionCount × 5) + (codeCount × 3) + (crossProjectCount × 4)
```

Implemented in `extractor.js → computeSignalScore()`:

```js
function computeSignalScore(concept, sessionItems) {
  const conceptLower = concept.toLowerCase();
  const re = new RegExp(`\\b${escapeRegex(conceptLower)}\\b`, 'i');

  let sessionCount     = 0;
  let decisionCount    = 0;
  let codeCount        = 0;
  const projectSources = new Set();

  for (const item of sessionItems) {
    const { session, extracted } = item;

    // Only count sessions where this concept was extracted
    const appearsInSession = (extracted.concepts || []).some(
      (c) => c.toLowerCase() === conceptLower
    );
    if (!appearsInSession) continue;

    sessionCount++;

    // Count decision sentences that mention this concept
    for (const d of (extracted.decisions || []))
      if (re.test(d)) decisionCount++;

    // Count code snippets whose body references this concept
    for (const s of (extracted.snippets || []))
      if (s && s.code && re.test(s.code)) codeCount++;

    // Track distinct workspaces/sources
    if (session.source)        projectSources.add(session.source);
    if (session.workspacePath) projectSources.add(session.workspacePath);
  }

  const crossProjectCount = projectSources.size;
  return (sessionCount * 2) + (decisionCount * 5) + (codeCount * 3) + (crossProjectCount * 4);
}
```

Note the guard: a concept is only counted for a session if it actually appears in that session's `extracted.concepts` list. This prevents false positives from the word-boundary regex matching incidental substrings.

### Weight rationale

**`sessionCount × 2` — Raw frequency (lowest weight)**

Session count is necessary but weak. A concept appearing in many sessions just means it's common in your stack, not that it's worth a dedicated note. "JavaScript" might appear in every session, but "JavaScript" is not a useful concept note for most developers — it's so ubiquitous it carries no signal about your actual thinking. The weight is 2 rather than 1 because multiple sessions do provide mild evidence of recurrence, but only in combination with other signals does it matter. Think of this as the "at least it's not one-off" contribution.

**`decisionCount × 5` — Explicit decisions (highest weight)**

Decision sentences are the gold standard. "We chose SQLite over Postgres because we need zero-dep distribution" — that sentence represents crystallized reasoning that took real effort to arrive at. It encodes a tradeoff. It would be painful to re-derive. If a concept appears in decision language across your sessions, it was worth reasoning about explicitly, which means it's worth preserving explicitly.

The 5× weight reflects this primacy: one decision sentence is worth more than two raw session appearances. A concept discussed once with one explicit decision scores `(1×2) + (1×5) = 7`, which sits just below the default threshold — it's on the boundary of being notable but hasn't quite earned standalone status. Two sessions with one decision: `(2×2) + (1×5) = 9`. Threshold crossed.

**`codeCount × 3` — Code co-occurrence (medium-high weight)**

When a concept appears in both conversation text and extracted code snippets within the same session, the concept has moved from discussion into implementation. It is being actively used, not just talked about. A concept that only appears in prose might be speculative or exploratory; one that appears in code is operational.

Weight 3 is higher than session frequency (2) because code evidence is more concrete — it means the concept was implemented, not just considered. It is lower than decisions (5) because code presence doesn't mean the concept was *understood*: sometimes concepts appear in code snippets incidentally, as part of a longer example that happened to include the term.

**`crossProjectCount × 4` — Cross-workspace relevance (near-highest weight)**

`crossProjectCount` is built from the set of distinct `session.source` values and `session.workspacePath` values across all sessions mentioning the concept. A concept that spans multiple projects or workspaces is a genuine cross-cutting concern in your work.

The 4× weight reflects that cross-project recurrence is the strongest environmental indicator of structural importance. "AEM Replication" showing up in three different workspace paths means you've thought about it in three different problem contexts — three different projects, three different codebases, potentially three different teams. That concept has earned its own note. "AEM Replication" showing up 50 times in one project might just be background noise from a focused sprint.

Note that `projectSources` is a `Set` — adding the same source or path twice doesn't increase the count. The weight is applied to the count of *distinct* workspaces, not total appearances.

### The default threshold: 8

The default minimum signal score (`--min-signal 8`, controlled via `DEFAULT_MIN_SIGNAL = 8` in `defrag.js`) was calibrated to filter:

- **Single-session, no-decision concepts**: score = `(1×2) = 2` — far too weak
- **Common tech terms, multiple sessions, no decisions or code**: e.g. 2 sessions = `(2×2) = 4` — still weak

To cross the threshold with `score ≥ 8`, a concept needs at minimum one of these combinations:

| Combination | Score | Notes |
|-------------|-------|-------|
| 2 sessions + 1 decision | `(2×2)+(1×5) = 9` | Most common qualifying case |
| 1 session + 1 code + 1 cross-project | `(1×2)+(1×3)+(1×4) = 9` | Technical concept in use |
| 4 sessions, 2 workspaces | `(4×2)+(2×4) = 16` | Cross-project recurrence |
| 1 session + 2 decisions | `(1×2)+(2×5) = 12` | Heavily reasoned about |
| 1 session + 1 decision + 1 code | `(1×2)+(1×5)+(1×3) = 10` | Decided and implemented |

The threshold is tunable via `--min-signal <n>`. Useful calibration approaches:
- Run `--dry-run --verbose` to see concept frequency without writing files
- Lower the threshold to include borderline concepts for discovery
- Raise it (e.g. `--min-signal 15`) for very large corpora where even "interesting" concepts are numerous

### What happens to low-signal concepts

Concepts that don't meet the threshold are not discarded. They are written to `_low-signal.md` as a searchable alphabetical index with mention counts. This serves two purposes:

1. **Completeness**: every extracted concept still exists somewhere in the vault, searchable by QMD and by Obsidian's built-in search.
2. **Graph cleanliness**: `_low-signal.md` is one file, not one file per term. A vault with 8,000 individual concept nodes is unusable as a knowledge graph — it's visual noise with no structure. The tier system ensures the graph contains a manageable number of high-signal nodes (typically 50–500) representing your actual knowledge topology.

Re-running with `--min-signal 4` will promote low-signal concepts to full notes for concepts that scored 4–7. The `--min-signal 0` flag produces a note for every extracted concept — useful for bulk exploration of an unfamiliar corpus.

---

## 4. Excerpt Ranking

Excerpt ranking is how concept notes acquire meaningful, quoted context from the sessions that mention them, rather than just session titles and bare links.

### The problem

A concept note for "OSGi Bundle Lifecycle" that just says "mentioned in 4 sessions" is marginally useful. A concept note that quotes the three sentences where you explicitly worked through why bundle activation order matters is actually valuable — it reconstructs your reasoning without requiring you to re-read the full sessions.

### The algorithm

Implemented in `extractor.js → extractConceptExcerpts(concept, sessionItems, maxExcerpts = 5)`.

```
For each session that contains the concept:
  For each message in the session:
    Split into paragraphs (on \n{2,})
    Skip paragraphs that don't contain the concept (fast pre-filter)
    Split paragraph into sentences (on lookbehind [.!?]\s+)
    Filter sentences shorter than 15 chars
    For each sentence containing the concept:
      Build a 3-sentence window:
        window = [sentences[i-1], sentences[i], sentences[i+1]]
                 .filter(Boolean).join(' ').slice(0, 300)
      Deduplicate by normalized text (lowercase + whitespace-collapse)
      Score the window against EXCERPT_SIGNAL_PATTERNS
      Push to candidates
Sort candidates by score descending
Return top maxExcerpts (default: 5)
```

### Sentence window scoring

Each candidate window starts with a base score of 1. Each `EXCERPT_SIGNAL_PATTERN` that matches adds 2 points:

```js
const EXCERPT_SIGNAL_PATTERNS = [
  // Decision language (score +2)
  /\b(decided|will use|going with|avoid|chosen|don't use|do not use|opted for|settled on)\b/i,
  // Problem framing (score +2)
  /\b(issue|problem|failing|broken|slow|error|bug|crash|failing)\b/i,
  // Code context (score +2)
  /\b(function|method|class|returns|throws|implements|extends|interface)\b/i,
];
```

A window matching all three patterns scores 7 (1 base + 2 + 2 + 2). A window matching none scores 1. The ordering is by score descending, so concept notes surface the most decision-rich, problem-framed, or code-contextual excerpts at the top.

**Why these three pattern categories:**

- **Decision language** is the highest-value excerpt type. "We decided to avoid `BundleActivator` because..." is the compressed form of a reasoning chain. If you can see one of these sentences you can reconstruct the full thought.
- **Problem framing** shows the context that motivated a decision. "The bundle keeps failing to activate" tells you *why* a decision was needed, making adjacent decision sentences interpretable. Without problem context, decisions can seem arbitrary.
- **Code context** bridges from discussion to implementation. "The `activate()` method is called by the OSGi container" — this sentence provides the concrete technical anchor for an abstract concept.

### Why sentence windows rather than full paragraphs

Full paragraphs would include too much context — they become mini-essays that defeat the goal of having a scannable concept note. Individual sentences without context are often too cryptic ("just avoid the manual approach" — avoid *what*?). The three-sentence window is the minimum meaningful unit: it captures why the concept came up (preceding sentence), the sentence containing it, and what immediately followed (consequent sentence).

The 300-character cap ensures windows remain atomic knowledge units composable for downstream semantic indexing. QMD's embeddings work best on focused, self-contained passages.

### Deduplication

Before scoring, windows are deduplicated by normalized text:

```js
const key = window.toLowerCase().replace(/\s+/g, ' ');
if (seenKeys.has(key)) continue;
seenKeys.add(key);
```

This catches cases where the same passage appears in multiple sessions (e.g. copy-pasted context, common boilerplate). Exact-match deduplication is used rather than fuzzy similarity because fuzzy matching at scale would be expensive and the precision gain is minimal — truly identical text is the problem to solve.

---

## 5. Session Narrative Construction

Every session note includes a 2–3 sentence narrative at the top answering: **what was this session about, and what came out of it?** When scanning 196 sessions in `_timeline.md`, this narrative is the difference between finding the right session in 10 seconds versus 10 minutes.

Implemented in `extractor.js → extractSessionNarrative(session, extracted)`.

### Step 1 — Opening (the problem statement)

```js
const firstLine = firstHuman.content
  .replace(/\n+/g, ' ')
  .trim()
  .split(/[.!?]\s+/)[0]   // first sentence only
  .slice(0, 150)
  .trim();
```

The first human message in an LLM session is almost always a problem statement, question, or task. People open LLM sessions with intent — the opening question defines what the session is for. Taking the first sentence (split at `.`, `!`, or `?` followed by whitespace) and truncating to 150 characters captures this intent without including the full context dump that often follows.

**Design note**: `split(/[.!?]\s+/)[0]` is used rather than a hard 150-character slice. The sentence split happens first, ensuring the opening ends at a sentence boundary. The 150-character slice is only a fallback cap for the rare case of an extremely long first sentence (e.g. a dense technical question without punctuation). The result is a clean, grammatically complete problem statement.

**Fallback**: if the first human message is empty or under 10 characters, fall back to `Topic: {session.title}`. This keeps the narrative useful even for sessions that started with a tool invocation or file dump rather than a natural-language question.

### Step 2 — Approach (what was tried)

```js
const best = decisions
  .slice()
  .sort((a, b) => b.length - a.length)         // longest first
  .find((d) => d.length <= 200);               // but not too long
```

Decision sentences from the session are sorted by length descending. The longest sentence that fits within 200 characters is selected. This heuristic rests on a practical observation: short decision sentences tend to be vague ("we should use the other approach"), while longer ones contain the actual reasoning ("we decided to use `BundleContext.registerService()` directly instead of Declarative Services because we need dynamic service registration at runtime"). Length correlates with specificity.

**Fallback**: if no decision sentences were extracted, fall back to:
```
Covered: {top 4 concepts from extracted.concepts}.
```

This weaker form is still useful — it tells you what topics were in play without fabricating a conclusion. "Covered: OSGi, BundleActivator, ServiceLoader, Sling." is honest about what the session contained without pretending to know what was concluded.

### Step 3 — Outcome (what was concluded)

Scan assistant messages in reverse chronological order (most recent first) for conclusion language:

```js
const CONCLUSION_PATTERNS = [
  /\b(recommend|suggest|should|best approach|in summary|ultimately|conclusion|final)\b/i,
  /\b(the solution|the fix|the answer|the approach|going forward|next steps)\b/i,
];
```

The first matching sentence found becomes the outcome, truncated to 200 characters. Scanning in reverse order maximizes the chance of finding the assistant's final summary or recommendation — the sentence most likely to contain the session's conclusion.

**Why omit rather than fabricate**: if no conclusion language is found, the outcome is omitted entirely. A 2-sentence narrative is better than a 3-sentence narrative with a fabricated conclusion. Adding a placeholder like "Session ended without conclusion" would be noise; omitting the outcome part signals to the reader that the session may have been exploratory or cut off.

### Assembly

```js
const parts = [opening, approach, outcome].filter(Boolean);
return parts.join(' ');
```

The result is 1–3 sentences. The function will always return *something* because the opening step has its own fallback to the session title. The narrative is functional recall, not quality prose — it answers "what was this?" not "tell me about this."

---

## 6. Tiered Note Creation

The vault uses a three-tier system to prevent graph pollution while preserving full-text coverage.

### Tier 1 — High-signal concept notes

Concepts with `signalScore ≥ threshold` (default 8) receive a standalone note in `concepts/`.

**File**: `concepts/{slug}.md`

The slug is computed by `slugify(concept)`:
```js
str.toLowerCase()
   .replace(/[^a-z0-9]+/g, '-')
   .replace(/^-+|-+$/g, '')
   .slice(0, 80)
```

**Content structure** (as rendered by `renderConceptNote()`):

```markdown
---
title: "OSGi Bundle Lifecycle"
tags: [concept, claude, cursor]
signal: 24
sessions: 6
decisions: 3
first-seen: 2025-02-14
last-seen: 2025-05-21
---

# OSGi Bundle Lifecycle

## Key Decisions
- We decided to use DS annotations rather than BundleActivator for lifecycle management (2025-03-01, [[sessions/claude-2025-03-01-osgi-ds-migration]])
- Avoid manual bundle activation order — use service dependencies instead (2025-04-12, [[sessions/cursor-2025-04-12-bundle-ordering]])

## Context & Excerpts
> "The activator approach fails because OSGi doesn't guarantee activation order between bundles..."
> — [[sessions/claude-2025-02-14-osgi-lifecycle|OSGi lifecycle deep-dive]], 2025-02-14

## Code Context
Links to code snippets where this concept appears:
- [[code/snippet-042]] — java — BundleActivator

## Sessions (6)
- [[sessions/cursor-2025-05-21-osgi-replication|OSGi replication issue]] — 2025-05-21
- [[sessions/claude-2025-04-12-bundle-ordering|Bundle ordering]] — 2025-04-12
...

## Related
- [[concepts/osgi|OSGi]]
- [[concepts/sling|Sling]]
- [[concepts/aem|AEM]]

<!-- defrag:end -->
```

The YAML frontmatter carries `signal`, `sessions`, and `decisions` counts. These are indexed by QMD as filterable facets and are visible in Obsidian's file metadata pane without opening the note.

**Graph behavior**: Tier 1 notes appear as nodes in the Obsidian graph. They connect to session notes (via `## Sessions` wikilinks) and to each other (via `## Related` wikilinks). This creates the knowledge topology that makes the graph useful: concept clusters emerge organically from co-occurrence patterns.

### Tier 2 — Low-signal concepts

Concepts with `signalScore < threshold` are collected into `_low-signal.md`, grouped alphabetically with their session mention count:

```markdown
## A
- async (4 mentions)
- array (2 mentions)

## B
- base (3 mentions)
```

**Why not individual files?** The Obsidian graph is a visual knowledge map. If every term with 2 mentions becomes a node, the graph becomes a sea of dots with no navigable structure. `_low-signal.md` is one file — it appears as one node in the graph, clearly labeled as the index of borderline terms.

**Promotability**: `_low-signal.md` is fully searchable by QMD and by Obsidian's built-in search. If you remember discussing something and want to find it, the low-signal index will surface it. Re-run with `--min-signal 4` to promote those terms to Tier 1 notes.

### Tier 3 — Stopwords (filtered at extraction time)

The `CONCEPT_STOPWORDS` set in `extractor.js` contains terms filtered *before* concept candidates are even scored. They are never written anywhere in the vault:

```js
const CONCEPT_STOPWORDS = new Set([
  'http','https','null','true','false','undefined','const','let','var',
  'function','return','class','import','export','default','async','await',
  'error','warning','info','debug','test','type','data','value','result',
  'object','array','string','number','boolean','file','path','name','key',
  'index','items','list','node','root','base','core','main','util','utils',
  'helper','helpers','service','services','handler','handlers','config',
  'options','params','args','props','state','store','model','schema',
]);
```

These are programming keywords, common English nouns in developer contexts, and structural terms that appear constantly but carry zero knowledge signal on their own. Filtering at extraction time means they never consume signal-scoring CPU, never appear in concept maps, and never reach `_low-signal.md`.

**The distinction between Tier 2 and Tier 3**: Tier 2 terms *might* become interesting with more context or a lower threshold. Tier 3 terms are definitionally uninteresting — no amount of sessions or decisions would make "null" a useful concept note. The stopword list represents this categorical judgment; the signal threshold represents a quantitative one.

### The graph philosophy

The Obsidian graph is meaningful only if its nodes represent things worth knowing about. A graph with 400 nodes, each a real concept you've worked with, is a knowledge map — you can see clusters, bridges, and isolated ideas. A graph with 8,000 nodes — half of which are "string", "async", "data" — is noise. The tier system enforces the discipline that makes the graph useful: **the graph shows your actual knowledge topology, not a frequency distribution of your vocabulary**.

---

## 7. The Linker

The linker (`cli/writers/linker.js`) runs as a post-processing pass over the written vault. Its job is to inject `[[wikilinks]]` into plain-text mentions of known note titles, so that concepts referenced in session notes automatically become navigable links in Obsidian.

### Why a separate pass?

The writer generates notes in sequence: session notes first, then concept notes. If wikilink injection happened during write time, session notes would need to know which concept notes exist before those notes are written. The linker solves this by running after all notes are written — it operates on a complete vault with full knowledge of all note titles. This also means the linker is reusable for vaults not generated by this tool.

### Pass 1 — Registry construction

```
buildRegistry(vaultDir)
  → collectMarkdownFiles(vaultDir)      ← recursive walkDir, all *.md
  → for each file:
      extractTitle(content, filePath)   ← front-matter title > H1 > filename
      extractAliases(content, title)    ← front-matter aliases[] + lowercase(title)
  → returns Entry[]
     { filePath, vaultPath, title, aliases }
```

Every Markdown file in the vault gets an entry. `vaultPath` is the path relative to the vault root, without `.md` extension — e.g. `concepts/osgi-bundle-lifecycle`. This is the target string for wikilinks: `[[concepts/osgi-bundle-lifecycle|OSGi Bundle Lifecycle]]`.

**Alias registration**: The linker automatically registers the lowercase form of every title as an alias. So "OSGi Bundle Lifecycle" (stored title) will match `osgi bundle lifecycle` in plain text. The `aliases:` front-matter field can register additional variants (e.g. abbreviated forms, alternative spellings).

**Title extraction priority**:
1. `title:` field in YAML frontmatter
2. First `# H1` heading
3. Filename with hyphens replaced by spaces (last resort)

### Pass 2 — Zone tokenization and injection

For each Markdown file, the content is split into typed zones:

```
tokenise(content) → Zone[]

Zone types:
  frontmatter   --- ... ---  at the start of the file
  codeblock     ```...```    fenced code
  codespan      `...`        inline code  
  wikilink      [[...]]      existing wikilink
  mdlink        [text](url)  markdown hyperlink
  text                       everything else
```

Only `text` zones are candidates for link injection. All other zones are passed through unchanged. This prevents:
- Linking YAML keys in frontmatter (`source: claude` should not become `source: [[concepts/claude|claude]]`)
- Injecting wikilinks into code blocks (which would corrupt the code syntax)
- Double-linking already-wikilinked terms
- Corrupting existing Markdown hyperlinks

The zone tokenizer uses a single regex pass over the body content:

```js
const PROTECTED_RE = /(```[\s\S]*?```|`[^`\n]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\))/g;
```

Plain text between protected regions becomes `text` zones. The frontmatter is handled separately first (it must appear at the start of the file).

### The forward-scan position check

Within `text` zones, the linker uses a global regex replace to find term occurrences. Before committing to a replacement, it checks whether the match position is inside a protected region that might have been missed at zone boundaries:

```js
const before = text.slice(0, offset);

// Count unclosed [[ without matching ]]
const openBrackets  = (before.match(/\[\[/g)  || []).length;
const closeBrackets = (before.match(/\]\]/g)  || []).length;
if (openBrackets > closeBrackets) return match; // inside a wikilink

// Count unmatched backticks
const backticks = (before.match(/`/g) || []).length;
if (backticks % 2 !== 0) return match; // inside a code span
```

This forward-scan approach counts unclosed `[[` and unmatched backticks in the text preceding the match. If the counts indicate an unclosed protected region, the match is returned unchanged.

**Why not lookbehind regex?** Lookbehind for nested or multiline patterns is unreliable across Node.js versions prior to v22, and the patterns involved (arbitrary content between `[[` and `]]`) cannot be expressed as fixed-length lookbehind assertions. The forward scan is O(n) per match but straightforward and portable across all Node versions the tool supports.

### Linking behavior and self-link prevention

```js
// Don't self-link: the OSGi note should not wikilink its own title
if (entry.vaultPath === currentVaultPath) continue;

// Only link terms that are at least 3 characters
if (!candidate || candidate.length < 3) continue;
```

A note is never linked to itself. The `linkifyTerm()` function replaces all occurrences via a global regex, but after the first replacement the match text becomes `[[vaultPath|term]]` — a `wikilink` zone — and will not be re-matched by subsequent calls. The practical effect is first-occurrence-only linking per text zone: one link establishes the navigable connection; subsequent occurrences in the same contiguous text block remain unlinked. This prevents visual clutter from over-linking.

---

## 8. Source Formats

Each miner is responsible for a single source's format. All miners implement the same interface:

```js
async function mine({ since, verbose } = {}) {
  // Returns: { source: string, sessions: Session[], skipped?: any[] }
}
```

The returned `Session` objects share this normalized shape:

```js
{
  source:    'claude' | 'codex' | 'cursor',
  id:        string,       // FNV-1a hash, stable across runs
  filePath:  string,       // original source path (provenance)
  title:     string,       // human-readable, ≤80 chars
  timestamp: Date,         // session start time
  messages:  Message[],    // [{ role, content, timestamp? }]
  turnCount: number,
  // miner-specific optional fields:
  format?:    string,      // 'desktop' | 'code' (Claude miner)
  workspace?: string,      // workspace hash (Cursor miner)
}
```

Role values are normalized to `'human'` or `'assistant'` by each miner. Unknown roles (e.g. `'tool'`, `'system'`) are preserved as-is — the extraction engine ignores them, but they remain available in the session object for debugging.

---

### Claude Miner

**File**: `cli/miners/claude.js`

**Search roots** (all three are checked on every run):
```
~/.claude/
~/.config/claude/                        (XDG config fallback)
~/Library/Application Support/Claude/    (macOS Claude Desktop app)
```

All three roots are searched and deduplicated using `fs.realpathSync()` before processing — the same file discovered via a symlink from multiple roots is only processed once.

**File discovery**: `walkDir()` recursively enumerates all `.jsonl` files under each root using `fs.readdirSync({ withFileTypes: true })`. No glob library is used. Permission errors and broken symlinks are silently skipped via try/catch, since user home directories frequently contain inaccessible paths.

**Format detection**: The miner reads the first non-empty line of each file and calls `detectFormat()`:

```
Desktop format:
  First line: { "uuid": "...", "messages": [...] }
  → each line is a COMPLETE conversation
  → one file may contain multiple sessions (one per line)
  → format = 'desktop'

Code format (shape 1):
  First line: { "type": "user", "message": { "role": "...", "content": "..." }, "timestamp": "..." }
  → each line is a SINGLE TURN
  → one file = one session
  → format = 'code'

Code format (shape 2, older variant):
  First line: { "role": "human", "content": "...", "timestamp": "..." }
  → each line is a SINGLE TURN
  → format = 'code'
```

Both 'code' and 'unknown' formats are processed by the Code parser. Unknown format is likely a variant of Claude Code; the parser degrades gracefully — it silently skips lines that don't normalize to a valid message.

**Desktop format parsing** (`parseDesktopFile`): Each line is parsed as a complete conversation object with a `messages` array. Content arrays (Claude's API returns content as `[{type: "text", text: "..."}, ...]` blocks) are flattened to plain text by `flattenContent()`. Tool-use and tool-result blocks are included if they contain text; otherwise skipped.

**Code format parsing** (`parseCodeFile`): Each line is parsed as a single turn. Three known message shapes are normalized:

| Shape | Detection | Fields used |
|-------|-----------|-------------|
| Shape A — direct turn | `obj.role && obj.content !== undefined` | `role`, `content`, `timestamp` |
| Shape B — wrapped turn (Claude Code) | `obj.message && typeof obj.message === 'object'` | `obj.type` or `obj.message.role`, `obj.message.content`, `obj.timestamp` |
| Shape C — legacy type field | `obj.type in ['human','assistant'] && obj.text` | `obj.type`, `obj.text`, `obj.createdAt` |

**URL-encoded project paths**: Claude Code stores project-scoped sessions in directories named after URL-encoded absolute paths, e.g.:
```
~/.claude/projects/%2FUsers%2Falice%2Fprojects%2Fmy-app/abc123.jsonl
```

The parent directory name is decoded via `safeDecodeURIComponent()` (which handles the `+` → space convention and catches malformed encodings without throwing) and `path.basename()` to extract a human-readable project name for the session title fallback.

**Title derivation priority**:
1. First human message, whitespace-collapsed, truncated to 60 characters
2. Decoded URL path basename (Code format, if path was URL-encoded)
3. `Claude Session — {uuid}` (final fallback)

**Timestamp derivation**: `deriveTimestamp()` iterates all messages looking for the earliest `message.timestamp` or `message.createdAt` value. If none are present in any message, falls back to `fs.statSync(filePath).mtime`. This means sessions without explicit timestamps are ordered by file modification time — less accurate but non-null.

**Role normalization**:
```
"user", "human"             → "human"
"assistant", "ai", "bot"    → "assistant"
other (e.g. "tool")         → preserved as-is
```

**ID generation**: FNV-1a hash over the file path (Code format, one session per file) or over `filePath` + `:` + line index (Desktop format, multiple sessions per file). Stability: IDs are stable as long as the file path doesn't change. Desktop format IDs use the line index as a tiebreaker when the conversation object has no `uuid` — if the file is rewritten with lines in a different order, IDs would change. In practice this is rare because Desktop format files are append-only.

---

### Cursor Miner

**File**: `cli/miners/cursor.js`

**Root path** (macOS only, currently):
```
~/Library/Application Support/Cursor/
```

**Storage structure**:
```
~/Library/Application Support/Cursor/
├── User/
│   └── workspaceStorage/
│       ├── <workspace-hash>/
│       │   └── state.vscdb       ← SQLite database, one per workspace
│       └── <workspace-hash>/
│           └── state.vscdb
└── logs/
    └── <session>/
        └── *.log                 ← plain-text log fallback
```

Each `<workspace-hash>` is a hex digest of the workspace's absolute path, generated by VS Code's storage subsystem. The miner does not need to resolve the hash back to a path — the hash itself is used as the `workspace` field in session objects for cross-project scoring.

**SQLite loading strategy**: The miner tries two SQLite drivers in order:

1. `node:sqlite` (Node.js 22+ built-in, `DatabaseSync`) — no native compilation, no binary dependencies, fastest
2. `better-sqlite3` (npm package, requires native compilation) — fallback for Node < 22

```js
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
```

If neither driver is available, the database is skipped with a verbose warning. This graceful degradation means the tool works on Node 20 environments as long as `better-sqlite3` is installed, and works out-of-the-box on Node 22+ with zero additional dependencies.

**Chat key enumeration**: The following `ItemTable` keys are queried in order for each workspace database:

```js
const CHAT_KEYS = [
  'workbench.panel.aichat.view.aichat.chatdata',  // main chat panel (Cursor 0.40+)
  'aiService.prompts',                             // inline prompts
  'aiService.generations',                         // code generation records
  'composer.composerData',                         // Composer multi-file sessions
  'aiService.chatHistory',                         // older key variant
  'cursor.chatHistory',                            // even older key variant
];
```

Cursor's storage schema has changed significantly across versions. Rather than version-detecting and dispatching, the miner attempts all known keys and handles "key not present" gracefully — a `try/catch` around each `db.prepare().get()` call ensures one missing key doesn't abort the others. This forward-compatible approach means new Cursor versions that add new keys require only a new entry in `CHAT_KEYS`.

**Payload shape normalization**: Three shapes are handled:

```
Shape A: { tabs: [{ chatTitle, lastSendTime, tabId, bubbles: [...] }] }
  → Cursor 0.40+, main chat panel
  → bubbles use type: "user" | "ai"
  → message content in bubble.text | bubble.rawText | bubble.content | bubble.message
  → session timestamp from tab.lastSendTime

Shape B: [{ prompt, response, timestamp }]
  → older aiService.prompts format
  → flat array of prompt/response pairs
  → prompt text in item.prompt | item.text | item.question
  → response text in item.response | item.answer | item.completion

Shape C: { conversations: [{ id, title, messages: [...] }] }
  → aiService.generations and Composer
  → messages use role | type | sender for role field
  → content in m.content | m.text | m.message
```

For Shape A bubbles, role normalization handles both old and new Cursor conventions:
```js
const role = bubble.type === 'ai'   ? 'assistant'
           : bubble.type === 'user' ? 'user'
           : bubble.role || null;
```

**Log file fallback**: `mineLogFiles()` scans `~/Library/Application Support/Cursor/logs/` for `.log` files that contain `aiService`, `copilot`, or `chat` in their text. It then attempts to parse each line as JSON, looking for `prompt`/`completion`/`response` fields. This is a last-resort path for sessions that predate or bypass the workspace storage system. Log sessions receive the filename as their title and the file `mtime` as their timestamp.

**Internal deduplication**: After mining both workspace storage and logs, sessions are deduplicated by `session.id` within the Cursor miner before returning. This handles cases where the same chat appears in both storage systems.

---

### Codex CLI Miner

**File**: `cli/miners/codex.js`

**Search root**: `~/.codex/`

Codex CLI has undergone multiple storage format changes. The miner uses a degradation-tolerant multi-strategy approach, checking for each format's existence in order:

**Strategy 1 — Sessions directory** (`~/.codex/sessions/<id>.json`):
Each file is a JSON session object:
```json
{
  "id": "sess_19a",
  "cwd": "/Users/alice/projects/myapp",
  "createdAt": 1715705021,
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

**Strategy 2 — History file** (`~/.codex/history.json` or `~/.codex/history`):
A single JSON array of all sessions. Same session shape as Strategy 1.

**Strategy 3 — SQLite database** (`~/.codex/history.db`):
```sql
CREATE TABLE sessions (
  id      TEXT PRIMARY KEY,
  cwd     TEXT,
  created INTEGER,   -- unix timestamp
  messages TEXT      -- JSON array
);
```
Loaded with the same two-driver strategy as the Cursor miner.

**Strategy 4 — JSONL file** (`~/.codex/conversations.jsonl`):
One session per line, same shape as Strategy 1.

The `cwd` field, when present, is normalized to a project slug via `path.basename(cwd)`. This value is used as `session.workspacePath`, which feeds into `crossProjectCount` in signal scoring.

---

## 9. Idempotency

Context Defrag is designed to be run repeatedly on a live vault — after every work session, on a cron schedule, or in `--watch` mode. Re-runs must update content without duplicating or destroying it.

### The `<!-- defrag:end -->` sentinel system

Every generated note contains a `<!-- defrag:end -->` comment marking the boundary between auto-generated content (above) and user-authored content (below):

```markdown
## Related
- [[concepts/osgi|OSGi]]

<!-- defrag:end -->

## My Notes

This pattern came up again in the June dispatcher session.
The OSGi spec section 6.2.4 is the authoritative reference here.
```

On re-run, `writeNote()` implements the merge logic:

```js
const SENTINEL = '<!-- defrag:end -->';
const existingEnd = existing.indexOf(SENTINEL);
const newEnd      = content.indexOf(SENTINEL);

if (existingEnd !== -1 && newEnd !== -1) {
  const existingTail = existing.slice(existingEnd + SENTINEL.length);
  const newHead      = content.slice(0, newEnd + SENTINEL.length);
  const merged       = newHead + existingTail;

  if (merged === existing) { stats.skipped++; return; }

  fs.writeFileSync(filePath, merged, 'utf8');
  stats.written++;
  return;
}

// No sentinel — fall back to exact-match idempotency
if (existing === content) { stats.skipped++; return; }
```

The generated content above the sentinel is regenerated fresh every run. The user content below is extracted from the existing file and appended to the new head. If the result is identical to the existing file (nothing changed), the write is skipped.

**This means users can safely annotate any note immediately after a run.** Their annotations survive all subsequent re-runs indefinitely. If a note is regenerated with different content above the sentinel (because new sessions were added), the user's notes below remain intact.

**Notes without the sentinel** (e.g. generated by an older version of the tool): fall back to exact-match idempotency. The file is overwritten if content differs. User annotations in files without the sentinel will be lost on re-run — this is the migration path from pre-sentinel vault versions.

### Content comparison

The merge check compares the fully assembled `merged` string against `existing` using strict equality. This is O(n) in file size but files are small (typically 2–15 KB), and the equality check prevents unnecessary write syscalls and filesystem mtime updates. Unchanged notes are reported as `skipped` in the final summary.

### Session ID stability

Session IDs are FNV-1a hashes of file paths. As long as source files don't move, IDs are stable across runs. If a source file moves (e.g. Cursor updates its storage path), sessions will appear as new on the next run and old session notes will remain as orphans — inert but harmless. There is no automatic cleanup of orphaned session notes; the vault is strictly additive.

### Concept note additivity

`buildConceptMap()` in `obsidian.js` builds a fresh concept→sessions mapping on every run from the full corpus. Concept notes are regenerated from scratch on each run. The sentinel system preserves user annotations. This means concept notes gain new sessions and decisions on each re-run without requiring explicit diff logic — the full regeneration is always correct, and the sentinel preserves manual work.

---

## 10. The `defrag.json` Manifest

After each complete run, `defrag.json` is written to the vault root. It serves three distinct roles.

### Role 1 — Web visualizer data

The GitHub Pages demo and local web visualizer read `defrag.json` to populate the block-grid animation with real data. Rather than hardcoded fake counts, the visualizer reads `stats.sessions`, `stats.concepts`, `stats.snippets`, and `stats.links` and drives the grid dimensions accordingly. The `topConcepts` array populates the concept ticker in the visualizer.

### Role 2 — QMD collection metadata

QMD reads `defrag.json` to bootstrap its understanding of the vault before indexing. The `sources` object tells QMD which tools contributed data and how many sessions each produced. The `vault` path tells QMD where to find the Markdown files. This allows `qmd collection add <vault>` to skip filesystem discovery entirely for the initial collection setup.

### Role 3 — Incremental run support (planned)

The `generated` timestamp and per-source session counts are the foundation for automatic incremental runs. A future implementation will read `defrag.json` on startup and automatically apply a `--since` filter based on `generated`, without requiring the user to pass `--since` manually. Per-source counts allow this to work correctly when only some sources have new data.

### Full schema

```json
{
  "version": "1.0",
  "generated": "2025-06-01T14:23:41.000Z",
  "vault": "/Users/alice/vault",
  "signalThreshold": 8,
  "model": "claude-opus-4-5",
  "sources": {
    "claude": {
      "found": true,
      "sessions": 142,
      "path": "~/.claude/projects/"
    },
    "cursor": {
      "found": true,
      "sessions": 38,
      "path": "~/Library/Application Support/Cursor/"
    },
    "codex": {
      "found": false,
      "sessions": 0,
      "path": "~/.codex/"
    }
  },
  "stats": {
    "sessions":     180,
    "concepts":     412,
    "snippets":     891,
    "urls":         234,
    "links":        1847,
    "filesWritten": 603
  },
  "topConcepts": [
    "AEM", "TypeScript", "OSGi", "React", "PostgreSQL",
    "Docker", "GraphQL", "Sling", "Next.js", "Redis"
  ]
}
```

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Manifest schema version. Currently `"1.0"`. Increment on breaking changes. |
| `generated` | ISO 8601 string | Timestamp of this run's completion. Used for incremental run support. |
| `vault` | string | Absolute path to the vault root, as resolved by `path.resolve(opts.output)`. |
| `signalThreshold` | number | The `--min-signal` value used for this run. Stored so re-runs can verify threshold consistency. |
| `model` | string? | Optional LLM model hint, set via `--model`. Not used by the pipeline; informational metadata for QMD and the visualizer. |
| `sources[name].found` | boolean | Whether this source's storage root was found on disk during this run. |
| `sources[name].sessions` | number | Sessions successfully read from this source on this run (post-`--since` filter, pre-dedup). |
| `sources[name].path` | string | Display path shown in CLI output and visualizer. Always present even when `found: false`. |
| `stats.sessions` | number | Total sessions processed (post-deduplication). |
| `stats.concepts` | number | Unique concept strings extracted across all sessions (before signal filtering). |
| `stats.snippets` | number | Total code snippets extracted across all sessions. |
| `stats.urls` | number | Total unique URLs extracted across all sessions. |
| `stats.links` | number | Wikilinks injected by the linker in this run. |
| `stats.filesWritten` | number | Vault files written (new or updated) in this run. Does not include skipped files. |
| `topConcepts` | string[] | Top 10 concepts by raw cross-session frequency, in display-cased form. Frequency is raw `conceptFreq` count, not signal score. |

---

## 11. Vault Structure Decisions

### Why `{source}-{date}-{title}` for session filenames?

```
claude-2025-05-14-fix-osgi-bundle-activation.md
cursor-2025-05-21-refactor-dispatcher-config.md
```

The source prefix (`claude-`, `cursor-`) makes the tool origin visible at a glance in any file browser without opening the file. The date prefix ensures chronological sort in alphabetically-sorted file trees (Obsidian's default). The title slug makes the filename human-readable without needing to open the file. The combination is collision-resistant in the common case without needing a UUID suffix.

The slug is constructed as:
```js
session.title
  .replace(/[^a-zA-Z0-9 ]+/g, ' ')
  .replace(/\s+/g, '-')
  .toLowerCase()
  .slice(0, 50)
  .replace(/-+$/, '')
```

### Why a flat `concepts/` directory?

Concept notes have no discoverable hierarchy. An auto-assigned taxonomy (grouping concepts by technology domain) would be wrong enough of the time to be more confusing than helpful. Obsidian's graph view and backlinks provide the actual organizational structure. Users who want folder-based organization can move concept notes manually — Obsidian resolves wikilinks globally by note title, not by path, so moves don't break links.

### Why session notes by date, not by project?

Sessions are atomic units of context. A session in a "my-rust-project" workspace might discuss TypeScript (comparative analysis), OSGi (tangential docs reading), and Rust (main topic). Organizing by project forces a choice about which project a session "belongs to." Date-first organization avoids this: sessions are what they are. Cross-project grouping happens naturally through concept notes, which aggregate all sessions mentioning a concept regardless of their originating workspace.

### The `code/` directory

Code snippets are extracted into standalone notes in `code/` rather than inlined into session notes for two reasons:

1. **Length**: code blocks can be hundreds of lines. Inlining them makes session notes unwieldy.
2. **Reusability**: a useful code snippet might be referenced from multiple session notes and concept notes. Standalone notes can be wikilinked from multiple places; inline code cannot.

Snippet notes are named `snippet-001.md`, `snippet-002.md` in global sequential order across all sessions (not per-session). This keeps `code/` flat. The sequential index is assigned during the `write()` loop as `snippetIndex` increments across all sessions — the index is stable within a run but may change between runs if the session set changes. The snippet's `session` backlink is always present regardless of index changes.

### Frontmatter schema

**Session notes:**
```yaml
---
title: "Fix OSGi Bundle Activation"
source: claude
date: 2025-05-14T17:23:41.000Z
turns: 24
signal: 47
concepts: 12
tags: [session, claude]
---
```

**Concept notes:**
```yaml
---
title: "OSGi Bundle Lifecycle"
tags: [concept, claude, cursor]
signal: 24
sessions: 6
decisions: 3
first-seen: 2025-02-14
last-seen: 2025-05-21
---
```

**Code snippet notes:**
```yaml
---
title: "Code Snippet 042"
tags: [code, java, claude]
source: claude
date: 2025-05-14
language: java
---
```

The `source` field enables QMD's `--source` filter. The `tags` field powers Obsidian's tag-based navigation. The `signal`, `sessions`, and `decisions` fields on concept notes are indexed as numeric facets by QMD, enabling queries like "concepts with more than 3 decisions."

---

## 12. QMD Integration

QMD is the semantic search companion to `context-defrag`. After running `context-defrag`, users run:

```bash
qmd collection add ./vault --name llm-context
qmd embed
qmd query "your question here"
```

### How the integration works

1. `qmd collection add ./vault` reads `defrag.json` from the vault root. It uses the `sources` object to understand the collection's provenance and the `stats` object for collection metadata.

2. `qmd embed` indexes all Markdown files in the vault. It uses the front-matter `source`, `date`, and `tags` fields as filterable facets alongside the semantic embedding of the body text.

3. `qmd query "replication retry policy" --source claude --concept osgi` performs a semantic + faceted search across the indexed collection.

### Why the vault is QMD-friendly

The vault is designed to be a good QMD input:

- **Structured front-matter**: filterable metadata on every file
- **Short, focused notes**: concept notes are typically 200–500 words — the right granularity for embeddings
- **Explicit links**: wikilinks create a graph structure that QMD can use for link-based re-ranking
- **Stable paths**: filenames are deterministic, so QMD's incremental indexing (comparing content hashes) works correctly across re-runs

### Collections

| Vault directory | QMD collection | Notes |
|-----------------|----------------|-------|
| `sessions/` | `sessions` | Indexed by date, source, concept count, signal score |
| `concepts/` | `concepts` | Primary semantic documents — highest embedding quality |
| `code/` | `snippets` | Language-aware tokenization; code content weighted higher |
| `links.md` | `links` | URL index; useful for "find where I referenced X docs" |
| `_timeline.md` | `meta` | Structural document; typically excluded from semantic search |
| `_low-signal.md` | `meta` | Term index; useful for full-corpus search, not semantic |

---

## 13. Extension Points

### Adding a new miner

1. Create `cli/miners/<toolname>.js` implementing the standard interface:

```js
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

/**
 * mine({ since, verbose }) → { source, sessions, skipped? }
 *
 * sessions: Array of normalized Session objects:
 * {
 *   source:    '<toolname>',
 *   id:        string,          // stable FNV-1a hash derived from file path
 *   filePath:  string,          // original source file path (provenance)
 *   title:     string,          // ≤80 chars, human readable
 *   timestamp: Date,            // session start time
 *   messages:  Message[],       // [{ role, content, timestamp? }]
 *   turnCount: number,
 *   // optional: workspacePath for cross-project scoring
 * }
 *
 * Return { source, sessions: [], skipped: [rootPath] } if source not found.
 * Return { source, sessions: [] } with no skipped if found but empty.
 */
async function mine({ since, verbose } = {}) {
  // 1. Discover source files/databases
  // 2. Parse into normalized Session objects
  // 3. Apply since filter: if (since && session.timestamp < since) continue;
  // 4. Deduplicate internally if multiple sources can yield the same session
  return { source: '<toolname>', sessions };
}

module.exports = { mine };
```

2. Register in `cli/defrag.js`:

```js
const myToolMiner = require('./miners/mytool');

const MINER_MAP = {
  claude: claudeMiner,
  codex:  codexMiner,
  cursor: cursorMiner,
  mytool: myToolMiner,           // ← add here
};

const ALL_SOURCES = ['claude', 'codex', 'cursor', 'mytool'];  // ← add here

const SOURCE_DISPLAY_PATHS = {
  claude: '~/.claude/projects/',
  codex:  '~/.codex/',
  cursor: '~/Library/Application Support/Cursor/',
  mytool: '~/.mytool/',          // ← add here
};
```

3. Add the source to the `--sources` option documentation in `printHelp()`.

**Critical contract**: The `id` field must be stable and unique across runs. Use FNV-1a hash over a stable file path as used by existing miners. If your source stores multiple conversations per file (like Claude Desktop format), incorporate a stable per-conversation identifier (UUID or deterministic line index) into the hash input. An unstable ID will cause session notes to be re-created as new notes on every run.

---

### Adding a new extraction heuristic

The extraction engine in `cli/extractor.js` has a clean extension pattern. The `extract()` function is the entry point:

```js
function extract(session) {
  const fullText = session.messages.map((m) => m.content).join('\n\n');
  return {
    concepts:  extractConcepts(fullText),
    decisions: extractDecisions(session.messages),
    snippets:  extractSnippets(fullText),
    urls:      extractUrls(fullText),
    entities:  extractEntities(fullText),
    // ← new field here
  };
}
```

To add a new extraction type:

1. Write an `extractX(text | messages)` function in `extractor.js` following the existing patterns. Keep it pure — no I/O, no side effects.
2. Add the result to the returned object in `extract()`.
3. If it should influence signal scoring, add a counter for it in `computeSignalScore()` and update the formula.
4. Update `renderSessionNote()` in `obsidian.js` to include the new field in session notes.
5. Update `renderConceptNote()` in `obsidian.js` if concepts should aggregate the new field.
6. Update `defrag.json` manifest generation in `defrag.js` if it should appear in stats.

The extraction system's contract is: **pure functions, no side effects, no I/O.** `extract()` takes a session object and returns a plain data object. This makes extraction trivially testable (`assert.deepEqual(extract(mockSession), expected)`) and safely parallelizable if a future version adds concurrency.

---

### Adding a new note type

The writer in `cli/writers/obsidian.js` has a clear pattern for adding new note types:

1. Write a `renderXNote(data, context)` function returning a Markdown string with YAML frontmatter. End the generated section with `<!-- defrag:end -->\n` so user annotations are preserved.
2. Add a section to `write()` that calls `renderXNote()` for each relevant data item and passes the result to `writeNote()`.
3. Create the directory in `write()`'s setup block:
   ```js
   ensureDir(path.join(outputDir, 'mytype'));
   ```
4. The linker's `collectMarkdownFiles()` walks the entire vault tree recursively — new directories and their files are automatically picked up for link injection with no changes to `linker.js`.
5. If the new note type should appear in `defrag.json` stats, add a counter in `defrag.js`'s stats aggregation.
6. Document the new QMD collection in the [QMD Integration](#12-qmd-integration) section.

---

### Adding a new signal scoring factor

The signal scoring formula is in `computeSignalScore()` in `extractor.js`:

```js
return (sessionCount * 2) + (decisionCount * 5) + (codeCount * 3) + (crossProjectCount * 4);
```

To add a new factor (e.g. `urlCount` — concepts that appear near referenced URLs):

1. Add the counter to the accumulation loop in `computeSignalScore()`.
2. Choose a weight. Use the existing weight rationale as a guide: how confident are you that this signal indicates genuine knowledge crystallization? Compare to the existing factors: is it stronger or weaker evidence than a decision sentence? A code co-occurrence?
3. Update the formula comment in the source file.
4. Update the `--min-signal` documentation in `defrag.js → printHelp()`.
5. Re-calibrate the default threshold if the new factor significantly changes the score distribution. A useful approach: run with `--dry-run --verbose` on a known corpus before and after the change and compare the count of concepts above the threshold.

---

### Tuning the stopword and keyword lists

Three lists in `extractor.js` control what gets extracted and how:

**`CONCEPT_STOPWORDS`**: Terms filtered before concept scoring. Add terms that appear frequently in your sessions but carry no signal. These should be programming constructs, generic English nouns in developer contexts, and structural terms. Removing a term from this list will allow it to be scored and potentially promoted to a concept note.

**`STOP_PHRASES`**: Title-case multi-word phrases that look like concepts but are English connectives. The `TITLE_CASE_RE` pattern is intentionally aggressive — it catches everything with two or more capitalized words, including "The Following" and "It Is" — so this list prevents those from being scored. Add phrases that appear in your corpus and produce false positives.

**`TECH_KEYWORDS`** + **`KEYWORD_DISPLAY`**: The canonical tech keyword list and their display-cased forms. To add a new technology:
1. Add the lowercase term to `TECH_KEYWORDS`.
2. Add `'lowercase': 'DisplayForm'` to `KEYWORD_DISPLAY`. Without a display entry, the term will appear lowercased in concept notes (e.g., `mytech` instead of `MyTech`).

Note that `TECH_KEYWORDS` matches exact word boundaries — adding `'nextjs'` matches "nextjs" but not "next.js". The display entry `'nextjs': 'Next.js'` handles the display form. If your technology name contains punctuation, add both the sanitized form (for matching) and ensure the display form is set.
