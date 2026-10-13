/**
 * DEV-ONLY fixture screen (T3). Rendered ONLY via the guarded
 * `__DEV__ && EXPO_PUBLIC_NATIVE_FIXTURE=1` branch in `App.tsx`, which
 * bypasses the normal readiness bootstrap and never opens `tengo.db`.
 *
 * The harness run is memoized in a ref so React StrictMode double-effects
 * cannot launch a second run or reuse fixture databases mid-flight.
 * Every outcome — counts, pass/fail, error text — is rendered with stable
 * `fixture-*` testIDs so an external native verifier (Maestro/`adb`) can
 * observe a real on-device pass.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  type FixtureResult,
  runNativeSqliteFixture,
} from './nativeSqliteFixture';

export default function NativeSqliteFixtureScreen() {
  const [result, setResult] = useState<FixtureResult | null>(null);
  const runRef = useRef<Promise<FixtureResult> | null>(null);

  useEffect(() => {
    let mounted = true;
    if (!runRef.current) {
      runRef.current = runNativeSqliteFixture();
    }
    runRef.current.then(
      (value) => {
        if (mounted) setResult(value);
      },
      (error: unknown) => {
        if (mounted) {
          setResult({
            pass: false,
            checks: [
              {
                name: 'harness launch',
                pass: false,
                detail: error instanceof Error ? error.message : String(error),
              },
            ],
          });
        }
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  const status = result === null ? 'running' : result.pass ? 'pass' : 'fail';
  const passed = result?.checks.filter((c) => c.pass).length ?? 0;
  const total = result?.checks.length ?? 0;

  return (
    <View style={styles.container} testID="native-fixture-screen">
      <Text testID="fixture-title" style={styles.title}>
        Native SQLite fixture (dev only)
      </Text>
      <Text testID="fixture-status">{status}</Text>
      <Text testID="fixture-summary">
        {result === null ? 'running…' : `${passed}/${total} checks passed`}
      </Text>
      {result?.checks.map((check, index) => (
        <View key={check.name} style={styles.row}>
          <Text testID={`fixture-check-${index}`}>
            {check.pass ? 'PASS' : 'FAIL'} {check.name}: {check.detail}
          </Text>
        </View>
      ))}
      {result && !result.pass ? (
        <Text testID="fixture-error">fixture failed — see checks above</Text>
      ) : null}
    </View>
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
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 12,
  },
  row: {
    marginTop: 6,
    paddingHorizontal: 12,
  },
});
