'use strict';
/**
 * tui.js — Full-screen terminal UI for context-defrag
 *
 * Aesthetic: 1994 MS-DOS Disk Defragmenter rebuilt by someone who also ships
 * Raycast plugins. CGA color palette, box-drawing characters, block grid,
 * DOS vocabulary — but crisp, fluid, and intentional.
 *
 * Uses only Node.js built-ins + ANSI escape codes.
 * Falls back to plain console.log() when stdout is not a TTY.
 */

// ── TTY detection ─────────────────────────────────────────────────────────────
// ENABLED can be overridden via disable() before init() — used by --no-tui flag.
let ENABLED = process.stdout.isTTY === true;

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const ESC = '\x1b';
const fg = {
  black:         `${ESC}[30m`,
  red:           `${ESC}[31m`,
  green:         `${ESC}[32m`,
  yellow:        `${ESC}[33m`,
  blue:          `${ESC}[34m`,
  magenta:       `${ESC}[35m`,
  cyan:          `${ESC}[36m`,
  white:         `${ESC}[37m`,
  brightBlack:   `${ESC}[90m`,
  brightRed:     `${ESC}[91m`,
  brightGreen:   `${ESC}[92m`,
  brightYellow:  `${ESC}[93m`,
  brightBlue:    `${ESC}[94m`,
  brightMagenta: `${ESC}[95m`,
  brightCyan:    `${ESC}[96m`,
  brightWhite:   `${ESC}[97m`,
  reset:         `${ESC}[0m`,
};
const style = {
  bold:      `${ESC}[1m`,
  dim:       `${ESC}[2m`,
  underline: `${ESC}[4m`,
  reset:     `${ESC}[0m`,
};

// ── Terminal control sequences ────────────────────────────────────────────────
const ALT_SCREEN_ON  = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const HIDE_CURSOR    = `${ESC}[?25l`;
const SHOW_CURSOR    = `${ESC}[?25h`;
const CLEAR_SCREEN   = `${ESC}[2J${ESC}[H`;
const RESET_ALL      = `${ESC}[0m`;

function moveTo(row, col) {
  return `${ESC}[${row};${col}H`;
}

function eraseLine() {
  return `${ESC}[2K`;
}

// ── Write to stdout (buffered for the frame) ──────────────────────────────────
function out(str) {
  process.stdout.write(str);
}

// ── Cleanup / exit handling ───────────────────────────────────────────────────
let _cleanedUp = false;
function cleanup() {
  if (_cleanedUp) return;
  _cleanedUp = true;
  if (_renderInterval) { clearInterval(_renderInterval); _renderInterval = null; }
  if (ENABLED) {
    // Restore stdin before exiting — critical when setRawMode was called
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch (_) {}
    out(SHOW_CURSOR);
    out(ALT_SCREEN_OFF);
    out(RESET_ALL);
  }
}

process.on('exit',    cleanup);
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGHUP',  () => { cleanup(); process.exit(0); });
process.on('SIGQUIT', () => { cleanup(); process.exit(0); });  // Ctrl-\ — works even in raw mode
// Uncaught exceptions — restore terminal before crashing
process.on('uncaughtException', (err) => { cleanup(); throw err; });

// ── Exit request handling ──────────────────────────────────────────────────────
// When raw mode is active, Ctrl-C delivers \x03 as data instead of SIGINT.
// If the event loop is blocked (e.g. during a heavy extract() call), the
// 'data' event won't fire until the loop yields. We set a flag that the
// pipeline checks on each yield, plus attempt immediate exit when possible.
let _wantExit = false;
function requestExit() {
  _wantExit = true;
  // Try immediate cleanup + exit; if event loop is alive this works instantly.
  // If not, the pipeline will check tui.exitRequested on next yield.
  cleanup();
  process.exit(0);
}

// ── Layout constants ──────────────────────────────────────────────────────────
// These are recalculated on each frame from actual terminal size
function termSize() {
  const cols = process.stdout.columns  || 80;
  const rows = process.stdout.terminalRows || process.stdout.rows || 24;
  return { cols, rows };
}

// ── Block grid ────────────────────────────────────────────────────────────────
const GRID_ROWS    = 6;
const BLOCK_CHARS  = {
  unread:   '░',   // dark gray     — unread / empty
  reading:  '▓',   // bright blue   — being read / leading edge
  written:  '█',   // bright cyan   — written
  linked:   '■',   // bright yellow — link flash (150 ms)
  done:     '▪',   // bright green  — complete
  error:    '!',   // bright red    — error
};
const BLOCK_COLORS = {
  unread:   fg.brightBlack,
  reading:  fg.brightBlue,
  written:  fg.brightCyan,
  linked:   fg.brightYellow,
  done:     fg.brightGreen,
  error:    fg.brightRed,
};

// Seeded PRNG (mulberry32) — deterministic scatter pattern
function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Grid state: array of { state, flashUntil }
// state ∈ 'unread' | 'reading' | 'written' | 'linked' | 'done' | 'error'
let _grid         = [];
let _gridCols     = 0;
let _gridTotal    = 0;
let _sweepHead    = 0;     // index of the defrag sweep leading edge

function initGrid(cols) {
  const gridCols = cols - 4;   // 2-char padding each side
  _gridCols  = gridCols;
  _gridTotal = gridCols * GRID_ROWS;
  _grid      = [];

  const rng = seededRng(0xDEF4A6);  // seeded scatter pattern

  for (let i = 0; i < _gridTotal; i++) {
    // Initial fragmented state — most cells unread, occasional reading sprinkle
    // to look genuinely fragmented, not a flat rectangle
    const r = rng();
    let state;
    if (r < 0.03) {
      state = 'reading';
    } else if (r < 0.07) {
      // Slight "pre-written" clusters near the start
      state = i < _gridTotal * 0.15 && r < 0.05 ? 'written' : 'unread';
    } else {
      state = 'unread';
    }
    _grid.push({ state, flashUntil: 0 });
  }

  _sweepHead = 0;
}

// ── Log buffer ────────────────────────────────────────────────────────────────
const LOG_LINES    = 8;    // visible lines (Bug 2: increased from 6)
const _logBuffer   = [];   // newest at end
let   _lastLogTime = Date.now();

function logPush(entry) {
  // entry: { type, text, time }
  _logBuffer.push(entry);
  _lastLogTime = Date.now();
  if (_logBuffer.length > 40) _logBuffer.shift();
}

// Heartbeat: synthetic pulse line injected when no activity for >4s (Bug 3: was 2.5s)
function maybeHeartbeat() {
  if (_state.phase === 'COMPLETE') return;
  const silent = Date.now() - _lastLogTime;
  if (silent > 4000) {
    const dots = ['   ', '.  ', '.. ', '...'][Math.floor(Date.now() / 400) % 4];
    const msg  = `${fg.brightBlack}working${dots}${style.reset}`;
    // Don't push to buffer — just render as a temporary overlay in renderLog
    return msg;
  }
  return null;
}

// ── State ─────────────────────────────────────────────────────────────────────
const _state = {
  phase:      'SCANNING',
  pct:        0,
  sessions:   0,
  concepts:   0,
  links:      0,
  files:      0,
  sources:    {},          // { claude: 'found'|'missing'|'scanning', ... }
  startTime:  0,          // Bug 5: set in init(), not at module load time
  lastUpdate: Date.now(),
  done:       false,
  currentSession: '',    // e.g. "[42/544] codex 2026-05-14" — shown during extraction
  currentStage:   '',
  currentDetail:  '',
  currentFocus:   '',
  currentQuality: '',
  // Session tier tracking
  tiersHigh:     0,
  tiersMedium:   0,
  tiersLow:      0,
  promoted:      0,       // concepts that got standalone notes
  lowSignal:     0,       // concepts in _low-signal.md
  topConcepts:   [],      // top 5 promoted concept names for completion screen
};

// Animation sub-state
const _anim = {
  sourceDotsFrame: 0,
  linkFlashTimer:  0,
  doneSwept:       0,     // how many cells swept to 'done' during final animation
  doneSweeping:    false,
};

// ── Event loop health tracking ────────────────────────────────────────────────
let _lastFrameTime = Date.now();
let _frameLag      = 0;         // ms since last successful frame render

// ── Render loop ───────────────────────────────────────────────────────────────
let _renderInterval = null;
const FRAME_MS = 80;

function startRenderLoop() {
  if (_renderInterval) return;
  _renderInterval = setInterval(frame, FRAME_MS);
}

function stopRenderLoop() {
  if (_renderInterval) {
    clearInterval(_renderInterval);
    _renderInterval = null;
  }
}

// ── Full-frame render ─────────────────────────────────────────────────────────
let _lastCols = 0;
let _lastRows = 0;

function frame() {
  // Track event loop health
  const now = Date.now();
  _frameLag      = now - _lastFrameTime;
  _lastFrameTime = now;

  const { cols, rows } = termSize();

  // If terminal resized, clear and redraw everything
  const resized = cols !== _lastCols || rows !== _lastRows;
  if (resized) {
    if (cols !== _lastCols) initGrid(cols);
    _lastCols = cols;
    _lastRows = rows;
    out(CLEAR_SCREEN);
  }

  // Advance animations before rendering
  tickAnimations();

  // Build entire frame as a single string for minimal flicker
  let buf = '';
  buf += moveTo(1, 1);

  const innerW = cols - 2;   // inside the border

  // ── Header bar ──────────────────────────────────────────────────────────────
  buf += renderHeader(cols, innerW);

  // ── Grid section ────────────────────────────────────────────────────────────
  buf += renderGrid(cols, innerW);

  // ── Legend bar ──────────────────────────────────────────────────────────────
  buf += renderLegend(cols, innerW);

  // ── Activity log ────────────────────────────────────────────────────────────
  buf += renderLog(cols, innerW);

  // ── Stats / progress footer ─────────────────────────────────────────────────
  buf += renderFooter(cols, innerW);

  // Tick the dot animation
  if (++_anim.sourceDotsFrame >= 12) _anim.sourceDotsFrame = 0;

  out(buf);
}

// ── Tick animations ───────────────────────────────────────────────────────────
function tickAnimations() {
  const now = Date.now();

  // Sweep head advances based on phase
  if (_state.phase === 'SCANNING' || _state.phase === 'EXTRACTING') {
    // Move read head: advance based on pct
    const target = Math.floor((_state.pct / 100) * _gridTotal * 0.4);
    if (_sweepHead < target) {
      const step = Math.max(1, Math.floor((target - _sweepHead) / 8));
      _sweepHead = Math.min(target, _sweepHead + step);
    }
    // Leading edge: cells behind sweep head turn 'reading'; a few cells ahead glow too
    for (let i = 0; i < _gridTotal; i++) {
      if (i <= _sweepHead) {
        if (_grid[i].state === 'unread') {
          _grid[i].state = 'reading';
        }
      }
    }
  } else if (_state.phase === 'WRITING') {
    // Sweep wave — cells ahead show 'reading' briefly, then 'written'
    const target = Math.floor((_state.pct / 100) * _gridTotal * 0.9);
    if (_sweepHead < target) {
      const step = Math.max(1, Math.floor((target - _sweepHead) / 5));
      for (let i = _sweepHead; i < Math.min(_sweepHead + step, _gridTotal); i++) {
        if (_grid[i].state !== 'written' && _grid[i].state !== 'done') {
          // Wave front: a few cells ahead glow 'reading' before written
          if (i >= _sweepHead - 2 && i <= _sweepHead + 2) {
            _grid[i].state = 'reading';
          } else {
            _grid[i].state = 'written';
          }
        }
      }
      _sweepHead = Math.min(target, _sweepHead + step);
      // Cells behind leading edge settle to 'written'
      for (let i = 0; i < Math.max(0, _sweepHead - 4); i++) {
        if (_grid[i].state === 'reading') _grid[i].state = 'written';
      }
    }
  } else if (_state.phase === 'LINKING') {
    // Random cells flash to 'linked' (yellow) for 150ms
    _anim.linkFlashTimer += FRAME_MS;
    if (_anim.linkFlashTimer >= 120) {
      _anim.linkFlashTimer = 0;
      // Flash 1-3 random written cells
      const rng = seededRng(now & 0xFFFF);
      const count = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < count; k++) {
        const idx = Math.floor(rng() * _gridTotal);
        if (_grid[idx].state === 'written') {
          _grid[idx].state     = 'linked';
          _grid[idx].flashUntil = now + 150;
        }
      }
    }
    // Expire flashes
    for (let i = 0; i < _gridTotal; i++) {
      if (_grid[i].state === 'linked' && now > _grid[i].flashUntil) {
        _grid[i].state = 'written';
      }
    }
    // Also advance sweep to near-complete
    const target = Math.floor((_state.pct / 100) * _gridTotal);
    if (_sweepHead < target) {
      _sweepHead = Math.min(target, _sweepHead + Math.max(1, Math.floor((target - _sweepHead) / 3)));
    }
    for (let i = 0; i < _sweepHead; i++) {
      if (_grid[i].state === 'unread' || _grid[i].state === 'reading') {
        _grid[i].state = 'written';
      }
    }
  } else if (_state.phase === 'COMPLETE') {
    // Sweep all cells to 'done' over ~800ms — wave moves left to right
    if (!_anim.doneSweeping) {
      _anim.doneSweeping  = true;
      _anim.doneSwept     = 0;
    }
    const targetDone = Math.min(_gridTotal, _anim.doneSwept + Math.ceil(_gridTotal / 10));
    for (let i = _anim.doneSwept; i < targetDone; i++) {
      _grid[i].state = 'done';
    }
    _anim.doneSwept = targetDone;
  }
}

// ── Section renderers ─────────────────────────────────────────────────────────

// Braille spinner frames — smooth and modern, reads instantly as "working"
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

function renderHeader(cols, innerW) {
  const VERSION = '1.0';

  // Spinner: only show when actively processing (not complete)
  const isDone = _state.phase === 'COMPLETE';
  const spinFrame = SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length];
  const spinner = isDone
    ? `${fg.brightGreen}\u2713${style.reset}`
    : `${fg.brightCyan}${spinFrame}${style.reset}`;

  const phase = `${fg.brightCyan}${style.bold}${_state.phase}${style.reset}`;

  // Event loop health indicator — shows lag when the loop is stalled
  let lagStr = '';
  let lagPlain = '';
  if (!isDone && _frameLag > 200) {
    // Show lag when > 200ms (normal is ~80ms)
    const lagMs = Math.round(_frameLag);
    if (lagMs >= 2000) {
      lagStr     = `  ${fg.brightRed}${style.bold}IO ${(lagMs / 1000).toFixed(1)}s${style.reset}`;
      lagPlain   = `  IO ${(lagMs / 1000).toFixed(1)}s`;
    } else {
      lagStr     = `  ${fg.brightYellow}IO ${lagMs}ms${style.reset}`;
      lagPlain   = `  IO ${lagMs}ms`;
    }
  }

  const title = `${style.bold}${fg.brightWhite}CTXDEFRAG.EXE${style.reset}  ${spinner} ${phase}${lagStr}`;
  const right = `${fg.brightBlack}v${VERSION}  [ESC quit]${style.reset}`;

  // Plain lengths for padding calc
  const titlePlain = `CTXDEFRAG.EXE  ${spinFrame} ${_state.phase}${lagPlain}`;
  const rightLen   = `v${VERSION}  [ESC quit]`.length;
  const midPad     = innerW - titlePlain.length - rightLen;
  const mid        = ' '.repeat(Math.max(1, midPad));

  let s = '';
  s += hLine('top', cols);
  s += `│ ${title}${mid}${right} │\n`;
  s += hLine('mid', cols);
  return s;
}

function renderGrid(cols, innerW) {
  // Grid rows — padded 1 char each side inside the box
  const gridCols = _gridCols;    // use state value — consistent with initGrid and grid array size
  let s = '';

  for (let row = 0; row < GRID_ROWS; row++) {
    s += '│ ';
    for (let col = 0; col < gridCols; col++) {
      const idx = row * _gridCols + col;
      if (idx < _gridTotal) {
        const cell = _grid[idx];
        s += BLOCK_COLORS[cell.state] + BLOCK_CHARS[cell.state];
      } else {
        s += fg.brightBlack + BLOCK_CHARS.unread;
      }
    }
    s += `${style.reset} │\n`;
  }
  return s;
}

function renderLegend(cols, innerW) {
  const items = [
    `${fg.brightBlack}░${style.reset} Unread`,
    `${fg.brightBlue}▓${style.reset} Reading`,
    `${fg.brightCyan}█${style.reset} Written`,
    `${fg.brightYellow}■${style.reset} Linked`,
    `${fg.brightGreen}▪${style.reset} Done`,
    `${fg.brightRed}!${style.reset} Error`,
  ];
  const legend = items.join('  ');
  const legendPlain = '░ Unread  ▓ Reading  █ Written  ■ Linked  ▪ Done  ! Error';
  const pad    = Math.max(0, innerW - legendPlain.length);

  let s = '';
  s += hLine('mid', cols);
  s += `│ ${legend}${' '.repeat(pad)} │\n`;
  s += hLine('mid', cols);
  return s;
}

function renderLog(cols, innerW) {
  // The outer box is cols wide: │ ... (innerW chars) ... │
  // We draw an inner activity box indented 1 char on each side:
  //   outer:  │ [space] inner-content [space] │
  //   inner:  ┌─ Activity ──────────────────┐
  //           │ log line                    │
  //           └─────────────────────────────┘
  // inner box width = innerW - 2  (1-space inset each side inside the outer │)

  const innerBoxW = innerW - 2;  // chars between the inner ┌ and ┐ (including them)
  const label     = '─ Activity ';

  // Inner border lines — exactly innerBoxW - 2 dash chars between ┌ and ┐
  const dashCount  = Math.max(0, innerBoxW - 2);
  const labelDash  = Math.max(0, dashCount - label.length);
  const topBorder  = `┌${label}${'─'.repeat(labelDash)}┐`;
  const botBorder  = `└${'─'.repeat(dashCount)}┘`;

  // Each log line: outer │ + space + inner │ + space + content + space + inner │ + space + outer │
  // That means inner content width = innerBoxW - 4  (│space ... space│)
  const contentW = innerBoxW - 4;

  let s = '';
  s += `│ ${topBorder} │\n`;

  const heartbeat   = maybeHeartbeat();
  const entries     = _logBuffer.slice(-LOG_LINES);
  while (entries.length < LOG_LINES) entries.unshift(null);

  const recencyCount = entries.filter(Boolean).length;

  entries.forEach((entry, i) => {
    const isLastSlot  = i === LOG_LINES - 1;
    // If silent, replace the last (most recent) slot with heartbeat pulse
    const lineContent = (isLastSlot && heartbeat && !entry)
      ? heartbeat
      : entry ? formatLogEntry(entry) : '';
    const plainLen    = (isLastSlot && heartbeat && !entry)
      ? plainLength(heartbeat)
      : entry ? plainLength(formatLogEntry(entry)) : 0;
    const pad         = ' '.repeat(Math.max(0, contentW - plainLen));

    // Bug 6: Dim entries older than 3 positions (was > 1) for a recency waterfall
    const entryIndex  = entries.slice(0, i + 1).filter(Boolean).length - (entry ? 1 : 0);
    const age         = recencyCount - 1 - entryIndex;
    const isDim       = !entry || age > 3;
    const dimOn       = isDim && !heartbeat ? style.dim : '';
    const dimOff      = isDim && !heartbeat ? style.reset : '';

    s += `│ │ ${dimOn}${lineContent}${pad}${dimOff} │ │\n`;
  });

  s += `│ ${botBorder} │\n`;
  return s;
}

function formatLogEntry(entry) {
  const { type, text } = entry;
  switch (type) {
    case 'SCAN':
      return `${fg.brightYellow}[SCAN]${style.reset}    ${text}`;
    case 'EXTRACT':
      return `${fg.brightMagenta}[EXTRACT]${style.reset} ${text}`;
    case 'WRITE':
      return `${fg.brightCyan}[WRITE]${style.reset}   ${text}`;
    case 'LINK':
      return `${fg.brightGreen}[LINK]${style.reset}    ${text}`;
    case 'WARN':
      return `${fg.brightRed}[WARN]${style.reset}    ${text}`;
    case 'DRY':
      return `${style.dim}[DRY]${style.reset}     ${text}`;
    case 'DONE':
      return `${fg.brightGreen}${style.bold}[DONE]${style.reset}    ${text}`;
    case 'INFO':
    default:
      return `${fg.brightBlack}[INFO]${style.reset}    ${text}`;
  }
}

/** Strip ANSI codes and count visible characters */
function plainLength(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function renderFooter(cols, innerW) {
  const elapsed = elapsedStr();
  const phase   = _state.phase;

  // Progress bar label — show current session during extraction for liveness
  let labelText = phase;
  let labelPlainLen = phase.length;
  if (phase === 'EXTRACTING' && _state.currentSession) {
    labelText = _state.currentSession;
    labelPlainLen = _state.currentSession.length;
  }

  const barLabel    = `${fg.brightCyan}${style.bold}${labelText}${style.reset}`;
  const barLabelLen = labelPlainLen + 1;  // +1 space

  const pctStr   = `${String(_state.pct).padStart(3)}%`;
  // pct string + space + label + margins
  const barWidth = innerW - barLabelLen - pctStr.length - 4;
  const bar      = renderProgressBar(_state.pct, Math.max(8, barWidth));

  let s = '';
  s += `│ ${barLabel} ${bar} ${fg.brightWhite}${pctStr}${style.reset}${' '.repeat(Math.max(0, innerW - barLabelLen - barWidth - pctStr.length - 3))} │\n`;
  const stateLine = buildCurrentStateLine(innerW);
  s += `│ ${stateLine}${' '.repeat(Math.max(0, innerW - plainLength(stateLine) - 1))}│\n`;

  // Stats row — fixed-width columns so numbers don't jump around
  const stats = buildStatsRow(innerW);
  s += `│ ${stats}${' '.repeat(Math.max(0, innerW - plainLength(stats) - 1))}│\n`;

  // Sources row
  const sourcesLine = buildSourcesRow();
  const elapsedPart = `${fg.brightBlack}Elapsed  ${fg.brightWhite}${elapsed}${style.reset}`;
  const elapsedPlain = `Elapsed  ${elapsed}`;
  const midGap = Math.max(1, innerW - plainLength(sourcesLine) - elapsedPlain.length - 2);
  s += `│ ${sourcesLine}${' '.repeat(midGap)}${elapsedPart} │\n`;

  s += hLine('bot', cols);
  return s;
}

// Bug 4: Progress bar with pulsing leading edge
function renderProgressBar(pct, width) {
  const filled = Math.floor((pct / 100) * width);
  const empty  = width - filled;

  // Pulsing leading edge: when not at 0% or 100%, the last filled char
  // alternates between █ and ▓ on a ~400ms cycle for a subtle "alive" signal
  const isPulsing = pct > 0 && pct < 100 && filled > 0;
  const pulseHigh = Math.floor(Date.now() / 400) % 2 === 0;

  let fullPart;
  if (isPulsing) {
    const solidCount = filled - 1;
    const edgeChar   = pulseHigh ? '█' : '▓';
    const edgeColor  = pulseHigh ? fg.brightCyan : fg.brightBlue;
    fullPart = `${fg.brightCyan}${'█'.repeat(solidCount)}${edgeColor}${edgeChar}`;
  } else {
    fullPart = `${fg.brightCyan}${'█'.repeat(filled)}`;
  }

  const emptyPart = `${fg.brightBlack}${'░'.repeat(empty)}`;
  return fullPart + emptyPart + style.reset;
}

function buildStatsRow(innerW) {
  const s = _state;
  const cols = [
    stat('Sessions', s.sessions,  5),
    stat('Concepts', s.concepts,  5),
    stat('Links',    s.links,     5),
    stat('Files',    s.files,     5),
  ];

  // Show tier distribution once extraction has started producing tiers
  const hasTiers = s.tiersHigh > 0 || s.tiersMedium > 0 || s.tiersLow > 0;
  if (hasTiers) {
    const tierStr = `${fg.brightGreen}▲${s.tiersHigh}${style.reset} `
                  + `${fg.brightCyan}●${s.tiersMedium}${style.reset} `
                  + `${fg.brightBlack}·${s.tiersLow}${style.reset}`;
    cols.push(tierStr);
  }

  return cols.join('   ');
}

function buildCurrentStateLine(innerW) {
  if (!_state.currentStage && !_state.currentDetail && !_state.currentFocus) {
    return `${fg.brightBlack}State${style.reset}  ${fg.brightWhite}${_state.phase.toLowerCase()}${style.reset}`;
  }

  const qualityColor = _state.currentQuality === 'blocked' || _state.currentQuality === 'weak'
    ? fg.brightRed
    : _state.currentQuality === 'resumed'
      ? fg.brightYellow
      : _state.currentQuality === 'rich'
        ? fg.brightGreen
        : fg.brightCyan;

  const parts = [
    `${fg.brightBlack}State${style.reset}  ${fg.brightWhite}${truncateDisplay(_state.currentStage || _state.phase, Math.max(12, innerW / 3))}${style.reset}`,
  ];
  if (_state.currentDetail) {
    parts.push(`${fg.brightBlack}·${style.reset} ${qualityColor}${truncateDisplay(_state.currentDetail, Math.max(18, innerW / 2))}${style.reset}`);
  }
  if (_state.currentFocus) {
    parts.push(`${fg.brightBlack}·${style.reset} ${fg.brightYellow}${truncateDisplay(_state.currentFocus, Math.max(12, innerW / 4))}${style.reset}`);
  }
  return parts.join(' ');
}

function stat(label, value, valueWidth) {
  const val = String(value === undefined ? 0 : value).padStart(valueWidth);
  return `${fg.brightBlack}${label}${style.reset}  ${fg.brightWhite}${val}${style.reset}`;
}

function buildSourcesRow() {
  const ALL  = ['claude', 'codex', 'cursor'];
  const parts = ALL.map((src) => {
    const sourceState = (_state.sources || {})[src];
    const status = typeof sourceState === 'string' ? sourceState : sourceState?.status;
    const sessionCount = typeof sourceState === 'object' ? sourceState?.sessions : 0;
    if (!status || status === 'pending' || status === 'scanning') {
      const dots = ['.  ', '.. ', '...'][Math.floor(_anim.sourceDotsFrame / 4) % 3];
      return `${fg.brightBlack}${src}${fg.brightBlack}${dots}${style.reset}`;
    } else if (status === 'found') {
      const count = sessionCount ? ` ${sessionCount}` : '';
      return `${fg.brightBlack}${src}${count} ${fg.brightGreen}✓${style.reset}`;
    } else if (status === 'error') {
      return `${fg.brightBlack}${src} ${fg.brightRed}!${style.reset}`;
    } else {
      return `${fg.brightBlack}${src} —${style.reset}`;
    }
  });
  return `${fg.brightBlack}Sources  ${style.reset}` + parts.join('  ');
}

function elapsedStr() {
  const ms  = Date.now() - _state.startTime;
  const s   = Math.floor(ms / 1000);
  const m   = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

// ── Box-drawing helpers ───────────────────────────────────────────────────────
function hLine(type, cols) {
  const inner = cols - 2;
  const bar   = '─'.repeat(inner);
  if (type === 'top') return `┌${bar}┐\n`;
  if (type === 'mid') return `├${bar}┤\n`;
  if (type === 'bot') return `└${bar}┘\n`;
  return `├${bar}┤\n`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * disable() — Force the TUI off even when stdout is a TTY.
 * Call before init(). Used by --no-tui flag for scripting/debugging.
 * Falls back to plain console.log() for all output.
 */
function disable() {
  ENABLED = false;
}

/**
 * init() — Enter alt screen, hide cursor, start render loop
 */
function init() {
  if (!ENABLED) return;

  // Bug 5: Set startTime at init(), not at module load
  _state.startTime = Date.now();

  const { cols } = termSize();
  initGrid(cols);

  out(ALT_SCREEN_ON);
  out(HIDE_CURSOR);
  out(CLEAR_SCREEN);

  // Catch ESC / q / Ctrl-C to exit gracefully.
  // Raw mode means Ctrl-C won't generate SIGINT — we must handle \x03 manually.
  // ESC (\x1b) alone means quit, but \x1b followed by more bytes is an escape
  // sequence (arrow keys, etc.) so we only quit on bare \x1b.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      const buf = data.toString();

      // Ctrl-C (\x03) — always exit immediately
      if (buf.includes('\x03')) {
        requestExit();
        return;
      }

      // 'q' — quit
      if (buf === 'q' || buf === 'Q') {
        requestExit();
        return;
      }

      // Bare ESC (\x1b alone, not followed by '[' or other sequence chars)
      // Multi-byte escapes like \x1b[A (arrow up) have length > 1
      if (buf === '\x1b') {
        requestExit();
        return;
      }
    });
  }

  startRenderLoop();
}

/**
 * update(patch) — Merge state patch and update grid/animations accordingly
 * patch: { phase, pct, sessions, concepts, links, files, sources }
 */
function update(patch) {
  if (!patch) return;

  if (patch.phase   !== undefined) _state.phase    = patch.phase.toUpperCase();
  if (patch.pct     !== undefined) _state.pct      = Math.min(100, Math.max(0, patch.pct));
  if (patch.sessions !== undefined) _state.sessions = patch.sessions;
  if (patch.concepts !== undefined) _state.concepts = patch.concepts;
  if (patch.links   !== undefined) _state.links    = patch.links;
  if (patch.files   !== undefined) _state.files    = patch.files;

  if (patch.sources) {
    // sources can be an array of source names that were found,
    // or an object from scanResults { claude: {found, sessions}, ... }
    if (Array.isArray(patch.sources)) {
      for (const src of patch.sources) {
        _state.sources[src] = { status: 'found', found: true, sessions: 0 };
      }
    } else {
      for (const [src, data] of Object.entries(patch.sources)) {
        if (typeof data === 'string') {
          _state.sources[src] = { status: data, found: data === 'found', sessions: 0 };
        } else {
          _state.sources[src] = {
            status: data.status || (data.found ? 'found' : 'missing'),
            found: Boolean(data.found),
            sessions: data.sessions || 0,
          };
        }
      }
    }
  }

  if (patch.currentSession !== undefined) _state.currentSession = patch.currentSession;
  if (patch.currentStage !== undefined) _state.currentStage = patch.currentStage;
  if (patch.currentDetail !== undefined) _state.currentDetail = patch.currentDetail;
  if (patch.currentFocus !== undefined) _state.currentFocus = patch.currentFocus;
  if (patch.currentQuality !== undefined) _state.currentQuality = patch.currentQuality;

  // Tier counts and completion stats
  if (patch.tiersHigh   !== undefined) _state.tiersHigh   = patch.tiersHigh;
  if (patch.tiersMedium !== undefined) _state.tiersMedium  = patch.tiersMedium;
  if (patch.tiersLow    !== undefined) _state.tiersLow     = patch.tiersLow;
  if (patch.promoted    !== undefined) _state.promoted     = patch.promoted;
  if (patch.lowSignal   !== undefined) _state.lowSignal    = patch.lowSignal;
  if (patch.topConcepts !== undefined) _state.topConcepts  = patch.topConcepts;

  _state.lastUpdate = Date.now();

  if (!ENABLED) return;
}

/**
 * log(msg) — Add a log entry, visible in the activity panel
 * msg can be a plain string or start with a type prefix like "[SCAN] ..."
 */
function log(msg) {
  if (!msg && msg !== 0) return;

  const str = String(msg);

  if (!ENABLED) {
    console.log(str);
    return;
  }

  const entry = parseLogEntry(str);
  logPush(entry);
}

function parseLogEntry(str) {
  // Detect type from common patterns
  if (/^\[SCAN\]|Scann|Found \d+ session/i.test(str)) {
    return { type: 'SCAN',  text: stripBracketPrefix(str, 'SCAN'), time: Date.now() };
  }
  // Detect [DONE] before generic "done" pattern match
  if (/^\[DONE\]/i.test(str)) {
    return { type: 'DONE', text: stripBracketPrefix(str, 'DONE'), time: Date.now() };
  }
  // Bug 1: Detect [EXTRACT] before [WRITE] so extraction logs aren't misclassified
  if (/^\[EXTRACT\]|extracting.*concept/i.test(str)) {
    return { type: 'EXTRACT', text: stripBracketPrefix(str, 'EXTRACT'), time: Date.now() };
  }
  if (/^\[WRITE\]|\[linked\]/i.test(str) && !/link/i.test(str.slice(0, 7))) {
    return { type: 'WRITE', text: stripBracketPrefix(str, 'WRITE'), time: Date.now() };
  }
  if (/^\[LINK\]|\[\[linked\]\]/i.test(str) || /linked.*ref/i.test(str)) {
    return { type: 'LINK',  text: stripBracketPrefix(str, 'LINK'), time: Date.now() };
  }
  if (/^\[WARN\]|warning|warn/i.test(str)) {
    return { type: 'WARN',  text: stripBracketPrefix(str, 'WARN'), time: Date.now() };
  }
  if (/^\[DRY\]|dry.?run/i.test(str)) {
    return { type: 'DRY',   text: stripBracketPrefix(str, 'DRY'),  time: Date.now() };
  }
  if (/complete|done|safe to turn off/i.test(str)) {
    return { type: 'DONE',  text: str, time: Date.now() };
  }
  if (/writing vault|building links/i.test(str)) {
    return { type: 'WRITE', text: str, time: Date.now() };
  }
  if (/scanning|session.*found|source/i.test(str)) {
    return { type: 'SCAN',  text: str, time: Date.now() };
  }
  return { type: 'INFO', text: str, time: Date.now() };
}

function stripBracketPrefix(str, type) {
  return str.replace(new RegExp(`^\\[${type}\\]\\s*`, 'i'), '').trim();
}

function truncateDisplay(str, max) {
  const plain = String(str || '');
  if (plain.length <= max) return plain;
  return plain.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * done() — Trigger completion animation, then exit alt screen
 */
function done() {
  if (!ENABLED) return Promise.resolve();

  return new Promise((resolve) => {
    _state.phase = 'COMPLETE';
    _state.pct   = 100;

    // Let the final sweep animation play
    const completeStart = Date.now();
    const CHECK_MS = 80;

    const check = setInterval(() => {
      const elapsed = Date.now() - completeStart;
      if (_anim.doneSwept >= _gridTotal || elapsed > 2000) {
        clearInterval(check);
        // Brief pause at the "safe to turn off" screen
        setTimeout(() => {
          stopRenderLoop();
          cleanup();
          resolve();
        }, 600);
      }
    }, CHECK_MS);
  });
}

// ── Non-TTY pass-through ──────────────────────────────────────────────────────
// All public methods above already guard with `if (!ENABLED) return`.
// done() returns a resolved promise when not a TTY.

// ── Module export ─────────────────────────────────────────────────────────────
module.exports = {
  get ENABLED() { return ENABLED; },
  disable,
  init,
  update,
  log,
  done,
  // Expose exit flag so the pipeline can check it on each yield and bail out
  // gracefully instead of requiring the event loop to process the exit.
  get exitRequested() { return _wantExit; },
};
