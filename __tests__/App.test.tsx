/**
 * Renders against mocked native modules (see `jest.setup.ts`): the
 * `react-native-safe-area-context` mock below stands in for the native
 * insets provider, which renders no children under Jest. On a real device
 * the genuine provider supplies safe-area insets.
 *
 * The database boundary is faked at `../src/db`: `initializeDatabase`
 * resolves a fake whose `getAllAsync` answers every read with `[]`
 * (first-run empty), so these suites prove App wiring only — never native
 * SQLite behavior.
 */
import { act, cleanup, render, screen } from '@testing-library/react-native';
import type { ViewProps } from 'react-native';

import App from '../App';

jest.mock('../src/db', () => ({
  initializeDatabase: jest.fn(),
}));

const { initializeDatabase } = require('../src/db') as {
  initializeDatabase: jest.Mock;
};

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    SafeAreaView: ({ children, ...props }: ViewProps) => (
      <View {...props}>{children}</View>
    ),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

function emptyDb() {
  return {
    getAllAsync: jest.fn(async () => [] as Record<string, unknown>[]),
  };
}

async function renderApp() {
  return render(<App />);
}

beforeEach(() => {
  initializeDatabase.mockReset();
  initializeDatabase.mockResolvedValue(emptyDb());
});

afterEach(async () => {
  await cleanup();
});

describe('<App /> wired inventory screen', () => {
  test('renders the inventory list with stable Maestro testIDs', async () => {
    await renderApp();

    expect(screen.getByTestId('inventory-list')).toBeTruthy();
    expect(screen.getByTestId('inventory-search')).toBeTruthy();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();
    expect(screen.getByTestId('inventory-empty-title')).toBeTruthy();
  });

  test('reaches the ready list state against the faked database layer', async () => {
    await renderApp();
    expect(await screen.findByText('0 of 0')).toBeTruthy();
  });

  test('reports the generic error state when bootstrap fails', async () => {
    initializeDatabase.mockRejectedValueOnce(new Error('no native module'));
    await renderApp();
    expect(await screen.findByTestId('inventory-error-message')).toBeTruthy();
    // Raw driver text never reaches the screen.
    expect(screen.queryByText('no native module')).toBeNull();
  });

  test('owns a single bootstrap for the default launch', async () => {
    await renderApp();
    await act(async () => {});
    expect(initializeDatabase).toHaveBeenCalledTimes(1);
  });
});

jest.mock(
  '../src/dev/NativeSqliteFixtureScreen',
  () => {
    const { View } = require('react-native');
    return {
      __esModule: true,
      default: () => <View testID="native-fixture-screen" />,
    };
  },
  { virtual: true },
);

jest.mock(
  '../src/dev/NativeRepositoryFixtureScreen',
  () => {
    const { View } = require('react-native');
    return {
      __esModule: true,
      default: () => <View testID="repository-fixture-screen" />,
    };
  },
  { virtual: true },
);

describe('<App /> DEV-only native repository fixture gate (P2b)', () => {
  const G = globalThis as Record<string, unknown>;
  const origDev = G.__DEV__;
  const origFixture = process.env.EXPO_PUBLIC_NATIVE_FIXTURE;
  const origRepo = process.env.EXPO_PUBLIC_NATIVE_REPOSITORY;

  afterEach(async () => {
    G.__DEV__ = origDev;
    if (origFixture === undefined) {
      delete process.env.EXPO_PUBLIC_NATIVE_FIXTURE;
    } else {
      process.env.EXPO_PUBLIC_NATIVE_FIXTURE = origFixture;
    }
    if (origRepo === undefined) {
      delete process.env.EXPO_PUBLIC_NATIVE_REPOSITORY;
    } else {
      process.env.EXPO_PUBLIC_NATIVE_REPOSITORY = origRepo;
    }
    await cleanup();
  });

  test('both flags in DEV render the repository screen, never tengo.db', async () => {
    G.__DEV__ = true;
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE = '1';
    process.env.EXPO_PUBLIC_NATIVE_REPOSITORY = '1';
    const SQLite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
    SQLite.openDatabaseAsync.mockClear();
    await renderApp();
    expect(screen.getByTestId('repository-fixture-screen')).toBeTruthy();
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalledWith('tengo.db');
    expect(initializeDatabase).not.toHaveBeenCalled();
  });

  test('repository flag without the fixture flag keeps the default screen', async () => {
    G.__DEV__ = true;
    delete process.env.EXPO_PUBLIC_NATIVE_FIXTURE;
    process.env.EXPO_PUBLIC_NATIVE_REPOSITORY = '1';
    await renderApp();
    expect(screen.getByTestId('inventory-list')).toBeTruthy();
  });

  test('production ignores both flags and keeps the normal inventory', async () => {
    G.__DEV__ = false;
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE = '1';
    process.env.EXPO_PUBLIC_NATIVE_REPOSITORY = '1';
    await renderApp();
    expect(screen.getByTestId('inventory-list')).toBeTruthy();
  });
});

describe('<App /> DEV-only native fixture gate', () => {
  const G = globalThis as Record<string, unknown>;
  const origDev = G.__DEV__;
  const origFlag = process.env.EXPO_PUBLIC_NATIVE_FIXTURE;

  afterEach(async () => {
    G.__DEV__ = origDev;
    if (origFlag === undefined) {
      delete process.env.EXPO_PUBLIC_NATIVE_FIXTURE;
    } else {
      process.env.EXPO_PUBLIC_NATIVE_FIXTURE = origFlag;
    }
    await cleanup();
  });

  test('flagged DEV path renders the fixture screen, never tengo.db', async () => {
    G.__DEV__ = true;
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE = '1';
    const SQLite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
    SQLite.openDatabaseAsync.mockClear();
    await renderApp();
    expect(screen.getByTestId('native-fixture-screen')).toBeTruthy();
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalledWith('tengo.db');
    expect(initializeDatabase).not.toHaveBeenCalled();
  });

  test('production ignores the public flag and keeps the normal inventory', async () => {
    G.__DEV__ = false;
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE = '1';
    await renderApp();
    expect(screen.getByTestId('inventory-list')).toBeTruthy();
  });
});
