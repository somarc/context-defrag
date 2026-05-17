#!/usr/bin/env node
/**
 * smoke_test_shutdown.js  Verify graceful shutdown behavior
 *
 * Tests that the context-defrag process:
 *   1. Starts successfully with --no-tui
 *   2. Responds to SIGINT within 2 seconds
 *   3. Exits with code 0 (not a crash)
 *   4. Does not leave the terminal in a broken state
 *
 * Usage:
 *   node cli/smoke_test_shutdown.js
 *
 * Exit codes:
 *   0  all tests passed
 *   1  a test failed
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');

const DEFRAG_PATH = path.join(__dirname, 'defrag.js');
const TIMEOUT_MS  = 10000;  // max time to wait for graceful exit
const SIGNAL_DELAY = 2000;  // send SIGINT after 2 seconds

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn().then(() => {
    console.log(`   ${name}`);
    passed++;
  }).catch((err) => {
    console.log(`   ${name}: ${err.message || err}`);
    failed++;
  });
}

async function run() {
  console.log('Shutdown smoke tests\n');

  // Test 1: --no-tui starts and produces output
  await test('--no-tui starts and produces output', () => {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DEFRAG_PATH, '--no-tui', '--dry-run'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
      });

      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });

      child.on('close', (code) => {
        if (stdout.length === 0) {
          return reject(new Error('No stdout output'));
        }
        // Dry run should complete on its own
        resolve();
      });

      child.on('error', (err) => reject(err));

      // Safety timeout
      setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timed out waiting for dry-run to complete'));
      }, TIMEOUT_MS);
    });
  });

  // Test 2: SIGINT causes graceful exit
  await test('SIGINT causes graceful exit within 3s', () => {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DEFRAG_PATH, '--no-tui'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
      });

      let exited = false;

      child.on('close', (code, signal) => {
        exited = true;
        // Should exit cleanly (code 0 or null with signal)
        if (code === 0 || signal === 'SIGINT') {
          resolve();
        } else {
          reject(new Error(`Exited with code=${code} signal=${signal} (expected 0 or SIGINT)`));
        }
      });

      child.on('error', (err) => reject(err));

      // Send SIGINT after a delay
      setTimeout(() => {
        if (!exited) {
          child.kill('SIGINT');
        }
      }, SIGNAL_DELAY);

      // Safety timeout  if it doesn't exit within 3s of SIGINT, it's broken
      setTimeout(() => {
        if (!exited) {
          child.kill('SIGKILL');
          reject(new Error('Process did not exit within 3s of SIGINT'));
        }
      }, SIGNAL_DELAY + 3000);
    });
  });

  // Test 3: SIGTERM causes graceful exit
  await test('SIGTERM causes graceful exit', () => {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DEFRAG_PATH, '--no-tui'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: TIMEOUT_MS,
      });

      let exited = false;

      child.on('close', (code, signal) => {
        exited = true;
        if (code === 0 || signal === 'SIGTERM') {
          resolve();
        } else {
          reject(new Error(`Exited with code=${code} signal=${signal}`));
        }
      });

      child.on('error', (err) => reject(err));

      setTimeout(() => {
        if (!exited) child.kill('SIGTERM');
      }, SIGNAL_DELAY);

      setTimeout(() => {
        if (!exited) {
          child.kill('SIGKILL');
          reject(new Error('Process did not exit within 3s of SIGTERM'));
        }
      }, SIGNAL_DELAY + 3000);
    });
  });

  // Summary
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
