'use strict';

/**
 * test-cli.js — Automated integration tests for the Magpie-style CLI client.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(PROJECT_ROOT, 'bin', 'cli.js');

// Never let tests rewrite the user's real config.json: run the CLI against a temp copy.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'accio-cli-test-'));
const TEMP_CONFIG = path.join(TEMP_DIR, 'config.json');
fs.copyFileSync(path.join(PROJECT_ROOT, 'config.json'), TEMP_CONFIG);
process.on('exit', () => {
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
});

function runCli(args = [], env = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ACCIO_BRIDGE_CONFIG: TEMP_CONFIG, ...env, NO_COLOR: '1' },
  });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

async function runCliSuite() {
  console.log('============================================================');
  console.log('       ACCIO CLI CLIENT (MAGPIE ARCHITECTURE) TEST SUITE    ');
  console.log('============================================================\n');

  let passed = 0;
  let total = 0;

  function check(name, fn) {
    total++;
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      throw err;
    }
  }

  check('accio --help displays Magpie-style subcommands', () => {
    const res = runCli(['--help']);
    assert.strictEqual(res.code, 0);
    assert.ok(res.stdout.includes('accio ls'));
    assert.ok(res.stdout.includes('accio status'));
    assert.ok(res.stdout.includes('accio providers'));
    assert.ok(res.stdout.includes('accio models'));
    assert.ok(res.stdout.includes('accio test'));
    assert.ok(res.stdout.includes('accio launch'));
    assert.ok(res.stdout.includes('accio daemon'));
  });

  check('accio ls lists agent bindings and domain-config path', () => {
    const res = runCli(['ls']);
    assert.strictEqual(res.code, 0);
    assert.ok(res.stdout.includes('Accio Work'));
    assert.ok(res.stdout.includes('gateway http://'));
    assert.ok(res.stdout.includes('domain-config.json'));
  });

  check('accio status reports gateway bridge and client status', () => {
    const res = runCli(['status']);
    assert.strictEqual(res.code, 0);
    assert.ok(res.stdout.includes('Gateway Bridge'));
    assert.ok(res.stdout.includes('Accio Work Client'));
    assert.ok(res.stdout.includes('Custom Models:'));
  });

  check('accio providers lists endpoints and enabled models', () => {
    const res = runCli(['providers']);
    assert.strictEqual(res.code, 0);
    assert.ok(res.stdout.includes('ollama'));
    assert.ok(res.stdout.includes('openai'));
  });

  check('accio models and model add/rm manages config.json models', () => {
    // 1. Add model
    const addRes = runCli(['model', 'add', 'test-cli-model', '--provider', 'openai', '--url', 'http://127.0.0.1:1234/v1']);
    assert.strictEqual(addRes.code, 0);
    assert.ok(addRes.stdout.includes('Added model test-cli-model'));

    // 2. List models
    const listRes = runCli(['models']);
    assert.strictEqual(listRes.code, 0);
    assert.ok(listRes.stdout.includes('test-cli-model'));
    assert.ok(listRes.stdout.includes('locked: false · freeUse: true'));

    // 3. Remove model
    const rmRes = runCli(['model', 'rm', 'test-cli-model']);
    assert.strictEqual(rmRes.code, 0);
    assert.ok(rmRes.stdout.includes('Removed model test-cli-model'));

    const listRes2 = runCli(['models']);
    assert.ok(!listRes2.stdout.includes('test-cli-model'));
  });

  check('accio evidence displays China vs Global classification points', () => {
    const res = runCli(['evidence']);
    assert.strictEqual(res.code, 0);
    assert.ok(res.stdout.includes('Classification :'));
    assert.ok(res.stdout.includes('Total Scores   :'));
    assert.ok(res.stdout.includes('domain-config.json'));
  });

  check('accio daemon start, status, and stop manages background service', () => {
    // Safety: never stop a gateway the user already had running.
    const before = runCli(['daemon', 'status']);
    if (before.stdout.includes('running')) {
      console.log('    (skipped stop: a gateway was already running before the test)');
      assert.strictEqual(before.code, 0);
      return;
    }

    // Start daemon
    const startRes = runCli(['daemon', 'start']);
    assert.strictEqual(startRes.code, 0);
    assert.ok(startRes.stdout.includes('Bridge daemon started'), startRes.stdout + startRes.stderr);

    // Status daemon
    const statusRes = runCli(['daemon', 'status']);
    assert.strictEqual(statusRes.code, 0);
    assert.ok(statusRes.stdout.includes('running'));

    // Stop daemon (only the instance this test started)
    const stopRes = runCli(['daemon', 'stop']);
    assert.strictEqual(stopRes.code, 0);
    assert.ok(stopRes.stdout.includes('Stopped bridge daemon') || stopRes.stdout.includes('not running'));

    // Status after stop
    const statusAfter = runCli(['daemon', 'status']);
    assert.strictEqual(statusAfter.code, 0);
    assert.ok(statusAfter.stdout.includes('stopped'));
  });

  console.log('\n============================================================');
  console.log(`RESULTS: ${passed}/${total} CLI tests passed`);
  console.log('============================================================\n');
}

runCliSuite().catch((err) => {
  console.error('Fatal CLI suite error:', err);
  process.exit(1);
});
