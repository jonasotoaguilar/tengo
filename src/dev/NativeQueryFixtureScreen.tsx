/**
 * DEV-ONLY query fixture screen (P3b3). Rendered ONLY via the guarded
 * `__DEV__ && EXPO_PUBLIC_NATIVE_FIXTURE=1 &&
 * EXPO_PUBLIC_NATIVE_QUERY=1` branch in `App.tsx`, which bypasses the
 * normal production bootstrap and never opens `tengo.db`.
 *
 * Embeds the REAL `InventoryContainer` with an injected isolated
 * bootstrap returning the cached fixture handle — no list fakes. The
 * fixture run is memoized in a ref so StrictMode double-effects cannot
 * launch a second run mid-flight. Status (`query-fixture-status`),
 * pass summary (`query-fixture-summary`), and every check
 * (`query-check-N`, failures also `query-fixture-error`) render with
 * stable testIDs so an external native verifier (Maestro/`adb`) can read
 * the actual structured results; every query result shown comes from the
 * real repository APIs, never hardcoded expectations.
 *
 * Fixture-only controls stay compact above the list viewport: seeded /
 * empty variant choice plus a controlled next-read failure (explicit fault
 * injection, never real database corruption) proving the generic error +
 * retry path. `resetKey` remounts the container onto the same cached
 * handle; the shared default path never reopens.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { RepositoryDb } from '../inventory/database';
import InventoryContainer from '../screens/InventoryContainer';
import {
  armQueryReadFault,
  createQueryReadFault,
  makeFaultableQueryDb,
  QUERY_FIXTURE_EMPTY_DB,
  QUERY_FIXTURE_SEEDED_DB,
  type QueryFixtureDb,
  type QueryFixtureResult,
  type QueryReadFault,
  runNativeQueryFixture,
} from './nativeQueryFixture';

type Variant = 'seeded' | 'empty';

function databaseFor(variant: Variant): string {
  return variant === 'seeded'
    ? QUERY_FIXTURE_SEEDED_DB
    : QUERY_FIXTURE_EMPTY_DB;
}

export default function NativeQueryFixtureScreen() {
  const [variant, setVariant] = useState<Variant>('seeded');
  const [result, setResult] = useState<QueryFixtureResult | null>(null);
  const [resetKey, setResetKey] = useState(0);
  // Details stay collapsed by default: the always-visible header carries
  // only status, summary, and essential controls, so the real list keeps
  // the viewport and its rows mount instead of starving. The full
  // structured report opens on demand in a bounded accessible modal.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const runRef = useRef<Promise<QueryFixtureResult> | null>(null);
  const variantRef = useRef<Variant>('seeded');
  // Cached isolated fixture handle: created once per variant run and
  // reused by every container bootstrap — never reopened per filter.
  const handleRef = useRef<QueryFixtureDb | null>(null);
  const faultRef = useRef<QueryReadFault>(createQueryReadFault());
  const wrappedRef = useRef<RepositoryDb | null>(null);

  useEffect(() => {
    let mounted = true;
    variantRef.current = variant;
    runRef.current = null;
    setResult(null);
    const previous = handleRef.current;
    handleRef.current = null;
    wrappedRef.current = null;
    if (previous) {
      previous.closeAsync().catch(() => {});
    }
    const run = runNativeQueryFixture(databaseFor(variant));
    runRef.current = run;
    run.then(
      (value) => {
        if (!mounted || variantRef.current !== variant) return;
        if (value.db) {
          handleRef.current = value.db;
          wrappedRef.current = makeFaultableQueryDb(value.db, faultRef.current)
            .db as unknown as RepositoryDb;
        }
        setResult(value);
      },
      (error: unknown) => {
        if (!mounted || variantRef.current !== variant) return;
        setResult({
          database: databaseFor(variant),
          status: 'fail',
          checks: [
            {
              name: 'harness launch',
              pass: false,
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
          db: null,
        });
      },
    );
    return () => {
      mounted = false;
    };
  }, [variant]);

  // Stable across renders: resolves the cached fixture handle, so the
  // container's single-flight bootstrap never reopens production.
  const bootstrap = useCallback(async (): Promise<RepositoryDb> => {
    const cached = wrappedRef.current;
    if (!cached) throw new Error('query fixture database not ready');
    return cached;
  }, []);

  const status = result === null ? 'running' : result.status;
  const passed = result?.checks.filter((c) => c.pass).length ?? 0;
  const total = result?.checks.length ?? 0;

  return (
    <View style={styles.container} testID="query-fixture-screen">
      <View style={styles.panel}>
        <Text testID="query-fixture-title" style={styles.title}>
          Native query fixture (dev only)
        </Text>
        <Text testID="query-fixture-status">{status}</Text>
        <Text testID="query-fixture-summary">
          {result === null ? 'running…' : `${passed}/${total} checks passed`}
        </Text>
        <Modal
          testID="query-fixture-details"
          visible={detailsOpen}
          transparent
          animationType="none"
          onRequestClose={() => setDetailsOpen(false)}
        >
          <View style={styles.detailsBackdrop}>
            <View style={styles.detailsCard}>
              <Text style={styles.detailsTitle}>Fixture details</Text>
              <ScrollView style={styles.detailsScroll}>
                {result?.checks.map((check, index) => (
                  <View key={check.name} style={styles.row}>
                    <Text selectable testID={`query-check-${index}`}>
                      {check.pass ? 'PASS' : 'FAIL'} {check.name}:{' '}
                      {check.detail}
                    </Text>
                  </View>
                ))}
                {result && result.status === 'fail' ? (
                  <Text testID="query-fixture-error">
                    fixture failed — see checks above
                  </Text>
                ) : null}
              </ScrollView>
              <Pressable
                testID="query-fixture-details-close"
                accessibilityRole="button"
                accessibilityLabel="Close fixture details"
                onPress={() => setDetailsOpen(false)}
                style={styles.button}
              >
                <Text>Close details</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
        <View style={styles.controls}>
          <Pressable
            testID="query-fixture-variant-seeded"
            accessibilityRole="button"
            accessibilityLabel="Use seeded fixture"
            accessibilityState={{ selected: variant === 'seeded' }}
            onPress={() => setVariant('seeded')}
            style={styles.button}
          >
            <Text>Seeded</Text>
          </Pressable>
          <Pressable
            testID="query-fixture-variant-empty"
            accessibilityRole="button"
            accessibilityLabel="Use empty fixture"
            accessibilityState={{ selected: variant === 'empty' }}
            onPress={() => setVariant('empty')}
            style={styles.button}
          >
            <Text>Empty</Text>
          </Pressable>
          <Pressable
            testID="query-fixture-fail-next"
            accessibilityRole="button"
            accessibilityLabel="Fail the next list read"
            accessibilityHint="Injects one controlled read failure, then retry recovers"
            onPress={() => armQueryReadFault(faultRef.current)}
            style={styles.button}
          >
            <Text>Fail next read</Text>
          </Pressable>
          <Pressable
            testID="query-fixture-details-open"
            accessibilityRole="button"
            accessibilityLabel="Open fixture details"
            accessibilityHint="Shows every structured check result"
            onPress={() => setDetailsOpen(true)}
            style={styles.button}
          >
            <Text>Details</Text>
          </Pressable>
          <Pressable
            testID="query-fixture-reset"
            accessibilityRole="button"
            accessibilityLabel="Re-mount the list on the cached fixture"
            onPress={() => setResetKey((key) => key + 1)}
            style={styles.button}
          >
            <Text>Reset list</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.listViewport} testID="query-fixture-list-viewport">
        {result?.db ? (
          <InventoryContainer
            key={`${variant}-${resetKey}`}
            bootstrap={bootstrap}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  panel: {
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  detailsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 64,
  },
  detailsCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 8,
    maxHeight: '80%',
  },
  detailsTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  detailsScroll: {
    flexGrow: 0,
  },
  row: {
    marginTop: 2,
  },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  button: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#C9C5B8',
    borderRadius: 999,
    paddingHorizontal: 16,
  },
  listViewport: {
    flex: 1,
  },
});
