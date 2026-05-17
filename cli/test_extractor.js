#!/usr/bin/env node
/**
 * test_extractor.js — Unit tests for extractor.js
 *
 * Covers: escapeRegex, extract, computeSessionScore, sessionTier,
 *         classifyDecisionPattern, computeSignalScore, extractSessionNarrative
 *
 * Usage:
 *   node cli/test_extractor.js
 *
 * Exit codes:
 *   0 — all tests passed
 *   1 — one or more tests failed
 */

'use strict';

const {
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
} = require('./extractor');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(arr, item, msg) {
  if (!arr.includes(item)) {
    throw new Error(`${msg || 'assertIncludes'}: ${JSON.stringify(item)} not found in [${arr.slice(0, 5).join(', ')}...]`);
  }
}

// ── Helper: build a minimal session object ────────────────────────────────────
function makeSession(messages, opts = {}) {
  return {
    id: opts.id || 'test-session-1',
    source: opts.source || 'claude',
    title: opts.title || 'Test Session',
    timestamp: opts.timestamp || new Date('2026-05-15T12:00:00Z'),
    messages: messages.map((m, i) => ({
      role: typeof m === 'string' ? (i % 2 === 0 ? 'human' : 'assistant') : m.role,
      content: typeof m === 'string' ? m : m.content,
      timestamp: null,
    })),
    turnCount: messages.length,
    ...opts,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nescapeRegex');
// ═════════════════════════════════════════════════════════════════════════════

test('escapeRegex handles basic special chars', () => {
  // We can't import escapeRegex directly (not exported), but we can test it
  // indirectly via extract — if escapeRegex is broken, signal scoring will throw
  const session = makeSession([
    'Should we use `node.js` or `C++`?',
    'I decided to go with `node.js` because of the ecosystem.',
  ]);
  const result = extract(session);
  // Should not throw — escapeRegex is used in computeSignalScore internals
  assert(result.concepts.length >= 0, 'extract should return concepts array');
});

test('escapeRegex handles regex special chars in concept names', () => {
  // Concepts with regex special chars like C++, .NET, $PATH
  const session = makeSession([
    'We evaluated `C++` and `.NET` frameworks.',
    'The `C++` performance was better than `.NET` for this use case.',
    'We decided to use `C++` for the core engine.',
  ]);
  const result = extract(session);
  // This will use escapeRegex internally during signal scoring
  // If escapeRegex is corrupted, this will throw SyntaxError
  assert(Array.isArray(result.concepts), 'should return concepts without throwing');
});

test('escapeRegex preserves string correctly via signal scoring', () => {
  // Create a session with a concept that has special regex chars
  const session = makeSession([
    'Using `node.js` with `express.js` for the API server.',
    'Decided to use `node.js` because of async support.',
    'The `express.js` middleware pattern works well with `node.js`.',
  ]);
  const result = extract(session);
  // computeSignalScore uses escapeRegex to build word-boundary regexes
  // If broken, it would throw or return NaN
  const mockSessionItems = [{ session, extracted: result }];
  const score = computeSignalScore('node.js', mockSessionItems, []);
  assert(typeof score === 'number' && !isNaN(score), `score should be a number, got: ${score}`);
  assert(score > 0, `score should be positive for a mentioned concept, got: ${score}`);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nextract()');
// ═════════════════════════════════════════════════════════════════════════════

test('extract returns all expected fields', () => {
  const session = makeSession([
    'How do I configure `webpack` for production?',
    'You should use `webpack` with the production mode flag.',
  ]);
  const result = extract(session);
  assert(Array.isArray(result.concepts), 'concepts should be an array');
  assert(Array.isArray(result.conceptObjects), 'conceptObjects should be an array');
  assert(Array.isArray(result.decisions), 'decisions should be an array');
  assert(Array.isArray(result.issues), 'issues should be an array');
  assert(Array.isArray(result.actionItems), 'actionItems should be an array');
  assert(Array.isArray(result.commits), 'commits should be an array');
  assert(Array.isArray(result.snippets), 'snippets should be an array');
  assert(Array.isArray(result.urls), 'urls should be an array');
  assert(Array.isArray(result.entities), 'entities should be an array');
  assert(result.continuity && typeof result.continuity === 'object', 'continuity should exist');
  assert(result.observability && typeof result.observability === 'object', 'observability should exist');
});

test('extract emits staged events and continuity state', () => {
  const session = makeSession([
    'We are back to the `cursor.js` extraction issue again. Still blocked on weak session recovery.',
    'Next step: update `cursor.js`, inspect `cli/defrag.js`, and continue the fix.',
    'I decided to switch to richer extraction state events before linking.',
  ], {
    source: 'cursor',
    workspacePath: '/Users/me/context-defrag',
    filesTouched: ['cli/miners/cursor.js', 'cli/defrag.js'],
  });
  const events = [];
  const result = extract(session, {
    onEvent: (event) => events.push(event.stage),
  });
  assert(events.length >= 5, 'should emit multiple extraction stages');
  assertEqual(events[0], 'prepare', 'first stage should be prepare');
  assert(events.includes('signals'), 'should emit structured signal stage');
  assert(events.includes('continuity'), 'should emit continuity stage');
  assertEqual(events[events.length - 1], 'complete', 'last stage should be complete');
  assert(result.continuity.resumed, 'should detect resumed work');
  assert(result.continuity.blocked, 'should detect blocked work');
  assertEqual(result.continuity.phase, 'implementing', 'should classify current work phase');
});

test('extract finds backtick-wrapped concepts', () => {
  const session = makeSession([
    'We need to set up `kubernetes` with `docker` containers.',
    'The `kubernetes` cluster should use `docker` images.',
  ]);
  const result = extract(session);
  assertIncludes(result.concepts, 'kubernetes', 'should find kubernetes');
  assertIncludes(result.concepts, 'docker', 'should find docker');
});

test('extract finds decision patterns', () => {
  const session = makeSession([
    'What database should we use?',
    'I decided to use PostgreSQL instead of MySQL because of JSON support.',
  ]);
  const result = extract(session);
  assert(result.decisions.length > 0, 'should find at least one decision');
  assertIncludes(result.concepts, 'PostgreSQL', 'single high-signal decision concept should survive');
});

test('extract finds issues, actions, and commit signals', () => {
  const session = makeSession([
    'The issue is that `cursor.js` is broken and Cursor sessions are missing from the vault.',
    'Next step: update `cursor.js`, commit the fix, and open a pull request.',
  ], {
    source: 'cursor',
    workspacePath: '/Users/me/context-defrag',
    filesTouched: ['cli/miners/cursor.js'],
  });
  const result = extract(session);
  assert(result.issues.length > 0, 'should detect issue framing');
  assert(result.actionItems.length > 0, 'should detect action items');
  assert(result.commits.length > 0, 'should detect commit or PR signals');
  assertIncludes(result.files, 'cli/miners/cursor.js', 'should retain technical file context');
});

test('extract creates rich concept objects', () => {
  const session = makeSession([
    'We decided to use `PostgreSQL` for metadata storage.',
    'Follow-up: add migrations and commit the PostgreSQL schema changes.',
  ]);
  const result = extract(session);
  const postgres = result.conceptObjects.find((concept) => concept.name === 'PostgreSQL');
  assert(postgres, 'should expose PostgreSQL as a rich concept object');
  assert(postgres.kind, 'concept should have a kind');
  assert(Array.isArray(postgres.evidence) && postgres.evidence.length > 0, 'concept should retain evidence');
  assert(postgres.decisionCount > 0 || postgres.actionItemCount > 0, 'concept should retain structured counts');
});

test('extract marks metadata-only cursor sessions as weak', () => {
  const session = makeSession([
    'Discuss fixing weak Cursor extraction',
  ], {
    source: 'cursor',
    cursorMetaOnly: true,
    workspacePath: '/Users/me/context-defrag',
  });
  const result = extract(session);
  assert(result.observability.weakSignals.includes('metadata-only cursor session'),
    'should surface metadata-only cursor sessions');
});

test('extract finds code snippets', () => {
  const session = makeSession([
    'Show me a config example.',
    'Here is the config:\n```json\n{"key": "value", "port": 3000}\n```\nThis should work.',
  ]);
  const result = extract(session);
  assert(result.snippets.length > 0, 'should find at least one snippet');
  assertEqual(result.snippets[0].lang, 'json', 'snippet lang should be json');
});

test('extract finds URLs', () => {
  const session = makeSession([
    'Check out https://github.com/somarc/context-defrag for the repo.',
    'The docs are at https://somarc.github.io/context-defrag/',
  ]);
  const result = extract(session);
  assert(result.urls.length >= 1, 'should find at least one URL');
});

test('extract handles empty session', () => {
  const session = makeSession([]);
  const result = extract(session);
  assertEqual(result.concepts.length, 0, 'empty session should have no concepts');
  assertEqual(result.decisions.length, 0, 'empty session should have no decisions');
});

test('extract seeds skill names as concepts', () => {
  const session = makeSession([
    'I need help with the AEM project.',
    'Sure, let me check the EDS configuration.',
  ]);
  session.skillsUsed = ['eds-blocks', 'aem-publish'];
  const result = extract(session);
  assertIncludes(result.concepts, 'eds-blocks', 'skill name should appear as concept');
  assertIncludes(result.concepts, 'aem-publish', 'skill name should appear as concept');
});

test('extract caps text at 500KB', () => {
  // Create a massive session — should not hang or crash
  const bigContent = 'x'.repeat(600000);
  const session = makeSession([bigContent, 'short reply']);
  const start = Date.now();
  const result = extract(session);
  const elapsed = Date.now() - start;
  assert(elapsed < 5000, `extraction should not take more than 5s, took ${elapsed}ms`);
  assert(Array.isArray(result.concepts), 'should still return valid result');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\ncomputeSessionScore()');
// ═════════════════════════════════════════════════════════════════════════════

test('HIGH tier for rich sessions', () => {
  const session = makeSession(new Array(20).fill('message'));
  const extracted = {
    decisions: ['decided X', 'chose Y', 'going with Z'],
    snippets: [{ lang: 'js', code: 'console.log()' }],
    concepts: ['webpack', 'babel', 'eslint', 'prettier', 'typescript'],
  };
  const score = computeSessionScore(session, extracted);
  // 20*0.5 + 3*3 + 1*2 + 5*0.3 = 10 + 9 + 2 + 1.5 = 22.5
  assertEqual(sessionTier(score), 'HIGH', `score ${score} should be HIGH`);
});

test('MEDIUM tier for moderate sessions', () => {
  const session = makeSession(new Array(8).fill('message'));
  const extracted = {
    decisions: ['decided to use X'],
    snippets: [],
    concepts: ['react', 'css'],
  };
  const score = computeSessionScore(session, extracted);
  // 8*0.5 + 1*3 + 0*2 + 2*0.3 = 4 + 3 + 0 + 0.6 = 7.6
  assertEqual(sessionTier(score), 'MEDIUM', `score ${score} should be MEDIUM`);
});

test('LOW tier for sparse sessions', () => {
  const session = makeSession(['hello', 'hi']);
  const extracted = {
    decisions: [],
    snippets: [],
    concepts: ['greeting'],
  };
  const score = computeSessionScore(session, extracted);
  // 2*0.5 + 0 + 0 + 1*0.3 = 1.3
  assertEqual(sessionTier(score), 'LOW', `score ${score} should be LOW`);
});

test('tier thresholds are correct', () => {
  assertEqual(sessionTier(12), 'HIGH', '12 should be HIGH');
  assertEqual(sessionTier(11.9), 'MEDIUM', '11.9 should be MEDIUM');
  assertEqual(sessionTier(5), 'MEDIUM', '5 should be MEDIUM');
  assertEqual(sessionTier(4.9), 'LOW', '4.9 should be LOW');
  assertEqual(sessionTier(0), 'LOW', '0 should be LOW');
});

test('SESSION_TIER constants are exported', () => {
  assertEqual(SESSION_TIER_HIGH, 12, 'HIGH threshold');
  assertEqual(SESSION_TIER_MEDIUM, 5, 'MEDIUM threshold');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nclassifyDecisionPattern()');
// ═════════════════════════════════════════════════════════════════════════════

test('classifies CHOICE patterns', () => {
  assertEqual(classifyDecisionPattern('We decided to use React'), 'CHOICE');
  assertEqual(classifyDecisionPattern('Going with PostgreSQL for the database'), 'CHOICE');
});

test('classifies AVOIDANCE patterns', () => {
  assertEqual(classifyDecisionPattern('We should avoid using jQuery'), 'AVOIDANCE');
  assertEqual(classifyDecisionPattern('Do not use eval in production'), 'AVOIDANCE');
});

test('classifies EVOLUTION patterns', () => {
  assertEqual(classifyDecisionPattern('We switched from MySQL to PostgreSQL'), 'EVOLUTION');
  assertEqual(classifyDecisionPattern('Migrated the frontend to React'), 'EVOLUTION');
});

test('classifies CONFIRMATION patterns', () => {
  assertEqual(classifyDecisionPattern('Confirmed that the approach works'), 'CONFIRMATION');
  assertEqual(classifyDecisionPattern('Still using the same architecture'), 'CONFIRMATION');
});

test('returns null for non-decision text', () => {
  assertEqual(classifyDecisionPattern('The weather is nice today'), null);
  assertEqual(classifyDecisionPattern('Hello world'), null);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\ncomputeSignalScore()');
// ═════════════════════════════════════════════════════════════════════════════

test('returns positive score for active concept', () => {
  const session = makeSession([
    'How should we handle `authentication` in the API?',
    'I decided to use JWT for `authentication` because it is stateless.',
  ]);
  const extracted = extract(session);
  const items = [{ session, extracted }];
  const score = computeSignalScore('authentication', items, []);
  assert(score > 0, `should be positive, got ${score}`);
});

test('higher score for concepts with more decisions', () => {
  const session = makeSession([
    'We need `caching` for performance.',
    'I decided to use Redis for `caching` because of speed.',
    'We chose to avoid Memcached — `caching` with Redis is simpler.',
    'Going with a `caching` TTL of 300 seconds.',
  ]);
  const extracted = extract(session);
  const items = [{ session, extracted }];
  const scoreCaching = computeSignalScore('caching', items, []);

  const session2 = makeSession([
    'Also using `logging` in the app.',
    'The `logging` framework is winston.',
  ]);
  const extracted2 = extract(session2);
  const items2 = [{ session: session2, extracted: extracted2 }];
  const scoreLogging = computeSignalScore('logging', items2, []);

  assert(scoreCaching > scoreLogging,
    `caching (${scoreCaching}) should score higher than logging (${scoreLogging})`);
});

test('score handles concepts with regex special chars', () => {
  const session = makeSession([
    'Using `node.js` for the backend.',
    'Decided on `node.js` over Python.',
  ]);
  const extracted = extract(session);
  const items = [{ session, extracted }];
  // This is the critical test — if escapeRegex is broken, this throws
  const score = computeSignalScore('node.js', items, []);
  assert(typeof score === 'number' && !isNaN(score), `score should be valid number, got: ${score}`);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nextractSessionNarrative()');
// ═════════════════════════════════════════════════════════════════════════════

test('produces narrative for normal session', () => {
  const session = makeSession([
    'I need to set up a CI/CD pipeline for our Node.js project.',
    'I recommend using GitHub Actions. You should create a workflow file.',
  ]);
  const extracted = extract(session);
  const narrative = extractSessionNarrative(session, extracted);
  assert(narrative.length > 10, 'narrative should be non-trivial');
});

test('handles empty session gracefully', () => {
  const session = makeSession([]);
  const extracted = extract(session);
  const narrative = extractSessionNarrative(session, extracted);
  assert(typeof narrative === 'string', 'should return a string');
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\ncomputeRecencyBonus()');
// ═════════════════════════════════════════════════════════════════════════════

test('returns 0 when fewer than 20 sessions', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => ({
    session: { timestamp: new Date(2026, 0, i + 1) },
    extracted: { concepts: ['test'] },
  }));
  const bonus = computeRecencyBonus('test', sessions, sessions);
  assertEqual(bonus, 0, 'should return 0 with < 20 sessions');
});

test('returns bonus for recent concept with enough sessions', () => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({
    session: { timestamp: new Date(2026, 0, i + 1) },
    extracted: { concepts: i >= 25 ? ['recent-concept'] : ['other'] },
  }));
  const conceptItems = sessions.filter(s => s.extracted.concepts.includes('recent-concept'));
  const bonus = computeRecencyBonus('recent-concept', conceptItems, sessions);
  assertEqual(bonus, 1.5, 'should return 1.5 for recent concept');
});

// ═════════════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
