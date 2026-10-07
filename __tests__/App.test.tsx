/**
 * Renders against mocked native modules (see `jest.setup.ts`): the
 * `react-native-safe-area-context` mock below stands in for the native
 * insets provider, which renders no children under Jest. On a real device
 * the genuine provider supplies safe-area insets.
 */
import { render, screen } from '@testing-library/react-native';
import type { ViewProps } from 'react-native';

import App from '../App';

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

describe('<App /> readiness screen', () => {
  test('renders translated content with stable Maestro testIDs', async () => {
    await render(<App />);

    expect(screen.getByTestId('readiness-screen')).toBeTruthy();
    expect(screen.getByTestId('readiness-title')).toHaveTextContent(
      'Tengo is ready',
    );
    expect(screen.getByTestId('readiness-status')).toBeTruthy();
    expect(screen.getByTestId('readiness-db-state')).toBeTruthy();
    expect(screen.getByTestId('readiness-language')).toBeTruthy();
  });

  test('reaches the ready database state against the mocked native layer', async () => {
    await render(<App />);
    expect(await screen.findByText('ready')).toBeTruthy();
  });

  test('reports the error state when the native layer fails', async () => {
    const SQLite = require('expo-sqlite') as {
      openDatabaseAsync: jest.Mock;
    };
    SQLite.openDatabaseAsync.mockRejectedValueOnce(
      new Error('no native module'),
    );
    await render(<App />);
    expect(await screen.findByText('error')).toBeTruthy();
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

  afterEach(() => {
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
  });

  test('both flags in DEV render the repository screen, never tengo.db', async () => {
    G.__DEV__ = true;
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE = '1';
    process.env.EXPO_PUBLIC_NATIVE_REPOSITORY = '1';
    const SQLite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
    SQLite.openDatabaseAsync.mockClear();
    await render(<App />);
    expect(screen.getByTestId('repository-fixture-screen')).toBeTruthy();
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalledWith('tengo.db');
  });

  test('repository flag without the fixture flag keeps the default screen', async () => {
    G.__DEV__ = true;
    delete process.env.EXPO_PUBLIC_NATIVE_FIXTURE;
    process.env.EXPO_PUBLIC_NATIVE_REPOSITORY = '1';
    await render(<App />);
    expect(screen.getByTestId('readiness-screen')).toBeTruthy();
  });

  test('production ignores both flags and keeps normal readiness', async () => {
    G.__DEV__ = false;
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE = '1';
    process.env.EXPO_PUBLIC_NATIVE_REPOSITORY = '1';
    await render(<App />);
    expect(screen.getByTestId('readiness-screen')).toBeTruthy();
  });
});

describe('<App /> DEV-only native fixture gate', () => {
  const G = globalThis as Record<string, unknown>;
  const origDev = G.__DEV__;
  const origFlag = process.env.EXPO_PUBLIC_NATIVE_FIXTURE;

  afterEach(() => {
    G.__DEV__ = origDev;
    if (origFlag === undefined) {
      delete process.env.EXPO_PUBLIC_NATIVE_FIXTURE;
    } else {
      process.env.EXPO_PUBLIC_NATIVE_FIXTURE = origFlag;
    }
  });

  test('flagged DEV path renders the fixture screen, never tengo.db', async () => {
    G.__DEV__ = true;
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE = '1';
    const SQLite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
    SQLite.openDatabaseAsync.mockClear();
    await render(<App />);
    expect(screen.getByTestId('native-fixture-screen')).toBeTruthy();
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalledWith('tengo.db');
  });

  test('production ignores the public flag and keeps normal readiness', async () => {
    G.__DEV__ = false;
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE = '1';
    await render(<App />);
    expect(screen.getByTestId('readiness-screen')).toBeTruthy();
  });
});
