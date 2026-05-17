#!/usr/bin/env node
'use strict';

const { _test } = require('./miners/cursor');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
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

console.log('\nCursor miner');

test('flattenCursorContent handles nested arrays and objects', () => {
  const value = [
    { text: 'First line' },
    { content: ['Second line', { markdown: 'Third line' }] },
  ];
  const result = _test.flattenCursorContent(value);
  assert(result.includes('First line'), 'should include first line');
  assert(result.includes('Second line'), 'should include second line');
  assert(result.includes('Third line'), 'should include third line');
});

test('prompt payload becomes multiple sessions', () => {
  const sessions = _test.extractPromptSessions(
    [
      { text: 'first prompt', commandType: 4 },
      { text: 'second prompt', commandType: 4 },
    ],
    'aiService.prompts',
    '/tmp/state.vscdb',
    { workspace: 'abc', workspaceName: 'demo', workspacePath: '/tmp/demo' }
  );
  assertEqual(sessions.length, 2, 'should create one session per prompt record');
  assertEqual(sessions[0].messages.length, 1, 'prompt-only record should remain a single-message session');
});

test('composer payload yields metadata-rich cursor sessions', () => {
  const sessions = _test.extractComposerSessions(
    {
      allComposers: [
        {
          type: 'head',
          composerId: 'composer-1',
          name: 'Fix weak extraction',
          subtitle: 'Focus on Cursor parsing',
          createdAt: 1760000000000,
          lastUpdatedAt: 1760000300000,
          unifiedMode: 'agent',
          forceMode: 'edit',
          contextUsagePercent: 42.5,
          isWorktree: true,
          isSpec: false,
          hasBlockingPendingActions: true,
        },
      ],
    },
    'composer.composerData',
    '/tmp/state.vscdb',
    { workspace: 'abc', workspaceName: 'demo', workspacePath: '/tmp/demo' }
  );
  assertEqual(sessions.length, 1, 'should create one composer session');
  assert(sessions[0].cursorMetaOnly, 'composer head should be marked metadata-only');
  assertEqual(sessions[0].cursorMeta.unifiedMode, 'agent', 'should retain composer mode');
  assertEqual(sessions[0].workspacePath, '/tmp/demo', 'should preserve workspace path');
});

test('generic tab payload normalizes assistant role and title', () => {
  const sessions = _test.extractSessionsFromPayload(
    {
      tabs: [
        {
          tabId: 'tab-1',
          chatTitle: 'Cursor discussion',
          lastSendTime: 1760000400000,
          bubbles: [
            { type: 'user', text: 'Please inspect cli/defrag.js' },
            { type: 'ai', content: [{ text: 'I found the issue in cli/defrag.js' }] },
          ],
        },
      ],
    },
    'workbench.panel.aichat.view.aichat.chatdata',
    '/tmp/state.vscdb',
    { workspace: 'abc', workspaceName: 'demo', workspacePath: '/tmp/demo' }
  );
  assertEqual(sessions.length, 1, 'should extract one tab session');
  assertEqual(sessions[0].messages[1].role, 'assistant', 'should normalize ai role');
  assertEqual(sessions[0].title, 'Cursor discussion', 'should retain tab title');
  assert(sessions[0].filesTouched.includes('cli/defrag.js'), 'should extract file references');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
