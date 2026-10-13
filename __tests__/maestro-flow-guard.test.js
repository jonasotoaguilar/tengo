/**
 * Regression tests for `scripts/verify-maestro-flows.mjs`.
 *
 * Each test spawns the REAL guard with `node` against a tiny temporary flow
 * tree (passed via `--flows <dir>`), so the guard stays testable without
 * copying it or fighting module resolution. Temp trees live under
 * `os.tmpdir()` and are removed after every test.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'verify-maestro-flows.mjs');

const HEADER = 'appId: com.tengo.app\n---\n';

let flowsDir;

beforeEach(() => {
  flowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tengo-flows-'));
});

afterEach(() => {
  fs.rmSync(flowsDir, { recursive: true, force: true });
});

function writeFlow(name, body) {
  fs.writeFileSync(path.join(flowsDir, name), HEADER + body);
}

function runGuard(dir) {
  return spawnSync(process.execPath, [GUARD, '--flows', dir], {
    encoding: 'utf8',
  });
}

function runTempFlows() {
  return runGuard(flowsDir);
}

test('unregistered command name fails and names the file and step', () => {
  writeFlow(
    'bad-command.yaml',
    "- launchApp\n- frobnicate:\n    id: 'whatever'\n",
  );
  const result = runTempFlows();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('bad-command.yaml:2');
  expect(result.stderr).toContain('unregistered Maestro command "frobnicate"');
});

test('retired clearText fails and points at eraseText', () => {
  writeFlow(
    'clear-text.yaml',
    "- launchApp\n- tapOn:\n    id: 'item-form/name'\n- clearText\n",
  );
  const result = runTempFlows();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('clearText');
  expect(result.stderr).toContain('use eraseText');
});

test('inputText followed by tapOn without hideKeyboard fails; with it passes', () => {
  writeFlow(
    'keyboard-tap.yaml',
    "- tapOn:\n    id: 'item-form/name'\n- inputText: 'Maestro Tomato'\n- tapOn:\n    id: 'item-form/save'\n",
  );
  const failing = runTempFlows();
  expect(failing.status).not.toBe(0);
  expect(failing.stderr).toContain('keyboard-tap.yaml:2');
  expect(failing.stderr).toContain('before hideKeyboard');

  writeFlow(
    'keyboard-tap.yaml',
    "- tapOn:\n    id: 'item-form/name'\n- inputText: 'Maestro Tomato'\n- hideKeyboard\n- tapOn:\n    id: 'item-form/save'\n",
  );
  expect(runTempFlows().status).toBe(0);
});

test('extendedWaitUntil on the transient running text fails', () => {
  writeFlow(
    'transient-wait.yaml',
    "- launchApp\n- extendedWaitUntil:\n    visible:\n      id: 'crud-fixture-status'\n      text: 'running'\n    timeout: 15000\n",
  );
  const result = runTempFlows();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('transient "running"');
});

test('assertVisible on the transient running text fails', () => {
  writeFlow(
    'transient-assert.yaml',
    "- launchApp\n- assertVisible:\n    id: 'crud-fixture-status'\n    text: 'running'\n",
  );
  const result = runTempFlows();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('transient "running"');
});

test('corrupted line inside the steps document fails and names the file', () => {
  writeFlow(
    'corrupt.yaml',
    "- launchApp\n- assertVisible:\n    id: 'crud-fixture-screen'\nbroken line without its hash\n- extendedWaitUntil:\n    visible:\n      id: 'inventory-add-empty'\n    timeout: 30000\n",
  );
  const result = runTempFlows();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('corrupt.yaml');
});

test('inputText followed by doubleTapOn without hideKeyboard fails', () => {
  writeFlow(
    'keyboard-double-tap.yaml',
    "- tapOn:\n    id: 'item-form/name'\n- inputText: 'Maestro Tomato'\n- doubleTapOn:\n    id: 'inventory-row-1'\n",
  );
  const result = runTempFlows();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('before hideKeyboard');
});

test('clean minimal flow passes', () => {
  writeFlow(
    'clean.yaml',
    "- launchApp\n- tapOn:\n    id: 'inventory-add-empty'\n- assertVisible:\n    id: 'item-form-screen'\n",
  );
  const result = runTempFlows();
  expect(result.status).toBe(0);
});

test('stale claims stay fixed: no running wait in m4 flow, smoke is not the only passing flow', () => {
  const m4 = fs.readFileSync(
    path.join(REPO_ROOT, '.maestro', 'm4-forms.yaml'),
    'utf8',
  );
  expect(m4).not.toMatch(/text:\s*['"]running['"]/);

  const roadmap = fs.readFileSync(path.join(REPO_ROOT, 'ROADMAP.md'), 'utf8');
  expect(roadmap).not.toMatch(/only passing Maestro flow/);
});
