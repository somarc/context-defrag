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

  // Protocols / formats (note: http/https excluded — too noisy as standalone terms)
  'rest','grpc','websocket','oauth','jwt','saml','oidc',
  'json','yaml','toml','protobuf','avro','parquet','arrow','csv','xml',

  // Misc
  'obsidian','markdown','git','npm','yarn','pnpm','bun','node','deno','nix',
]);

// ── Canonical display forms for acronyms / known-casing terms ───────────────
// Keys must match the lowercase entries in TECH_KEYWORDS exactly.
const KEYWORD_DISPLAY = {
  'aem':'AEM','jcr':'JCR','osgi':'OSGi','wcm':'WCM','dam':'DAM','cq':'CQ',
  'aws':'AWS','gcp':'GCP','iam':'IAM','ec2':'EC2','s3':'S3','rds':'RDS',
  'ecs':'ECS','eks':'EKS','cdn':'CDN',
  'json':'JSON','yaml':'YAML','xml':'XML','csv':'CSV','sql':'SQL',
  'graphql':'GraphQL','grpc':'gRPC','rest':'REST','oauth':'OAuth',
  'jwt':'JWT','saml':'SAML','oidc':'OIDC','api':'API','sdk':'SDK',
  'cli':'CLI','llm':'LLM','rag':'RAG','npm':'npm','css':'CSS','html':'HTML',
  'wasm':'WASM','k8s':'k8s','dbt':'dbt','lora':'LoRA','qlora':'QLoRA',
  'vllm':'vLLM','gguf':'GGUF','ggml':'GGML',
  'nextjs':'Next.js','nestjs':'NestJS','nuxt':'Nuxt','fastapi':'FastAPI',
  'postgresql':'PostgreSQL','mongodb':'MongoDB','elasticsearch':'Elasticsearch',
  'cloudflare':'Cloudflare','github':'GitHub','gitlab':'GitLab',
  'bitbucket':'Bitbucket','figma':'Figma','openai':'OpenAI',
  'anthropic':'Anthropic','claude':'Claude','pytorch':'PyTorch',
  'tensorflow':'TensorFlow','scikit-learn':'scikit-learn',
  'langchain':'LangChain','llamaindex':'LlamaIndex','huggingface':'HuggingFace',
  'obsidian':'Obsidian','markdown':'Markdown','typescript':'TypeScript',
  'javascript':'JavaScript','python':'Python','kotlin':'Kotlin','swift':'Swift',
  'golang':'Go','webassembly':'WebAssembly','powershell':'PowerShell',
};

// ── Terms that are too generic / noisy to be useful concepts ────────────────
const CONCEPT_STOPWORDS = new Set([
  'http','https','null','true','false','undefined','const','let','var',
  'function','return','class','import','export','default','async','await',
  'error','warning','info','debug','test','type','data','value','result',
  'object','array','string','number','boolean','file','path','name','key',
  'index','items','list','node','root','base','core','main','util','utils',
  'helper','helpers','service','services','handler','handlers','config',
  'options','params','args','props','state','store','model','schema',
]);

// ── Sentences that signal a decision ────────────────────────────────────────
const DECISION_PATTERNS = [
  /\b(decided|decision|we('re| are| will)?\s+(going|using|adopting|switching))\b/i,
  /\b(will use|we'll use|going with|chosen|we chose|opted for|settled on)\b/i,
  /\b(action item|todo|follow.?up|next step|we need to|should|must|have to)\b/i,
  /\b(don('t| not) use|avoid|drop|remove|replace|migrate (from|away))\b/i,
];

// ── Sentences that signal a strong excerpt (decision or problem framing) ─────
const EXCERPT_SIGNAL_PATTERNS = [
  // Decision language
  /\b(decided|will use|going with|avoid|chosen|don't use|do not use|opted for|settled on)\b/i,
  // Problem framing
  /\b(issue|problem|failing|broken|slow|error|bug|crash|failing)\b/i,
  // Code context
  /\b(function|method|class|returns|throws|implements|extends|interface)\b/i,
];

// ── Conclusion / recommendation language (for session narrative) ─────────────
const CONCLUSION_PATTERNS = [
  /\b(recommend|suggest|should|best approach|in summary|ultimately|conclusion|final)\b/i,
  /\b(the solution|the fix|the answer|the approach|going forward|next steps)\b/i,
];

// ── Regex patterns ───────────────────────────────────────────────────────────
const URL_RE        = /https?:\/\/[^\s<>"')\]]+/g;
const CODE_FENCE_RE = /```(\w*)\n([\s\S]*?)```/g;
const BACKTICK_RE   = /`([^`\n]{2,60})`/g;

// Capitalised multi-word phrases (Title Case), e.g. "Segment Store", "Oak Architecture"
const TITLE_CASE_RE = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){1,5})\b/g;

// Single PascalCase tokens that look like class/product names
const PASCAL_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

// ── Main export ──────────────────────────────────────────────────────────────
function extract(session) {
  const fullText = session.messages.map((m) => m.content).join('\n\n');

  // Inject skill names as high-frequency terms so they surface as concepts.
  // Each skill name gets a synthetic concept entry with count = sessions*2
  // (effectively guaranteed to pass the signal threshold).
  const extraConcepts = [];
  if (session.skillsUsed && session.skillsUsed.length > 0) {
    for (const skill of session.skillsUsed) {
      extraConcepts.push(skill);
    }
  }

  const concepts = extractConcepts(fullText, extraConcepts);

  return {
    concepts,
    decisions: extractDecisions(session.messages),
    snippets:  extractSnippets(fullText),
    urls:      extractUrls(fullText),
    entities:  extractEntities(fullText),
  };
}

// ── Concepts ─────────────────────────────────────────────────────────────────
/**
 * @param {string}   text          - Full session text
 * @param {string[]} [seedTerms]   - Pre-identified high-signal terms (e.g. skill names)
 *                                   that are injected with a high baseline count so they
 *                                   always pass the frequency filter.
 */
function extractConcepts(text, seedTerms = []) {
  const freq  = new Map(); // normalised term → { display, count }

  // 0. Seed terms (e.g. Codex skills) — injected with count 5 so they
  //    always pass the ≥2 filter and score well in signal computation.
  for (const term of seedTerms) {
    if (!term || term.length < 2) continue;
    const key = term.toLowerCase().trim();
    if (CONCEPT_STOPWORDS.has(key)) continue;
    // Use a high baseline count to ensure they surface as concepts
    if (!freq.has(key)) {
      freq.set(key, { display: term, count: 5 });
    } else {
      freq.get(key).count += 5;
    }
  }

  // 1. Backtick-wrapped identifiers
  for (const [, term] of text.matchAll(BACKTICK_RE)) {
    const t = term.trim();
    if (t.length < 2 || t.includes('\n')) continue;
    if (CONCEPT_STOPWORDS.has(t.toLowerCase())) continue;
    bump(freq, t.toLowerCase(), t);
  }

  // 2. Known tech keywords (case-insensitive) — preserve canonical display form
  const words = text.toLowerCase().split(/\W+/);
  for (const w of words) {
    if (TECH_KEYWORDS.has(w)) {
      bump(freq, w, KEYWORD_DISPLAY[w] || w);
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

  // Return concepts that appeared at least twice (or were seeded), sorted by frequency desc
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

// ── Signal scoring ────────────────────────────────────────────────────────────

// ── Decision pattern classification keywords ──────────────────────────────────
const DECISION_PATTERN_KEYWORDS = {
  CHOICE:       /\b(decided|going with|chosen|opted for|will use|we'?ll use|going to use)\b/i,
  AVOIDANCE:    /\b(avoid|don'?t use|not using|rejected|against|won'?t use|shouldn'?t use)\b/i,
  EVOLUTION:    /\b(switched|migrated|replaced|moved away from|deprecated|refactored away)\b/i,
  CONFIRMATION: /\b(confirmed|still using|keeping|sticking with|continuing with|works well)\b/i,
};

/**
 * Classify a single decision sentence into a pattern type.
 *
 * @param {string} sentence
 * @returns {'CHOICE'|'AVOIDANCE'|'EVOLUTION'|'CONFIRMATION'|null}
 */
function classifyDecisionPattern(sentence) {
  if (!sentence) return null;
  for (const [type, re] of Object.entries(DECISION_PATTERN_KEYWORDS)) {
    if (re.test(sentence)) return type;
  }
  return null;
}

/**
 * Compute the number of distinct decision pattern types found for a concept
 * across all sessions (0–4).
 *
 * @param {string} concept      - The concept string (case-insensitive match)
 * @param {Array}  sessionItems - Array of { session, extracted } objects
 * @returns {number}
 */
function computeDecisionPatternDiversity(concept, sessionItems) {
  if (!concept || !Array.isArray(sessionItems)) return 0;

  const re = new RegExp(`\\b${escapeRegex(concept)}\\b`, 'i');
  const foundTypes = new Set();

  for (const item of sessionItems) {
    if (!item || !item.extracted) continue;
    for (const decision of (item.extracted.decisions || [])) {
      if (!re.test(decision)) continue;
      const type = classifyDecisionPattern(decision);
      if (type) foundTypes.add(type);
    }
  }

  return foundTypes.size;
}

/**
 * Compute a relative recency bonus for a concept.
 * Returns 1.5 if the concept appears in any session in the top-quartile
 * (p75) of timestamps across allSessions, otherwise 0.
 * Guard: requires at least 20 sessions to avoid noise on small datasets.
 *
 * @param {string} conceptKey   - The concept string (case-insensitive)
 * @param {Array}  sessionItems - Array of { session, extracted } for sessions mentioning this concept
 * @param {Array}  allSessions  - Full array of { session, extracted } objects (all sessions)
 * @returns {number}
 */
function computeRecencyBonus(conceptKey, sessionItems, allSessions) {
  // Only meaningful with enough history
  if (!allSessions || allSessions.length < 20) return 0;

  // Compute p75 timestamp across all sessions (relative to this user's data)
  const timestamps = allSessions
    .map(s => {
      const ts = s.session ? s.session.timestamp : null;
      return ts instanceof Date ? ts.getTime() : 0;
    })
    .filter(t => t > 0)
    .sort((a, b) => a - b);

  const p75 = timestamps[Math.floor(timestamps.length * 0.75)] || 0;
  if (p75 === 0) return 0;

  // Check if this concept appears in any session in the top quartile
  const hasRecentSession = sessionItems.some(({ session }) => {
    const t = session.timestamp instanceof Date ? session.timestamp.getTime() : 0;
    return t >= p75;
  });

  return hasRecentSession ? 1.5 : 0;
}

/**
 * Compute a signal score for a concept across all sessions.
 *
 * signalScore = (sessionCount × 2) + (decisionCount × 5) + (codeCount × 3)
 *            + (crossProjectCount × 4) + (decisionPatternDiversity × 2) + recencyBoost
 *
 * @param {string}  concept      - The concept string (case-insensitive match)
 * @param {Array}   sessionItems - Array of { session, extracted } objects
 * @param {Array}   [allSessions] - Full session list for recency calculation (optional)
 * @returns {number}
 */
function computeSignalScore(concept, sessionItems, allSessions) {
  if (!concept || !Array.isArray(sessionItems)) return 0;

  const conceptLower = concept.toLowerCase();
  const re = new RegExp(`\\b${escapeRegex(conceptLower)}\\b`, 'i');

  let sessionCount     = 0;
  let decisionCount    = 0;
  let codeCount        = 0;
  const projectSources = new Set();

  // Collect only the sessionItems where this concept appears (for recency check)
  const conceptSessionItems = [];

  for (const item of sessionItems) {
    if (!item || !item.session || !item.extracted) continue;

    const { session, extracted } = item;

    // Check whether this concept appears in this session's concept list
    const appearsInSession = (extracted.concepts || []).some(
      (c) => c.toLowerCase() === conceptLower
    );
    if (!appearsInSession) continue;

    sessionCount++;
    conceptSessionItems.push(item);

    // Count decision sentences mentioning this concept
    for (const d of (extracted.decisions || [])) {
      if (re.test(d)) decisionCount++;
    }

    // Count code snippets whose code body mentions this concept
    for (const snippet of (extracted.snippets || [])) {
      if (snippet && snippet.code && re.test(snippet.code)) codeCount++;
    }

    // Track distinct project/workspace sources
    if (session.source) projectSources.add(session.source);
    // Also track by workspace path if available (miners may set session.workspacePath)
    if (session.workspacePath) projectSources.add(session.workspacePath);
  }

  const crossProjectCount        = projectSources.size;
  const decisionPatternDiversity = computeDecisionPatternDiversity(concept, conceptSessionItems);
  // allSessions may be omitted for backward compatibility — recencyBonus falls back to 0
  const recencyBoost             = computeRecencyBonus(conceptLower, conceptSessionItems, allSessions || null);

  // Skill bonus: if this concept was explicitly named as a skill in any session,
  // it's highly structured signal. +6 per session where it was invoked as a skill.
  let skillBonus = 0;
  for (const item of conceptSessionItems) {
    if (!item || !item.session) continue;
    const skills = item.session.skillsUsed || [];
    if (skills.some(s => s.toLowerCase() === conceptLower)) {
      skillBonus += 6;
    }
  }

  return (sessionCount * 2)
       + (decisionCount * 5)
       + (codeCount * 3)
       + (crossProjectCount * 4)
       + (decisionPatternDiversity * 2)
       + recencyBoost
       + skillBonus;
}

// ── Concept decision attribution ──────────────────────────────────────────────
/**
 * For a given concept string, scan ALL sessions' extracted decisions for
 * sentences mentioning that concept. Returns deduplicated decision sentences.
 *
 * @param {string} concept      - The concept to match (case-insensitive)
 * @param {Array}  sessionItems - Array of { session, extracted } objects
 * @returns {Array<{ sentence: string, sessionTitle: string, sessionDate: string, sessionSlug: string }>}
 */
function extractConceptDecisions(concept, sessionItems) {
  if (!concept || !Array.isArray(sessionItems)) return [];

  const re = new RegExp(`\\b${escapeRegex(concept)}\\b`, 'i');
  const results = [];
  const seen    = new Set();

  for (const item of sessionItems) {
    if (!item || !item.session || !item.extracted) continue;

    const { session, extracted } = item;
    const sessionDate = _isoDate(session.timestamp);
    const sessionSlug = _sessionFileName(session).replace('.md', '');

    for (const decision of (extracted.decisions || [])) {
      if (!re.test(decision)) continue;

      const key = decision.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        sentence:     decision,
        sessionTitle: session.title || sessionSlug,
        sessionDate,
        sessionSlug,
      });
    }
  }

  return results;
}

// ── Concept excerpts ──────────────────────────────────────────────────────────
/**
 * For a given concept, extract the best surrounding context sentences across
 * all sessions. "Best" = prefer sentences containing decision language,
 * problem framing, or code context. Returns up to maxExcerpts unique excerpts
 * with their source session title and date.
 *
 * @param {string} concept      - The concept string (case-insensitive match)
 * @param {Array}  sessionItems - Array of { session, extracted } objects
 * @param {number} maxExcerpts  - Maximum number of excerpts to return (default: 5)
 * @returns {Array<{ text: string, sessionTitle: string, sessionDate: string, sessionSlug: string, score: number }>}
 */
function extractConceptExcerpts(concept, sessionItems, maxExcerpts = 5) {
  if (!concept || !Array.isArray(sessionItems)) return [];

  const re       = new RegExp(`\\b${escapeRegex(concept)}\\b`, 'i');
  const excerpts = [];
  const seenKeys = new Set();

  for (const item of sessionItems) {
    if (!item || !item.session || !item.extracted) continue;

    const { session, extracted } = item;

    // Only look in sessions where this concept appears
    const appearsInSession = (extracted.concepts || []).some(
      (c) => c.toLowerCase() === concept.toLowerCase()
    );
    if (!appearsInSession) continue;

    const sessionDate = _isoDate(session.timestamp);
    const sessionSlug = _sessionFileName(session).replace('.md', '');
    const messages    = (session.messages || []);

    for (const msg of messages) {
      if (!msg || !msg.content) continue;

      // Split into paragraphs, then sentences within each paragraph
      const paras = msg.content.split(/\n{2,}/);

      for (const para of paras) {
        if (!re.test(para)) continue;

        // Split paragraph into sentences
        const sentences = para
          .replace(/\n/g, ' ')
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 15);

        // Find sentences containing the concept
        for (let i = 0; i < sentences.length; i++) {
          const sentence = sentences[i];
          if (!re.test(sentence)) continue;

          // Build context window: preceding + current + following sentence
          const window = [
            i > 0 ? sentences[i - 1] : null,
            sentence,
            i < sentences.length - 1 ? sentences[i + 1] : null,
          ].filter(Boolean).join(' ').slice(0, 300).trim();

          if (window.length < 20) continue;

          // Dedup by normalised text
          const key = window.toLowerCase().replace(/\s+/g, ' ');
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          // Score this excerpt by signal quality
          let score = 1;
          for (const pat of EXCERPT_SIGNAL_PATTERNS) {
            if (pat.test(window)) score += 2;
          }

          excerpts.push({
            text:         window,
            sessionTitle: session.title || sessionSlug,
            sessionDate,
            sessionSlug,
            score,
          });
        }
      }
    }
  }

  // Sort by score desc, then trim to maxExcerpts
  return excerpts
    .sort((a, b) => b.score - a.score)
    .slice(0, maxExcerpts);
}

// ── Session narrative ─────────────────────────────────────────────────────────
/**
 * Produce a 2-3 sentence narrative summary for a session:
 * - Opening: core problem/topic from the first 1-2 human messages (~150 chars)
 * - Approach: decision sentences, or a summary of top concepts
 * - Outcome: last assistant message excerpt containing conclusion language
 *
 * Falls back gracefully if content is sparse.
 *
 * @param {Object} session   - Normalised session object (has .messages, .title)
 * @param {Object} extracted - Extracted data for this session
 * @returns {string}
 */
function extractSessionNarrative(session, extracted) {
  if (!session || !session.messages || session.messages.length === 0) {
    return (session && session.title) ? `Session: ${session.title}.` : '';
  }

  const messages = session.messages;

  // ── Opening: derive core problem/topic from first human message(s) ────────
  let opening = '';
  const humanMessages = messages.filter(
    (m) => m && (m.role === 'human' || m.role === 'user')
  );

  if (humanMessages.length > 0) {
    const firstHuman = humanMessages[0].content || '';
    // Take the first meaningful line/sentence
    const firstLine = firstHuman
      .replace(/\n+/g, ' ')
      .trim()
      .split(/[.!?]\s+/)[0]
      .slice(0, 150)
      .trim();

    if (firstLine.length > 10) {
      opening = firstLine.endsWith('.')
        ? firstLine
        : firstLine + '.';
    }
  }

  if (!opening && session.title) {
    opening = `Topic: ${session.title}.`;
  }

  // ── Approach: decision sentences, or top concept names ────────────────────
  let approach = '';
  const decisions = extracted && extracted.decisions ? extracted.decisions : [];

  if (decisions.length > 0) {
    // Take the most informative decision (longest one up to 200 chars)
    const best = decisions
      .slice()
      .sort((a, b) => b.length - a.length)
      .find((d) => d.length <= 200);

    if (best) {
      approach = best.endsWith('.') ? best : best + '.';
    }
  }

  if (!approach) {
    // Fall back to listing top concepts
    const concepts = extracted && extracted.concepts ? extracted.concepts : [];
    if (concepts.length > 0) {
      const top = concepts.slice(0, 4).join(', ');
      approach = `Covered: ${top}.`;
    }
  }

  // ── Outcome: last assistant message with conclusion language ──────────────
  let outcome = '';
  const assistantMessages = messages.filter(
    (m) => m && (m.role === 'assistant' || m.role === 'bot')
  );

  // Search assistant messages in reverse for conclusion language
  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const content = (assistantMessages[i].content || '').replace(/\n/g, ' ');

    // Split into sentences and find the one with conclusion language
    const sentences = content
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15);

    for (const sentence of sentences) {
      if (CONCLUSION_PATTERNS.some((re) => re.test(sentence))) {
        outcome = sentence.slice(0, 200).trim();
        if (!outcome.endsWith('.')) outcome += '.';
        break;
      }
    }

    if (outcome) break;
  }

  // ── Assemble ───────────────────────────────────────────────────────────────
  const parts = [opening, approach, outcome].filter(Boolean);

  // Avoid returning an empty string — fall back to title
  if (parts.length === 0) {
    return session.title ? `Session: ${session.title}.` : '';
  }

  return parts.join(' ');
}

// ── Private helpers (used internally — not re-exported from obsidian.js) ─────

function _isoDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

function _sessionFileName(session) {
  if (!session) return 'unknown.md';
  const date  = _isoDate(session.timestamp);
  const title = (session.title || 'untitled')
    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 50)
    .replace(/-+$/, '');
  return `${session.source || 'unknown'}-${date}-${title}.md`;
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

module.exports = {
  extract,
  computeSignalScore,
  computeRecencyBonus,
  classifyDecisionPattern,
  computeDecisionPatternDiversity,
  extractConceptDecisions,
  extractConceptExcerpts,
  extractSessionNarrative,
};
