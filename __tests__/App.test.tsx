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
