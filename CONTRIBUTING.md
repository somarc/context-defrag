# Contributing to context-defrag

Pull requests welcome. This document covers setup, the miner interface, tests, and what to know before submitting a PR.

---

## Getting started

```bash
# Clone and install
git clone https://github.com/your-username/context-defrag.git
cd context-defrag
npm install

# Run against your own LLM history
node cli/defrag.js --dry-run --verbose

# Run against the included fixture data
node cli/defrag.js --sources claude --config fixtures/config.json --out /tmp/test-vault
```

**Requirements:** Node.js 18+. No other runtime dependencies. The tool is intentionally offline — no API keys, no network calls during extraction.

---

## Running tests

```bash
npm test
```

`npm test` runs the full test suite in dry-run mode against the fixture data in `fixtures/`. No files are written. The test runner checks that:

- Each miner produces valid `ConversationRecord` objects from its fixture input
- The extraction engine produces the expected concepts, summaries, and code blocks
- The wikilink resolver produces the expected link graph
- The vault writer produces the expected file list (without writing)

Individual test files:

```bash
node --test test/miners/claude.test.js
node --test test/miners/cursor.test.js
node --test test/miners/codex.test.js
node --test test/extraction.test.js
node --test test/wikilinks.test.js
```

---

## Adding a new miner

A miner is the only place that knows about a specific tool's storage format. Everything downstream operates on the normalized `ConversationRecord` interface.

### 1. Create the miner file

```js
// src/miners/my-tool.js

export default {
  name: 'my-tool',

  // Default path, resolved with ~ expansion.
  // Used when no path is specified in config.json.
  defaultPath: '~/.my-tool/',

  // Async generator: yield one ConversationRecord per session.
  async *mine(rootPath, options = {}) {
    // rootPath is the resolved absolute path (defaultPath or config override)
    // options: { since?: Date, verbose?: boolean, includeToolCalls?: boolean }

    // Example: read JSON files from rootPath
    const files = await glob('**/*.json', { cwd: rootPath, absolute: true });

    for (const file of files) {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));

      // Filter by date if --since was passed
      const startedAt = new Date(raw.createdAt * 1000);
      if (options.since && startedAt < options.since) continue;

      yield {
        id: createHash('sha256').update(file).digest('hex').slice(0, 16),
        source: 'my-tool',
        projectSlug: slugify(raw.cwd ?? 'unknown'),
        startedAt,
        messages: raw.messages.map(m => ({
          role: m.role === 'human' ? 'user' : m.role,
          content: m.content,
          timestamp: m.ts ? new Date(m.ts * 1000) : undefined,
        })),
        rawPath: file,
      };
    }
  }
};
```

### 2. Register the miner

```js
// src/miners/index.js
import myToolMiner from './my-tool.js';

export const miners = {
  claude:   claudeMiner,
  codex:    codexMiner,
  cursor:   cursorMiner,
  'my-tool': myToolMiner,   // ← add here
};
```

### 3. Add fixture data

Add a minimal fixture file under `fixtures/my-tool/` that exercises the miner's parsing logic. The fixture should be self-contained and not contain any real conversation content.

### 4. Add a test

```js
// test/miners/my-tool.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import myToolMiner from '../../src/miners/my-tool.js';

describe('my-tool miner', () => {
  it('yields ConversationRecord objects from fixture data', async () => {
    const records = [];
    for await (const record of myToolMiner.mine('fixtures/my-tool')) {
      records.push(record);
    }

    assert.ok(records.length > 0, 'should yield at least one record');
    assert.equal(records[0].source, 'my-tool');
    assert.ok(records[0].startedAt instanceof Date);
    assert.ok(Array.isArray(records[0].messages));
  });
});
```

---

## PR guidelines

**Before opening a PR:**

- Run `npm test` — all tests must pass
- For new miners: include fixture data and a test
- For changes to the extraction pipeline: update `docs/ARCHITECTURE.md` if the behavior description changes
- For changes to the visualizer: see the aesthetics note below

**PR size:** Keep PRs focused. A new miner is a natural unit. A new extractor is a natural unit. Refactors touching multiple pipeline stages should be discussed in an issue first.

**Commit style:** No enforced convention, but descriptive commit messages are appreciated. `feat(cursor-miner): handle pre-0.40 role field variants` is better than `fix stuff`.

---

## Issue labels

| Label | Meaning |
|-------|---------|
| `miner` | New source support or fixes to an existing miner |
| `extraction` | Concept/summary/code extraction behavior |
| `vault-output` | Note format, frontmatter schema, wikilink behavior |
| `visualizer` | Terminal UI or GitHub Pages demo |
| `cli` | Flags, config, or CLI behavior |
| `good first issue` | Well-scoped, self-contained, documented |
| `needs-fixture` | Issue requires real-world data to reproduce — help wanted |

---

## On the DOS aesthetic

The terminal visualizer is a deliberate recreation of the MS-DOS 6.x Disk Defragmenter. This is not a theme that can be swapped out — it is load-bearing. The metaphor of fragmented disk clusters maps directly onto the problem the tool solves, and the aesthetic reinforces that connection.

If you are contributing to the visualizer or the GitHub Pages demo:

- Box-drawing characters (`╔`, `║`, `╚`, `═`, `┌`, `│`, `└`) for all frames
- Block characters (`░`, `▓`, `█`, `■`) for the progress display, in that order
- Fixed-width layout; no proportional fonts
- Color palette: the classic CGA blue background / white text / yellow highlight is the reference. The terminal version uses ANSI codes; the demo uses CSS that matches it
- No rounded corners, no gradients, no animations that aren't directly tied to pipeline progress

The last line of the tool's output will always be:

```
  It is now safe to turn off your computer.
```

This line is not configurable. Do not remove it.

---

## License

By contributing, you agree that your contributions will be licensed under the MIT license.
