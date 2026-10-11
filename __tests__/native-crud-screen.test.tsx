/**
 * Native CRUD fixture SCREEN tests (M4, Jest/RNTL only).
 *
 * Structural/interaction regressions for the isolated mutation harness:
 * the real `InventoryContainer` composes with `enableMutations` plus an
 * injected bootstrap resolving the isolated fixture handle (never the
 * production bootstrap), the stable Maestro testIDs exist, the reset
 * control deletes only the fixture file and reopens, and the handle
 * closes on unmount. The container is mocked for composition only —
 * explicit NOT native proof; the real runtime uses `InventoryContainer`.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import type { ReactElement } from 'react';

interface RawTestNode {
  props: { testID?: string; onPress?: () => void };
}

interface RawRenderer {
  root: { findAll(predicate: (node: RawTestNode) => boolean): RawTestNode[] };
  unmount(): void;
}

import NativeCrudFixtureScreen from '../src/dev/NativeCrudFixtureScreen';
import { CRUD_FIXTURE_DB } from '../src/dev/nativeCrudFixture';

jest.mock('../src/screens/InventoryContainer', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: jest.fn(() => <View testID="mock-inventory-container" />),
  };
});

jest.mock('../src/db', () => ({
  initializeDatabase: jest.fn(),
}));

jest.mock('../src/dev/nativeCrudFixture', () => {
  const actual = jest.requireActual('../src/dev/nativeCrudFixture');
  return {
    ...actual,
    openNativeCrudFixture: jest.fn(),
    resetNativeCrudFixture: jest.fn(),
    runCrudMeasurePass: jest.fn(),
  };
});

import { initializeDatabase } from '../src/db';
import InventoryContainer from '../src/screens/InventoryContainer';

const { openNativeCrudFixture, resetNativeCrudFixture, runCrudMeasurePass } =
  jest.requireMock('../src/dev/nativeCrudFixture') as {
    openNativeCrudFixture: jest.Mock;
    resetNativeCrudFixture: jest.Mock;
    runCrudMeasurePass: jest.Mock;
  };

const MockedInventoryContainer = InventoryContainer as unknown as jest.Mock;

function fakeHandle() {
  return {
    runAsync: jest.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
    getFirstAsync: jest.fn(async () => null),
    getAllAsync: jest.fn(async () => []),
    execAsync: jest.fn(async () => {}),
    closeAsync: jest.fn(async () => {}),
  };
}

beforeEach(() => {
  MockedInventoryContainer.mockClear();
  openNativeCrudFixture.mockReset();
  resetNativeCrudFixture.mockReset();
  runCrudMeasurePass.mockReset();
  (initializeDatabase as jest.Mock).mockClear();
  const db = fakeHandle();
  openNativeCrudFixture.mockResolvedValue({ database: CRUD_FIXTURE_DB, db });
  resetNativeCrudFixture.mockResolvedValue(undefined);
  runCrudMeasurePass.mockResolvedValue({
    database: CRUD_FIXTURE_DB,
    status: 'pass',
    checks: [],
  });
});

function lastContainerProps(): {
  bootstrap: () => Promise<unknown>;
  enableMutations: boolean;
} {
  const calls = MockedInventoryContainer.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as {
    bootstrap: () => Promise<unknown>;
    enableMutations: boolean;
  };
}

test('embeds InventoryContainer with enableMutations and an injected bootstrap', async () => {
  await render(<NativeCrudFixtureScreen />);
  expect(await screen.findByTestId('mock-inventory-container')).toBeTruthy();
  const props = lastContainerProps();
  expect(props.enableMutations).toBe(true);
  expect(typeof props.bootstrap).toBe('function');
  const resolved = (await props.bootstrap()) as { closeAsync: jest.Mock };
  expect(resolved.closeAsync).toBeDefined();
  expect(openNativeCrudFixture).toHaveBeenCalledTimes(1);
});

test('never calls the production bootstrap and never opens tengo.db', async () => {
  await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  expect(initializeDatabase as jest.Mock).not.toHaveBeenCalled();
  const SQLite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
  expect(SQLite.openDatabaseAsync).not.toHaveBeenCalledWith('tengo.db');
  expect(openNativeCrudFixture).toHaveBeenCalledWith();
});

test('exposes the stable Maestro testIDs', async () => {
  await render(<NativeCrudFixtureScreen />);
  expect(screen.getByTestId('crud-fixture-screen')).toBeTruthy();
  expect(screen.getByTestId('crud-fixture-reset')).toBeTruthy();
  expect(screen.getByTestId('crud-fixture-list-viewport')).toBeTruthy();
  expect(screen.getByTestId('crud-fixture-status')).toBeTruthy();
  expect(await screen.findByTestId('mock-inventory-container')).toBeTruthy();
});

test('reset deletes the fixture file and reopens the isolated handle', async () => {
  await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  await fireEvent.press(screen.getByTestId('crud-fixture-reset'));
  expect(resetNativeCrudFixture).toHaveBeenCalledTimes(1);
  expect(resetNativeCrudFixture).toHaveBeenCalledWith();
  expect(await screen.findByTestId('mock-inventory-container')).toBeTruthy();
  expect(openNativeCrudFixture.mock.calls.length).toBeGreaterThanOrEqual(2);
});

function deferredOpen(): {
  promise: Promise<{ database: string; db: unknown }>;
  resolve: (value: { database: string; db: unknown }) => void;
} {
  let resolve!: (value: { database: string; db: unknown }) => void;
  const promise = new Promise<{ database: string; db: unknown }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('reset is disabled until the fixture reaches a terminal state', async () => {
  const gate = deferredOpen();
  openNativeCrudFixture.mockImplementation(() => gate.promise);
  await render(<NativeCrudFixtureScreen />);
  expect(screen.getByTestId('crud-fixture-reset')).toBeDisabled();
  gate.resolve({ database: CRUD_FIXTURE_DB, db: fakeHandle() });
  expect(await screen.findByTestId('mock-inventory-container')).toBeTruthy();
  expect(screen.getByTestId('crud-fixture-reset')).not.toBeDisabled();
});

test('reset during pending open waits for the open, then closes before deleting', async () => {
  const gate = deferredOpen();
  openNativeCrudFixture.mockImplementation(() => gate.promise);
  const db = fakeHandle();
  // Raw renderer (not RNTL): composites stay reachable, so the reset
  // handler can be invoked while the control is disabled — the exact race
  // `fireEvent` cannot express, since it honors `disabled`. Matched by
  // testID + handler (not by component reference: the tree holds a second
  // react-native copy whose Pressable identity differs).
  const TestRenderer = require('react-test-renderer') as {
    create(element: ReactElement): RawRenderer;
    act(fn: () => Promise<void>): Promise<void>;
  };
  let renderer: RawRenderer | undefined;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(<NativeCrudFixtureScreen />);
  });
  if (!renderer) throw new Error('renderer not created');
  const [resetPressable] = renderer.root.findAll(
    (node) =>
      node.props.testID === 'crud-fixture-reset' &&
      typeof node.props.onPress === 'function',
  );
  if (!resetPressable?.props.onPress)
    throw new Error('reset Pressable not found');
  await TestRenderer.act(async () => {
    resetPressable.props.onPress?.();
  });
  // Open still pending: the deleter must not have been touched and the
  // (not yet existing) handle was never closed.
  expect(resetNativeCrudFixture).not.toHaveBeenCalled();
  expect(db.closeAsync).not.toHaveBeenCalled();
  await TestRenderer.act(async () => {
    gate.resolve({ database: CRUD_FIXTURE_DB, db });
  });
  // The reset chain (close, then delete, then reopen) settles inside the
  // act scope above: the delete provably runs only after the close.
  expect(db.closeAsync).toHaveBeenCalledTimes(1);
  expect(resetNativeCrudFixture).toHaveBeenCalledTimes(1);
  expect(db.closeAsync.mock.invocationCallOrder[0]).toBeLessThan(
    resetNativeCrudFixture.mock.invocationCallOrder[0],
  );
  await TestRenderer.act(async () => {
    renderer?.unmount();
  });
});

test('successful reset closes the previous handle exactly once', async () => {
  openNativeCrudFixture.mockImplementation(async () => ({
    database: CRUD_FIXTURE_DB,
    db: fakeHandle(),
  }));
  const rendered = await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  const first = (await lastContainerProps().bootstrap()) as {
    closeAsync: jest.Mock;
  };
  await fireEvent.press(screen.getByTestId('crud-fixture-reset'));
  await waitFor(() => expect(openNativeCrudFixture.mock.calls.length).toBe(2));
  expect(first.closeAsync).toHaveBeenCalledTimes(1);
  expect(resetNativeCrudFixture).toHaveBeenCalledTimes(1);
  const second = (await lastContainerProps().bootstrap()) as {
    closeAsync: jest.Mock;
  };
  expect(second).not.toBe(first);
  await rendered.unmount();
  // The reset close is not repeated by the effect cleanup, and the fresh
  // generation handle closes once on unmount.
  expect(first.closeAsync).toHaveBeenCalledTimes(1);
  expect(second.closeAsync).toHaveBeenCalledTimes(1);
});

test('a failing close prevents the delete and surfaces an error', async () => {
  await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  const handle = (await lastContainerProps().bootstrap()) as {
    closeAsync: jest.Mock;
  };
  handle.closeAsync.mockRejectedValueOnce(new Error('close boom'));
  await fireEvent.press(screen.getByTestId('crud-fixture-reset'));
  await act(async () => {});
  expect(resetNativeCrudFixture).not.toHaveBeenCalled();
  expect(await screen.findByTestId('crud-fixture-status')).toHaveTextContent(
    'error',
  );
});

test('a second reset after a failed close still does not delete', async () => {
  await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  const handle = (await lastContainerProps().bootstrap()) as {
    closeAsync: jest.Mock;
  };
  handle.closeAsync.mockRejectedValueOnce(new Error('close boom'));
  await fireEvent.press(screen.getByTestId('crud-fixture-reset'));
  await act(async () => {});
  expect(resetNativeCrudFixture).not.toHaveBeenCalled();
  expect(handle.closeAsync).toHaveBeenCalledTimes(1);
  expect(await screen.findByTestId('crud-fixture-status')).toHaveTextContent(
    'error',
  );
  // The control re-enables on error, but the close is never retried and
  // the delete is never attempted: the connection may still be open.
  expect(screen.getByTestId('crud-fixture-reset')).not.toBeDisabled();
  await fireEvent.press(screen.getByTestId('crud-fixture-reset'));
  await act(async () => {});
  expect(resetNativeCrudFixture).not.toHaveBeenCalled();
  expect(handle.closeAsync).toHaveBeenCalledTimes(1);
  expect(await screen.findByTestId('crud-fixture-status')).toHaveTextContent(
    'error',
  );
});

test('closes the isolated handle on unmount', async () => {
  const rendered = await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  const props = lastContainerProps();
  const handle = (await props.bootstrap()) as { closeAsync: jest.Mock };
  await rendered.unmount();
  expect(handle.closeAsync).toHaveBeenCalled();
});

/**
 * P5b measurement control (mocked, not native proof).
 *
 * The control runs the fixture measurement pass on demand against the
 * isolated handle: never automatically on mount, disabled until the
 * fixture is ready, and the reported numbers plus PASS/FAIL text stay
 * readable on screen. Real milliseconds are observed only on device.
 */
function mockMeasureResult() {
  return {
    database: CRUD_FIXTURE_DB,
    status: 'pass',
    checks: [
      {
        name: 'seed 500 items (diagnostic setup, no budget)',
        pass: true,
        detail: '410.2ms setup: 500 items, no budget asserted',
      },
      {
        name: 'first-viewport data readiness (budget 1000ms)',
        pass: true,
        detail: '120.5ms vs budget 1000ms: PASS',
      },
      {
        name: 'search per keystroke, data layer only (budget 200ms)',
        pass: true,
        detail: '45.0ms vs budget 200ms: PASS',
      },
      {
        name: 'single-row write (budget 100ms)',
        pass: true,
        detail: '20.1ms vs budget 100ms: PASS',
      },
    ],
  };
}

test('measurement control is disabled until the fixture is ready and never runs on mount', async () => {
  const gate = deferredOpen();
  openNativeCrudFixture.mockImplementation(() => gate.promise);
  await render(<NativeCrudFixtureScreen />);
  expect(screen.getByTestId('crud-fixture-measure')).toBeDisabled();
  expect(runCrudMeasurePass).not.toHaveBeenCalled();
  gate.resolve({ database: CRUD_FIXTURE_DB, db: fakeHandle() });
  expect(await screen.findByTestId('mock-inventory-container')).toBeTruthy();
  expect(screen.getByTestId('crud-fixture-measure')).not.toBeDisabled();
  // Ready but untouched: the pass runs only on demand, never on mount.
  expect(runCrudMeasurePass).not.toHaveBeenCalled();
});

test('measurement control runs the pass and surfaces numbers with PASS/FAIL text', async () => {
  runCrudMeasurePass.mockResolvedValue(mockMeasureResult());
  await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  await fireEvent.press(screen.getByTestId('crud-fixture-measure'));
  expect(runCrudMeasurePass).toHaveBeenCalledTimes(1);
  expect(runCrudMeasurePass).toHaveBeenCalledWith(
    expect.objectContaining({ closeAsync: expect.anything() }),
    CRUD_FIXTURE_DB,
  );
  const results = await screen.findByTestId('crud-fixture-measure-results');
  expect(results).toHaveTextContent(/120\.5ms/);
  expect(results).toHaveTextContent(/PASS/);
  expect(
    await screen.findByTestId('crud-fixture-measure-check-1'),
  ).toHaveTextContent(/first-viewport data readiness/);
});

test('a missed budget surfaces FAIL text with its measured value', async () => {
  const failed = mockMeasureResult();
  failed.status = 'fail';
  failed.checks[2] = {
    name: 'search per keystroke, data layer only (budget 200ms)',
    pass: false,
    detail: '350.0ms vs budget 200ms: FAIL',
  };
  runCrudMeasurePass.mockResolvedValue(failed);
  await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  await fireEvent.press(screen.getByTestId('crud-fixture-measure'));
  const results = await screen.findByTestId('crud-fixture-measure-results');
  expect(results).toHaveTextContent(/FAIL/);
  expect(results).toHaveTextContent(/350\.0ms/);
});

test('first list layout reports a wall-time diagnostic after the viewport lays out', async () => {
  await render(<NativeCrudFixtureScreen />);
  await screen.findByTestId('mock-inventory-container');
  expect(screen.getByTestId('crud-fixture-first-layout')).toHaveTextContent(
    /diagnostic/,
  );
  await fireEvent(screen.getByTestId('crud-fixture-list-viewport'), 'layout', {
    nativeEvent: { layout: { width: 360, height: 640 } },
  });
  expect(screen.getByTestId('crud-fixture-first-layout')).toHaveTextContent(
    /\d+(\.\d+)?ms/,
  );
});
