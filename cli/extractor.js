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
  /\b(don('t| not) use|avoid|drop|remove|replace|migrate (from|away))\b/i,
];

const ISSUE_PATTERNS = [
  /\b(issue|problem|bug|broken|failing|failure|regression|crash|blocked|stuck|missing)\b/i,
  /\b(error|exception|stack trace|timeout|timed out|429|500|403|404|permission denied)\b/i,
  /\b(can('?t|not)|won('?t)|doesn('?t)|didn('?t)|unable to|cannot)\b/i,
  /\b(slow|latency|performance|hang|hung|degraded)\b/i,
];

const ACTION_ITEM_PATTERNS = [
  /\b(action item|todo|follow.?up|next step|need to|needs to|should|must|have to|remember to)\b/i,
  /^\s*[-*]\s+(todo|follow.?up|next step)\b/i,
];

const COMMIT_PATTERNS = [
  /\b(git commit|commit message|committed|commit|pushed|push|merged|merge|pull request|opened pr|created pr)\b/i,
  /\b(checkout|branch|rebase|cherry-pick|stash|squash)\b/i,
  /\b[0-9a-f]{7,40}\b/i,
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
const FILE_PATH_RE  = /(?:^|[\s("'`])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@~-]+\/)+[A-Za-z0-9_.@~-]+\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|json|jsx|mjs|cjs|md|py|rb|rs|sh|sql|ts|tsx|txt|xml|ya?ml))(?=$|[\s)"'`,;:])/gm;

// Capitalised multi-word phrases (Title Case), e.g. "Segment Store", "Oak Architecture"
const TITLE_CASE_RE = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){1,5})\b/g;

// Single PascalCase tokens that look like class/product names
const PASCAL_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

// ── Main export ──────────────────────────────────────────────────────────────

// Cap the text size fed to regex-heavy extraction to prevent event loop starvation.
// 500 KB of session text is more than enough for concept/decision extraction;
// larger sessions are usually bloated by tool output or copied file contents.
const MAX_EXTRACT_TEXT_LENGTH = 500_000;
const MAX_CONCEPTS_PER_SESSION = 40;

function extract(session) {
  const messages = Array.isArray(session?.messages)
    ? session.messages.filter((m) => m && typeof m.content === 'string' && m.content.trim())
    : [];

  let fullText = messages.map((m) => m.content).join('\n\n');
  const originalLength = fullText.length;

  // Truncate excessively long sessions to prevent regex stalls
  if (fullText.length > MAX_EXTRACT_TEXT_LENGTH) {
    fullText = fullText.slice(0, MAX_EXTRACT_TEXT_LENGTH);
  }

  const snippets    = extractSnippets(fullText);
  const urls        = extractUrls(fullText);
  const entities    = extractEntities(fullText);
  const files       = extractFileReferences(fullText, session);
  const tools       = extractToolContext(session, fullText);
  const workspaces  = extractWorkspaceContext(session);
  const skills      = Array.isArray(session.skillsUsed) ? session.skillsUsed.filter(Boolean) : [];

  const decisionItems = extractStructuredItems(messages, DECISION_PATTERNS, 'decision');
  const issueItems    = extractStructuredItems(messages, ISSUE_PATTERNS, 'issue');
  const actionItems   = extractStructuredItems(messages, ACTION_ITEM_PATTERNS, 'action');
  const commitItems   = extractStructuredItems(messages, COMMIT_PATTERNS, 'commit');

  const conceptObjects = buildConceptObjects({
    session,
    fullText,
    messages,
    snippets,
    urls,
    entities,
    files,
    tools,
    workspaces,
    skills,
    decisionItems,
    issueItems,
    actionItems,
    commitItems,
  });

  return {
    concepts: conceptObjects.map((concept) => concept.name),
    conceptObjects,
    decisions: decisionItems.map((item) => item.text),
    decisionItems,
    issues: issueItems,
    actionItems,
    commits: commitItems,
    snippets,
    urls,
    entities,
    files,
    tools,
    technicalContext: {
      files,
      tools,
      workspaces,
      skills,
      entities,
    },
    observability: buildExtractionObservability({
      source: session?.source || 'unknown',
      originalLength,
      extractedLength: fullText.length,
      truncated: originalLength > fullText.length,
      conceptObjects,
      decisionItems,
      issueItems,
      actionItems,
      commitItems,
      snippets,
      urls,
      files,
      tools,
      metaOnly: Boolean(session?.cursorMetaOnly),
    }),
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
  const conceptObjects = buildConceptObjects({
    session: {},
    fullText: text || '',
    messages: [],
    snippets: [],
    urls: [],
    entities: [],
    files: [],
    tools: [],
    workspaces: [],
    skills: seedTerms,
    decisionItems: [],
    issueItems: [],
    actionItems: [],
    commitItems: [],
  });
  return conceptObjects.map((concept) => concept.name);
}

function buildConceptObjects({
  session,
  fullText,
  messages,
  snippets,
  urls,
  entities,
  files,
  tools,
  workspaces,
  skills,
  decisionItems,
  issueItems,
  actionItems,
  commitItems,
}) {
  const conceptMap = new Map();

  const register = (rawValue, opts = {}) => registerConceptEvidence(conceptMap, rawValue, opts);

  for (const skill of skills || []) {
    register(skill, { sourceType: 'skill', kind: 'skill', weight: 6, evidenceText: skill });
  }

  for (const tool of tools || []) {
    register(tool, { sourceType: 'tool', kind: 'tool', weight: 4, tool, evidenceText: tool });
  }

  for (const workspace of workspaces || []) {
    register(workspace, { sourceType: 'workspace', kind: 'workspace', weight: 4, workspace, evidenceText: workspace });
  }

  if (session && session.title) {
    addTextConceptEvidence(conceptMap, session.title, {
      sourceType: 'title',
      weight: 3,
      allowSingle: true,
      evidenceText: session.title,
    });
  }

  addTextConceptEvidence(conceptMap, fullText, { sourceType: 'message', weight: 1, allowSingle: false });

  for (const snippet of snippets || []) {
    if (snippet && snippet.lang) {
      register(snippet.lang, {
        sourceType: 'snippet-language',
        kind: 'technology',
        weight: 2,
        evidenceText: snippet.lang,
      });
    }
  }

  for (const fileRef of files || []) {
    const fileName = pathTail(fileRef);
    register(fileName, {
      sourceType: 'file',
      kind: 'artifact',
      weight: 3,
      allowSingle: true,
      file: fileRef,
      evidenceText: fileRef,
    });
  }

  addStructuredConceptEvidence(conceptMap, decisionItems, { sourceType: 'decision', weight: 4, counter: 'decisionCount' });
  addStructuredConceptEvidence(conceptMap, issueItems, { sourceType: 'issue', weight: 4, counter: 'issueCount' });
  addStructuredConceptEvidence(conceptMap, actionItems, { sourceType: 'action', weight: 3, counter: 'actionItemCount' });
  addStructuredConceptEvidence(conceptMap, commitItems, { sourceType: 'commit', weight: 3, counter: 'commitCount' });

  for (const entity of entities || []) {
    register(KEYWORD_DISPLAY[entity] || entity, {
      sourceType: 'entity',
      kind: 'technology',
      weight: 2,
      evidenceText: entity,
    });
  }

  const results = [...conceptMap.values()]
    .map(finalizeConceptObject)
    .filter(shouldKeepConcept)
    .sort((a, b) =>
      b.score - a.score ||
      b.mentionCount - a.mentionCount ||
      a.name.localeCompare(b.name)
    )
    .slice(0, MAX_CONCEPTS_PER_SESSION);

  return results;
}

function addStructuredConceptEvidence(conceptMap, items, { sourceType, weight, counter }) {
  for (const item of items || []) {
    const candidateKeys = [];

    for (const candidate of collectTextConceptCandidates(item.text, { allowSingle: true, includeFiles: true })) {
      const key = registerConceptEvidence(conceptMap, candidate.display, {
        sourceType,
        kind: candidate.kind,
        weight,
        evidenceText: item.text,
        role: item.role,
        timestamp: item.timestamp,
        counter,
        file: candidate.file || null,
      });
      if (key) candidateKeys.push(key);
    }

    item.concepts = uniqueDisplayNames(
      candidateKeys.map((key) => conceptMap.get(key)?.name).filter(Boolean)
    );

    connectRelatedConcepts(conceptMap, candidateKeys);
  }
}

function addTextConceptEvidence(conceptMap, text, { sourceType, weight, allowSingle, evidenceText }) {
  for (const candidate of collectTextConceptCandidates(text, { allowSingle, includeFiles: true })) {
    registerConceptEvidence(conceptMap, candidate.display, {
      sourceType,
      kind: candidate.kind,
      weight,
      evidenceText: evidenceText || text,
      file: candidate.file || null,
    });
  }
}

function registerConceptEvidence(conceptMap, rawValue, {
  sourceType = 'message',
  kind = 'topic',
  weight = 1,
  evidenceText = '',
  role = null,
  timestamp = null,
  counter = null,
  file = null,
  tool = null,
  workspace = null,
} = {}) {
  const concept = normaliseConceptValue(rawValue);
  if (!concept) return null;

  const key = normaliseConceptKey(concept);
  let draft = conceptMap.get(key);
  if (!draft) {
    draft = {
      key,
      name: concept,
      kind,
      aliases: new Set(),
      sourceTypes: new Set(),
      mentionCount: 0,
      score: 0,
      decisionCount: 0,
      issueCount: 0,
      actionItemCount: 0,
      commitCount: 0,
      codeCount: 0,
      evidence: [],
      files: new Set(),
      tools: new Set(),
      workspaces: new Set(),
      related: new Map(),
    };
    conceptMap.set(key, draft);
  } else if (shouldReplaceDisplayName(draft.name, concept)) {
    draft.aliases.add(draft.name);
    draft.name = concept;
  } else if (concept !== draft.name) {
    draft.aliases.add(concept);
  }

  draft.kind = pickConceptKind(draft.kind, kind);
  draft.sourceTypes.add(sourceType);
  draft.mentionCount++;
  draft.score += weight;

  if (counter && typeof draft[counter] === 'number') {
    draft[counter]++;
  }
  if (file) draft.files.add(file);
  if (tool) draft.tools.add(tool);
  if (workspace) draft.workspaces.add(workspace);

  if (evidenceText) {
    const excerpt = normaliseInline(evidenceText).slice(0, 220);
    if (excerpt && !draft.evidence.some((entry) => entry.text === excerpt && entry.type === sourceType)) {
      draft.evidence.push({
        type: sourceType,
        text: excerpt,
        role,
        timestamp,
      });
    }
  }

  return key;
}

function collectTextConceptCandidates(text, { allowSingle = false, includeFiles = false } = {}) {
  const candidates = [];
  if (!text) return candidates;

  for (const [, term] of text.matchAll(BACKTICK_RE)) {
    const value = normaliseConceptValue(term, { allowSingle });
    if (!value) continue;
    candidates.push({ display: value, kind: looksLikeFileRef(value) ? 'artifact' : 'topic' });
  }

  if (includeFiles) {
    for (const fileRef of extractFileReferences(text)) {
      const fileName = pathTail(fileRef);
      const display = normaliseConceptValue(fileName, { allowSingle: true });
      if (!display) continue;
      candidates.push({ display, kind: 'artifact', file: fileRef });
    }
  }

  const lower = text.toLowerCase();
  for (const keyword of TECH_KEYWORDS) {
    const re = keywordNeedsLooseBoundary(keyword)
      ? new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(keyword)}(?=$|[^A-Za-z0-9])`, 'i')
      : new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i');
    if (!re.test(lower)) continue;
    candidates.push({ display: KEYWORD_DISPLAY[keyword] || keyword, kind: 'technology' });
  }

  for (const [, phrase] of text.matchAll(TITLE_CASE_RE)) {
    if (isStopPhrase(phrase)) continue;
    const value = normaliseConceptValue(phrase, { allowSingle: true });
    if (!value) continue;
    candidates.push({ display: value, kind: 'topic' });
  }

  for (const [, token] of text.matchAll(PASCAL_RE)) {
    const value = normaliseConceptValue(token, { allowSingle: true });
    if (!value) continue;
    candidates.push({ display: value, kind: 'topic' });
  }

  return dedupConceptCandidates(candidates);
}

function dedupConceptCandidates(candidates) {
  const seen = new Set();
  const results = [];

  for (const candidate of candidates) {
    const key = `${normaliseConceptKey(candidate.display)}::${candidate.kind}::${candidate.file || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(candidate);
  }

  return results;
}

function finalizeConceptObject(draft) {
  const relatedConcepts = [...draft.related.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => ({ key, count }));

  return {
    key: draft.key,
    name: draft.name,
    kind: draft.kind,
    aliases: [...draft.aliases].sort(),
    sourceTypes: [...draft.sourceTypes].sort(),
    mentionCount: draft.mentionCount,
    score: draft.score
      + draft.decisionCount * 3
      + draft.issueCount * 3
      + draft.actionItemCount * 2
      + draft.commitCount * 2
      + draft.codeCount * 2
      + draft.files.size
      + draft.tools.size
      + draft.workspaces.size,
    decisionCount: draft.decisionCount,
    issueCount: draft.issueCount,
    actionItemCount: draft.actionItemCount,
    commitCount: draft.commitCount,
    codeCount: draft.codeCount,
    files: [...draft.files].slice(0, 12),
    tools: [...draft.tools].slice(0, 12),
    workspaces: [...draft.workspaces].slice(0, 8),
    evidence: draft.evidence.slice(0, 6),
    relatedConcepts,
  };
}

function shouldKeepConcept(concept) {
  if (!concept) return false;
  if (concept.mentionCount >= 2) return true;
  if (concept.decisionCount > 0 || concept.issueCount > 0 || concept.actionItemCount > 0 || concept.commitCount > 0) {
    return true;
  }
  if (concept.files.length > 0 || concept.tools.length > 0 || concept.workspaces.length > 0) {
    return true;
  }
  if (concept.kind === 'skill' || concept.kind === 'tool' || concept.kind === 'workspace') {
    return true;
  }
  return concept.score >= 4;
}

function connectRelatedConcepts(conceptMap, keys) {
  const uniqueKeys = [...new Set(keys)].filter(Boolean);
  for (let i = 0; i < uniqueKeys.length; i++) {
    for (let j = i + 1; j < uniqueKeys.length; j++) {
      const left = conceptMap.get(uniqueKeys[i]);
      const right = conceptMap.get(uniqueKeys[j]);
      if (!left || !right) continue;
      left.related.set(right.key, (left.related.get(right.key) || 0) + 1);
      right.related.set(left.key, (right.related.get(left.key) || 0) + 1);
    }
  }
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
  return extractStructuredItems(messages, DECISION_PATTERNS, 'decision').map((item) => item.text);
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
    const re = buildConceptRegex(kw);
    if (re.test(lower)) {
      found.add(kw);
    }
  }

  return [...found].sort();
}

function extractStructuredItems(messages, patterns, kind) {
  const items = [];
  const seen = new Set();

  for (const msg of messages || []) {
    const units = splitMessageIntoUnits(msg.content || '');
    for (const unit of units) {
      if (unit.length < 12 || unit.length > 420) continue;
      if (!patterns.some((re) => re.test(unit))) continue;

      const key = unit.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        type: kind,
        text: unit,
        role: msg.role || null,
        timestamp: msg.timestamp || null,
        concepts: [],
      });
    }
  }

  return items;
}

function splitMessageIntoUnits(text) {
  if (!text) return [];
  const stripped = stripCodeFences(text);
  return stripped
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .flatMap((part) => part.split('\n'))
    .map((part) => normaliseInline(part))
    .filter(Boolean);
}

function stripCodeFences(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ');
}

function extractFileReferences(text, session) {
  const found = new Set(Array.isArray(session?.filesTouched) ? session.filesTouched : []);
  if (text) {
    for (const match of text.matchAll(FILE_PATH_RE)) {
      const fileRef = normaliseInline(match[1]).replace(/[,;.]+$/, '');
      if (fileRef) found.add(fileRef);
    }
  }
  return [...found].slice(0, 20);
}

function extractToolContext(session, text) {
  const tools = new Set();
  if (Array.isArray(session?.toolCalls)) {
    for (const toolCall of session.toolCalls) {
      if (toolCall && toolCall.tool) tools.add(toolCall.tool);
    }
  }
  const toolListMatch = String(text || '').match(/\[Tools called:\s*([^\]]+)\]/i);
  if (toolListMatch) {
    toolListMatch[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((tool) => tools.add(tool));
  }
  return [...tools].slice(0, 20);
}

function extractWorkspaceContext(session) {
  const workspaces = [];
  const candidates = [
    session?.workspacePath,
    session?.workspaceName,
    session?.cwd,
    session?.workspace,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const name = typeof candidate === 'string' && candidate.includes('/')
      ? pathTail(candidate)
      : String(candidate);
    if (!name) continue;
    if (/^[0-9a-f]{8,}$/i.test(name)) continue;
    if (!workspaces.includes(name)) workspaces.push(name);
  }

  return workspaces.slice(0, 6);
}

function buildExtractionObservability({
  source,
  originalLength,
  extractedLength,
  truncated,
  conceptObjects,
  decisionItems,
  issueItems,
  actionItems,
  commitItems,
  snippets,
  urls,
  files,
  tools,
  metaOnly,
}) {
  const weakSignals = [];
  if (metaOnly) weakSignals.push('metadata-only cursor session');
  if (conceptObjects.length === 0) weakSignals.push('no concepts');
  if (decisionItems.length === 0 && issueItems.length === 0 && actionItems.length === 0 && commitItems.length === 0) {
    weakSignals.push('no structured signals');
  }
  if (snippets.length === 0 && files.length === 0 && tools.length === 0) {
    weakSignals.push('thin technical context');
  }
  if (truncated) weakSignals.push('truncated input');

  return {
    source,
    textLength: originalLength,
    extractedLength,
    truncated,
    conceptCount: conceptObjects.length,
    decisionCount: decisionItems.length,
    issueCount: issueItems.length,
    actionItemCount: actionItems.length,
    commitCount: commitItems.length,
    snippetCount: snippets.length,
    urlCount: urls.length,
    fileCount: files.length,
    toolCount: tools.length,
    weakSignals,
  };
}

// ── Signal scoring ────────────────────────────────────────────────────────────

// ── Decision pattern classification keywords ──────────────────────────────────
const DECISION_PATTERN_KEYWORDS = {
  CHOICE:       /\b(decided|going with|chosen|opted for|will use|we'?ll use|going to use)\b/i,
  AVOIDANCE:    /\b(avoid(?:\s+using)?|do not use|don'?t use|not using|rejected|against|won'?t use|shouldn'?t use)\b/i,
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

  const re = buildConceptRegex(concept);
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

  const conceptLower = normaliseConceptKey(concept);
  const re = buildConceptRegex(conceptLower);

  let sessionCount     = 0;
  let decisionCount    = 0;
  let issueCount       = 0;
  let actionItemCount  = 0;
  let commitCount      = 0;
  let codeCount        = 0;
  const projectSources = new Set();

  // Collect only the sessionItems where this concept appears (for recency check)
  const conceptSessionItems = [];

  for (const item of sessionItems) {
    if (!item || !item.session || !item.extracted) continue;

    const { session, extracted } = item;
    const conceptRecord = findConceptRecord(extracted, conceptLower);

    // Check whether this concept appears in this session's concept list
    const appearsInSession = Boolean(conceptRecord) || (extracted.concepts || []).some(
      (c) => normaliseConceptKey(c) === conceptLower
    );
    if (!appearsInSession) continue;

    sessionCount++;
    conceptSessionItems.push(item);

    decisionCount   += conceptRecord?.decisionCount   || countMatchingStrings(extracted.decisionItems || extracted.decisions || [], re);
    issueCount      += conceptRecord?.issueCount      || countMatchingStrings(extracted.issues || [], re);
    actionItemCount += conceptRecord?.actionItemCount || countMatchingStrings(extracted.actionItems || [], re);
    commitCount     += conceptRecord?.commitCount     || countMatchingStrings(extracted.commits || [], re);
    codeCount       += conceptRecord?.codeCount       || countMatchingCode(extracted.snippets || [], re);

    // Track distinct project/workspace sources
    if (session.source) projectSources.add(session.source);
    if (session.workspace) projectSources.add(session.workspace);
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
       + (issueCount * 4)
       + (actionItemCount * 4)
       + (commitCount * 3)
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

  const key = normaliseConceptKey(concept);
  const re = buildConceptRegex(key);
  const results = [];
  const seen    = new Set();

  for (const item of sessionItems) {
    if (!item || !item.session || !item.extracted) continue;

    const { session, extracted } = item;
    const sessionDate = _isoDate(session.timestamp);
    const sessionSlug = _sessionFileName(session).replace('.md', '');

    const sourceItems = extracted.decisionItems || (extracted.decisions || []).map((text) => ({ text, concepts: [] }));
    for (const decision of sourceItems) {
      const text = typeof decision === 'string' ? decision : decision.text;
      const concepts = decision && Array.isArray(decision.concepts) ? decision.concepts : [];
      const matchesConcept = concepts.some((name) => normaliseConceptKey(name) === key) || re.test(text);
      if (!matchesConcept) continue;

      const seenKey = text.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);

      results.push({
        sentence:     text,
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

  const key      = normaliseConceptKey(concept);
  const re       = buildConceptRegex(key);
  const excerpts = [];
  const seenKeys = new Set();

  for (const item of sessionItems) {
    if (!item || !item.session || !item.extracted) continue;

    const { session, extracted } = item;

    // Only look in sessions where this concept appears
    const appearsInSession = Boolean(findConceptRecord(extracted, key)) || (extracted.concepts || []).some(
      (c) => normaliseConceptKey(c) === key
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
  const issues    = extracted && extracted.issues ? extracted.issues.map((item) => item.text || item) : [];
  const actions   = extracted && extracted.actionItems ? extracted.actionItems.map((item) => item.text || item) : [];

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
    const strongProblem = issues.find((item) => item.length <= 180);
    if (strongProblem) {
      approach = strongProblem.endsWith('.') ? strongProblem : strongProblem + '.';
    }
  }

  if (!approach) {
    const nextStep = actions.find((item) => item.length <= 180);
    if (nextStep) {
      approach = nextStep.endsWith('.') ? nextStep : nextStep + '.';
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

function uniqueDisplayNames(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function findConceptRecord(extracted, conceptKey) {
  const key = normaliseConceptKey(conceptKey);
  const concepts = Array.isArray(extracted?.conceptObjects) ? extracted.conceptObjects : [];
  return concepts.find((concept) =>
    concept.key === key ||
    normaliseConceptKey(concept.name) === key ||
    (concept.aliases || []).some((alias) => normaliseConceptKey(alias) === key)
  ) || null;
}

function countMatchingStrings(items, re) {
  let count = 0;
  for (const item of items || []) {
    const text = typeof item === 'string' ? item : item?.text;
    if (text && re.test(text)) count++;
  }
  return count;
}

function countMatchingCode(snippets, re) {
  let count = 0;
  for (const snippet of snippets || []) {
    if (snippet && snippet.code && re.test(snippet.code)) count++;
  }
  return count;
}

function normaliseConceptValue(value, { allowSingle = false } = {}) {
  if (!value) return null;
  const text = normaliseInline(value)
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ');

  if (!text || text.length < 2 || text.length > 80) return null;
  if (!allowSingle && text.split(/\s+/).length > 6) return null;
  if (CONCEPT_STOPWORDS.has(text.toLowerCase())) return null;
  if (/^[^A-Za-z0-9]+$/.test(text)) return null;
  if (/^(todo|fix|issue|problem|next step)$/i.test(text)) return null;
  return text;
}

function normaliseConceptKey(value) {
  return normaliseInline(value)
    .toLowerCase()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ');
}

function normaliseInline(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function keywordNeedsLooseBoundary(keyword) {
  return /[.+#/\- ]/.test(keyword);
}

function looksLikeFileRef(value) {
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

function pathTail(value) {
  const cleaned = String(value || '').replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

function shouldReplaceDisplayName(current, incoming) {
  if (!current) return true;
  if (KEYWORD_DISPLAY[normaliseConceptKey(incoming)] === incoming) return true;
  if (/[A-Z]/.test(incoming) && !/[A-Z]/.test(current)) return true;
  return incoming.length < current.length && incoming.includes('-');
}

function pickConceptKind(current, next) {
  const priority = { skill: 5, tool: 4, workspace: 4, artifact: 3, technology: 2, topic: 1 };
  const currentPriority = priority[current] || 0;
  const nextPriority = priority[next] || 0;
  return nextPriority > currentPriority ? next : current;
}

function buildConceptRegex(value) {
  const concept = normaliseConceptKey(value);
  return keywordNeedsLooseBoundary(concept)
    ? new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(concept)}(?=$|[^A-Za-z0-9])`, 'i')
    : new RegExp(`\\b${escapeRegex(concept)}\\b`, 'i');
}


function escapeRegex(s) {
  return s.replace(/[-.*+?^${}()|[\]\\]/g, '\\$' + '&');
}

//    Session signal scoring                                                   
// Determines the rendering tier for a session note:
//   HIGH   (e12): Full treatment  narrative + decisions + concepts + code + URLs
//   MEDIUM (511): Narrative + decisions + top concepts (skip code/URL sections)
//   LOW    (<5):  Minimal  title, date, source, top 3 concepts inline

const SESSION_TIER_HIGH   = 12;
const SESSION_TIER_MEDIUM = 5;

function computeSessionScore(session, extracted) {
  const turnCount       = session.turnCount    || session.messages?.length || 0;
  const decisionCount   = extracted.decisions   ? extracted.decisions.length  : 0;
  const issueCount      = extracted.issues      ? extracted.issues.length     : 0;
  const actionCount     = extracted.actionItems ? extracted.actionItems.length : 0;
  const commitCount     = extracted.commits     ? extracted.commits.length    : 0;
  const snippetCount    = extracted.snippets    ? extracted.snippets.length   : 0;
  const conceptCount    = extracted.concepts    ? extracted.concepts.length   : 0;
  const fileCount       = extracted.files       ? extracted.files.length       : 0;
  const toolCount       = extracted.tools       ? extracted.tools.length       : 0;

  return (turnCount * 0.5)
       + (decisionCount * 3)
       + (issueCount * 2.5)
       + (actionCount * 2.5)
       + (commitCount * 2)
       + (snippetCount * 2)
       + (conceptCount * 0.3)
       + (fileCount * 0.2)
       + (toolCount * 0.3);
}

function sessionTier(score) {
  if (score >= SESSION_TIER_HIGH)   return 'HIGH';
  if (score >= SESSION_TIER_MEDIUM) return 'MEDIUM';
  return 'LOW';
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
  computeSessionScore,
  sessionTier,
  SESSION_TIER_HIGH,
  SESSION_TIER_MEDIUM,
};
