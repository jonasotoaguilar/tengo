/**
 * Native query fixture SCREEN tests (P3b3 viewport fix, Jest/RNTL only).
 *
 * Structural/interaction regressions for the compact-header + details-modal
 * layout: details closed by default so the real list keeps the viewport,
 * open shows the actual checks, close restores the list, the container
 * composes with the remaining flex space, and essential variant/fault
 * controls survive. The container is mocked for composition only — explicit
 * NOT native proof; the real runtime uses `InventoryContainer`.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

import NativeQueryFixtureScreen from '../src/dev/NativeQueryFixtureScreen';
import {
  QUERY_FIXTURE_EMPTY_DB,
  QUERY_FIXTURE_SEEDED_DB,
} from '../src/dev/nativeQueryFixture';

jest.mock('../src/screens/InventoryContainer', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: () => <View testID="mock-inventory-container" />,
  };
});

jest.mock('../src/dev/nativeQueryFixture', () => {
  const actual = jest.requireActual('../src/dev/nativeQueryFixture');
  return {
    ...actual,
    runNativeQueryFixture: jest.fn(),
    armQueryReadFault: jest.fn(),
  };
});

const { runNativeQueryFixture, armQueryReadFault } = jest.requireMock(
  '../src/dev/nativeQueryFixture',
) as { runNativeQueryFixture: jest.Mock; armQueryReadFault: jest.Mock };

function fakeResult() {
  const checks = [
    'schema v2',
    'seed',
    'unicode',
    'no-fold',
    'literal',
    'andor',
    'dedup',
    'zero',
    'timing',
  ].map((name) => ({ name, pass: true, detail: `${name} ok` }));
  return {
    database: QUERY_FIXTURE_SEEDED_DB,
    status: 'pass' as const,
    checks,
    db: {
      getAllAsync: jest.fn(async () => []),
      closeAsync: jest.fn(async () => {}),
    },
  };
}

beforeEach(() => {
  runNativeQueryFixture.mockReset();
  armQueryReadFault.mockClear();
  runNativeQueryFixture.mockResolvedValue(fakeResult());
});

test('details are closed by default: summary visible, checks hidden', async () => {
  await render(<NativeQueryFixtureScreen />);
  expect(await screen.findByTestId('query-fixture-summary')).toHaveTextContent(
    '9/9 checks passed',
  );
  expect(screen.getByTestId('query-fixture-status')).toBeTruthy();
  expect(screen.queryByTestId('query-check-0')).toBeNull();
});

test('opening details shows actual checks; closing restores the list view', async () => {
  await render(<NativeQueryFixtureScreen />);
  await screen.findByTestId('query-fixture-summary');
  await fireEvent.press(screen.getByTestId('query-fixture-details-open'));
  expect(await screen.findByTestId('query-check-0')).toHaveTextContent(
    /schema v2/,
  );
  await fireEvent.press(screen.getByTestId('query-fixture-details-close'));
  expect(screen.queryByTestId('query-check-0')).toBeNull();
  expect(screen.getByTestId('query-fixture-summary')).toBeTruthy();
  expect(screen.getByTestId('mock-inventory-container')).toBeTruthy();
});

test('real container composes in the remaining flex viewport', async () => {
  await render(<NativeQueryFixtureScreen />);
  await screen.findByTestId('query-fixture-summary');
  expect(screen.getByTestId('mock-inventory-container')).toBeTruthy();
  const viewport = screen.getByTestId('query-fixture-list-viewport');
  expect(viewport.props.style).toMatchObject({ flex: 1 });
});

test('essential variant and fault controls are preserved', async () => {
  await render(<NativeQueryFixtureScreen />);
  await screen.findByTestId('query-fixture-summary');
  expect(screen.getByTestId('query-fixture-variant-seeded')).toBeTruthy();
  expect(screen.getByTestId('query-fixture-variant-empty')).toBeTruthy();
  expect(screen.getByTestId('query-fixture-fail-next')).toBeTruthy();
  expect(screen.getByTestId('query-fixture-reset')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('query-fixture-fail-next'));
  expect(armQueryReadFault).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByTestId('query-fixture-variant-empty'));
  expect(runNativeQueryFixture).toHaveBeenLastCalledWith(
    QUERY_FIXTURE_EMPTY_DB,
  );
});
