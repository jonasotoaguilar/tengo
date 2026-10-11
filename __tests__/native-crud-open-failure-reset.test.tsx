/**
 * Open-failure reset integration (M4, Jest/RNTL only).
 *
 * Uses the REAL `nativeCrudFixture` module (never mocked here) with the
 * low-level pieces faked: `openManagedDatabase` opens tagged handles
 * whose `closeAsync` always rejects, `initializeDatabase` always rejects,
 * and `deleteDatabaseAsync` only records. This reproduces the verifier's
 * delete-with-open-connection sequence: init throws, the cleanup close
 * rejects, status goes `error`, and a Reset press must never delete while
 * the failed connection is still tracked. Nothing here touches a real
 * database and nothing here is native proof.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

import NativeCrudFixtureScreen from '../src/dev/NativeCrudFixtureScreen';

jest.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: jest.fn(async () => {}),
}));

jest.mock('../src/db/exclusive', () => ({
  openManagedDatabase: jest.fn(),
}));

jest.mock('../src/db', () => ({
  DATABASE_NAME: 'tengo.db',
  initializeDatabase: jest.fn(),
}));

jest.mock('../src/screens/InventoryContainer', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: jest.fn(() => <View testID="mock-inventory-container" />),
  };
});

const { deleteDatabaseAsync } = require('expo-sqlite') as {
  deleteDatabaseAsync: jest.Mock;
};
const { openManagedDatabase } = jest.requireMock('../src/db/exclusive') as {
  openManagedDatabase: jest.Mock;
};
const { initializeDatabase } = jest.requireMock('../src/db') as {
  initializeDatabase: jest.Mock;
};

const log: string[] = [];

function failingHandle(tag: string) {
  return {
    runAsync: jest.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
    getFirstAsync: jest.fn(async () => null),
    getAllAsync: jest.fn(async () => []),
    execAsync: jest.fn(async () => {}),
    closeAsync: jest.fn(async () => {
      log.push(`close:${tag}:reject`);
      throw new Error(`close boom ${tag}`);
    }),
  };
}

beforeEach(() => {
  log.length = 0;
  jest.clearAllMocks();
  deleteDatabaseAsync.mockImplementation(async () => {
    log.push('delete');
  });
  initializeDatabase.mockRejectedValue(new Error('migrate boom'));
  openManagedDatabase.mockImplementation(async () =>
    failingHandle(`opened${openManagedDatabase.mock.calls.length}`),
  );
});

test('one reset after open failure with rejecting close never deletes', async () => {
  await render(<NativeCrudFixtureScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('crud-fixture-status')).toHaveTextContent(
      'error',
    ),
  );
  expect(log).toEqual(['close:opened1:reject']);
  await fireEvent.press(screen.getByTestId('crud-fixture-reset'));
  await waitFor(() =>
    expect(screen.getByTestId('crud-fixture-status')).toHaveTextContent(
      'error',
    ),
  );
  // No delete and no second open: the failed handle is still tracked, so
  // the module refuses the reset instead of deleting with it open.
  expect(deleteDatabaseAsync).not.toHaveBeenCalled();
  expect(openManagedDatabase).toHaveBeenCalledTimes(1);
  expect(log).toEqual(['close:opened1:reject']);
  // A second press refuses the same way: still no delete, still no close.
  await fireEvent.press(screen.getByTestId('crud-fixture-reset'));
  await waitFor(() =>
    expect(screen.getByTestId('crud-fixture-status')).toHaveTextContent(
      'error',
    ),
  );
  expect(deleteDatabaseAsync).not.toHaveBeenCalled();
  expect(openManagedDatabase).toHaveBeenCalledTimes(1);
  expect(log).toEqual(['close:opened1:reject']);
});
