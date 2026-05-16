```
╔═══════════════════════════════════════════════════════════════════╗
║  ██████╗ ██████╗ ███╗  ██╗████████╗███████╗██╗  ██╗████████╗     ║
║ ██╔════╝██╔═══██╗████╗ ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝     ║
║ ██║     ██║   ██║██╔██╗██║   ██║   █████╗   ╚███╔╝    ██║        ║
║ ██║     ██║   ██║██║╚████║   ██║   ██╔══╝   ██╔██╗    ██║        ║
║ ╚██████╗╚██████╔╝██║ ╚███║   ██║   ███████╗██╔╝╚██╗   ██║        ║
║  ╚═════╝ ╚═════╝ ╚═╝  ╚══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝        ║
║                                                                   ║
║   ██████╗ ███████╗███████╗██████╗  █████╗  ██████╗               ║
║   ██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝               ║
║   ██║  ██║█████╗  █████╗  ██████╔╝███████║██║  ███╗              ║
║   ██║  ██║██╔══╝  ██╔══╝  ██╔══██╗██╔══██║██║   ██║              ║
║   ██████╔╝███████╗██║     ██║  ██║██║  ██║╚██████╔╝              ║
║   ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝               ║
╠═══════════════════════════════════════════════════════════════════╣
║  Definitely Not Microsoft(R) Context Defragmenter   Version 1.0  ║
║  Copyright (C) context-defrag contributors, 2026.                 ║
╚═══════════════════════════════════════════════════════════════════╝
```

> *"Every time you explain your architecture to Claude, that knowledge dies*
> *when the context window closes. context-defrag fixes that."*

---

```
  Drive C: Context fragments found.   Defragmenting...

  ░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓████████████████████████■■■■■■■■■■■■■■■

  Cluster 0047: claude/proj_k9x2m   → concepts/rust-lifetimes.md
  Cluster 0048: cursor/sess_7f3a1   → concepts/borrow-checker.md
  Cluster 0049: claude/proj_k9x2m   → sessions/2025-05-14-my-project.md
  Cluster 0050: codex/sess_19a      → concepts/async-runtime.md

  Sessions read: 47    Concepts extracted: 234
  Notes written: 189   Wikilinks created:  891
```

---

## What it does

Your LLM conversations are a fragmented disk — the same insights scattered across hundreds of JSON files and SQLite databases, unlinked and unsearchable, decaying in `~/Library`. `context-defrag` reads your Claude, Cursor, and Codex session histories and reorganizes them into a structured [Obsidian](https://obsidian.md) knowledge vault with bidirectional wikilinks, extracted concepts, and a full session timeline.

One command. Permanent knowledge.

---

## Quick start

```bash
npx context-defrag
```

Or install globally:

```bash
npm install -g context-defrag
context-defrag
```

Then open the `./vault` directory in Obsidian as a new vault. The graph view loads immediately.

---

## Demo

**[→ Live demo at somarc.github.io/context-defrag](https://somarc.github.io/context-defrag/)**

The demo is an interactive HTML recreation of the defrag UI — blocks ticking across the screen, cluster assignments appearing in real time. Open it in any browser.

### About the visualizer

The terminal UI is a faithful recreation of the MS-DOS 6.x Disk Defragmenter, rendered live as your context is processed.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║  Definitely Not Microsoft(R) Context Defragmenter            ║
  ╠══════════════════════════════════════════════════════════════╣
  ║                                                              ║
  ║  ████████████████████████▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ║
  ║  ■■■■■■■■■■■■■■■■■■■■■■░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ║
  ║  ■■■■■■■■■■■■■■■■■■░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ║
  ║                                                              ║
  ║  Reading:  claude/projects/proj_k9x2m/conversation.jsonl    ║
  ║  Writing:  vault/concepts/rust-lifetimes.md                 ║
  ║  Links:    [[borrow-checker]] [[ownership]] [[Pin]]          ║
  ║                                                              ║
  ║  Sessions read: 47    Concepts extracted: 234               ║
  ║  Notes written: 189   Wikilinks created:  891               ║
  ╚══════════════════════════════════════════════════════════════╝

  ┌──────────────────────────────────────────────────────────────┐
  │  Legend                                                      │
  │                                                              │
  │  ░  Unprocessed conversation                                 │
  │  ▓  Currently reading                                        │
  │  █  Defragmented (written to vault)                          │
  │  ■  Linked (wikilinks created)                               │
  │                                                              │
  │  Each block = 1 conversation cluster                         │
  └──────────────────────────────────────────────────────────────┘
```

This is not a gimmick. The metaphor is exact: your conversations *are* fragmented clusters on a disk. The read head *does* have to seek for them. This tool *does* reorganize them into contiguous, navigable structure. The aesthetic is earned.

---

## What gets mined

| Source          | Default path (macOS)                                          | Format        |
|-----------------|---------------------------------------------------------------|---------------|
| Claude          | `~/.claude/projects/`                                         | JSONL         |
| Codex CLI       | `~/.codex/`                                                   | JSON / SQLite |
| Cursor          | `~/Library/Application Support/Cursor/User/workspaceStorage/` | SQLite        |
| Cursor (Linux)  | `~/.config/Cursor/User/workspaceStorage/`                     | SQLite        |
| Cursor (Win)    | `%APPDATA%\Cursor\User\workspaceStorage\`                     | SQLite        |

Override any path in `config.json`:

```json
{
  "sources": {
    "claude": { "path": "/custom/path/to/claude/projects" },
    "cursor": { "path": "/custom/path/to/cursor/storage" }
  }
}
```

---

## Output

### Vault structure

```
vault/
├── _index.md                      ← Map of content (MOC)
├── _timeline.md                   ← Chronological session index
│
├── sessions/
│   ├── _claude-index.md
│   ├── _cursor-index.md
│   ├── 2025-05-14-my-rust-project.md
│   ├── 2025-05-13-dotfiles.md
│   └── 2025-05-11-my-rust-project.md
│
├── concepts/
│   ├── rust-lifetimes.md
│   ├── borrow-checker.md
│   ├── ownership.md
│   ├── async-runtime.md
│   └── pin.md
│
├── projects/
│   └── my-rust-project.md         ← Per-project rollup
│
├── snippets/                      ← Long code blocks (>50 lines)
│   └── 2025-05-14-my-rust-project-1.md
│
└── .obsidian/
    ├── app.json                   ← Dark theme, live preview
    └── appearance.json
```

### Example concept note

```markdown
---
title: "Concept: Rust Lifetimes"
slug: rust-lifetimes
sessions: [2025-05-14-my-rust-project, 2025-05-10-my-rust-project]
sources: [claude]
defrag-id: sha256:bb1e2d...
defrag-updated: 2025-05-16T17:00:00Z
---

# Rust Lifetimes

Appears in **2 sessions** across **1 project**.

## Sessions

- [[2025-05-14-my-rust-project]] — debugging `'a` annotations on struct fields
- [[2025-05-10-my-rust-project]] — first encounter; E0106 lifetime missing

## Related concepts

[[borrow-checker]] · [[ownership]] · [[Pin]]

<!-- defrag:end -->
```

### Example session note

```markdown
---
title: "Session: My Rust Project — 2025-05-14"
date: 2025-05-14
source: claude
project: my-rust-project
concepts: [rust-lifetimes, borrow-checker, ownership]
defrag-id: sha256:7a3f9c...
defrag-updated: 2025-05-16T17:00:00Z
---

# My Rust Project — 2025-05-14

**Source:** Claude · **Project:** my-rust-project

## Summary

Debugging lifetime annotation errors on a self-referential struct.
→ Concluded that `Pin<Box<T>>` is the correct pattern; raw lifetime annotations
  on the struct fields were the wrong approach.

## Concepts discussed

[[rust-lifetimes]] · [[borrow-checker]] · [[ownership]] · [[pin]]

## Code

```rust
use std::pin::Pin;

struct MyStruct {
    data: String,
    ptr: *const String,
}
```

<!-- defrag:end -->
```

---

## QMD integration — semantic search over your vault

[QMD](https://github.com/your-username/qmd) is the companion tool. `context-defrag` mines and writes the vault. `qmd` makes it searchable — not by filename, but by meaning.

```bash
# 1. Install QMD
npm install -g qmd

# 2. Index your vault
qmd index ./vault

# 3. Ask a question
qmd query "how did I fix the borrow checker error in my Rust project?"

# 4. Open the result in Obsidian
qmd query "Pin<Box<T>>" --open
```

Example output:

```
  ╔══════════════════════════════════════╗
  ║  QMD — Query: "borrow checker fix"   ║
  ╚══════════════════════════════════════╝

  [0.94]  concepts/borrow-checker.md
          "...the fix was to annotate the return lifetime explicitly..."

  [0.91]  sessions/2025-05-14-my-rust-project.md
          "...E0597: borrowed value does not live long enough..."

  [0.87]  sessions/2025-05-11-my-rust-project.md
          "...first encountered this trying to store a &str in the struct..."

  3 results  ·  12ms
```

The two tools are designed as a workflow: run `context-defrag` periodically (or on a cron), query with `qmd` when you need to remember something. Your LLM sessions become a searchable, permanent knowledge base.

---

## How it works

The pipeline has four stages:

```
  ┌──────────────────────────────────────────────────────────┐
  │                      CLI (defrag.js)                     │
  └──────────────────────────┬───────────────────────────────┘
                             │
             ┌───────────────┼───────────────┐
             ▼               ▼               ▼
       ClaudeMiner      CodexMiner      CursorMiner
             │               │               │
             └───────────────┼───────────────┘
                             ▼
                   ConversationRecord[]       ← normalized IR
                             │
                             ▼
                    ExtractionEngine
                  (concepts · summaries ·
                   code snippets · dates)
                             │
                             ▼
                      NoteGraph              ← in-memory graph
                   (nodes + edges)
                             │
                             ▼
                   WikilinkResolver
                             │
                             ▼
                      VaultWriter            ← disk I/O
```

**Scan** — resolves source paths, hands file lists to miners.  
**Parse** — each miner reads its native format (JSONL, JSON, SQLite) and emits normalized `ConversationRecord` objects. The rest of the pipeline never touches raw formats.  
**Extract** — heuristic extraction of concepts (NLP noun phrases + markdown headers + optional dictionary), summaries, and code blocks. No LLM calls required.  
**Write** — the vault writer diffs against the existing vault, writes only changed files, and preserves any user content below `<!-- defrag:end -->` markers.

Re-runs are safe and fast. Content is hashed; unchanged notes are skipped.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical walkthrough.

---

## CLI reference

```bash
context-defrag [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--sources <list>` | `claude,codex,cursor` | Comma-separated list of sources to mine |
| `--out <path>` | `./vault` | Output vault directory |
| `--since <duration>` | *(all time)* | Only process conversations newer than e.g. `30d`, `2w` |
| `--dry-run` | `false` | Scan and extract but write nothing |
| `--verbose` | `false` | Print every cluster assignment |
| `--update` | `false` | Re-run and update existing notes (idempotent) |
| `--fuzzy-links` | `false` | Enable fuzzy wikilink matching (Levenshtein ≤ 2) |
| `--create-stubs` | `false` | Create stub notes for unresolved link targets |
| `--include-tool-calls` | `false` | Include tool-use and tool-result turns in extraction |
| `--concepts <path>` | *(none)* | Path to a custom `concepts.json` dictionary |
| `--config <path>` | `./config.json` | Path to config file |

---

## Roadmap

- [ ] **VS Code extension** — mine Copilot Chat history from `.vscode/`
- [ ] **Windsurf / Aider support** — new miners for more AI coding tools
- [ ] **Incremental updates** — track processed sessions in `defrag.json`; only parse new conversations on re-run
- [ ] **`--llm-summarize`** — optional Ollama integration for richer session summaries
- [ ] **Web UI** — browser-based vault browser that doesn't require Obsidian
- [ ] **Logseq export** — alternative output format
- [ ] **GitHub Discussions mining** — extract knowledge from your own issue threads

---

## Contributing

Pull requests welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to understand the miner interface and how to add a new source. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching the extraction pipeline or wikilink resolver.

Open an issue before starting large features — especially new miners, which tend to have format-detection complexity.

---

## License

MIT — Copyright (c) context-defrag contributors

---

```
  ████████████████████████████████████████████████████████████
  Defragmentation complete. All clusters accounted for.
  ████████████████████████████████████████████████████████████

  It is now safe to turn off your computer.
```
