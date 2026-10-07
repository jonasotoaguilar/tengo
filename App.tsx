import { StatusBar } from 'expo-status-bar';
import { I18nextProvider } from 'react-i18next';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import i18n from './src/i18n';
import InventoryContainer from './src/screens/InventoryContainer';

export default function App() {
  // DEV-ONLY repository fixture gate (P2b verification infra): enabled
  // only when `__DEV__` is true AND BOTH `EXPO_PUBLIC_NATIVE_FIXTURE=1`
  // and `EXPO_PUBLIC_NATIVE_REPOSITORY=1`. Takes precedence over the M1
  // fixture gate below; bypasses `InventoryContainer` entirely, so the normal
  // `tengo.db` bootstrap never runs here. Release builds ignore both flags.
  const repositoryLaunch =
    (globalThis as Record<string, unknown>).__DEV__ === true &&
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE === '1' &&
    process.env.EXPO_PUBLIC_NATIVE_REPOSITORY === '1';
  if (repositoryLaunch) {
    const RepositoryScreen = require('./src/dev/NativeRepositoryFixtureScreen')
      .default as React.ComponentType;
    return (
      <I18nextProvider i18n={i18n}>
        <SafeAreaProvider>
          <RepositoryScreen />
        </SafeAreaProvider>
      </I18nextProvider>
    );
  }
  // DEV-ONLY fixture gate (T3 verification infra): enabled only when BOTH
  // `__DEV__` is true and `EXPO_PUBLIC_NATIVE_FIXTURE=1`. This branch
  // bypasses `InventoryContainer` entirely, so the normal `tengo.db`
  // bootstrap never runs here. Release builds (`__DEV__ === false`) ignore
  // the public flag and always take the normal path below. The harness is
  // required lazily so release bundles never execute it.
  const fixtureLaunch =
    (globalThis as Record<string, unknown>).__DEV__ === true &&
    process.env.EXPO_PUBLIC_NATIVE_FIXTURE === '1';
  if (fixtureLaunch) {
    const FixtureScreen = require('./src/dev/NativeSqliteFixtureScreen')
      .default as React.ComponentType;
    return (
      <I18nextProvider i18n={i18n}>
        <SafeAreaProvider>
          <FixtureScreen />
        </SafeAreaProvider>
      </I18nextProvider>
    );
  }
  // Default (P3b2): the App-wired read-only inventory list. The container
  // owns the single `tengo.db` bootstrap; nothing else here initializes.
  return (
    <I18nextProvider i18n={i18n}>
      <SafeAreaProvider>
        <InventoryContainer />
        <StatusBar style="auto" />
      </SafeAreaProvider>
    </I18nextProvider>
  );
}
