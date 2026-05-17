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
  // Codex/Claude injection artifacts — skill filenames, system context fragments
  'skill.md','agents.md','claude.md','readme.md','contributing.md','license.md',
  'package.json','tsconfig','eslintrc','gitignore','env',
  // Codex tool names — appear in every agentic session, zero concept signal
  'exec_command','read_file','write_file','delete_file','create_file',
  'bash','grep','find','sed','awk','cat','ls','cd','mv','cp','rm','mkdir',
  'shell','terminal','command','run','execute','invoke',
  // Generic coding noise
  'todo','fixme','hack','workaround','temp','tmp','wip','n/a','tbd','tbc',
  // Single-char and near-empty
  'a','b','c','d','e','f','g','h','i','j','k','l','m',
  'n','o','p','q','r','s','t','u','v','w','x','y','z',
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

const RESUME_PATTERNS = [
  /\b(continue|continuing|continued|resume|resuming|resumed)\b/i,
  /\b(pick(?:ing)? up|back to|return(?:ing)? to|revisit(?:ing)?)\b/i,
  /\b(still|again|follow.?up|as discussed|same issue|previously)\b/i,
];

const BLOCKER_PATTERNS = [
  /\b(blocked|stuck|waiting on|pending|cannot proceed|can'?t proceed|unable to continue)\b/i,
  /\b(has blocking pending actions|needs unblock|waiting for)\b/i,
];

const PIVOT_PATTERNS = [
  /\b(instead|rather than|pivot|switched|changed course|moved away from)\b/i,
  /\b(replace|replaced|migrated from|migrating away)\b/i,
];

const RESOLUTION_PATTERNS = [
  /\b(fixed|resolved|working now|works now|unblocked|done|complete|completed)\b/i,
  /\b(merged|landed|shipped|closed out|finalized)\b/i,
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

function extract(session, opts = {}) {
  const ctx = createExtractionContext(session, opts);
  runExtractionStages(ctx);
  return finalizeExtractionResult(ctx);
}

async function extractAsync(session, opts = {}) {
  const ctx = createExtractionContext(session, { ...opts, deferEvents: true });
  await runExtractionStagesAsync(ctx);
  return finalizeExtractionResult(ctx);
}

function createExtractionContext(session, opts = {}) {
  const messages = Array.isArray(session?.messages)
    ? session.messages.filter((m) => m && typeof m.content === 'string' && m.content.trim())
    : [];

  let fullText = messages.map((m) => m.content).join('\n\n');
  const originalLength = fullText.length;
  const truncated = fullText.length > MAX_EXTRACT_TEXT_LENGTH;
  if (truncated) {
    fullText = fullText.slice(0, MAX_EXTRACT_TEXT_LENGTH);
  }

  return {
    session,
    messages,
    fullText,
    originalLength,
    truncated,
    reporter: createExtractionReporter(session, opts),
    snippets: [],
    urls: [],
    entities: [],
    files: [],
    tools: [],
    workspaces: [],
    skills: Array.isArray(session?.skillsUsed) ? session.skillsUsed.filter(Boolean) : [],
    decisionItems: [],
    issueItems: [],
    actionItems: [],
    commitItems: [],
    conceptObjects: [],
    continuity: null,
  };
}

function runExtractionStages(ctx) {
  runPrepareStage(ctx);
  runArtifactStage(ctx);
  runContextStage(ctx);
  runSignalStage(ctx);
  runConceptStage(ctx);
  runContinuityStage(ctx);
}

async function runExtractionStagesAsync(ctx) {
  runPrepareStage(ctx);
  await yieldToEventLoop();
  runArtifactStage(ctx);
  await yieldToEventLoop();
  runContextStage(ctx);
  await yieldToEventLoop();
  runSignalStage(ctx);
  await yieldToEventLoop();
  runConceptStage(ctx);
  await yieldToEventLoop();
  runContinuityStage(ctx);
  await yieldToEventLoop();
}

function runPrepareStage(ctx) {
  ctx.reporter.emit('prepare', {
    progress: 0.05,
    label: 'Assembling session text',
    detail: `${ctx.messages.length} message${ctx.messages.length !== 1 ? 's' : ''} · ${formatCount(ctx.originalLength)} chars`,
    quality: ctx.truncated ? 'truncated' : 'steady',
  });
}

function runArtifactStage(ctx) {
  ctx.snippets = extractSnippets(ctx.fullText);
  ctx.urls = extractUrls(ctx.fullText);
  ctx.entities = extractEntities(ctx.fullText);
  ctx.reporter.emit('artifacts', {
    progress: 0.2,
    label: 'Reading code and links',
    detail: `${ctx.snippets.length} snippet${ctx.snippets.length !== 1 ? 's' : ''} · ${ctx.urls.length} url${ctx.urls.length !== 1 ? 's' : ''}`,
    quality: ctx.snippets.length > 0 || ctx.urls.length > 0 ? 'rich' : 'steady',
  });
}

function runContextStage(ctx) {
  ctx.files = extractFileReferences(ctx.fullText, ctx.session);
  ctx.tools = extractToolContext(ctx.session, ctx.fullText);
  ctx.workspaces = extractWorkspaceContext(ctx.session);
  ctx.reporter.emit('context', {
    progress: 0.38,
    label: 'Recovering technical context',
    detail: `${ctx.files.length} file${ctx.files.length !== 1 ? 's' : ''} · ${ctx.tools.length} tool${ctx.tools.length !== 1 ? 's' : ''} · ${ctx.workspaces.length} workspace${ctx.workspaces.length !== 1 ? 's' : ''}`,
    focus: ctx.files[0] || ctx.workspaces[0] || '',
    quality: ctx.files.length > 0 || ctx.tools.length > 0 ? 'rich' : 'thin',
  });
}

function runSignalStage(ctx) {
  ctx.decisionItems = extractStructuredItems(ctx.messages, DECISION_PATTERNS, 'decision');
  ctx.issueItems = extractStructuredItems(ctx.messages, ISSUE_PATTERNS, 'issue');
  ctx.actionItems = extractStructuredItems(ctx.messages, ACTION_ITEM_PATTERNS, 'action');
  ctx.commitItems = extractStructuredItems(ctx.messages, COMMIT_PATTERNS, 'commit');
  ctx.reporter.emit('signals', {
    progress: 0.56,
    label: 'Classifying work signals',
    detail: `${ctx.decisionItems.length} decision${ctx.decisionItems.length !== 1 ? 's' : ''} · ${ctx.issueItems.length} issue${ctx.issueItems.length !== 1 ? 's' : ''} · ${ctx.actionItems.length} action${ctx.actionItems.length !== 1 ? 's' : ''} · ${ctx.commitItems.length} change`,
    quality: ctx.decisionItems.length || ctx.issueItems.length || ctx.actionItems.length || ctx.commitItems.length ? 'rich' : 'thin',
  });
}

function runConceptStage(ctx) {
  ctx.conceptObjects = buildConceptObjects({
    session: ctx.session,
    fullText: ctx.fullText,
    messages: ctx.messages,
    snippets: ctx.snippets,
    urls: ctx.urls,
    entities: ctx.entities,
    files: ctx.files,
    tools: ctx.tools,
    workspaces: ctx.workspaces,
    skills: ctx.skills,
    decisionItems: ctx.decisionItems,
    issueItems: ctx.issueItems,
    actionItems: ctx.actionItems,
    commitItems: ctx.commitItems,
  });
  ctx.reporter.emit('concepts', {
    progress: 0.74,
    label: 'Building concept evidence',
    detail: `${ctx.conceptObjects.length} concept${ctx.conceptObjects.length !== 1 ? 's' : ''}`,
    focus: ctx.conceptObjects[0]?.name || '',
    quality: ctx.conceptObjects.length >= 6 ? 'rich' : ctx.conceptObjects.length > 0 ? 'steady' : 'thin',
  });
}

function runContinuityStage(ctx) {
  ctx.continuity = extractSessionContinuity(ctx.session, {
    messages: ctx.messages,
    conceptObjects: ctx.conceptObjects,
    decisionItems: ctx.decisionItems,
    issueItems: ctx.issueItems,
    actionItems: ctx.actionItems,
    commitItems: ctx.commitItems,
    files: ctx.files,
    tools: ctx.tools,
  });
  ctx.reporter.emit('continuity', {
    progress: 0.9,
    label: 'Reconstructing session continuity',
    detail: summarizeContinuity(ctx.continuity),
    focus: ctx.continuity.primaryThread || '',
    quality: ctx.continuity.status === 'blocked' ? 'blocked' : ctx.continuity.resumed ? 'resumed' : 'steady',
  });
}

function finalizeExtractionResult(ctx) {
  const observability = buildExtractionObservability({
    source: ctx.session?.source || 'unknown',
    originalLength: ctx.originalLength,
    extractedLength: ctx.fullText.length,
    truncated: ctx.truncated,
    conceptObjects: ctx.conceptObjects,
    decisionItems: ctx.decisionItems,
    issueItems: ctx.issueItems,
    actionItems: ctx.actionItems,
    commitItems: ctx.commitItems,
    snippets: ctx.snippets,
    urls: ctx.urls,
    files: ctx.files,
    tools: ctx.tools,
    metaOnly: Boolean(ctx.session?.cursorMetaOnly),
    continuity: ctx.continuity,
    stageTrace: ctx.reporter.stageTrace,
  });

  const result = {
    concepts: ctx.conceptObjects.map((concept) => concept.name),
    conceptObjects: ctx.conceptObjects,
    decisions: ctx.decisionItems.map((item) => item.text),
    decisionItems: ctx.decisionItems,
    issues: ctx.issueItems,
    actionItems: ctx.actionItems,
    commits: ctx.commitItems,
    snippets: ctx.snippets,
    urls: ctx.urls,
    entities: ctx.entities,
    files: ctx.files,
    tools: ctx.tools,
    continuity: ctx.continuity,
    technicalContext: {
      files: ctx.files,
      tools: ctx.tools,
      workspaces: ctx.workspaces,
      skills: ctx.skills,
      entities: ctx.entities,
      continuity: ctx.continuity,
    },
    observability,
  };

  if (ctx.reporter.onEvent) {
    ctx.reporter.onEvent({
      stage: 'complete',
      progress: 1,
      label: 'Session extraction complete',
      detail: `${result.concepts.length} concepts · ${ctx.continuity.status}`,
      focus: ctx.continuity.primaryThread || '',
      quality: observability.weakSignals.length > 0 ? 'weak' : 'rich',
    });
  }

  return result;
}

function createExtractionReporter(session, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const stageTrace = [];

  return {
    onEvent,
    stageTrace,
    emit(stage, payload = {}) {
      const event = {
        stage,
        progress: payload.progress ?? 0,
        label: payload.label || stage,
        detail: payload.detail || '',
        focus: payload.focus || '',
        quality: payload.quality || '',
        source: session?.source || 'unknown',
        sessionId: session?.id || null,
      };
      stageTrace.push(event);
      if (onEvent && !opts.deferEvents) onEvent(event);
      return event;
    },
  };
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
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

function extractSessionContinuity(session, {
  messages,
  conceptObjects,
  decisionItems,
  issueItems,
  actionItems,
  commitItems,
  files,
  tools,
}) {
  const humanMessages = (messages || []).filter((msg) => msg.role === 'human' || msg.role === 'user');
  const assistantMessages = (messages || []).filter((msg) => msg.role === 'assistant' || msg.role === 'bot');
  const openingWindow = humanMessages.slice(0, 2).map((msg) => msg.content).join('\n\n');
  const closingWindow = assistantMessages.slice(-2).map((msg) => msg.content).join('\n\n');
  const resumed = RESUME_PATTERNS.some((re) => re.test(openingWindow));
  const blocked = BLOCKER_PATTERNS.some((re) => re.test(openingWindow))
    || issueItems.some((item) => BLOCKER_PATTERNS.some((re) => re.test(item.text || '')))
    || Boolean(session?.cursorMeta?.hasBlockingPendingActions);
  const pivoted = PIVOT_PATTERNS.some((re) => re.test(openingWindow))
    || decisionItems.some((item) => PIVOT_PATTERNS.some((re) => re.test(item.text || '')));
  const resolved = RESOLUTION_PATTERNS.some((re) => re.test(closingWindow))
    || commitItems.some((item) => RESOLUTION_PATTERNS.some((re) => re.test(item.text || '')));
  const unfinished = blocked || (!resolved && (actionItems.length > 0 || issueItems.length > 0));

  let phase = 'exploring';
  if (commitItems.length > 0 || resolved) {
    phase = 'shipping';
  } else if (files.length > 0 || tools.length > 0 || messages.length >= 6) {
    phase = 'implementing';
  } else if (decisionItems.length > 0) {
    phase = 'deciding';
  } else if (issueItems.length > 0) {
    phase = 'investigating';
  }

  const activeThreads = (conceptObjects || []).slice(0, 4).map((concept) => concept.name);
  const primaryThread = activeThreads[0] || session?.title || 'session';
  const openLoops = actionItems.slice(0, 3).map((item) => item.text);
  const markers = [];
  if (resumed) markers.push('resumed');
  if (pivoted) markers.push('pivoted');
  if (blocked) markers.push('blocked');
  if (unfinished) markers.push('unfinished');
  if (resolved) markers.push('resolved');

  let status = 'in-flight';
  if (blocked) status = 'blocked';
  else if (resolved && !unfinished) status = 'resolved';
  else if (resumed) status = 'resumed';

  return {
    status,
    phase,
    resumed,
    blocked,
    unfinished,
    pivoted,
    resolved,
    primaryThread,
    activeThreads,
    openLoops,
    markers,
    turnCount: messages.length,
    humanTurns: humanMessages.length,
    assistantTurns: assistantMessages.length,
  };
}

function summarizeContinuity(continuity) {
  if (!continuity) return 'continuity unavailable';
  const parts = [continuity.status, continuity.phase];
  if (continuity.resumed) parts.push('resumed thread');
  if (continuity.blocked) parts.push('blocked');
  if (continuity.openLoops.length > 0) parts.push(`${continuity.openLoops.length} open loop${continuity.openLoops.length !== 1 ? 's' : ''}`);
  return parts.join(' · ');
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
  continuity,
  stageTrace,
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
  if (continuity?.blocked) weakSignals.push('blocked work thread');
  if (continuity?.unfinished && !continuity?.blocked) weakSignals.push('unfinished follow-up');

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
    continuity,
    stageTrace: (stageTrace || []).map((event) => ({
      stage: event.stage,
      progress: event.progress,
      label: event.label,
      detail: event.detail,
      quality: event.quality,
    })),
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

// Module-level regex cache — avoids recompiling the same concept regex
// across multiple calls to computeSignalScore / buildConceptRegex
const _regexCache = new Map();

function buildConceptRegex(value) {
  const concept = normaliseConceptKey(value);
  if (_regexCache.has(concept)) return _regexCache.get(concept);
  const re = keywordNeedsLooseBoundary(concept)
    ? new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(concept)}(?=$|[^A-Za-z0-9])`, 'i')
    : new RegExp(`\\b${escapeRegex(concept)}\\b`, 'i');
  _regexCache.set(concept, re);
  return re;
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

/**
 * Pre-aggregate signal evidence for all concepts across all sessions.
 * Returns a Map<conceptKey, SignalRecord> where SignalRecord contains
 * all counts needed to compute the final signal score.
 *
 * This runs in O(sessions × concepts_per_session) — linear in total
 * concept mentions, not O(all_concepts × all_sessions).
 *
 * @param {Array} sessionItems - Array of { session, extracted } objects
 * @returns {Map<string, Object>}
 */
function buildSignalIndex(sessionItems) {
  if (!Array.isArray(sessionItems)) return new Map();

  const index = new Map(); // conceptKey → accumulator

  // First pass: accumulate raw counts from each session
  for (const item of sessionItems) {
    if (!item || !item.session || !item.extracted) continue;
    const { session, extracted } = item;

    for (const conceptName of (extracted.concepts || [])) {
      const key = normaliseConceptKey(conceptName);
      if (!key) continue;

      if (!index.has(key)) {
        index.set(key, {
          displayName:     conceptName,
          sessionCount:    0,
          decisionCount:   0,
          issueCount:      0,
          actionItemCount: 0,
          commitCount:     0,
          codeCount:       0,
          projectSources:  new Set(),
          sessionItems:    [],
          skillBonus:      0,
        });
      }

      const rec = index.get(key);
      rec.sessionCount++;
      rec.sessionItems.push(item);

      // Use pre-computed conceptRecord evidence if available, else regex scan (cached)
      const conceptRecord = findConceptRecord(extracted, key);
      const re = buildConceptRegex(key); // always hits cache after first call

      rec.decisionCount   += conceptRecord?.decisionCount   || countMatchingStrings(extracted.decisionItems || extracted.decisions || [], re);
      rec.issueCount      += conceptRecord?.issueCount      || countMatchingStrings(extracted.issues || [], re);
      rec.actionItemCount += conceptRecord?.actionItemCount || countMatchingStrings(extracted.actionItems || [], re);
      rec.commitCount     += conceptRecord?.commitCount     || countMatchingStrings(extracted.commits || [], re);
      rec.codeCount       += conceptRecord?.codeCount       || countMatchingCode(extracted.snippets || [], re);

      if (session.source)        rec.projectSources.add(session.source);
      if (session.workspace)     rec.projectSources.add(session.workspace);
      if (session.workspacePath) rec.projectSources.add(session.workspacePath);

      // Skill bonus: +6 per session where this concept was invoked as a named skill
      const skills = session.skillsUsed || [];
      if (skills.some(s => s.toLowerCase() === key)) {
        rec.skillBonus += 6;
      }
    }
  }

  // Second pass: compute derived scores (pattern diversity, recency, final score)
  // Also pre-compute decisions and excerpts scoped to rec.sessionItems so the
  // write phase doesn't need to re-scan all sessions per concept.
  for (const [key, rec] of index) {
    rec.patternDiversity  = computeDecisionPatternDiversity(key, rec.sessionItems);
    rec.recencyBoost      = computeRecencyBonus(key, rec.sessionItems, sessionItems);
    rec.crossProjectCount = rec.projectSources.size;
    rec.score = (rec.sessionCount     * 2)
              + (rec.decisionCount    * 5)
              + (rec.issueCount       * 4)
              + (rec.actionItemCount  * 4)
              + (rec.commitCount      * 3)
              + (rec.codeCount        * 3)
              + (rec.crossProjectCount* 4)
              + (rec.patternDiversity * 2)
              + rec.recencyBoost
              + rec.skillBonus;

    // Pre-compute decisions and excerpts for promoted concepts.
    // This eliminates the per-concept full-corpus scan in renderConceptNote:
    // instead of scanning all sessions, we scan only the N sessions where the
    // concept actually appears (rec.sessionItems, avg 3-5).
    rec.decisions = extractConceptDecisions(key, rec.sessionItems);
    rec.excerpts  = extractConceptExcerpts(key, rec.sessionItems, 5);
  }

  return index;
}

module.exports = {
  extract,
  extractAsync,
  computeSignalScore,
  buildSignalIndex,
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
