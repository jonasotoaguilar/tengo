#!/usr/bin/env node
/**
 * Static guard for the Maestro flows under `.maestro/`.
 *
 * A device run costs a full emulator cycle, and each of the defects this
 * script prevents was previously caught only after a run had been spent:
 *
 * - a step whose command name is not registered by the pinned Maestro CLI
 *   (`clearText` was used where Maestro 2.11.0 only registers `eraseText`,
 *   and the CLI rejects the whole flow before touching a device);
 * - a text input left followed by a tap while the soft keyboard is still up,
 *   which hides the target so the tap fails with "element not found";
 * - a wait or assertion on a transient state the app enters and leaves
 *   inside the tap-settle window, which is then never observable.
 *
 * This is a static check over the YAML plus a pinned command registry. It is
 * not a substitute for running a flow on a device, and it deliberately does
 * not verify selectors against component source.
 *
 * Usage: `node scripts/verify-maestro-flows.mjs [--flows <dir>]` (default:
 * the repo's `.maestro` directory, so `npm run verify:flows` needs no
 * arguments).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAllDocuments } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultFlowsDir = join(repoRoot, '.maestro');

function parseFlowsDir(argv) {
  const flag = argv.indexOf('--flows');
  if (flag === -1) return defaultFlowsDir;
  const value = argv[flag + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--flows requires a directory argument');
  }
  return value;
}

let flowsDir;
try {
  flowsDir = parseFlowsDir(process.argv.slice(2));
} catch (error) {
  console.error('Maestro flow validation failed:');
  console.error(`  - ${error.message}`);
  process.exit(1);
}

/**
 * Command names registered by Maestro 2.11.0, the CLI these flows are pinned
 * to. A bare list item is a command with no arguments, so both the map form
 * and the bare-string form are checked against this set.
 */
const REGISTERED_COMMANDS = new Set([
  'addMedia',
  'assertDarkMode',
  'assertLightMode',
  'assertNoDefectsWithAI',
  'assertNotVisible',
  'assertScreenshot',
  'assertTrue',
  'assertVisible',
  'assertWithAI',
  'back',
  'clearKeychain',
  'clearState',
  'copyTextFrom',
  'defineVariables',
  'doubleTapOn',
  'eraseText',
  'evalScript',
  'extendedWaitUntil',
  'hideKeyboard',
  'inputText',
  'killApp',
  'launchApp',
  'longPressOn',
  'openLink',
  'pasteText',
  'pressKey',
  'repeat',
  'retry',
  'runFlow',
  'runScript',
  'scroll',
  'scrollUntilVisible',
  'setAirplaneMode',
  'setClipboard',
  'setDarkMode',
  'setLocation',
  'setOrientation',
  'setPermissions',
  'startRecording',
  'stopApp',
  'stopRecording',
  'swipe',
  'takeScreenshot',
  'tapOn',
  'toggleAirplaneMode',
  'toggleDarkMode',
  'travel',
  'waitForAnimationToEnd',
]);

/**
 * Pointer commands that need a visible target: after an `inputText` the soft
 * keyboard is still up, so any of these fails as if the element did not
 * exist until a `hideKeyboard` closes it. `tapOn` alone used to be checked;
 * `doubleTapOn` and `longPressOn` take the same element targets.
 */
const POINTER_TARGET_COMMANDS = new Set([
  'doubleTapOn',
  'longPressOn',
  'tapOn',
]);

/** States that live inside a tap-settle window and cannot be observed. */
const UNOBSERVABLE_WAIT_TEXTS = new Set(['running']);

const problems = [];

function commandNames(step) {
  if (typeof step === 'string') return [step];
  if (step === null || typeof step !== 'object') return [];
  return Object.keys(step).filter((key) => !/^\d+$/.test(key));
}

function readFlow(name) {
  const documents = parseAllDocuments(
    readFileSync(join(flowsDir, name), 'utf8'),
  );
  const parseErrors = documents.flatMap((document) => document.errors);
  if (parseErrors.length > 0) {
    const details = parseErrors.map((error) => {
      const start = error.linePos?.[0];
      const where =
        start === undefined
          ? 'unknown location'
          : `line ${start.line}, column ${start.col}`;
      return `invalid YAML at ${where} (${error.code})`;
    });
    throw new Error(details.join('; '));
  }
  const header = documents[0]?.toJS();
  const body = documents[1]?.toJS();
  if (!header || typeof header.appId !== 'string' || header.appId === '') {
    throw new Error(`${name}: missing a string appId in the header document`);
  }
  if (!body || typeof body !== 'object') {
    throw new Error(`${name}: missing the steps document`);
  }
  const steps = Object.keys(body)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => body[key]);
  if (steps.length === 0) throw new Error(`${name}: no steps found`);
  return { name, appId: header.appId, steps };
}

const flowNames = readdirSync(flowsDir)
  .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
  .sort();

if (flowNames.length === 0) {
  problems.push('.maestro/: no flow files found');
}

for (const name of flowNames) {
  let flow;
  try {
    flow = readFlow(name);
  } catch (error) {
    problems.push(`${name}: ${error.message}`);
    continue;
  }

  flow.steps.forEach((step, index) => {
    const line = index + 1;

    for (const command of commandNames(step)) {
      if (command === 'clearText') {
        problems.push(
          `${name}:${line}: clearText is not a Maestro 2.11.0 command; use eraseText`,
        );
      } else if (!REGISTERED_COMMANDS.has(command)) {
        problems.push(
          `${name}:${line}: unregistered Maestro command "${command}"`,
        );
      }
    }

    const wait = step?.extendedWaitUntil?.visible?.text;
    if (typeof wait === 'string' && UNOBSERVABLE_WAIT_TEXTS.has(wait)) {
      problems.push(
        `${name}:${line}: waits for the transient "${wait}" state, which a tap-settle window hides`,
      );
    }

    if (
      commandNames(step).includes('assertVisible') &&
      typeof step?.assertVisible?.text === 'string' &&
      UNOBSERVABLE_WAIT_TEXTS.has(step.assertVisible.text)
    ) {
      problems.push(
        `${name}:${line}: asserts the transient "${step.assertVisible.text}" state, which a tap-settle window hides`,
      );
    }
  });

  // Every text input must close the keyboard before the next pointer
  // command, otherwise the keyboard can cover the tap target and the flow
  // fails as if the element did not exist.
  flow.steps.forEach((step, index) => {
    if (!commandNames(step).includes('inputText')) return;
    for (let next = index + 1; next < flow.steps.length; next += 1) {
      const commands = commandNames(flow.steps[next]);
      if (commands.includes('hideKeyboard')) return;
      const pointer = commands.find((command) =>
        POINTER_TARGET_COMMANDS.has(command),
      );
      if (pointer !== undefined) {
        problems.push(
          `${name}:${index + 1}: inputText is followed by ${pointer} before hideKeyboard`,
        );
        return;
      }
    }
  });
}

if (problems.length > 0) {
  console.error('Maestro flow validation failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Maestro flow validation passed (${flowNames.length} flows: ${flowNames.join(', ')})`,
);
