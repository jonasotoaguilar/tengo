/**
 * Regression tests for `scripts/run-maestro.sh`.
 *
 * The wrapper is the only place that decides where Maestro writes its run
 * artifacts (inside the gitignored `.maestro/runs/`, not `$HOME`), so these
 * tests drive it with a FAKE `maestro` and a FAKE `adb` on PATH: no device,
 * no emulator, no real flow ever runs here.
 *
 * Covered: the two fail-closed paths (no arguments, missing flow), refusal of
 * the flags the wrapper pins, exit-code propagation from Maestro, the exact
 * `--test-output-dir`/`--format`/`--output` it passes, a flow path containing
 * spaces, and the opt-in `adb reverse` add plus its removal on exit.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(REPO_ROOT, 'scripts', 'run-maestro.sh');

/** Fake binaries that record their arguments instead of touching a device. */
function makeFakeBin(dir, { maestroExit = 0, junit = true } = {}) {
  const log = path.join(dir, 'invocations.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });

  fs.writeFileSync(
    path.join(bin, 'maestro'),
    `#!/usr/bin/env bash\n` +
      `printf 'maestro %s\\n' "$*" >> ${JSON.stringify(log)}\n` +
      // Mirror Maestro's own contract: write the report at --output.
      (junit
        ? `out=""; while [ "$#" -gt 0 ]; do case "$1" in --output) shift; out="$1";; esac; shift; done\n` +
          `[ -n "$out" ] && printf '<testsuite tests="7" failures="0" errors="0"/>\\n' > "$out"\n`
        : '') +
      `exit ${maestroExit}\n`,
    { mode: 0o755 },
  );

  fs.writeFileSync(
    path.join(bin, 'adb'),
    `#!/usr/bin/env bash\n` +
      `printf 'adb %s\\n' "$*" >> ${JSON.stringify(log)}\n` +
      `case "$*" in *'--list'*) printf 'host-11 tcp:8082 tcp:8082\\n';; esac\n` +
      `exit 0\n`,
    { mode: 0o755 },
  );

  return { bin, log };
}

function run(args, { env = {}, cwd = REPO_ROOT } = {}) {
  return spawnSync('bash', [WRAPPER, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

let scratch;
let fake;
let runDir;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tengo-wrapper-'));
  fake = makeFakeBin(scratch);
  runDir = path.join(scratch, 'runs');
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function invocations() {
  return fs.existsSync(fake.log)
    ? fs.readFileSync(fake.log, 'utf8').trim().split('\n')
    : [];
}

function env(extra = {}) {
  return {
    MAESTRO_RUN_DIR: runDir,
    PATH: `${fake.bin}:${process.env.PATH}`,
    ...extra,
  };
}

test('no arguments fails closed without invoking maestro', () => {
  const result = run([], { env: env() });
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/usage: scripts\/run-maestro\.sh/);
  expect(invocations()).toEqual([]);
  expect(fs.existsSync(runDir)).toBe(false);
});

test('a missing flow fails closed without invoking maestro', () => {
  const result = run(['.maestro/does-not-exist.yaml'], { env: env() });
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/flow not found/);
  expect(invocations()).toEqual([]);
});

test.each([
  '--test-output-dir',
  '--test-output-dir=/tmp/elsewhere',
  '--format',
  '--output',
  '--udid=other-device',
])('refuses the pinned flag %s instead of splitting the artifacts', (flag) => {
  const flow = path.join(scratch, 'flow.yaml');
  fs.writeFileSync(flow, '- assertVisible: x\n');
  const result = run([flow, flag, 'value'], { env: env() });
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/pins that flag/);
  expect(invocations()).toEqual([]);
});

test('passes the pinned output flags and reports the artifact directory', () => {
  const flow = path.join(scratch, 'flow.yaml');
  fs.writeFileSync(flow, '- assertVisible: x\n');
  const result = run([flow], { env: env() });

  expect(result.status).toBe(0);
  const maestro = invocations().find((line) => line.startsWith('maestro '));
  expect(maestro).toContain(`--test-output-dir ${runDir}/`);
  expect(maestro).toContain('--format JUNIT');
  expect(maestro).toContain('--output ');
  expect(maestro).toContain('--udid emulator-5554');
  expect(maestro).toContain(flow);
  // The run directory is named after the flow, with no trailing separator
  // from the name derivation.
  const outDir = maestro.match(/--test-output-dir (\S+)/)?.[1];
  expect(outDir).toMatch(/_flow$/);
  // The JUnit summary the wrapper greps must come from the report Maestro wrote.
  expect(result.stdout).toMatch(/tests="7" failures="0" errors="0"/);
  expect(result.stdout).toMatch(/artifacts: {4}/);
});

test('propagates a failing maestro exit code', () => {
  const failing = makeFakeBin(path.join(scratch, 'failing'), {
    maestroExit: 1,
  });
  const flow = path.join(scratch, 'flow.yaml');
  fs.writeFileSync(flow, '- assertVisible: x\n');
  const result = run([flow], {
    env: {
      MAESTRO_RUN_DIR: runDir,
      PATH: `${failing.bin}:${process.env.PATH}`,
    },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/maestro exit: 1/);
});

test('a flow path containing spaces reaches maestro intact', () => {
  const dir = path.join(scratch, 'with space');
  fs.mkdirSync(dir, { recursive: true });
  const flow = path.join(dir, 'my flow.yaml');
  fs.writeFileSync(flow, '- assertVisible: x\n');
  const result = run([flow], { env: env() });

  expect(result.status).toBe(0);
  const maestro = invocations().find((line) => line.startsWith('maestro '));
  expect(maestro).toContain('with space/my flow.yaml');
  // The artifact directory is sanitized, so downstream shell use never has to
  // quote a path that came from a file name.
  const outDir = maestro.match(/--test-output-dir (\S+)/)?.[1];
  expect(outDir).toContain('my-flow');
  expect(outDir).not.toContain(' ');
  expect(outDir).not.toMatch(/-$/);
});

test.each([
  ['m4-forms.yaml', 'm4-forms'],
  ['my flow.yaml', 'my-flow'],
  ['my  flow.yaml', 'my-flow'],
  ['a.b.c.yaml', 'a.b.c'],
  ['flow .yaml', 'flow'],
  ['@@.yaml', 'flow'],
])('sanitizes the run directory name for %s', (name, expected) => {
  const dir = path.join(scratch, 'names');
  fs.mkdirSync(dir, { recursive: true });
  const flow = path.join(dir, name);
  fs.writeFileSync(flow, '- assertVisible: x\n');
  const result = run([flow], { env: env() });

  expect(result.status).toBe(0);
  const maestro = invocations().find((line) => line.startsWith('maestro '));
  const runName = path.basename(maestro.match(/--test-output-dir (\S+)/)[1]);
  expect(runName).toMatch(new RegExp(`_${expected.replace(/\./g, '\\.')}$`));
  expect(runName).not.toMatch(/--/);
});

test('the adb reverse workaround is opt-in and removed on exit', () => {
  const flow = path.join(scratch, 'flow.yaml');
  fs.writeFileSync(flow, '- assertVisible: x\n');

  const withoutFlag = run([flow], { env: env() });
  expect(withoutFlag.status).toBe(0);
  expect(invocations().filter((line) => line.startsWith('adb '))).toEqual([]);

  fs.rmSync(fake.log, { force: true });
  const withFlag = run([flow], { env: env({ MAESTRO_REVERSE: '1' }) });
  expect(withFlag.status).toBe(0);
  const adb = invocations().filter((line) => line.startsWith('adb '));
  expect(adb).toContain('adb reverse tcp:8082 tcp:8083');
  expect(adb).toContain('adb reverse --remove tcp:8082');
  // A pre-existing rule is not silently replaced: the caller is told how to
  // put it back.
  expect(withFlag.stderr).toMatch(/adb reverse tcp:8082 tcp:8082/);
});

test('outside a git repository it refuses to guess the artifact root', () => {
  const flow = path.join(scratch, 'flow.yaml');
  fs.writeFileSync(flow, '- assertVisible: x\n');
  const notARepo = path.join(scratch, 'not-a-repo');
  fs.mkdirSync(notARepo);
  const result = run([flow], {
    cwd: notARepo,
    env: {
      PATH: `${fake.bin}:${process.env.PATH}`,
      MAESTRO_RUN_DIR: '',
    },
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/set MAESTRO_RUN_DIR/);
  expect(invocations()).toEqual([]);
});
