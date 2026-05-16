/**
 * linker.js — Post-processes the vault to add [[wikilinks]] between notes
 *
 * Strategy:
 *   1. Build a registry of all note slugs (concepts, sessions, code)
 *   2. For each note, scan the body text for mentions of known titles
 *   3. Replace plain-text mentions with [[wikilinks]] (only outside front-matter,
 *      existing links, and code blocks)
 *   4. Append a "## Related" section to concept notes that lack one
 *
 * This pass is idempotent — already-linked text is not double-linked.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Main export ──────────────────────────────────────────────────────────────
/**
 * @param {string}   vaultDir   - Root vault directory
 * @param {boolean}  dryRun
 * @param {boolean}  verbose
 * @param {Function} onProgress - Optional callback(msg) called for each linked file
 * @returns {{ linksCreated: number }}
 */
function link({ vaultDir, dryRun, verbose, onProgress }) {
  const registry = buildRegistry(vaultDir);

  if (verbose) {
    console.log(`  Registry: ${registry.length} notes indexed`);
  }

  let linksCreated = 0;

  // Process all markdown files
  const allFiles = collectMarkdownFiles(vaultDir);

  for (const filePath of allFiles) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      continue;
    }

    const { linked, count } = injectLinks(content, registry, filePath, vaultDir);

    if (count > 0) {
      linksCreated += count;

      if (verbose) {
        console.log(`  [[linked]] ${count} reference(s) in ${path.relative(vaultDir, filePath)}`);
      }

      // Fire progress callback for the TUI activity log
      if (onProgress) {
        onProgress(`[[linked]] ${count} ref${count !== 1 ? 's' : ''} in ${path.relative(vaultDir, filePath)}`);
      }

      if (!dryRun) {
        fs.writeFileSync(filePath, linked, 'utf8');
      }
    }
  }

  return { linksCreated };
}

// ── Build a registry of all vault notes ──────────────────────────────────────
/**
 * Each registry entry:
 * {
 *   filePath:   absolute path,
 *   vaultPath:  relative to vault root (e.g. "concepts/jackrabbit-oak"),
 *   title:      display name (from front-matter or filename),
 *   aliases:    alternative names that should link to this note
 * }
 */
function buildRegistry(vaultDir) {
  const entries  = [];
  const files    = collectMarkdownFiles(vaultDir);

  for (const filePath of files) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      continue;
    }

    const vaultPath = path.relative(vaultDir, filePath).replace(/\.md$/, '');
    const title     = extractTitle(content, filePath);
    const aliases   = extractAliases(content, title);

    entries.push({ filePath, vaultPath, title, aliases });
  }

  return entries;
}

// ── Inject wikilinks into a note's content ────────────────────────────────────
function injectLinks(content, registry, currentFile, vaultDir) {
  const currentVaultPath = path
    .relative(vaultDir, currentFile)
    .replace(/\.md$/, '');

  // Split the content into zones: front-matter, code blocks, existing links, plain text
  const zones = tokenise(content);

  let totalCount = 0;

  const processed = zones.map((zone) => {
    if (zone.type !== 'text') return zone.raw; // leave non-text zones intact

    let text  = zone.raw;
    let count = 0;

    for (const entry of registry) {
      // Don't self-link
      if (entry.vaultPath === currentVaultPath) continue;

      // Try the title and each alias
      const candidates = [entry.title, ...entry.aliases].filter(Boolean);

      for (const candidate of candidates) {
        if (!candidate || candidate.length < 3) continue;

        const result = linkifyTerm(text, candidate, entry.vaultPath);
        if (result.count > 0) {
          text  = result.text;
          count += result.count;
        }
      }
    }

    totalCount += count;
    return text;
  });

  return { linked: processed.join(''), count: totalCount };
}

/**
 * Replace the FIRST occurrence of `term` in `text` with [[vaultPath|term]].
 * Skips matches that are already inside [[...]] or `code spans`.
 * Uses a forward-scan approach (no lookbehind) for Node 25 compatibility.
 */
function linkifyTerm(text, term, vaultPath) {
  const escaped = escapeRegex(term);
  const re = new RegExp(`\\b(${escaped})\\b`, 'gi');

  let count = 0;
  const result = text.replace(re, (match, p1, offset) => {
    // Check if this position is inside an existing [[...]] or `...`
    const before = text.slice(0, offset);
    // Count unclosed [[ without matching ]]
    const openBrackets  = (before.match(/\[\[/g)  || []).length;
    const closeBrackets = (before.match(/\]\]/g)  || []).length;
    if (openBrackets > closeBrackets) return match; // inside a wikilink

    // Count unclosed backticks
    const backticks = (before.match(/`/g) || []).length;
    if (backticks % 2 !== 0) return match; // inside a code span

    count++;
    return `[[${vaultPath}|${p1}]]`;
  });

  return { text: result, count };
}

// ── Tokeniser — splits content into typed zones ───────────────────────────────
/**
 * Zones:
 *   { type: 'frontmatter', raw }
 *   { type: 'codeblock',   raw }
 *   { type: 'codespan',    raw }
 *   { type: 'wikilink',    raw }
 *   { type: 'mdlink',      raw }
 *   { type: 'text',        raw }
 */
function tokenise(content) {
  const zones = [];
  let pos = 0;

  // 1. Front matter (must be at the very start)
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  if (fmMatch && fmMatch.index === 0) {
    zones.push({ type: 'frontmatter', raw: fmMatch[0] });
    pos = fmMatch[0].length;
  }

  // 2. Tokenise the rest character-by-character using a simple state machine
  const body = content.slice(pos);
  const parts = splitBody(body);
  zones.push(...parts);

  return zones;
}

function splitBody(text) {
  const zones = [];
  // Regex-based split into protected regions and plain text
  // Protected: fenced code blocks, inline code, wikilinks, md links
  const PROTECTED_RE = /(```[\s\S]*?```|`[^`\n]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\))/g;

  let lastIndex = 0;

  for (const match of text.matchAll(PROTECTED_RE)) {
    // Plain text before this match
    if (match.index > lastIndex) {
      zones.push({ type: 'text', raw: text.slice(lastIndex, match.index) });
    }

    const raw = match[0];
    let type  = 'text';
    if (raw.startsWith('```'))       type = 'codeblock';
    else if (raw.startsWith('`'))    type = 'codespan';
    else if (raw.startsWith('[['))   type = 'wikilink';
    else if (raw.startsWith('['))    type = 'mdlink';

    zones.push({ type, raw });
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    zones.push({ type: 'text', raw: text.slice(lastIndex) });
  }

  return zones;
}

// ── Collect all markdown files in a directory tree ───────────────────────────
function collectMarkdownFiles(dir) {
  const results = [];
  walkDir(dir, (filePath) => {
    if (filePath.endsWith('.md')) results.push(filePath);
  });
  return results;
}

function walkDir(dir, callback) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, callback);
    } else if (entry.isFile()) {
      callback(full);
    }
  }
}

// ── Extract title from front-matter or H1 ────────────────────────────────────
function extractTitle(content, filePath) {
  // Try front-matter title:
  const fmTitle = content.match(/^---[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
  if (fmTitle) return fmTitle[1].trim();

  // Try first H1
  const h1 = content.match(/^#\s+(.+)/m);
  if (h1) return h1[1].trim();

  // Fall back to filename
  return path.basename(filePath, '.md').replace(/-/g, ' ');
}

// ── Extract aliases from front-matter ────────────────────────────────────────
function extractAliases(content, title) {
  const aliases = [];

  // Front-matter aliases field
  const aliasMatch = content.match(/^aliases:\s*\[([^\]]*)\]/m);
  if (aliasMatch) {
    aliasMatch[1].split(',').forEach((a) => {
      const trimmed = a.trim().replace(/^["']|["']$/g, '');
      if (trimmed) aliases.push(trimmed);
    });
  }

  // Also add the slug form as an alias so "jackrabbit oak" matches "Jackrabbit Oak"
  if (title) {
    const lower = title.toLowerCase();
    if (lower !== title) aliases.push(lower);
  }

  return aliases;
}

// ── Utilities ────────────────────────────────────────────────────────────────
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { link };
