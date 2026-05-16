
/* ════════════════════════════════════════════════════════════
   CONFIG
   ════════════════════════════════════════════════════════════ */
const COLS_DESKTOP = 40;
const COLS_MOBILE  = 20;
let   COLS = window.innerWidth > 540 ? COLS_DESKTOP : COLS_MOBILE;
const ROWS = 20;
let   TOTAL = COLS * ROWS;

/* ── Phases ── */
const PH = { BOOT:'boot', SCAN:'scan', DEFRAG:'defrag', LINK:'link', DONE:'done' };

/* ── Block state classes ── */
const BS = {
  EMPTY:    's-empty',
  READING:  's-reading',
  DONE:     's-done',
  WRITING:  's-writing',
  ERROR:    's-error',
  LINKED:   's-linked',
  COMPLETE: 's-complete',
};

/* ── Status message pools ── */
const MSGS = {
  scan: [
    "Reading conversation: 'Oak Segment Store architecture discussion'",
    "Reading conversation: 'React Query cache invalidation patterns'",
    "Reading conversation: 'Kubernetes pod scheduling and affinity rules'",
    "Reading conversation: 'AEM replication agent deep dive'",
    "Reading conversation: 'Rust ownership model — lifetimes explained'",
    "Reading conversation: 'GraphQL schema design for microservices'",
    "Reading conversation: 'Sling content distribution topology'",
    "Reading conversation: 'Claude context window optimization'",
    "Reading conversation: 'TypeScript discriminated union patterns'",
    "Reading conversation: 'JCR node types and CND namespaces'",
    "Scanning cluster 1,024...",
    "Scanning cluster 2,847...",
    "Scanning cluster 4,112...",
    "Scanning cluster 7,391...",
    "Scanning cluster 9,004...",
    "Scanning cluster 12,288...",
    "Scanning cluster 15,001...",
    "Parsing session: ~/.codex/history/session-042.json",
    "Parsing session: ~/.cursor/workspaces/project-alpha.db",
    "Parsing session: ~/.claude/projects/oak-research/CLAUDE.md",
    "Extracting concept: [[JCR Node Types]]",
    "Extracting concept: [[Sling Resource Resolution]]",
    "Extracting concept: [[React Suspense Boundaries]]",
    "Extracting concept: [[Kubernetes CRD Operators]]",
    "Extracting concept: [[Rust Borrow Checker]]",
    "Extracting concept: [[GraphQL Federation v2]]",
    "Extracting concept: [[AEM Content Policies]]",
    "Extracting concept: [[Claude Artifacts]]",
  ],
  defrag: [
    "Consolidating fragmented blocks 3,200–3,248...",
    "Consolidating fragmented blocks 7,712–7,760...",
    "Moving cluster 11,024 → position 2,048...",
    "Moving cluster 14,336 → position 3,072...",
    "Defragmenting context chain...",
    "Merging duplicate concept clusters...",
    "Deduplicating 47 redundant concept entries...",
    "Resolving conflict: [[AEM Replication]] ↔ [[Sling Content Distribution]]",
    "Writing note: vault/concepts/jackrabbit-oak.md",
    "Writing note: vault/concepts/aem-replication.md",
    "Writing note: vault/concepts/sling-resource-resolver.md",
    "Writing note: vault/concepts/react-query-patterns.md",
    "Writing note: vault/concepts/kubernetes-scheduling.md",
    "Writing note: vault/concepts/graphql-schema-design.md",
    "Writing note: vault/concepts/rust-ownership.md",
    "Writing note: vault/sessions/claude-oak-research.md",
    "Writing note: vault/sessions/codex-k8s-debugging.md",
    "Writing note: vault/sessions/cursor-refactor-2025.md",
    "Optimizing cluster 4,291...",
    "Optimizing cluster 8,104...",
    "Optimizing cluster 11,872...",
  ],
  link: [
    "Creating link: [[AEM Replication]] → [[Sling Content Distribution]]",
    "Creating link: [[JCR Node Types]] → [[Jackrabbit Oak]]",
    "Creating link: [[Oak Segment Store]] → [[TarMK]]",
    "Creating link: [[React Query]] → [[TanStack Query]]",
    "Creating link: [[Kubernetes Operators]] → [[CRD Design]]",
    "Creating link: [[Rust Lifetimes]] → [[Borrow Checker]]",
    "Creating link: [[GraphQL Federation]] → [[Apollo Router]]",
    "Creating link: [[Sling Resource Resolution]] → [[ResourceProvider]]",
    "Creating link: [[Claude Context Window]] → [[Context Defrag]]",
    "Creating link: [[TypeScript Discriminated Unions]] → [[Exhaustive Switch]]",
    "Scanning for wikilink opportunities...",
    "Indexing backlinks for [[Jackrabbit Oak]] (14 references)...",
    "Indexing backlinks for [[AEM Replication]] (8 references)...",
    "Validating link graph integrity...",
    "Writing vault/graph/link-index.json...",
    "Building graph: 192 nodes, 341 edges",
  ],
  done: [
    "Defragmentation complete. Vault is fully optimized.",
    "All 18,432 clusters processed successfully.",
    "Context successfully consolidated into Obsidian vault.",
    "Press [Optimize] to run again, or [Exit] to quit.",
  ],
};

/* ── Cluster name pool ── */
const CNAMES = [
  "'Oak Segment Store architecture'",
  "'React Query cache patterns'",
  "'K8s pod scheduling deep-dive'",
  "'AEM replication config'",
  "'Rust ownership — lifetimes'",
  "'GraphQL schema federation'",
  "'Sling content distribution'",
  "'Claude context optimization'",
  "'TypeScript discriminated unions'",
  "'JCR node types + CND'",
  "'Codex session #42'",
  "'Cursor workspace alpha'",
  "'CLAUDE.md — oak-research'",
  "'Session: refactor-2025'",
  "'Conversation: k8s debugging'",
  "'Note: jackrabbit-oak.md'",
  "'Note: aem-replication.md'",
  "'Note: react-patterns.md'",
  "'Wikilink batch #7'",
  "'Concept graph node #192'",
];

/* ════════════════════════════════════════════════════════════
   STATE
   ════════════════════════════════════════════════════════════ */
let phase       = PH.BOOT;
let blocks      = [];    // current state class per block
let blkEls      = [];    // DOM elements
let speed       = 1;     // multiplier (1×, 2×, 4×, 8×)
let notes       = 0;
let links       = 0;
let errs        = 0;
let startMs     = null;
let timerIv     = null;
let scanIdx     = 0;
let dfqIdx      = 0;
let dfq         = [];    // defrag queue (indices)
let lqIdx       = 0;
let lq          = [];    // link queue
let cmpIdx      = 0;
let bootDone    = false;
let bootTmr     = null;
let bootLineIdx = 0;
let msgIdx      = { scan:0, defrag:0, link:0, done:0 };

/* ════════════════════════════════════════════════════════════
   BOX DRAWING — build the frame
   ════════════════════════════════════════════════════════════ */
function buildFrame() {
  /* measure available width in character columns */
  const appEl = document.getElementById('app');
  const appW  = appEl.clientWidth;
  /* approximate char width for monospace at 13px ≈ 7.8px */
  const charW = 7.8;
  const cols  = Math.max(60, Math.floor(appW / charW) - 2);
  const C = cols; // inner width

  function hline(l, m, r) { return l + m.repeat(C) + r; }

  document.getElementById('hr-top').textContent = hline('╔','═','╗');
  document.getElementById('hr-1').textContent   = hline('╠','═','╣');
  document.getElementById('hr-2').textContent   = hline('╠','═','╣');
  document.getElementById('hr-3').textContent   = hline('╠','═','╣');
  document.getElementById('hr-4').textContent   = hline('╠','═','╣');
  document.getElementById('hr-bot').textContent = hline('╚','═','╝');

  // Grid frame — inner single-line box
  // The side borders are rendered as "║ │" and "│ ║" in the HTML
  // The top/bottom need to span: ║ ┌─…─┐ ║
  document.getElementById('gfr-top').textContent = '║ ┌' + '─'.repeat(C - 2) + '┐ ║';
  document.getElementById('gfr-bot').textContent = '║ └' + '─'.repeat(C - 2) + '┘ ║';
}

/* ════════════════════════════════════════════════════════════
   BOOT SEQUENCE
   ════════════════════════════════════════════════════════════ */
const BOOT_SEQ = [
  { t:'\n',                                     d:0   },
  { t:'  CTXDEFRAG.EXE\n',                      d:50,  c:'bhi' },
  { t:'  Context Defragmenter v1.0\n',          d:40,  c:'bhi' },
  { t:'  Copyright (C) 2025 somarc. All rights reserved.\n', d:35 },
  { t:'  Licensed under MIT License.\n',        d:28 },
  { t:'  <https://github.com/somarc/context-defrag>\n', d:28, c:'bdim' },
  { t:'\n',                                     d:20  },
  { t:'  WARNING: Host system is not a PC.\n',  d:60,  c:'bwrn' },
  { t:'  Running on Apple Silicon. This is fine.\n', d:45, c:'bwrn' },
  { t:'\n',                                     d:20  },
  { t:'  Initializing memory allocator...         ', d:50 },
  { t:'[ OK ]\n',                                d:280, c:'bok' },
  { t:'  Loading context parser v2.1...           ', d:55 },
  { t:'[ OK ]\n',                                d:220, c:'bok' },
  { t:'  Mounting Obsidian vault filesystem...    ', d:55 },
  { t:'[ OK ]\n',                                d:190, c:'bok' },
  { t:'  Checking cluster allocation table...     ', d:55 },
  { t:'[ OK ]\n',                                d:310, c:'bok' },
  { t:'\n',                                     d:20  },
  { t:'  Scanning context sources...\n',         d:70  },
  { t:'    Found: ~/.claude/projects/     ', d:50 },
  { t:'[47 conversations]\n',                    d:380, c:'bwrn' },
  { t:'    Found: ~/.codex/history        ', d:45 },
  { t:'[12 sessions]\n',                         d:310, c:'bwrn' },
  { t:'    Found: ~/.cursor/workspaces    ', d:45 },
  { t:'[8 projects]\n',                          d:270, c:'bwrn' },
  { t:'\n',                                     d:20  },
  { t:'  Total context size:   2.4 GB\n',        d:60 },
  { t:'  Total clusters:       18,432\n',        d:40 },
  { t:'  Estimated defrag time: ~90 seconds\n',  d:40 },
  { t:'\n',                                     d:20  },
  { t:'  Verifying disk integrity...             ', d:60 },
  { t:'[ OK ]\n',                                d:190, c:'bok' },
  { t:'  No bad sectors detected.\n',            d:45, c:'bok' },
  { t:'\n',                                     d:20  },
  { t:'  Press any key to begin defragmentation...\n', d:70, c:'bhi' },
  { t:'',                                        d:0,   cursor:true },
];

function startBoot() {
  const el = document.getElementById('boot-scr');
  el.innerHTML = '';
  el.style.display = 'block';
  document.getElementById('blk-grid').style.display = 'none';
  bootLineIdx = 0;
  bootDone = false;
  phase = PH.BOOT;
  nextBootLine();
}

function nextBootLine() {
  if (bootLineIdx >= BOOT_SEQ.length) { bootDone = true; return; }
  const item = BOOT_SEQ[bootLineIdx];
  const delay = item.d / Math.max(1, speed * 0.6);
  bootTmr = setTimeout(() => {
    renderBootItem(item);
    bootLineIdx++;
    nextBootLine();
  }, delay);
}

function renderBootItem(item) {
  const el = document.getElementById('boot-scr');
  if (item.cursor) {
    const c = document.createElement('span');
    c.id = 'boot-cur';
    el.appendChild(c);
    bootDone = true;
    return;
  }
  if (!item.t) return;
  const span = document.createElement('span');
  if (item.c) span.className = item.c;
  span.textContent = item.t;
  el.appendChild(span);
  // Auto-scroll
  el.scrollTop = el.scrollHeight;
}

function skipBoot() {
  if (bootTmr) clearTimeout(bootTmr);
  const el = document.getElementById('boot-scr');
  // Remove stale cursor
  const cur = document.getElementById('boot-cur');
  if (cur) cur.remove();
  // Render remaining
  for (let i = bootLineIdx; i < BOOT_SEQ.length; i++) {
    renderBootItem(BOOT_SEQ[i]);
  }
  bootDone = true;
}

function advanceFromBoot() {
  if (phase !== PH.BOOT) return;
  if (!bootDone) { skipBoot(); return; }
  beginScan();
}

/* ════════════════════════════════════════════════════════════
   GRID BUILD
   ════════════════════════════════════════════════════════════ */
function buildGrid() {
  const g = document.getElementById('blk-grid');
  g.innerHTML = '';
  blocks = [];
  blkEls = [];

  // Recompute COLS for current viewport
  COLS  = window.innerWidth > 540 ? COLS_DESKTOP : COLS_MOBILE;
  TOTAL = COLS * ROWS;

  g.style.display = 'grid';
  g.style.gridTemplateColumns = `repeat(${COLS}, 1fr)`;

  for (let i = 0; i < TOTAL; i++) {
    const el = document.createElement('div');
    el.className = 'blk ' + BS.EMPTY;
    el.dataset.i = i;
    el.addEventListener('mouseenter', onHover);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('click',      onClick);
    g.appendChild(el);
    blkEls.push(el);
    blocks.push(BS.EMPTY);
  }
}

function setBlock(i, st) {
  if (i < 0 || i >= TOTAL) return;
  blocks[i] = st;
  blkEls[i].className = 'blk ' + st;
}

/* ════════════════════════════════════════════════════════════
   TOOLTIP
   ════════════════════════════════════════════════════════════ */
const tipEl = document.getElementById('tip');
let tipHideTimer = null;

const STATE_NAMES = {
  [BS.EMPTY]:    'Unread / Empty cluster',
  [BS.READING]:  'Reading context data',
  [BS.DONE]:     'Processed / Defragmented',
  [BS.WRITING]:  'Currently writing note',
  [BS.ERROR]:    'Bad cluster / Parse error',
  [BS.LINKED]:   'Wikilink created',
  [BS.COMPLETE]: 'Optimized / Complete',
};

function clusterInfo(i) {
  const cnum  = (i * 4 + 1024).toLocaleString();
  const csize = (Math.floor(i * 7.3) % 180 + 32).toLocaleString();
  const name  = CNAMES[i % CNAMES.length];
  const st    = STATE_NAMES[blocks[i]] || 'Unknown';
  return [
    `Cluster : ${cnum}`,
    `Source  : ${name}`,
    `State   : ${st}`,
    `Size    : ${csize} KB`,
    `Offset  : 0x${(i * 0x200).toString(16).toUpperCase().padStart(6,'0')}`,
  ].join('\n');
}

function positionTip(e) {
  const x = e.clientX + 14;
  const y = e.clientY + 14;
  const tw = tipEl.offsetWidth || 220;
  const th = tipEl.offsetHeight || 90;
  tipEl.style.left = Math.min(x, window.innerWidth  - tw - 10) + 'px';
  tipEl.style.top  = Math.min(y, window.innerHeight - th - 10) + 'px';
}

function onHover(e) {
  if (tipHideTimer) clearTimeout(tipHideTimer);
  const i = +e.currentTarget.dataset.i;
  tipEl.textContent = clusterInfo(i);
  tipEl.style.display = 'block';
  positionTip(e);
}
function onLeave() {
  tipHideTimer = setTimeout(() => { tipEl.style.display = 'none'; }, 200);
}
function onClick(e) {
  const i = +e.currentTarget.dataset.i;
  tipEl.textContent = clusterInfo(i);
  tipEl.style.display = 'block';
  positionTip(e);
  if (tipHideTimer) clearTimeout(tipHideTimer);
  tipHideTimer = setTimeout(() => { tipEl.style.display = 'none'; }, 3000);
}
document.addEventListener('mousemove', (e) => {
  if (tipEl.style.display === 'block') positionTip(e);
});

/* ════════════════════════════════════════════════════════════
   PROGRESS + STATUS HELPERS
   ════════════════════════════════════════════════════════════ */
function setProgress(pct, color) {
  pct = Math.min(100, Math.max(0, pct));
  const fill = document.getElementById('prog-fill');
  const pctEl = document.getElementById('prog-pct');
  fill.style.width = pct + '%';
  fill.style.background = color || 'var(--blue)';
  const chars = Math.round(pct / 3.2);
  fill.textContent = '█'.repeat(chars);
  pctEl.textContent = Math.round(pct) + '%';
}

function setStatus(msg) {
  document.getElementById('status-line').textContent = msg;
}

function setBanner(text, color) {
  const el = document.getElementById('phase-ban');
  el.textContent = text;
  el.style.color = color || 'var(--yellow)';
}

function updateCounters() {
  document.getElementById('ct-notes').textContent = notes;
  document.getElementById('ct-links').textContent = links;
  document.getElementById('ct-errs').textContent  = errs;
}

/* ── Timer ── */
function startTimer() {
  startMs = Date.now();
  if (timerIv) clearInterval(timerIv);
  timerIv = setInterval(() => {
    const s = Math.floor((Date.now() - startMs) / 1000);
    const m = Math.floor(s / 60);
    document.getElementById('ct-time').textContent =
      m + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}

/* ── Shuffle ── */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── Next message from pool ── */
function nextMsg(pool, key) {
  const msgs = MSGS[key];
  const m = msgs[msgIdx[key] % msgs.length];
  msgIdx[key]++;
  return m;
}

/* ════════════════════════════════════════════════════════════
   PHASE 1: SCAN
   ════════════════════════════════════════════════════════════ */
function beginScan() {
  phase = PH.SCAN;
  document.getElementById('boot-scr').style.display  = 'none';
  document.getElementById('blk-grid').style.display  = 'grid';
  buildGrid();
  startTimer();
  notes = 0; links = 0; errs = 0; updateCounters();
  scanIdx = 0;
  setBanner('[ PHASE 1 / 4  ─  SCANNING CONTEXT SOURCES ]', 'var(--blue)');
  setProgress(0, 'var(--blue)');
  doScan();
}

function doScan() {
  if (phase !== PH.SCAN) return;

  const batchSize = Math.max(1, Math.round(2 * speed));
  const delay     = Math.max(5, 30 / speed);

  for (let b = 0; b < batchSize && scanIdx < TOTAL; b++, scanIdx++) {
    const i = scanIdx;

    // Occasionally mark error
    if (Math.random() < 0.022) {
      setBlock(i, BS.ERROR);
      errs++;
    } else {
      setBlock(i, BS.READING);
    }

    // Mark a few blocks behind us as processed
    if (i >= 4) {
      const behind = i - 4;
      if (blocks[behind] === BS.READING) setBlock(behind, BS.DONE);
    }

    if (i % Math.max(1, Math.floor(TOTAL / MSGS.scan.length)) === 0) {
      setStatus('Status: ' + nextMsg(null, 'scan'));
    }
  }

  setProgress((scanIdx / TOTAL) * 33, 'var(--blue)');
  setStatus('Status: Scanning cluster ' + (scanIdx * 4 + 1024).toLocaleString() +
            ' of ' + (TOTAL * 4 + 1024).toLocaleString());

  if (scanIdx < TOTAL) {
    setTimeout(doScan, delay);
  } else {
    // finalize
    for (let i = 0; i < TOTAL; i++) {
      if (blocks[i] === BS.READING) setBlock(i, BS.DONE);
    }
    setProgress(33, 'var(--blue)');
    setStatus('Status: Scan complete. ' + TOTAL + ' clusters read. Analyzing fragmentation...');
    setTimeout(beginDefrag, 700 / speed);
  }
}

/* ════════════════════════════════════════════════════════════
   PHASE 2: DEFRAG
   ════════════════════════════════════════════════════════════ */
function beginDefrag() {
  phase = PH.DEFRAG;
  setBanner('[ PHASE 2 / 4  ─  DEFRAGMENTING — CONSOLIDATING CLUSTERS ]', 'var(--cyan)');
  setProgress(33, 'var(--cyan)');

  // Build queue: randomly pick ~38% of blocks to "move"
  const indices = Array.from({length: TOTAL}, (_, i) => i);
  shuffle(indices);
  dfq    = indices.slice(0, Math.floor(TOTAL * 0.38));
  dfqIdx = 0;
  doDefrag();
}

function doDefrag() {
  if (phase !== PH.DEFRAG) return;

  const batchSize = Math.max(1, Math.round(3 * speed));
  const delay     = Math.max(8, 38 / speed);

  for (let b = 0; b < batchSize && dfqIdx < dfq.length; b++, dfqIdx++) {
    const i = dfq[dfqIdx];
    setBlock(i, BS.WRITING);
    // schedule transition to DONE
    const ci = i;
    setTimeout(() => {
      if (blocks[ci] === BS.WRITING) {
        setBlock(ci, BS.DONE);
        notes++;
        updateCounters();
      }
    }, 130 / speed);

    if (dfqIdx % Math.max(1, Math.floor(dfq.length / MSGS.defrag.length)) === 0) {
      setStatus('Status: ' + nextMsg(null, 'defrag'));
    }
  }

  const pct = 33 + (dfqIdx / dfq.length) * 33;
  setProgress(pct, 'var(--cyan)');

  if (dfqIdx < dfq.length) {
    setTimeout(doDefrag, delay);
  } else {
    setProgress(66, 'var(--cyan)');
    setStatus('Status: Defragmentation complete. Building link graph...');
    setTimeout(beginLink, 700 / speed);
  }
}

/* ════════════════════════════════════════════════════════════
   PHASE 3: LINK
   ════════════════════════════════════════════════════════════ */
function beginLink() {
  phase = PH.LINK;
  setBanner('[ PHASE 3 / 4  ─  INFERRING WIKILINKS ]', 'var(--yellow)');
  setProgress(66, 'var(--yellow)');

  // Turn ~45% of DONE blocks yellow
  const doneIdxs = blocks
    .map((s, i) => s === BS.DONE ? i : -1)
    .filter(i => i >= 0);
  shuffle(doneIdxs);
  lq    = doneIdxs.slice(0, Math.floor(doneIdxs.length * 0.45));
  lqIdx = 0;
  doLink();
}

function doLink() {
  if (phase !== PH.LINK) return;

  const batchSize = Math.max(1, Math.round(2 * speed));
  const delay     = Math.max(10, 45 / speed);

  for (let b = 0; b < batchSize && lqIdx < lq.length; b++, lqIdx++) {
    const i = lq[lqIdx];
    setBlock(i, BS.WRITING);
    const ci = i;
    setTimeout(() => {
      if (blocks[ci] === BS.WRITING) {
        setBlock(ci, BS.LINKED);
        links++;
        updateCounters();
      }
    }, 160 / speed);

    if (lqIdx % Math.max(1, Math.floor(lq.length / MSGS.link.length)) === 0) {
      setStatus('Status: ' + nextMsg(null, 'link'));
    }
  }

  const pct = 66 + (lqIdx / lq.length) * 26;
  setProgress(pct, 'var(--yellow)');

  if (lqIdx < lq.length) {
    setTimeout(doLink, delay);
  } else {
    setProgress(92, 'var(--yellow)');
    setStatus('Status: Link graph complete. Finalizing vault...');
    setTimeout(beginComplete, 600 / speed);
  }
}

/* ════════════════════════════════════════════════════════════
   PHASE 4: COMPLETE
   ════════════════════════════════════════════════════════════ */
function beginComplete() {
  phase = PH.DONE;
  setBanner('[ PHASE 4 / 4  ─  OPTIMIZATION COMPLETE ]', 'var(--green)');
  cmpIdx = 0;
  doComplete();
}

function doComplete() {
  if (phase !== PH.DONE) return;

  const batchSize = Math.max(4, Math.round(10 * speed));
  const delay     = Math.max(5, 16 / speed);

  for (let b = 0; b < batchSize && cmpIdx < TOTAL; b++, cmpIdx++) {
    setBlock(cmpIdx, BS.COMPLETE);
  }

  const pct = 92 + (cmpIdx / TOTAL) * 8;
  setProgress(pct, 'var(--green)');

  if (cmpIdx % Math.max(1, Math.floor(TOTAL / 6)) === 0) {
    setStatus('Status: Finalizing cluster ' + (cmpIdx * 4 + 1024).toLocaleString() + '...');
  }

  if (cmpIdx < TOTAL) {
    setTimeout(doComplete, delay);
  } else {
    setProgress(100, 'var(--green)');
    setStatus('Status: ' + nextMsg(null, 'done'));
    setBanner(
      '[ ✓  CONTEXT FULLY DEFRAGMENTED  —  ' + notes + ' notes  |  ' + links + ' links  ]',
      'var(--green)'
    );
    // Auto-restart loop
    setTimeout(() => {
      speed = 1; // reset speed
      beginScan();
    }, 8000 / speed);
  }
}

/* ════════════════════════════════════════════════════════════
   OPTIMIZE BUTTON
   ════════════════════════════════════════════════════════════ */
function onOptimize() {
  if (phase === PH.BOOT) {
    advanceFromBoot();
    return;
  }
  speed = Math.min(8, speed * 2);
  setStatus('Status: Speed set to ' + speed + 'x — hold on...');
}
window.onOptimize = onOptimize;

/* ════════════════════════════════════════════════════════════
   EXIT FLOW
   ════════════════════════════════════════════════════════════ */
function onExit() {
  document.getElementById('exit-modal').classList.add('show');
  document.getElementById('ebtn-n').focus();
}
window.onExit = onExit;

document.getElementById('ebtn-y').addEventListener('click', () => {
  document.getElementById('exit-modal').classList.remove('show');
  doExit();
});
document.getElementById('ebtn-n').addEventListener('click', () => {
  document.getElementById('exit-modal').classList.remove('show');
});

function doExit() {
  // Fade to black
  const fade = document.createElement('div');
  Object.assign(fade.style, {
    position: 'fixed', inset: '0', background: '#000',
    opacity: '0', transition: 'opacity 1.4s ease', zIndex: '25000',
  });
  document.body.appendChild(fade);
  requestAnimationFrame(() => { fade.style.opacity = '1'; });
  setTimeout(() => {
    document.getElementById('safe-scr').classList.add('show');
  }, 1500);
}

/* ════════════════════════════════════════════════════════════
   KEYBOARD
   ════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('exit-modal');
  if (modal.classList.contains('show')) {
    if (e.key === 'y' || e.key === 'Y') { document.getElementById('ebtn-y').click(); }
    if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { document.getElementById('ebtn-n').click(); }
    return;
  }
  if (e.key === 'Escape' && phase !== PH.BOOT) { onExit(); return; }
  if (phase === PH.BOOT) { advanceFromBoot(); }
});

document.getElementById('boot-scr').addEventListener('click', advanceFromBoot);

/* ════════════════════════════════════════════════════════════
   README
   ════════════════════════════════════════════════════════════ */
function buildReadme() {
  document.getElementById('readme-body').innerHTML = `<h2>What is context-defrag?</h2>
<span style="color:var(--cyan)">context-defrag</span> consolidates the fragmented knowledge scattered across your LLM
conversation histories into a structured, navigable Obsidian vault.

Every time you explain a concept to Claude, debug something with Codex, or sketch
an architecture in Cursor — that knowledge lives and dies inside an ephemeral
session file. <span class="rm-hi">context-defrag extracts it, deduplicates it, and links it.</span>

Think of it as MS-DOS Disk Defragmenter for your AI context: the fragmented,
redundant clusters of thought get consolidated into contiguous, permanent notes
with inferred wikilinks between them.

<h2>How to use the CLI</h2>
<span class="rm-dim">Install:</span>
  <span class="rm-cmd">npm install -g context-defrag</span>

<span class="rm-dim">Run with defaults (auto-discovers ~/.claude, ~/.codex, ~/.cursor):</span>
  <span class="rm-cmd">context-defrag run --vault ~/obsidian/vault</span>

<span class="rm-dim">Explicit source targeting:</span>
  <span class="rm-cmd">context-defrag run \
    --claude   ~/.claude/projects/ \
    --codex    ~/.codex/history \
    --cursor   ~/.cursor/workspaces \
    --vault    ~/notes/vault \
    --model    gpt-4o</span>

<span class="rm-dim">Flags:</span>
  <span class="rm-cmd">--dry-run</span>       Preview extraction without writing to vault
  <span class="rm-cmd">--no-links</span>      Skip wikilink inference pass
  <span class="rm-cmd">--overwrite</span>     Replace existing notes (default: skip)
  <span class="rm-cmd">--watch</span>         Watch source dirs and re-run on change
  <span class="rm-cmd">--verbose</span>       Show per-cluster processing log

<h2>Output structure</h2>
<span class="rm-path">vault/
  concepts/</span>          <span class="rm-dim">Deduplicated concept notes, one per idea</span><span class="rm-path">
  sessions/</span>          <span class="rm-dim">Per-conversation summary files</span><span class="rm-path">
  graph/</span>             <span class="rm-dim">link-index.json, entity map, backlinks</span><span class="rm-path">
  _templates/</span>        <span class="rm-dim">Obsidian note templates (dataview-ready)</span>

<h2>Obsidian vault template</h2>
A starter vault with pre-configured templates, Dataview queries, Canvas graph
views, and tag taxonomy is available at:

  <a href="https://github.com/somarc/context-defrag-vault" target="_blank" rel="noopener">github.com/somarc/context-defrag-vault</a>

<h2>Source + contributing</h2>
  <a href="https://github.com/somarc/context-defrag" target="_blank" rel="noopener">github.com/somarc/context-defrag</a>

<span class="rm-dim">Issues, PRs, and feedback welcome.
────────────────────────────────────────────────────────────────────────────────
context-defrag v1.0  |  MIT License  |  somarc  |  2025
────────────────────────────────────────────────────────────────────────────────</span>`;
}

/* ════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════ */
function init() {
  buildFrame();
  buildReadme();
  // Force font load check so first render isn't ugly
  document.fonts.ready.then(() => {
    buildFrame(); // re-measure with real font metrics
  });
  startBoot();
  setProgress(0);
  setStatus('Status: Loading...');
}

window.addEventListener('DOMContentLoaded', init);
window.addEventListener('resize', () => {
  buildFrame();
});

