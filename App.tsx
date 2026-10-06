import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { initializeDatabase } from './src/db';
import i18n from './src/i18n';

type DbState = 'initializing' | 'ready' | 'error';

function ReadinessScreen() {
  const {
    t,
    i18n: { language },
  } = useTranslation();
  const [dbState, setDbState] = useState<DbState>('initializing');

  useEffect(() => {
    let mounted = true;
    initializeDatabase()
      .then(() => {
        if (mounted) setDbState('ready');
      })
      .catch(() => {
        if (mounted) setDbState('error');
      });
    return () => {
      mounted = false;
    };
  }, []);

  const status =
    dbState === 'ready'
      ? t('statusReady')
      : dbState === 'error'
        ? t('statusError')
        : t('statusInitializing');

  return (
    <SafeAreaView style={styles.container} testID="readiness-screen">
      <Text testID="readiness-title" style={styles.title}>
        {t('readinessTitle')}
      </Text>
      <Text testID="readiness-subtitle" style={styles.subtitle}>
        {t('readinessSubtitle')}
      </Text>
      <Text testID="readiness-status">{status}</Text>
      <View style={styles.meta}>
        <Text testID="readiness-db-state">{dbState}</Text>
        <Text testID="readiness-language">{language}</Text>
      </View>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <SafeAreaProvider>
        <ReadinessScreen />
      </SafeAreaProvider>
    </I18nextProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    opacity: 0.7,
    marginBottom: 16,
    textAlign: 'center',
  },
  meta: {
    marginTop: 12,
    alignItems: 'center',
    gap: 4,
  },
});
