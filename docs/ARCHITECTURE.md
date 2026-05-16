# Context Defrag — Architecture

> Technical reference for contributors and the curious.
> For usage, see the [README](../README.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Pipeline](#pipeline)
3. [Source Miners](#source-miners)
   - [Claude](#claude-miner)
   - [Codex CLI](#codex-cli-miner)
   - [Cursor](#cursor-miner)
4. [Extraction Engine](#extraction-engine)
5. [Note Naming and Slug Generation](#note-naming-and-slug-generation)
6. [Wikilink Resolution](#wikilink-resolution)
7. [Idempotency](#idempotency)
8. [Vault Structure Decisions](#vault-structure-decisions)
9. [Extension Points](#extension-points)

---

## Overview

Context Defrag is a four-stage pipeline: **scan → parse → extract → write**.

Each stage is independently testable and isolated behind a clean interface. Miners (source-specific readers) produce a normalized intermediate representation (`ConversationRecord[]`). The extraction engine operates only on that normalized form — it has no knowledge of source formats. The writer consumes extracted notes and resolves links before committing to disk.

```
  ┌──────────────────────────────────────────────────────────────┐
  │                        CLI (defrag.js)                       │
  └───────────────────────────┬──────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ClaudeMiner      CodexMiner      CursorMiner
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                    ConversationRecord[]          ← normalized IR
                              │
                              ▼
                     ExtractionEngine
                    (concepts, summaries,
                     code snippets, dates)
                              │
                              ▼
                       NoteGraph                 ← in-memory graph
                    (nodes + edges)
                              │
                              ▼
                    WikilinkResolver
                              │
                              ▼
                        VaultWriter              ← disk I/O
```

---

## Pipeline

### Stage 1 — Scan

The CLI resolves source paths (from defaults or `config.json`), checks existence, and hands a list of candidate file paths to each miner. No parsing happens at this stage.

```js
// src/scan.js
async function scan(sources) {
  const candidates = {};
  for (const [name, cfg] of Object.entries(sources)) {
    candidates[name] = await glob(cfg.pattern, { cwd: cfg.path });
  }
  return candidates;
}
```

### Stage 2 — Parse (Miners)

Each miner reads its native format and emits `ConversationRecord` objects into a shared async generator. The miner is the only component that understands the source format.

```ts
interface ConversationRecord {
  id: string;                  // stable, derived from source path
  source: 'claude' | 'codex' | 'cursor';
  projectSlug: string;         // normalized project/workspace name
  startedAt: Date;
  messages: Message[];         // [{role, content, timestamp?}]
  rawPath: string;             // original file path, for provenance
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
}
```

### Stage 3 — Extract

The extraction engine runs each `ConversationRecord` through a set of extractors:

| Extractor         | Output                                |
|-------------------|---------------------------------------|
| `SummaryExtractor`   | One-paragraph session summary      |
| `ConceptExtractor`   | Array of concept slugs             |
| `CodeExtractor`      | Fenced code blocks with language   |
| `DecisionExtractor`  | Explicit decisions / conclusions   |
| `DateExtractor`      | Canonical date for the session     |

Extraction is heuristic and does not require an LLM. `ConceptExtractor` uses a combination of frequency analysis, noun-phrase chunking (via `compromise`), and a configurable concept dictionary. For sessions where the assistant produces structured output (e.g., markdown headers), header text is also promoted to concept candidates.

### Stage 4 — Write

The `VaultWriter` takes the fully-resolved `NoteGraph` and writes Markdown files. It computes a diff against the existing vault (if `--update` is set) and only writes files that have changed. New files are always written; existing files are updated if their content hash differs.

---

## Source Miners

### Claude Miner

**Path:** `~/.claude/projects/<project-id>/`

Claude stores conversations as JSONL files, one line per message turn. Project directories are UUID-named; the miner reads all `.jsonl` files recursively.

```
~/.claude/projects/
└── proj_k9x2m4r8/
    ├── conversation.jsonl
    └── metadata.json
```

**JSONL line shape (observed):**

```json
{
  "uuid": "msg_01XyzAbc",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "..."}],
  "created_at": "2025-05-14T17:23:41Z",
  "model": "claude-opus-4-5"
}
```

The miner reads `metadata.json` for the project name and creation date, then streams the JSONL. Content arrays are flattened to plain text; tool-use and tool-result turns are included as structured blocks but tagged `role: "tool"` in the IR (skipped by extractors by default, includable via `--include-tool-calls`).

**Project slug derivation:** `metadata.json` contains a human-readable project name. If absent, the miner falls back to the directory UUID, truncated to 8 characters.

---

### Codex CLI Miner

**Path:** `~/.codex/`

Codex CLI stores session history in a mix of formats depending on version:

- **v0.x:** Individual JSON files per session (`~/.codex/sessions/<id>.json`)
- **v1.x+:** SQLite database at `~/.codex/history.db`, table `sessions` with a `messages` JSON column

The miner detects which format is present via a file-existence check and dispatches to the appropriate reader.

**SQLite schema (v1.x):**

```sql
CREATE TABLE sessions (
  id        TEXT PRIMARY KEY,
  cwd       TEXT,
  created   INTEGER,   -- unix timestamp
  messages  TEXT       -- JSON array
);
```

The `cwd` field is used as the project slug after path normalization.

**JSON session shape (v0.x):**

```json
{
  "id": "sess_19a",
  "cwd": "/Users/somarc/projects/myapp",
  "createdAt": 1715705021,
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

---

### Cursor Miner

**Path (macOS):** `~/Library/Application Support/Cursor/User/workspaceStorage/`

Cursor stores per-workspace SQLite databases. Each workspace directory is a hash of the workspace path. The miner enumerates all `*.vscdb` files and queries each for chat history.

**Discovery:**

```js
// Map hash → workspace path via workspaceStorage/manifest.json
// or by reading the 'vscdb' key 'workspace' in each db
const workspacePath = await db.get(
  "SELECT value FROM ItemTable WHERE key = 'workspace'"
);
```

**Relevant tables:**

```sql
-- Chat sessions
SELECT key, value FROM ItemTable
WHERE key LIKE 'aiService.chat%';

-- Inline edit sessions  
SELECT key, value FROM ItemTable
WHERE key LIKE 'aiService.generations%';
```

The `value` column contains JSON-encoded chat history. Message shapes vary across Cursor versions; the miner normalizes all observed variants to the `Message` IR.

**Known variants:**

| Cursor Version | `role` field    | Content field     |
|----------------|-----------------|-------------------|
| < 0.40         | `"human"` / `"ai"` | `"text"`       |
| 0.40+          | `"user"` / `"assistant"` | `"content"` |

The miner maps both to the canonical `"user"` / `"assistant"` roles.

---

## Extraction Engine

### Concept Extraction

Concept extraction runs in three passes:

**Pass 1 — Structural signals**
Extract markdown headers (`##`, `###`) from assistant messages. These are high-confidence concept candidates: if the assistant structured a response around a header, that topic is salient.

**Pass 2 — NLP noun phrases**
Run `compromise` (lightweight NLP library, no network calls) over the full conversation text. Extract noun phrases longer than one token; filter against a stopword list; score by frequency × position weight (earlier mentions score higher).

**Pass 3 — Dictionary match**
Match against an optional `concepts.json` dictionary of known terms (e.g., `["borrow checker", "async runtime", "CRDT"]`). Dictionary matches bypass the frequency threshold.

Candidates from all three passes are merged, deduplicated, and normalized to slugs. The top `N` (default: 20) are attached to the `ConversationRecord`.

### Summary Extraction

The `SummaryExtractor` takes the first user message and the last assistant message of a session and constructs a summary using a template:

```
[first user message, truncated to 200 chars]
→ [last assistant message, truncated to 300 chars]
```

This is intentionally simple and offline. A future `--llm-summarize` flag will enable calling a local Ollama model for richer summaries.

### Code Extraction

All fenced code blocks from assistant messages are extracted with their declared language. Blocks over 50 lines are truncated in the session note but written in full to `vault/snippets/<session-slug>-<n>.md` and linked.

---

## Note Naming and Slug Generation

All note filenames are generated deterministically from their content identity — never from human input directly — to ensure stability across re-runs.

### Session notes

```
vault/sessions/YYYY-MM-DD-<project-slug>[-<n>].md
```

- Date is the `startedAt` date of the first message.
- `<project-slug>` is the normalized project name: lowercased, spaces to hyphens, non-alphanumeric stripped, max 40 chars.
- `<n>` is a disambiguation suffix (2, 3, …) if multiple sessions share a date and project slug.

Examples:
```
2025-05-14-my-rust-project.md
2025-05-14-my-rust-project-2.md
2025-05-13-dotfiles.md
```

### Concept notes

```
vault/concepts/<concept-slug>.md
```

- Concept slugs are derived from the concept text: lowercased, spaces to hyphens, non-alphanumeric (except hyphens) stripped.
- `borrow checker` → `borrow-checker.md`
- `async/await` → `asyncawait.md`
- `CRDT` → `crdt.md`

### Slug generation function

```js
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}
```

---

## Wikilink Resolution

Wikilinks are resolved in a two-pass process after all notes have been constructed in-memory.

### Pass 1 — Link collection

Each extractor annotates its output with *unresolved link targets* — strings like `"borrow checker"` or `"ownership"`. These are collected into a `LinkRequest[]` alongside the source note slug.

### Pass 2 — Resolution

The `WikilinkResolver` builds a lookup table of all known note slugs:

```js
const slugIndex = new Map(); // slug → NoteNode
for (const note of noteGraph.nodes()) {
  slugIndex.set(note.slug, note);
  // also index by title aliases
  for (const alias of note.aliases) {
    slugIndex.set(slugify(alias), note);
  }
}
```

For each `LinkRequest`, the resolver attempts:

1. **Exact slug match** — `slugify(target) === note.slug`
2. **Fuzzy match** — Levenshtein distance ≤ 2 against all known slugs (only used when `--fuzzy-links` is set; off by default to avoid false positives)
3. **Create stub** — if no match found and `--create-stubs` is set, emit a stub concept note

Resolved links are written as `[[concept-slug|Display Text]]`. Unresolved links with no stub are written as plain text with a `<!-- unresolved: target -->` comment for debugging.

---

## Idempotency

Context Defrag is designed to be run repeatedly on a live vault. Re-runs should update content, not duplicate it.

### Content hashing

Every note carries a deterministic ID in its frontmatter:

```yaml
---
defrag-id: sha256:7a3f...   # hash of source record ID + content hash
defrag-source: claude
defrag-updated: 2025-05-16T17:00:00Z
---
```

On a re-run, the writer computes the new content hash and compares it to the stored `defrag-id`. If the hash is unchanged, the file is skipped. If changed, the file is overwritten and `defrag-updated` is bumped.

### Additive-only concept notes

Concept notes are *additive*: they list sessions that mentioned a concept. On re-run, the writer merges the new session list with the existing list rather than overwriting it. Sessions are deduplicated by session slug.

### Manual edits are preserved

Content below a `<!-- defrag:end -->` marker in any note is treated as user-authored and is never overwritten. Users can add personal notes, corrections, or additional links after this marker.

```markdown
<!-- defrag:end -->

## My notes

This came up again in the [[2025-05-21-my-project]] session.
Worth reading [[the-book-ch4]] before returning to this.
```

---

## Vault Structure Decisions

### Why a flat `concepts/` directory?

Concept notes have no meaningful hierarchy that can be automatically determined. A flat structure with Obsidian's graph view and backlinks is more useful than an arbitrary folder taxonomy. If users want to organize concepts into subfolders, they can do so manually — the wikilinks will continue to resolve correctly.

### Why session notes by date, not by project?

Sessions are the atomic unit of context. Organizing by project would require maintaining a project taxonomy (fragile), and sessions often span multiple concerns. Date-first organization makes the timeline natural. Cross-project grouping is handled by concept notes (which aggregate across projects) and project rollup notes (in `vault/projects/`), which are generated as secondary indexes.

### Why include `.obsidian/` in the output?

The `.obsidian/` config ensures the vault opens correctly without manual setup. The included config sets dark theme, disables legacy editor, and enables live preview. Users who already have Obsidian preferences can delete or merge this directory. The config is minimal and non-destructive — it does not install plugins.

### Frontmatter schema

All generated notes use a consistent frontmatter schema:

**Session notes:**
```yaml
---
title: "Session: My Rust Project — 2025-05-14"
date: 2025-05-14
source: claude
project: my-rust-project
concepts: [rust-lifetimes, borrow-checker, ownership]
defrag-id: sha256:7a3f9c...
defrag-updated: 2025-05-16T17:00:00Z
---
```

**Concept notes:**
```yaml
---
title: "Concept: Rust Lifetimes"
slug: rust-lifetimes
sessions: [2025-05-14-my-rust-project, 2025-05-10-my-rust-project]
sources: [claude]
defrag-id: sha256:bb1e2d...
defrag-updated: 2025-05-16T17:00:00Z
---
```

---

## Extension Points

### Adding a new miner

Implement the `Miner` interface:

```js
// src/miners/my-tool.js
export default {
  name: 'my-tool',
  defaultPath: '~/.my-tool/',

  async *mine(rootPath, options) {
    // yield ConversationRecord objects
  }
};
```

Register in `src/miners/index.js`:

```js
import myToolMiner from './my-tool.js';
export const miners = { ..., 'my-tool': myToolMiner };
```

### Adding a new extractor

Implement the `Extractor` interface:

```js
// src/extractors/my-extractor.js
export default {
  name: 'my-extractor',

  extract(record) {
    // return { myField: [...] }
  }
};
```

Register in `src/extractors/index.js`.

### Custom concept dictionaries

Place a `concepts.json` array in the project root or pass `--concepts path/to/concepts.json`. Entries are matched case-insensitively and bypass the frequency threshold.
