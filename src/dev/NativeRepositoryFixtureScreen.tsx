/**
 * DEV-ONLY repository fixture screen (P2b). Rendered ONLY via the guarded
 * `__DEV__ && EXPO_PUBLIC_NATIVE_FIXTURE=1 &&
 * EXPO_PUBLIC_NATIVE_REPOSITORY=1` branch in `App.tsx`, which bypasses the
 * normal readiness bootstrap and never opens `tengo.db`.
 *
 * The harness run is memoized in a ref so React StrictMode double-effects
 * cannot launch a second run mid-flight. Phase (`repository-phase`),
 * status (`repository-status`: `running` | `restart-required` | `pass` |
 * `fail`), counts (`repository-summary`), and every check
 * (`repository-check-N`, failures also `repository-error`) render with
 * stable testIDs so an external native verifier (Maestro/`adb`) can
 * observe each launch: `restart-required` means force-stop + relaunch,
 * only a final `pass` counts as the native milestone gate.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  type RepositoryFixtureResult,
  runNativeRepositoryFixture,
} from './nativeRepositoryFixture';

export default function NativeRepositoryFixtureScreen() {
  const [result, setResult] = useState<RepositoryFixtureResult | null>(null);
  const runRef = useRef<Promise<RepositoryFixtureResult> | null>(null);

  useEffect(() => {
    let mounted = true;
    if (!runRef.current) {
      runRef.current = runNativeRepositoryFixture();
    }
    runRef.current.then(
      (value) => {
        if (mounted) setResult(value);
      },
      (error: unknown) => {
        if (mounted) {
          setResult({
            phase: 1,
            status: 'fail',
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

  const status = result === null ? 'running' : result.status;
  const passed = result?.checks.filter((c) => c.pass).length ?? 0;
  const total = result?.checks.length ?? 0;

  return (
    <View style={styles.container} testID="repository-fixture-screen">
      <Text testID="repository-title" style={styles.title}>
        Native repository fixture (dev only)
      </Text>
      <Text testID="repository-phase">
        {result === null ? 'phase-unknown' : `phase-${result.phase}`}
      </Text>
      <Text testID="repository-status">{status}</Text>
      <Text testID="repository-summary">
        {result === null ? 'running…' : `${passed}/${total} checks passed`}
      </Text>
      {result?.checks.map((check, index) => (
        <View key={check.name} style={styles.row}>
          <Text testID={`repository-check-${index}`}>
            {check.pass ? 'PASS' : 'FAIL'} {check.name}: {check.detail}
          </Text>
        </View>
      ))}
      {result && result.status === 'fail' ? (
        <Text testID="repository-error">fixture failed — see checks above</Text>
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
