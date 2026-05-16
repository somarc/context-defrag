# Context Defrag — Architecture

> Technical reference for contributors and the curious.
> For usage, see the [README](../README.md).

---

## Table of Contents

1. [Philosophy](#philosophy)
2. [Pipeline Overview](#pipeline-overview)
3. [Signal Scoring](#signal-scoring)
4. [Excerpt Ranking](#excerpt-ranking)
5. [Session Narrative Construction](#session-narrative-construction)
6. [Tiered Note Creation](#tiered-note-creation)
7. [The Linker](#the-linker)
8. [Source Formats](#source-formats)
   - [Claude Miner](#claude-miner)
   - [Cursor Miner](#cursor-miner)
   - [Codex CLI Miner](#codex-cli-miner)
9. [Idempotency](#idempotency)
10. [The `defrag.json` Manifest](#the-defragjson-manifest)
11. [Vault Structure Decisions](#vault-structure-decisions)
12. [QMD Integration](#qmd-integration)
13. [Extension Points](#extension-points)

---

## Philosophy

### The core problem

LLM conversations are ephemeral by design. Claude, Cursor, Codex — they all persist their history to disk in structured formats. The raw data exists. But it is fragmented: hundreds of sessions scattered across different storage locations, different formats, different naming schemes. Each session is an island. The knowledge inside them does not accumulate.

If you spent three hours working through why AEM's replication transport needs a custom retry policy, that reasoning lives in one JSONL file under an opaque UUID directory. It doesn't connect to the Cursor session from two weeks later where you ran into the same retry problem in a different project. It doesn't connect to the code snippet you extracted at the time. It doesn't surface when you search your notes. It evaporates.

**Context Defrag's job is defragmentation**: finding signal scattered across hundreds of sessions and consolidating it into a form that persists and compounds. The raw JSONL files are like a fragmented disk — all the data is there, but reading it requires seeking everywhere. The vault is the defragmented disk — knowledge laid out contiguously so it can actually be read.

### The two-layer output model

The tool produces two distinct layers, each optimized for a different access pattern:

**Vault layer** (`concepts/`, `sessions/`, `code/`, `links.md`, `_timeline.md`): structured, human-readable Markdown optimized for Obsidian's graph navigation and manual curation. A human can open this vault, browse the graph, click into a concept note, and immediately see every session where that concept was discussed, every decision made about it, and every related concept. The vault is the primary interface. It is designed for exploration, not just search.

**Search layer** (QMD): a semantic index over the vault, consumed programmatically by [QMD](https://github.com/your-username/qmd). QMD reads `defrag.json` to discover the vault contents, indexes the structured body text, and exposes filtered queries like `qmd query "replication retry" --source claude --since 30d`. The search layer is for retrieval when you know roughly what you're looking for but don't want to browse.

These layers complement each other. The vault is for discovery and serendipitous connection. QMD is for targeted lookup. Neither alone is sufficient.

### Why heuristic extraction, not LLM summarization

The extraction pipeline is entirely heuristic — regex patterns, keyword matching, frequency analysis, sentence windowing. No LLM is called during a standard run. This was a deliberate architectural choice with specific tradeoffs:

**Speed**: heuristic extraction runs a full corpus of 200 sessions in 3–5 seconds. An LLM summarization pass at one call per session would take 10–20 minutes, even with parallelism.

**Privacy**: the user's conversation history stays on their machine. No bytes of chat history leave the local process. Many users run this tool on codebases, codebases that contain proprietary logic, credentials in prompts, and unreleased product details.

**Reproducibility**: heuristics are deterministic. The same input always produces the same output. This makes re-runs predictable and diffing meaningful — if a note changed between runs, it's because the source data changed, not because an LLM chose different phrasing.

**Cost**: zero API calls means zero cost, no rate limits, and no dependency on external service availability.

**The tradeoff accepted**: heuristic extraction has lower semantic understanding than a language model. It will miss metaphors, indirect references, and nuanced reasoning. The decision sentences it finds are pattern-matched, not understood. This is acceptable because:

1. The heuristics are tuned for *recall* over *precision* — it is better to include a borderline sentence than to miss a real decision.
2. The vault is designed to be curated by the user, not consumed blindly.
3. LLM summarization is available as an opt-in `--synthesize` flag (planned) for users who want to upgrade specific concept notes after initial extraction.

The philosophy is: run the cheap pass first, get 80% of the value immediately, and let users opt into the expensive pass for the notes that matter most.

---

## Pipeline Overview

Context Defrag is a seven-phase pipeline: **scan → deduplicate → extract → write → link → manifest → QMD**.

Each phase is independently scoped. Miners produce a normalized intermediate representation. The extraction engine operates only on that normalized form — it has no knowledge of source formats. The writer consumes extracted data. The linker runs as a post-processing pass over the written vault.

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
                    Session[]                       ← normalized objects
                  { source, id, title,
                    timestamp, messages[],
                    turnCount, filePath }
                              │
                              ▼
                    deduplicateSessions()           ← ID-based dedup
                              │
                              ▼
                    extract(session)                ← per-session
                  { concepts[], decisions[],
                    snippets[], urls[],
                    entities[] }
                              │
                              ▼
                    enriched[]                      ← { session, extracted }
                  { session, extracted }
                              │
                              ▼
              ┌───────────────┼──────────────────────────┐
              │               │                          │
              ▼               ▼                          ▼
      session notes    concept notes            code / links /
      sessions/*.md    concepts/*.md            timeline / index
              │               │                          │
              └───────────────┼──────────────────────────┘
                              ▼
                    writeNote()                     ← idempotent
                    (content-hash diff)
                              │
                              ▼
                    link()                          ← post-process
                    (wikilink injection)
                              │
                              ▼
                    defrag.json                     ← manifest
```

### Phase 1 — Scan

`defrag.js` iterates over the requested source names (`claude`, `codex`, `cursor`), calls `miner.mine({ since, verbose })` on each, and accumulates `Session[]` results. Errors are caught per-miner — a broken Cursor installation does not abort Claude mining.

The `--since <date>` flag is passed to miners at this stage. Miners apply date filtering before returning sessions, so the extraction phase never sees stale data.

### Phase 2 — Deduplicate

After all miners return, sessions are deduplicated by `session.id`. Each miner computes IDs deterministically from file paths (FNV-1a hash), so the same conversation file discovered through multiple search roots (e.g. via symlinks or both `.claude/` and `Library/Application Support/Claude/`) produces a single session.

### Phase 3 — Extract

`extract(session)` runs on each deduplicated session. It operates on the full concatenated message text and produces a flat extracted object (see [Extraction Engine](#extraction-engine) below). The per-session extracted results are accumulated into `conceptFreq` — a Map used later to compute cross-session concept frequency.

### Phase 4 — Write (vault)

`write({ outputDir, sessions: enriched, dryRun, verbose })` creates all output files. It is responsible for the vault's directory structure and file content. The `writeNote()` helper inside is idempotent: if the file already exists and content is identical, it is skipped (`stats.skipped++`). Otherwise it is overwritten (`stats.written++`).

### Phase 5 — Link

`link({ vaultDir, dryRun, verbose })` runs as a separate post-processing pass over the written vault. It builds a registry of all note titles, then injects `[[wikilinks]]` into the text zones of each note. Running this as a separate pass (not inline during write) simplifies the writer: notes can reference each other without needing to know during write time whether the target note will exist.

### Phase 6 — Manifest

`defrag.json` is written to the vault root with aggregate statistics, source metadata, and the top concepts list. This file is the handshake between the CLI, the web visualizer, and QMD.

### Phase 7 — QMD Integration (optional)

If `--gpt-ko` is passed, the CLI attempts to auto-invoke `qmd collection add` if the `qmd` binary is in `PATH`. Whether or not the binary is found, it prints the manual QMD integration instructions.

### Watch mode

`--watch` keeps the process running after the first pipeline completion. It uses `fs.watch()` with `{ recursive: true }` on all detected source directories and re-runs the full pipeline after a 2-second debounce. The debounce prevents thrashing when an LLM client writes multiple files in rapid succession (common when Claude Code streams a long session). `.lock` and `.DS_Store` changes are filtered out at the watch event handler.

---

## Signal Scoring

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
    const appearsInSession = (extracted.concepts || []).some(
      (c) => c.toLowerCase() === conceptLower
    );
    if (!appearsInSession) continue;

    sessionCount++;
    for (const d of (extracted.decisions || []))
      if (re.test(d)) decisionCount++;
    for (const s of (extracted.snippets || []))
      if (s && s.code && re.test(s.code)) codeCount++;

    if (session.source)        projectSources.add(session.source);
    if (session.workspacePath) projectSources.add(session.workspacePath);
  }

  const crossProjectCount = projectSources.size;
  return (sessionCount * 2) + (decisionCount * 5) + (codeCount * 3) + (crossProjectCount * 4);
}
```

### Weight rationale

**`sessionCount × 2` — Raw frequency (lowest weight)**

Session count is a necessary but weak signal. A concept appearing in many sessions just means it's common in your stack — not that it's worth a dedicated note. "JavaScript" might appear in every session, but "JavaScript" is not a useful concept note. The weight is 2 rather than 1 because multiple sessions do provide mild evidence that the concept is recurring, but it needs to be combined with other signals to matter. Consider this the "at least it's not one-off" contribution.

**`decisionCount × 5` — Explicit decisions (highest weight)**

Decision sentences are the gold. "We chose SQLite over Postgres because we need zero-dep distribution" — that sentence represents crystallized reasoning that took real effort to arrive at. It encodes a tradeoff. It would be painful to re-derive. If a concept appears in decision language across your sessions, it was worth reasoning about explicitly, which means it's worth preserving explicitly.

The 5× weight reflects this: one decision sentence is worth more than two raw session appearances. A concept with a single decision hit scores `(1×2) + (1×5) = 7`, which is near (but below) the default threshold — signaling that a concept discussed once with one explicit decision is on the boundary of being notable.

**`codeCount × 3` — Code co-occurrence (medium-high weight)**

When a concept appears in both conversation text and code snippets within the same session, the concept has moved from discussion into implementation. It is being actively used, not just talked about. A concept that only appears in prose might be speculative; one that appears in code is operational.

Weight 3 is higher than session frequency (2) because code evidence is more concrete, but lower than decisions (5) because code presence doesn't mean the concept was *understood* — sometimes concepts appear in code snippets incidentally.

**`crossProjectCount × 4` — Cross-workspace relevance (near-highest weight)**

`crossProjectCount` is built from the set of distinct `session.source` and `session.workspacePath` values across all sessions mentioning the concept. A concept that spans multiple projects or workspaces is a genuine cross-cutting concern in your work.

The 4× weight reflects that cross-project recurrence is the strongest indicator of structural importance. "AEM Replication" showing up in three different workspace paths means you've thought about it in three different problem contexts. That's a concept that deserves its own note. "AEM Replication" showing up 50 times in one project might just be background noise from a focused week of work.

### The default threshold: 8

The default minimum signal score (`--min-signal 8`) was chosen to filter out:

- **Single-session, no-decision concepts** (score: 2) — too weak
- **Common tech terms with no decisions or code** — e.g. a concept appearing in 2 sessions but never in a decision or code snippet scores 4

To cross the threshold with `score ≥ 8`, a concept needs at least one of these combinations:
- 2 sessions + 1 decision sentence: `(2×2) + (1×5) = 9` ✓
- 1 session + 1 code snippet + 1 cross-project mention: `(1×2) + (1×3) + (1×4) = 9` ✓
- 4 sessions (cross-project): `(2×2) + (2×4) = 12` ✓ (appears in 2 different workspaces)
- 1 session + 2 decisions: `(1×2) + (2×5) = 12` ✓ (heavily reasoned about)

The threshold is tunable via `--min-signal <n>`. Lower it to include more borderline concepts; raise it to keep only the most certain signal.

### What happens to low-signal concepts

Concepts that don't meet the threshold are not discarded. They are written to `_low-signal.md` as a searchable alphabetical index with mention counts. This serves two purposes:

1. **Completeness**: the raw concept still exists somewhere in the vault if you want to find it via QMD or Obsidian search.
2. **Graph cleanliness**: `_low-signal.md` is one file, not one file per term. A vault with 8,000 individual concept nodes is unusable as a knowledge graph. The tier system ensures the graph contains ~50–500 high-signal nodes that represent your actual knowledge topology.

If you later realize a low-signal concept is actually important, re-run with `--min-signal 4` to promote it to a full note.

---

## Excerpt Ranking

Excerpt ranking is the mechanism by which concept notes acquire meaningful, quoted context from the sessions that mention them, rather than just session titles.

### The problem

A concept note for "OSGi Bundle Lifecycle" that just says "mentioned in 4 sessions" is marginally useful. A concept note that quotes the three sentences where you explicitly worked through why bundle activation order matters is actually valuable — it reconstructs your reasoning without requiring you to re-read the sessions.

### The algorithm

Implemented in `extractor.js → extractConceptExcerpts()`.

For each concept, iterate over every session that contains it. For each session, iterate over each message. Within each message, split into paragraphs, then into sentences. For each sentence that contains the concept (via word-boundary regex), extract a context window:

```
window = [sentence[i-1], sentence[i], sentence[i+1]].join(' ').slice(0, 300)
```

This one-before, current, one-after window provides context without padding. Sentences that are too short (`< 15 chars`) are filtered before windowing; the assembled window is capped at 300 characters to stay token-efficient for downstream QMD indexing.

Each candidate window is then scored:

```js
let score = 1; // base score
for (const pat of EXCERPT_SIGNAL_PATTERNS) {
  if (pat.test(window)) score += 2;
}
```

**Priority 3 (score += 2) — Decision language**:
```
/\b(decided|will use|going with|avoid|chosen|don't use|do not use|opted for|settled on)\b/i
```
These phrases mark explicit reasoning. An excerpt containing "we decided to avoid `BundleActivator` because..." is worth 3× more than a neutral descriptive sentence.

**Priority 2 (score += 2) — Problem framing**:
```
/\b(issue|problem|failing|broken|slow|error|bug|crash|failing)\b/i
```
Problem framing shows the context that motivated a decision. "The bundle keeps failing to activate" — this sentence tells you *why* a decision was needed, which makes adjacent decision sentences interpretable.

**Priority 1 (score += 2) — Code context**:
```
/\b(function|method|class|returns|throws|implements|extends|interface)\b/i
```
Sentences that connect the concept to implementation are more concrete than pure prose explanation.

Excerpts are **deduplicated by normalized text** (lowercase, whitespace-normalized). If two windows from different sessions are textually near-identical, only one is kept. After sorting by score descending, the top 5 are selected.

### Why sentence windows rather than full paragraphs

Full paragraphs would include too much context — they become mini-essays that defeat the goal of having a scannable concept note. Individual sentences without context are too cryptic ("just avoid the manual approach" — avoid what?). The three-sentence window is the minimum meaningful unit: it captures why the concept came up, the sentence containing it, and what immediately followed.

The 300-character cap ensures that windows remain atomic knowledge units composable for downstream semantic indexing. QMD's embeddings work best on focused, self-contained passages.

---

## Session Narrative Construction

Every session note includes a 2–3 sentence narrative at the top that answers: **what was this session about, and what came out of it?** When you're scanning 196 sessions in the `_timeline.md` view, this narrative is the difference between finding the right session in 10 seconds vs. 10 minutes.

Implemented in `extractor.js → extractSessionNarrative()`.

### Step 1 — Opening (the problem statement)

```js
const firstHuman = humanMessages[0].content || '';
const firstLine  = firstHuman
  .replace(/\n+/g, ' ')
  .trim()
  .split(/[.!?]\s+/)[0]
  .slice(0, 150)
  .trim();
```

The first human message is almost always a problem statement, question, or task. People open LLM sessions with intent. Taking the first sentence (split at `.`, `!`, or `?` followed by whitespace) and truncating to 150 characters captures this intent without including the full context dump that often follows.

Edge cases:
- If the first human message is empty or very short, fall back to `Topic: {session.title}`.
- The 150-character limit is a sentence-boundary truncation, not a hard cut — `split(/[.!?]\s+/)[0]` ensures we don't truncate mid-sentence.

### Step 2 — Approach (what was tried)

```js
const best = decisions
  .slice()
  .sort((a, b) => b.length - a.length)
  .find((d) => d.length <= 200);
```

Decision sentences extracted from the session are sorted by length descending. The longest decision sentence that fits within 200 characters is selected — length correlates with specificity (short decision sentences tend to be vague; long ones contain the actual reasoning).

If no decision sentences were extracted, fall back to:
```
Covered: {top 4 concepts}.
```

This fallback is weaker but honest — it tells you what topics were in play without fabricating a conclusion.

### Step 3 — Outcome (what was concluded)

Scan assistant messages in reverse order (most recent first) for conclusion language:
```js
const CONCLUSION_PATTERNS = [
  /\b(recommend|suggest|should|best approach|in summary|ultimately|conclusion|final)\b/i,
  /\b(the solution|the fix|the answer|the approach|going forward|next steps)\b/i,
];
```

The first matching sentence found (scanning backwards through assistant messages) becomes the outcome, truncated to 200 characters. If no conclusion language is found, the outcome is omitted — a 2-sentence narrative is better than a 3-sentence narrative with a fabricated conclusion.

### Assembly

```js
const parts = [opening, approach, outcome].filter(Boolean);
return parts.join(' ');
```

The result is 1–3 sentences: the minimum necessary to reconstruct the session's shape. It won't win literary prizes. The goal is functional recall, not quality prose.

---

## Tiered Note Creation

The vault uses a three-tier system to prevent graph pollution while preserving full-text coverage.

### Tier 1 — High-signal concept notes

Concepts with `signalScore ≥ threshold` (default 8) receive a standalone note in `concepts/`.

**File**: `concepts/{slug}.md`

**Content**:
- YAML frontmatter with `title`, `tags`, `source`, `date`
- `## Context` — a 2–3 sentence excerpt from the first session mentioning the concept (built by `buildContextSummary()` in `obsidian.js`)
- `## Related` — concepts that co-occur in the same sessions, sorted by co-occurrence frequency
- `## Mentions` — wikilinks to every session note that mentioned this concept
- `<!-- defrag:end -->` marker (future: content below preserved across re-runs)

**Graph behavior**: Tier 1 notes appear as nodes in the Obsidian graph. They connect to session notes (via `## Mentions` wikilinks) and to each other (via `## Related` wikilinks). This creates the knowledge topology that makes the graph useful.

**QMD behavior**: Tier 1 notes are primary documents in QMD's `concepts` collection, indexed with full semantic embeddings.

### Tier 2 — Low-signal concepts

Concepts with `signalScore < threshold` are collected into `_low-signal.md`, grouped alphabetically with their mention count.

```markdown
## A

- **async** (4 mentions)
- **array** (2 mentions)

## B

- **base** (3 mentions)
```

**Why not individual files?** The Obsidian graph is a visual knowledge map. If every term with 2 mentions becomes a node, the graph becomes a sea of dots with no navigable structure. `_low-signal.md` is a single file — it appears as one node, and that node is clearly labeled as the "noise bin."

**Promotability**: `_low-signal.md` is fully searchable by QMD and by Obsidian's built-in search. If you remember discussing something and want to find it, the low-signal index will surface it. You can then re-run with `--min-signal 4` to promote it to a Tier 1 note if it turns out to be worth it.

### Tier 3 — Stopwords (filtered at extraction time)

The `CONCEPT_STOPWORDS` set in `extractor.js` contains terms that carry zero knowledge signal and are filtered before concept candidates are even scored:

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

These are programming keywords, common English nouns in developer contexts, and structural terms that appear constantly but mean nothing on their own. Filtering them at extraction time means they never consume scoring CPU, never appear in concept maps, and never reach `_low-signal.md`.

The distinction between Tier 2 and Tier 3 is intent: Tier 2 terms might become interesting with more context or with a lower threshold. Tier 3 terms are definitionally uninteresting — no amount of sessions or decisions would make "null" a useful concept note.

### The graph philosophy

The Obsidian graph is meaningful only if its nodes represent things worth knowing about. A graph with 400 nodes, each a real concept you've worked with, is a knowledge map. A graph with 8,000 nodes — half of which are "string", "async", "data" — is noise. The tier system enforces the discipline that makes the graph useful: **the graph shows your actual knowledge topology, not a frequency distribution of your vocabulary**.

---

## The Linker

The linker (`cli/writers/linker.js`) runs as a post-processing pass over the written vault. Its job is to inject `[[wikilinks]]` into plain-text mentions of known note titles, so that concepts referenced in session notes automatically become navigable links in Obsidian.

### Why a separate pass?

The writer generates notes in sequence: session notes first, then concept notes. If wikilink injection happened during write time, session notes would need to know which concept notes exist before those notes are written. The linker solves this by running after all notes are written — it operates on a complete vault with full knowledge of all note titles.

### Pass 1 — Registry construction

```
buildRegistry(vaultDir)
  → collectMarkdownFiles(vaultDir)
  → for each file:
      extractTitle(content, filePath)    ← front-matter title, or H1, or filename
      extractAliases(content, title)     ← front-matter aliases[] + lowercase title
  → returns Entry[]
     { filePath, vaultPath, title, aliases }
```

Every Markdown file in the vault gets an entry. `vaultPath` is the path relative to the vault root without `.md` — e.g. `concepts/jackrabbit-oak`. This is the target string for wikilinks: `[[concepts/jackrabbit-oak|Jackrabbit Oak]]`.

**Alias registration**: The linker automatically registers the lowercase form of every title as an alias. So "Jackrabbit Oak" (the stored title) will match `jackrabbit oak` in plain text. The `aliases` front-matter field can be used to register additional variants.

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

Only `text` zones are candidates for link injection. Frontmatter, code blocks, code spans, and existing wikilinks are passed through unchanged. This prevents:
- Linking `yaml` keys in frontmatter
- Injecting wikilinks into code blocks (which would corrupt the code)
- Double-linking already-linked terms

The zone tokenizer uses a single regex pass to identify protected regions, interleaved with plain text:

```js
const PROTECTED_RE = /(```[\s\S]*?```|`[^`\n]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\))/g;
```

### The forward-scan position check

Within `text` zones, the linker uses `String.replace()` with a regex to find term occurrences. Before committing to a replacement, it checks whether the match position is inside a protected region that the zone tokenizer might have missed (edge cases involving partial matches at zone boundaries):

```js
const before       = text.slice(0, offset);
const openBrackets  = (before.match(/\[\[/g)  || []).length;
const closeBrackets = (before.match(/\]\]/g)  || []).length;
if (openBrackets > closeBrackets) return match; // inside a wikilink

const backticks = (before.match(/`/g) || []).length;
if (backticks % 2 !== 0) return match; // inside a code span
```

This forward-scan approach counts unclosed `[[` and unmatched backticks in the text preceding the match. If the counts indicate an unclosed protected region, the match is left as-is.

**Why not lookbehind regex?** Lookbehind for nested or multiline patterns is unreliable across Node.js versions prior to v22, and the patterns involved (arbitrary content between `[[` and `]]`) cannot be expressed as fixed-length lookbehind. The forward scan is O(n) per match but straightforward and portable.

### First-occurrence-only linking

The `linkifyTerm()` function replaces **all occurrences** via `String.replace(re, ...)` with a global regex. However, after the first replacement the match text becomes `[[vaultPath|term]]`, which is a `wikilink` zone in subsequent passes and will not be re-matched. The net effect is that each term is linked at most once per text zone, and since the zone tokenizer splits at existing wikilinks, the first occurrence in contiguous text gets the link and subsequent occurrences in the same zone do not. This is the correct behavior: a note about AEM Replication does not need "AEM" linked 47 times. One link establishes the connection; the rest are visual clutter.

### Self-link prevention

```js
if (entry.vaultPath === currentVaultPath) continue;
```

A note is never linked to itself. The "AEM Replication" concept note will not have `[[concepts/aem-replication|AEM Replication]]` injected into its own body.

---

## Source Formats

Each miner is responsible for a single source's format. All miners implement the same interface:

```js
async function mine({ since, verbose } = {}) {
  // returns: { source: string, sessions: Session[], skipped?: [] }
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
  // miner-specific:
  format?:    string,      // 'desktop' | 'code' (claude)
  workspace?: string,      // workspace hash (cursor)
}
```

### Claude Miner

**File**: `cli/miners/claude.js`

**Search roots** (checked in order):
```
~/.claude/
~/.config/claude/
~/Library/Application Support/Claude/    (macOS Claude Desktop)
```

All three roots are searched; the same file discovered in multiple roots (via symlinks) is deduplicated using `fs.realpathSync()` before processing.

**File discovery**: `walkDir()` recursively enumerates all `.jsonl` files under each root. No glob library is used — `fs.readdirSync()` with `withFileTypes: true` is called recursively. Permission errors and broken symlinks are silently skipped, since user home directories commonly contain inaccessible paths.

**Format detection**: The miner reads the first non-empty line of each file and calls `detectFormat()`:

```
Desktop format:  { "uuid": "...", "messages": [...] }
  → each line is a complete conversation
  → one file may contain multiple sessions

Code format:     { "type": "user", "message": { ... }, "timestamp": "..." }
  OR:            { "role": "human", "content": "...", "timestamp": "..." }
  → each line is a single turn
  → one file = one session
```

**Desktop format parsing** (`parseDesktopFile`): Each line is parsed as a complete conversation object with a `messages` array. Content arrays (Claude's API returns content as `[{type: "text", text: "..."}]` blocks) are flattened to plain text by `flattenContent()`. Tool-use and tool-result blocks are included if they contain text; otherwise skipped.

**Code format parsing** (`parseCodeFile`): Each line is parsed as a single turn. The three known message shapes are normalized:

| Shape | Detection | Fields used |
|-------|-----------|-------------|
| Shape A — direct | `obj.role && obj.content` | `role`, `content`, `timestamp` |
| Shape B — wrapped | `obj.message && obj.message.role` | `obj.type` or `obj.message.role`, `obj.message.content`, `obj.timestamp` |
| Shape C — legacy | `obj.type in ['human','assistant'] && obj.text` | `obj.type`, `obj.text`, `obj.createdAt` |

**URL-encoded project paths**: Claude Code stores project-scoped sessions in directories named after URL-encoded absolute paths, e.g.:
```
~/.claude/projects/%2FUsers%2Falice%2Fprojects%2Fmy-app/abc123.jsonl
```

The parent directory name is passed through `safeDecodeURIComponent()` and `path.basename()` to extract a human-readable project name for the session title fallback.

**Title derivation**: Primary source is the first human message, truncated to 60 characters. If the file is a Code-format file with a URL-encoded parent directory, the decoded directory basename is used as a secondary fallback. Final fallback is `Claude Session — {uuid}`.

**Timestamp derivation**: `deriveTimestamp()` iterates all messages looking for the earliest `message.timestamp` or `message.createdAt` value. If none are present, falls back to `fs.statSync(filePath).mtime`.

**Role normalization**:
```
"user", "human"           → "human"
"assistant", "ai", "bot"  → "assistant"
other                     → preserved as-is (e.g. "tool", "system")
```

**ID generation**: FNV-1a hash over the file path (Code format) or over `{filePath}:{lineIndex}` (Desktop format, since one file contains multiple conversations). This ensures stability across re-runs as long as the file path doesn't change.

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

Each `<workspace-hash>` is a hex digest of the workspace's absolute path, generated by VS Code's storage subsystem. The miner does not need to resolve the hash back to a path — the hash is used as a `workspace` identifier in the session object, and the workspace path can be recovered from the `state.vscdb` file itself if needed.

**SQLite loading**: The miner tries two SQLite drivers in order:

1. `node:sqlite` (Node.js 22+ built-in, `DatabaseSync`) — no native compilation, no binary dependencies
2. `better-sqlite3` (npm, requires native compilation) — fallback for Node < 22

If neither is available, the database is skipped with a verbose warning. This graceful degradation means the tool works on Node 20 environments as long as `better-sqlite3` is installed, and works out-of-the-box on Node 22+ with no additional dependencies.

**Chat key enumeration**: The following `ItemTable` keys are queried in order:

```js
const CHAT_KEYS = [
  'workbench.panel.aichat.view.aichat.chatdata',  // main chat panel
  'aiService.prompts',                             // inline prompts
  'aiService.generations',                         // code generation records
  'composer.composerData',                         // Composer multi-file sessions
  'aiService.chatHistory',                         // older key variant
  'cursor.chatHistory',                            // even older key variant
];
```

Cursor's storage schema has changed significantly across versions. Rather than version-detecting and dispatching, the miner attempts all known keys and handles "key not present" gracefully. This forward-compatible approach means new Cursor versions that add new keys require only a new entry in `CHAT_KEYS`.

**Payload shape normalization**: The JSON stored under each key has changed across Cursor versions. Three shapes are handled:

```
Shape A: { tabs: [{ chatTitle, lastSendTime, bubbles: [...] }] }
  → Cursor 0.40+, main chat panel
  → bubbles use type: "user" | "ai"
  → content in bubble.text | bubble.rawText | bubble.content

Shape B: [{ prompt, response, timestamp }]
  → older aiService.prompts format
  → flat array of prompt/response pairs

Shape C: { conversations: [{ id, title, messages: [...] }] }
  → aiService.generations and Composer
  → messages use role | type | sender for role field
  → content in content | text | message
```

For Shape A bubbles specifically:
```js
const role = bubble.type === 'ai'   ? 'assistant'
           : bubble.type === 'user' ? 'user'
           : bubble.role || null;
```

This covers both the old `"human"/"ai"` convention and the newer `"user"/"assistant"` convention without needing to version-detect.

**Log file fallback**: `mineLogFiles()` scans `~/Library/Application Support/Cursor/logs/` for `.log` files that contain `aiService`, `copilot`, or `chat` in their text. It then attempts to parse each line as JSON, looking for `prompt`/`completion`/`response` fields. This is a last-resort path for sessions that predate or bypass the workspace storage system. Log sessions receive the filename as their title and the file mtime as their timestamp.

**Deduplication**: After mining both workspace storage and logs, sessions are deduplicated by `session.id` within the Cursor miner before returning. This handles cases where the same chat appears in both storage systems.

---

### Codex CLI Miner

**File**: `cli/miners/codex.js`

**Search root**: `~/.codex/`

Codex CLI has undergone multiple storage format changes across versions. The miner uses a degradation-tolerant multi-strategy approach:

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
A single JSON array of all sessions. Same session shape as above.

**Strategy 3 — SQLite database** (`~/.codex/history.db`):
```sql
CREATE TABLE sessions (
  id      TEXT PRIMARY KEY,
  cwd     TEXT,
  created INTEGER,   -- unix timestamp
  messages TEXT      -- JSON array
);
```

**Strategy 4 — JSONL file** (`~/.codex/conversations.jsonl`):
One session per line, same shape as Strategy 1.

The miner checks for each format's existence in order and uses the first that exists. The `cwd` field, when present, is normalized to a project slug by taking `path.basename(cwd)`. This provides the workspace path context used in `crossProjectCount` scoring.

---

## Idempotency

Context Defrag is designed to be run repeatedly on a live vault — after every work session, on a cron schedule, or via `--watch`. Re-runs must update content without duplicating or destroying it.

### Content-based diffing

The `writeNote()` function in `obsidian.js` is the single point of all file I/O:

```js
function writeNote(filePath, content, { dryRun, verbose, stats }) {
  if (dryRun) { stats.written++; return; }

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing === content) { stats.skipped++; return; }
  }

  fs.writeFileSync(filePath, content, 'utf8');
  stats.written++;
}
```

The comparison is a full string equality check against the file content. This is O(n) in file size but files are small (typically < 10KB), and the check prevents unnecessary write syscalls and filesystem mtime updates. Unchanged notes report as `skipped` in the final summary.

**Why not SHA hashing?** Full string comparison is faster for small files and requires no additional state. The current implementation does not maintain a content-hash index — it reads the existing file and compares directly. A future optimization for very large vaults could store hashes in `defrag.json` to avoid the file read on unchanged records.

### The `<!-- defrag:end -->` marker system

Every generated note reserves the content below a `<!-- defrag:end -->` comment for user annotations. On re-runs, the writer regenerates everything above the marker and preserves everything below it.

```markdown
<!-- auto-generated above this line — do not edit -->
<!-- defrag:end -->

## My notes

This pattern came up again in the [[sessions/cursor-2025-06-01-dispatcher-config|June 1 Cursor session]].
Worth reading the official OSGi spec on activation order before revisiting.
```

The implementation: `writeNote()` checks for an existing file, splits on `<!-- defrag:end -->`, takes the user-written tail, appends it to the freshly generated head, and writes the result. If no marker exists in the existing file (i.e., the file was generated by an older version of the tool), the entire existing content is treated as auto-generated and overwritten.

This design means users can safely annotate any note immediately after a run. Their annotations will survive all subsequent re-runs indefinitely.

### Session ID stability

Session IDs are FNV-1a hashes of file paths (and for Claude Desktop format, file path + line index). As long as the source files don't move, IDs are stable. If a source file moves (e.g. Cursor updates its storage path), sessions will appear as new on the next run and the old session notes will remain as orphans. There is no merge step for relocated source files — this is acceptable because source storage paths rarely change.

### Concept note additivity

The `buildConceptMap()` function in `obsidian.js` builds a fresh concept→sessions mapping on every run. The concept note renderer uses this fresh map, not a diff against the existing vault. This means concept notes are regenerated from scratch on each run. The `<!-- defrag:end -->` marker ensures user annotations below the marker survive regeneration.

---

## The `defrag.json` Manifest

After each complete run, `defrag.json` is written to the vault root. It serves three distinct roles.

### Role 1 — Web visualizer data

The GitHub Pages demo and the local web visualizer read `defrag.json` to populate the block-grid animation with real data. Rather than hardcoding fake counts, the visualizer reads `stats.sessions`, `stats.concepts`, `stats.snippets`, and `stats.links` from the manifest and drives the grid dimensions accordingly. The `topConcepts` array populates the concept ticker in the visualizer.

### Role 2 — QMD collection metadata

QMD reads `defrag.json` to bootstrap its understanding of the vault before indexing. The `sources` object tells QMD which tools contributed data and how many sessions each produced. The `vault` path tells QMD where to find the Markdown files. This allows `qmd collection add <vault>` to skip filesystem discovery entirely for the initial collection setup.

### Role 3 — Incremental run support (planned)

The `generated` timestamp and per-source `lastProcessed` values are the foundation for `--since`-style incremental runs. A future implementation will read `defrag.json` on startup and automatically filter to sessions newer than `lastRun`, without requiring the user to pass `--since` manually. The per-source `lastProcessed` allows this to work correctly when only some sources have new data.

### Schema

```json
{
  "version": "1.0",
  "generated": "2025-06-01T14:23:41.000Z",
  "vault": "/Users/alice/vault",
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
| `version` | string | Manifest schema version. Currently `"1.0"`. |
| `generated` | ISO 8601 string | Timestamp of this run's completion. |
| `vault` | string | Absolute path to the vault root. |
| `model` | string? | Optional LLM model hint, set via `--model`. Not used by the pipeline; informational metadata for QMD. |
| `sources[name].found` | boolean | Whether this source's storage root was found on disk. |
| `sources[name].sessions` | number | Sessions read from this source on this run. |
| `sources[name].path` | string | Display path used in CLI output and visualizer. |
| `stats.sessions` | number | Total sessions processed (post-deduplication). |
| `stats.concepts` | number | Unique concept strings extracted across all sessions. |
| `stats.snippets` | number | Total code snippets extracted. |
| `stats.urls` | number | Total unique URLs extracted. |
| `stats.links` | number | Wikilinks injected by the linker. |
| `stats.filesWritten` | number | Vault files written (new or updated). |
| `topConcepts` | string[] | Top 10 concepts by cross-session frequency, display-cased. |

---

## Vault Structure Decisions

### Why `{source}-{date}-{title}` for session filenames?

```
claude-2025-05-14-fix-osgi-bundle-activation.md
cursor-2025-05-21-refactor-dispatcher-config.md
```

The source prefix (`claude-`, `cursor-`) makes the tool origin visible at a glance in the file browser without opening the file. The date prefix ensures chronological sort in any alphabetically-sorted file tree. The title slug makes the filename human-readable without requiring you to open the file. The combination is unique without needing a UUID suffix in the common case.

### Why a flat `concepts/` directory?

Concept notes have no discoverable hierarchy. An auto-assigned taxonomy (grouping concepts by technology domain, for example) would be wrong enough of the time to be more confusing than helpful. Obsidian's graph view and backlinks provide the actual organizational structure. Users who want folder-based organization can move concept notes manually — wikilinks continue to resolve correctly via Obsidian's global link resolution.

### Why session notes by date, not by project?

Sessions are atomic units of context. A session in a "my-rust-project" workspace might discuss TypeScript (because the user was comparing languages), OSGi (because they were reading docs), and Rust borrow checking (the main topic). Organizing by project forces a choice about which project the session "belongs to." Date-first organization avoids this: sessions are what they are, and cross-project grouping happens naturally through concept notes (which aggregate across all sessions mentioning a concept).

### The `code/` directory

Code snippets are extracted into standalone notes rather than inlined into session notes for two reasons:

1. **Length**: code blocks can be hundreds of lines. Inlining them makes session notes unwieldy.
2. **Reusability**: a useful code snippet might be referenced from multiple session notes and from concept notes. Standalone notes can be wikilinked from multiple places.

Snippet notes are named `snippet-001.md`, `snippet-002.md` in global sequential order (not per-session). This keeps the `code/` directory flat and avoids the need to coordinate numbering across sessions.

### Frontmatter schema

**Session notes:**
```yaml
---
title: "Fix OSGi Bundle Activation"
source: claude
date: 2025-05-14T17:23:41.000Z
turns: 24
tags: [session, claude]
---
```

**Concept notes:**
```yaml
---
title: "OSGi"
tags: [concept, claude]
source: claude
date: 2025-05-14
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

The `source` field in all notes enables QMD's `--source` filter. The `tags` field powers Obsidian's tag-based navigation. The `date` field is indexed as a sortable facet.

---

## QMD Integration

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
- **Short, focused notes**: concept notes are typically 200–500 words — the right size for embedding
- **Explicit links**: wikilinks create a graph structure that QMD can use for link-based re-ranking
- **Stable paths**: filenames are deterministic, so QMD's incremental indexing (comparing content hashes) works correctly across re-runs

### Collections

| Vault directory | QMD collection | Indexing notes |
|-----------------|----------------|----------------|
| `sessions/`     | `sessions`     | Indexed by date, source, concept list |
| `concepts/`     | `concepts`     | Primary semantic documents — highest embedding quality |
| `code/`         | `snippets`     | Language-aware tokenization; code content weighted higher |
| `links.md`      | `links`        | URL index; useful for "find where I referenced X docs" |
| `_timeline.md`  | `meta`         | Structural document; typically excluded from semantic search |

---

## Extension Points

### Adding a new miner

1. Create `cli/miners/<toolname>.js` implementing:

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
 *   id:        string,          // stable hash derived from file path
 *   filePath:  string,          // original source file path
 *   title:     string,          // ≤80 chars, human readable
 *   timestamp: Date,            // session start time
 *   messages:  Message[],       // [{ role, content, timestamp? }]
 *   turnCount: number,
 * }
 */
async function mine({ since, verbose } = {}) {
  // Discover source files
  // Parse them into Session objects
  // Apply since filter: if (since && session.timestamp < since) continue;
  // Return:
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

const ALL_SOURCES = ['claude', 'codex', 'cursor', 'mytool'];

const SOURCE_DISPLAY_PATHS = {
  // ...
  mytool: '~/.mytool/',          // ← add here
};
```

3. Add the source to the `--sources` option documentation in `printHelp()`.

**Important contract**: The `id` field must be stable and unique. Use a hash of the file path (FNV-1a as used by existing miners). If your source stores multiple conversations per file, incorporate a stable per-conversation identifier (UUID, line index) into the hash input.

---

### Adding a new extraction heuristic

The extraction engine is in `cli/extractor.js`. The `extract()` function is the entry point:

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

1. Write an `extractX(text | messages)` function in `extractor.js` following the existing patterns.
2. Add the result to the returned object in `extract()`.
3. Add the field to the `signalScore` formula if it should influence tiering (update `computeSignalScore()`).
4. Update `renderSessionNote()` in `obsidian.js` to include the new field in session notes.
5. Update `renderConceptNote()` if concepts should aggregate the new field.

The extraction system's contract is: **pure functions, no side effects, no I/O**. `extract()` takes a session object and returns a plain data object. This makes extraction trivially testable and safely parallelizable.

---

### Adding a new note type

The writer (`cli/writers/obsidian.js`) has a clear pattern for adding new note types:

1. Write a `renderXNote(data, context)` function that returns a Markdown string with YAML frontmatter.
2. Add a section to `write()` that calls `renderXNote()` for each relevant data item and calls `writeNote()` with the result.
3. Create the directory in `write()`'s directory setup block:
   ```js
   ensureDir(path.join(outputDir, 'mytype'));
   ```
4. Register the new directory with the linker: the linker's `collectMarkdownFiles()` walks the entire vault tree recursively, so new directories are picked up automatically with no changes to `linker.js`.
5. If the new note type should be indexed separately by QMD, document the new collection in the QMD Integration section.

---

### Tuning the stopword lists

Three lists control what gets filtered at extraction time:

**`CONCEPT_STOPWORDS`** (`extractor.js`): Terms filtered before concept scoring. Add terms that appear frequently in your sessions but carry no signal. These should be programming constructs, generic English nouns, and structural terms.

**`STOP_PHRASES`** (`extractor.js`): Title-case multi-word phrases that look like concepts but are actually English connectives. The pattern `TITLE_CASE_RE` is aggressive — it catches everything like "The Following" and "It Is" — so this list prevents those from reaching the concept stage.

**`KEYWORD_DISPLAY`** (`extractor.js`): The canonical display form for known-casing terms. If you add a new entry to `TECH_KEYWORDS`, add its display form here. Without a display entry, the term will appear lowercased in concept notes (e.g., `graphql` instead of `GraphQL`).

---

### Adjusting the signal weights

The signal scoring constants are in `computeSignalScore()` in `extractor.js`:

```js
return (sessionCount * 2) + (decisionCount * 5) + (codeCount * 3) + (crossProjectCount * 4);
```

If your workflow is heavily code-focused and you want code evidence weighted more highly, increase the `codeCount` multiplier. If you work primarily in a single project/workspace and `crossProjectCount` is always 1, you may want to reduce that weight and increase `decisionCount` weight to compensate.

The default threshold (`--min-signal 8`) should be re-evaluated after weight changes. A useful calibration approach: run with `--dry-run --verbose` and examine which concepts sit just above and just below the threshold; adjust weights or threshold until the boundary feels right for your corpus.
