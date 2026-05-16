/**
 * extractor.js — Extracts concepts, decisions, code snippets, URLs, and
 *                entities from a normalised session object.
 *
 * All extraction is pure regex / string analysis — no external NLP library
 * is required. The goal is high recall at acceptable precision.
 */

'use strict';

// ── Known technology/tool keywords (for entity extraction) ───────────────────
// This list catches the most common terms; the capitalised-phrase heuristic
// catches the long tail.
const TECH_KEYWORDS = new Set([
  // Languages
  'javascript','typescript','python','ruby','rust','go','golang','java','kotlin',
  'swift','c++','c#','csharp','php','scala','haskell','elixir','erlang','clojure',
  'r','matlab','bash','shell','powershell','sql','graphql','wasm','webassembly',

  // Frameworks / libs
  'react','vue','angular','svelte','nextjs','next.js','nuxt','gatsby','remix',
  'express','fastify','nestjs','django','flask','fastapi','rails','laravel',
  'spring','springboot','hibernate','junit','pytest','jest','vitest','playwright',
  'cypress','storybook','webpack','vite','esbuild','rollup','parcel','babel',
  'eslint','prettier','tailwind','bootstrap','shadcn','radix','chakra',

  // Databases
  'postgres','postgresql','mysql','sqlite','mongodb','redis','elasticsearch',
  'cassandra','dynamodb','firestore','supabase','planetscale','cockroachdb',
  'neon','turso','clickhouse','bigquery','snowflake','databricks','dbt',

  // Cloud / infra
  'aws','azure','gcp','vercel','netlify','cloudflare','heroku','railway','fly.io',
  'docker','kubernetes','k8s','helm','terraform','pulumi','ansible','nginx',
  'caddy','traefik','lambda','ec2','s3','rds','ecs','eks','iam','cloudfront',

  // AI / ML
  'openai','anthropic','claude','gpt','gpt-4','gpt4','llm','llama','mistral',
  'gemini','palm','langchain','llamaindex','huggingface','pytorch','tensorflow',
  'keras','scikit-learn','numpy','pandas','transformers','gguf','ggml','ollama',
  'embeddings','rag','fine-tuning','lora','qlora','vllm','triton',

  // Tools / platforms
  'github','gitlab','bitbucket','jira','confluence','notion','linear','figma',
  'postman','insomnia','datadog','sentry','grafana','prometheus','pagerduty',
  'stripe','twilio','sendgrid','segment','mixpanel','amplitude','posthog',

  // AEM / CMS (given the spec's example content)
  'aem','adobe','jackrabbit','oak','jcr','osgi','sling','wcm','dam','dispatcher',
  'replication','workflow','cq','content fragment','experience fragment',

  // Protocols / formats
  'rest','grpc','websocket','http','https','oauth','jwt','saml','oidc',
  'json','yaml','toml','protobuf','avro','parquet','arrow','csv','xml',

  // Misc
  'obsidian','markdown','git','npm','yarn','pnpm','bun','node','deno','nix',
]);

// ── Sentences that signal a decision ────────────────────────────────────────
const DECISION_PATTERNS = [
  /\b(decided|decision|we('re| are| will)?\s+(going|using|adopting|switching))\b/i,
  /\b(will use|we'll use|going with|chosen|we chose|opted for|settled on)\b/i,
  /\b(action item|todo|follow.?up|next step|we need to|should|must|have to)\b/i,
  /\b(don('t| not) use|avoid|drop|remove|replace|migrate (from|away))\b/i,
];

// ── Regex patterns ───────────────────────────────────────────────────────────
const URL_RE      = /https?:\/\/[^\s<>"')\]]+/g;
const CODE_FENCE_RE = /```(\w*)\n([\s\S]*?)```/g;
const BACKTICK_RE   = /`([^`\n]{2,60})`/g;

// Capitalised multi-word phrases (Title Case), e.g. "Segment Store", "Oak Architecture"
const TITLE_CASE_RE = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){1,5})\b/g;

// Single PascalCase tokens that look like class/product names
const PASCAL_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

// ── Main export ──────────────────────────────────────────────────────────────
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

// ── Concepts ─────────────────────────────────────────────────────────────────
function extractConcepts(text) {
  const freq  = new Map(); // normalised term → { display, count }

  // 1. Backtick-wrapped identifiers
  for (const [, term] of text.matchAll(BACKTICK_RE)) {
    const t = term.trim();
    if (t.length < 2 || t.includes('\n')) continue;
    bump(freq, t.toLowerCase(), t);
  }

  // 2. Known tech keywords (case-insensitive)
  const words = text.toLowerCase().split(/\W+/);
  for (const w of words) {
    if (TECH_KEYWORDS.has(w)) {
      bump(freq, w, w);
    }
  }

  // 3. Title-cased multi-word phrases
  for (const [, phrase] of text.matchAll(TITLE_CASE_RE)) {
    const key = phrase.toLowerCase();
    if (key.split(' ').length < 2) continue;      // must be ≥2 words
    if (isStopPhrase(phrase)) continue;
    bump(freq, key, phrase);
  }

  // 4. PascalCase compound words
  for (const [, token] of text.matchAll(PASCAL_RE)) {
    if (token.length < 5) continue;
    bump(freq, token.toLowerCase(), token);
  }

  // Return concepts that appeared at least twice, sorted by frequency desc
  return [...freq.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([, v]) => v.display);
}

function bump(map, key, display) {
  if (map.has(key)) {
    map.get(key).count++;
  } else {
    map.set(key, { display, count: 1 });
  }
}

// Common English title-case phrases that aren't concepts
const STOP_PHRASES = new Set([
  'The Following', 'In The', 'Of The', 'To The', 'For The',
  'It Is', 'There Is', 'This Is', 'That Is', 'We Are', 'You Are',
  'This Can', 'We Can', 'You Can', 'We Will', 'You Will',
  'This Will', 'It Will', 'Can Be', 'Will Be', 'Should Be',
  'May Be', 'Might Be', 'Has Been', 'Have Been', 'Would Be',
]);

function isStopPhrase(phrase) {
  if (STOP_PHRASES.has(phrase)) return true;
  // All-caps is likely an acronym sentence, not a concept
  if (phrase === phrase.toUpperCase() && phrase.length > 6) return true;
  return false;
}

// ── Decisions ─────────────────────────────────────────────────────────────────
function extractDecisions(messages) {
  const decisions = [];

  for (const msg of messages) {
    const lines = msg.content.split(/[.!?]\s+|\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 10 || trimmed.length > 500) continue;

      if (DECISION_PATTERNS.some((re) => re.test(trimmed))) {
        decisions.push(trimmed);
      }
    }
  }

  // Deduplicate near-identical decisions
  return dedupStrings(decisions);
}

// ── Code snippets ─────────────────────────────────────────────────────────────
function extractSnippets(text) {
  const snippets = [];
  let index = 0;

  for (const match of text.matchAll(CODE_FENCE_RE)) {
    const lang    = match[1] || 'text';
    const code    = match[2].trimEnd();

    if (code.trim().length < 10) continue; // skip trivial snippets

    snippets.push({
      index: index++,
      lang,
      code,
    });
  }

  return snippets;
}

// ── URLs ──────────────────────────────────────────────────────────────────────
function extractUrls(text) {
  const raw = [...text.matchAll(URL_RE)].map((m) => m[0]);
  // Clean trailing punctuation sometimes captured by the regex
  const cleaned = raw.map((u) => u.replace(/[.,;:!?)\]}"']+$/, ''));
  return [...new Set(cleaned)];
}

// ── Entities ──────────────────────────────────────────────────────────────────
function extractEntities(text) {
  const found = new Set();
  const lower = text.toLowerCase();

  for (const kw of TECH_KEYWORDS) {
    // Use word-boundary matching on the lowercase text
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
    if (re.test(lower)) {
      found.add(kw);
    }
  }

  return [...found].sort();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function dedupStrings(arr) {
  const seen = new Set();
  return arr.filter((s) => {
    const key = s.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { extract };
