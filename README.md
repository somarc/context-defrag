```
 ██████╗ ██████╗ ███╗  ██╗████████╗███████╗██╗  ██╗████████╗
██╔════╝██╔═══██╗████╗ ██║╚══██╔══╝██╔════╝╚██╗██╔╝╚══██╔══╝
██║     ██║   ██║██╔██╗██║   ██║   █████╗   ╚███╔╝    ██║
██║     ██║   ██║██║╚████║   ██║   ██╔══╝   ██╔██╗    ██║
╚██████╗╚██████╔╝██║ ╚███║   ██║   ███████╗██╔╝╚██╗   ██║
 ╚═════╝ ╚═════╝ ╚═╝  ╚══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝

  ██████╗ ███████╗███████╗██████╗  █████╗  ██████╗
  ██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝
  ██║  ██║█████╗  █████╗  ██████╔╝███████║██║  ███╗
  ██║  ██║██╔══╝  ██╔══╝  ██╔══██╗██╔══██║██║   ██║
  ██████╔╝███████╗██║     ██║  ██║██║  ██║╚██████╔╝
  ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝
```

```
  ════════════════════════════════════════════════════════════
   Microsoft(R) Context Defragmenter   Version 1.0
   Copyright (C) somarc, 2025. All rights reserved.
  ════════════════════════════════════════════════════════════

   Drive C: Context fragments found.   Defragmenting...

   ░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓████████████████████■■■■■■■■■■

   Cluster 0047: claude/proj_k9x2m → concepts/rust-lifetimes
   Cluster 0048: cursor/sess_19a   → concepts/borrow-checker
   Cluster 0049: claude/proj_k9x2m → sessions/2025-05-14
```

> *"There was something strangely meditative about watching Defrag run — the blocks slowly rearranging themselves into order."*
> — [@davepl1968](https://twitter.com/davepl1968)

---

## What is this?

In 1993, MS-DOS 6.0 shipped a Disk Defragmenter. Its job was simple: the files on your hard drive had been written in scattered clusters across the platters — bits of the same document living in non-contiguous blocks, forcing the read head to hunt and seek across the disk. Defrag reorganized those fragments into solid, contiguous runs. It was satisfying to watch. Meditative, even.

Your LLM session history is the same problem.

Every Claude conversation, every Cursor edit session, every Codex exchange is a fragment — a cluster of thought scattered across JSON files and SQLite databases, unlinked, unsearchable, decaying in `~/Library`. You had a breakthrough on Rust lifetimes in a Claude thread three weeks ago. You worked through a borrow-checker fix in Cursor last Tuesday. Those insights are *there*, but they're fragmented. The read head can't find them.

**Context Defrag** mines those scattered conversation fragments and reorganizes them into a coherent, navigable [Obsidian](https://obsidian.md) knowledge vault — with bidirectional wikilinks, concept extraction, and a session timeline. It turns your LLM history into a second brain.

The output renders as an MS-DOS Defragmenter UI — blocks ticking across the screen as your context is read, extracted, linked, and written.

---

## The Visual

The live defrag display is a faithful recreation of the MS-DOS 6.x Defragmenter interface, rendered in the terminal during a run and as a static demo on GitHub Pages.

```
  ╔══════════════════════════════════════════════════════════╗
  ║  Microsoft(R) Context Defragmenter        Drive C: 87%  ║
  ╠══════════════════════════════════════════════════════════╣
  ║                                                          ║
  ║  ████████████████████████▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░  ║
  ║  ■■■■■■■■■■■■■■■■■■■■■■░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ║
  ║  ■■■■■■■■■■■■■■■■■■░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ║
  ║                                                          ║
  ║  Reading:  claude/projects/proj_k9x2m/conversation.jsonl ║
  ║  Writing:  vault/concepts/rust-lifetimes.md              ║
  ║  Links:    [[borrow-checker]] [[ownership]] [[Pin]]       ║
  ║                                                          ║
  ║  Sessions read: 47    Concepts extracted: 234            ║
  ║  Notes written: 189   Wikilinks created:  891            ║
  ╚══════════════════════════════════════════════════════════╝
```

**[→ Live demo at somarc.github.io/context-defrag](https://somarc.github.io/context-defrag/)**

The demo is an interactive HTML recreation of the defrag UI with simulated block animation. Open it in any browser.

---

## Installation

```bash
git clone git@github.com:somarc/context-defrag.git
cd context-defrag
npm install
```

**Requirements**
- Node.js 18+
- [Obsidian](https://obsidian.md) (to open the output vault)
- macOS, Linux, or WSL (Windows paths supported via config)

---

## Usage

```bash
# Mine all sources, output to ./vault
node cli/defrag.js

# Mine only Claude contexts
node cli/defrag.js --sources claude

# Mine only Cursor and Codex
node cli/defrag.js --sources cursor,codex

# Preview without writing
node cli/defrag.js --dry-run --verbose

# Output to a specific vault path
node cli/defrag.js --out ~/Documents/ObsidianVault/context

# Limit to conversations from the last 30 days
node cli/defrag.js --since 30d

# Re-run and update existing notes (idempotent)
node cli/defrag.js --update
```

---

## Context Sources

Context Defrag knows where each tool hides its history. The following sources are supported:

| Source     | Default Path                                              | Format         |
|------------|-----------------------------------------------------------|----------------|
| Claude     | `~/.claude/projects/`                                     | JSONL          |
| Codex CLI  | `~/.codex/`                                               | JSON / SQLite  |
| Cursor     | `~/Library/Application Support/Cursor/User/workspaceStorage/` | SQLite    |
| Cursor (Linux) | `~/.config/Cursor/User/workspaceStorage/`             | SQLite         |
| Cursor (Win)   | `%APPDATA%\Cursor\User\workspaceStorage\`             | SQLite         |

Override any path via `config.json`:

```json
{
  "sources": {
    "claude": { "path": "/custom/path/to/claude/projects" },
    "cursor": { "path": "/custom/path/to/cursor/storage" }
  }
}
```

---

## Output Structure

```
vault/
├── _index.md                    ← Root map of content (MOC)
├── _timeline.md                 ← Chronological session index
│
├── sessions/
│   ├── _claude-index.md         ← Claude session index
│   ├── _cursor-index.md         ← Cursor session index
│   ├── 2025-05-14-proj-k9x2m.md ← Individual session notes
│   ├── 2025-05-13-proj-k9x2m.md
│   └── ...
│
├── concepts/
│   ├── rust-lifetimes.md        ← Extracted concept notes
│   ├── borrow-checker.md
│   ├── ownership.md
│   └── ...
│
├── projects/
│   ├── my-project.md            ← Per-project rollup notes
│   └── ...
│
└── .obsidian/
    ├── app.json
    └── appearance.json
```

Each session note captures: the date, source tool, project context, key concepts discussed, code snippets, and decisions made — with wikilinks to concept notes and related sessions.

Each concept note aggregates every session that touched that concept, with backlinks automatically maintained by Obsidian's graph.

---

## Opening in Obsidian

1. Open Obsidian
2. Click **Open folder as vault**
3. Select the `vault/` directory (or your `--out` path)
4. The `.obsidian/` config is included — dark theme and live preview are pre-configured

The graph view will show your concept clusters immediately. Switch to **Local Graph** on any concept note to see every session that touched it.

---

## The Legend

```
  ┌─────────────────────────────────────────────────────┐
  │  Legend                                             │
  │                                                     │
  │  ░  Unprocessed conversation                        │
  │  ▓  Currently reading                               │
  │  █  Defragmented (written to vault)                 │
  │  ■  Linked (wikilinks created)                      │
  │                                                     │
  │  Each block = 1 conversation cluster                │
  └─────────────────────────────────────────────────────┘
```

---

## Contributing

Pull requests welcome. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full technical walkthrough of the extraction pipeline, miner design, and wikilink resolution algorithm before submitting changes to core modules.

Please open an issue before starting large features.

---

## License

MIT

---

```
  It is now safe to turn off your computer.
```
