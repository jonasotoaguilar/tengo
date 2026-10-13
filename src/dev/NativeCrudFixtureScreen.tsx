/**
 * DEV-ONLY CRUD fixture screen (M4). Rendered ONLY via the guarded
 * `__DEV__ && EXPO_PUBLIC_NATIVE_FIXTURE=1 &&
 * EXPO_PUBLIC_NATIVE_CRUD=1` branch in `App.tsx`, which bypasses the
 * normal production bootstrap and never opens `tengo.db`.
 *
 * Embeds the REAL `InventoryContainer` with an injected isolated
 * bootstrap resolving the cached fixture handle AND `enableMutations`,
 * so a verifier can exercise add/edit/delete against the isolated
 * database. The bootstrap never falls back to the production bootstrap:
 * it resolves the fixture handle or throws, and the screen never opens
 * `tengo.db` itself.
 *
 * Handle lifecycle (no leaks, no open-file deletes): the MODULE owns the
 * invariant — it tracks every handle it opened until its close resolves,
 * and `resetNativeCrudFixture` refuses (never deleting) while any handle
 * is still tracked, no matter what the caller believes. The screen closes
 * every handle THROUGH the module's `closeCrudFixtureHandle`, never
 * behind its back. A failed open/initialize closes its own handle inside
 * `openNativeCrudFixture` and publishes `error` with no handle cached.
 * The reset control is disabled until the fixture reaches a terminal
 * state (`ready`/`error`), and reset additionally awaits any in-flight
 * open/initialize before touching the file. The screen never drops its
 * handle reference before the close resolves; on a rejected close it
 * keeps the reference, never retries the close, and never asks for a
 * reset it knows would refuse — the failure stays surfaced. Handles
 * closed by a reset are tracked so the effect cleanup never closes them
 * a second time; the cleanup still closes the live handle on unmount.
 *
 * Fail-closed stable testIDs for Maestro: `crud-fixture-screen` on the
 * root, `crud-fixture-reset` for the fixture-only reset,
 * `crud-fixture-status` for the readiness signal, the
 * `crud-fixture-list-viewport` wrapper, `crud-fixture-measure` for the
 * on-demand P5b measurement pass, `crud-fixture-measure-results` plus
 * `crud-fixture-measure-check-<index>` for its reported numbers and
 * PASS/FAIL text, and `crud-fixture-first-layout` for the
 * mount-to-first-layout diagnostic. The header stays compact so the
 * real list keeps the viewport; no details modal — the list itself is
 * the assertion surface.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { RepositoryDb } from '../inventory/database';
import InventoryContainer from '../screens/InventoryContainer';
import {
  CRUD_FIXTURE_DB,
  type CrudFixtureDb,
  type CrudMeasureResult,
  closeCrudFixtureHandle,
  openNativeCrudFixture,
  resetNativeCrudFixture,
  runCrudMeasurePass,
} from './nativeCrudFixture';

/** Wall clock available on device and in Jest; `performance.now` first. */
function wallNow(): number {
  try {
    if (
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
    ) {
      return performance.now();
    }
  } catch {
    // Fall through to Date.now below.
  }
  return Date.now();
}

type CrudStatus = 'running' | 'ready' | 'error';

export default function NativeCrudFixtureScreen() {
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<CrudStatus>('running');
  const [resetting, setResetting] = useState(false);
  // P5b measurement battery: on demand only, never on mount. Holds the
  // last pass result for the on-screen/`adb` report.
  const [measuring, setMeasuring] = useState(false);
  const [measureResult, setMeasureResult] = useState<CrudMeasureResult | null>(
    null,
  );
  // Wall time from first render (screen mount) to the first list-viewport
  // layout; a real `onLayout` diagnostic, never a budget.
  const [firstLayoutMs, setFirstLayoutMs] = useState<number | null>(null);
  const mountMsRef = useRef<number | null>(null);
  if (mountMsRef.current === null) mountMsRef.current = wallNow();
  // Cached isolated fixture handle: created once per generation and
  // reused by every container bootstrap — never reopened per filter,
  // never the production handle.
  const handleRef = useRef<CrudFixtureDb | null>(null);
  // Settled open/initialize chain: assigned the handle (or published the
  // failure) by the time it resolves, so reset can await it and never
  // touch the file mid-open.
  const openRef = useRef<Promise<void> | null>(null);
  // Handles already closed by a reset: the effect cleanup must not close
  // them a second time.
  const closedRef = useRef(new WeakSet<CrudFixtureDb>());
  // Handles whose close was attempted but never confirmed: never retry
  // the close (exactly-once attempts) and never ask for a reset while
  // one is recorded — the module would refuse it.
  const closeFailedRef = useRef(new WeakSet<CrudFixtureDb>());
  // Single-flight reset guard (the Pressable is also disabled while a
  // reset runs, but the guard owns the invariant).
  const resettingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `generation` below is a trigger-only dep by design: it replays the
  // isolated open after a reset-delete while the handle lives in its
  // ref, so no dep value is consumed for reading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation retriggers the open without being read
  useEffect(() => {
    let mounted = true;
    setStatus('running');
    handleRef.current = null;
    let handle: CrudFixtureDb | null = null;
    const run = openNativeCrudFixture().then(
      ({ db }) => {
        openRef.current = null;
        if (!mounted) {
          // Open finished after unmount: release through the module so
          // its tracking stays accurate, never leak.
          closeCrudFixtureHandle(db).catch(() => {});
          return;
        }
        handle = db;
        handleRef.current = db;
        setStatus('ready');
      },
      () => {
        openRef.current = null;
        if (mounted) setStatus('error');
      },
    );
    openRef.current = run;
    return () => {
      mounted = false;
      handleRef.current = null;
      if (openRef.current === run) openRef.current = null;
      if (handle && !closedRef.current.has(handle)) {
        // Through the module so a failed cleanup close keeps the handle
        // tracked and a later reset refuses.
        closeCrudFixtureHandle(handle).catch(() => {});
      }
    };
  }, [generation]);

  // Stable across renders: resolves the cached fixture handle, so the
  // container's single-flight bootstrap never touches production.
  const bootstrap = useCallback(async (): Promise<RepositoryDb> => {
    const cached = handleRef.current;
    if (!cached) throw new Error('CRUD fixture database not ready');
    return cached as unknown as RepositoryDb;
  }, []);

  // Fixture-only reset: settle any in-flight open first, then close the
  // handle THROUGH the module, then delete ONLY the allowlisted fixture
  // file, then reopen fresh on a new generation. The handle reference is
  // kept until its close resolves; on a rejected close the reference is
  // kept too, the close is never retried, and no reset is attempted — the
  // module would refuse it while the connection may still be open. A
  // module refusal (e.g. a handle the screen never held is still tracked)
  // likewise surfaces `error` without ever deleting.
  const onReset = useCallback(async () => {
    if (resettingRef.current) return;
    resettingRef.current = true;
    if (mountedRef.current) setResetting(true);
    try {
      const pending = openRef.current;
      if (pending) await pending;
      const previous = handleRef.current;
      if (previous && !closeFailedRef.current.has(previous)) {
        try {
          await closeCrudFixtureHandle(previous);
        } catch {
          // Keep the reference: the connection may still be open and a
          // following reset must still refuse. Never retry the close
          // here (exactly-once attempts); surface instead.
          closeFailedRef.current.add(previous);
          if (mountedRef.current) setStatus('error');
          return;
        }
        closedRef.current.add(previous);
      }
      if (previous && closeFailedRef.current.has(previous)) {
        // Close never confirmed: the module will refuse a reset, so do
        // not ask — keep the failure surfaced.
        if (mountedRef.current) setStatus('error');
        return;
      }
      handleRef.current = null;
      if (mountedRef.current) setStatus('running');
      try {
        await resetNativeCrudFixture();
      } catch {
        if (mountedRef.current) setStatus('error');
        return;
      }
      if (mountedRef.current) setGeneration((value) => value + 1);
    } finally {
      resettingRef.current = false;
      if (mountedRef.current) setResetting(false);
    }
  }, []);

  // Actionable only at a terminal state: never mid-open, never mid-reset.
  const resetDisabled = status === 'running' || resetting;

  // First viewport layout only: later layouts (rotation, keyboard) never
  // overwrite the mount-to-first-layout diagnostic.
  const onViewportLayout = useCallback(() => {
    setFirstLayoutMs((previous) =>
      previous === null && mountMsRef.current !== null
        ? wallNow() - mountMsRef.current
        : previous,
    );
  }, []);

  // On-demand measurement against the cached isolated handle: never
  // automatic, never production (the handle is the fixture handle and the
  // name is the allowlisted fixture file).
  const onMeasure = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle || measuring) return;
    setMeasuring(true);
    try {
      const result = await runCrudMeasurePass(handle, CRUD_FIXTURE_DB);
      if (mountedRef.current) setMeasureResult(result);
    } finally {
      if (mountedRef.current) setMeasuring(false);
    }
  }, [measuring]);

  // Actionable only when the fixture handle is cached and no pass runs.
  const measureDisabled = status !== 'ready' || measuring;

  return (
    <View style={styles.container} testID="crud-fixture-screen">
      <View style={styles.header}>
        <Text testID="crud-fixture-title" style={styles.title}>
          Native CRUD fixture (dev only)
        </Text>
        <Text testID="crud-fixture-status">{status}</Text>
        <Pressable
          testID="crud-fixture-reset"
          accessibilityRole="button"
          accessibilityLabel="Reset the isolated CRUD fixture database"
          accessibilityHint="Closes, deletes, and reopens only the fixture database"
          accessibilityState={{ disabled: resetDisabled }}
          disabled={resetDisabled}
          onPress={() => {
            void onReset();
          }}
          style={styles.button}
        >
          <Text>Reset fixture</Text>
        </Pressable>
        <Pressable
          testID="crud-fixture-measure"
          accessibilityRole="button"
          accessibilityLabel="Run the performance measurement pass"
          accessibilityHint="Seeds 500 rows and times reads and writes on the isolated fixture database"
          accessibilityState={{ disabled: measureDisabled }}
          disabled={measureDisabled}
          onPress={() => {
            void onMeasure();
          }}
          style={styles.button}
        >
          <Text>{measuring ? 'Measuring…' : 'Measure performance'}</Text>
        </Pressable>
        <Text testID="crud-fixture-first-layout" style={styles.diagnostic}>
          {firstLayoutMs === null
            ? 'first list layout: pending (diagnostic, no budget)'
            : `first list layout: ${firstLayoutMs.toFixed(1)}ms (diagnostic, no budget)`}
        </Text>
        {measureResult ? (
          <View testID="crud-fixture-measure-results">
            <Text style={styles.diagnostic}>
              {`measurement: ${measureResult.status} (${measureResult.checks.length} checks)`}
            </Text>
            {measureResult.checks.map((check, index) => (
              <Text
                key={check.name}
                testID={`crud-fixture-measure-check-${index}`}
                style={styles.diagnostic}
              >
                {`${check.name}: ${check.detail} — ${check.pass ? 'PASS' : 'FAIL'}`}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
      <View
        style={styles.listViewport}
        testID="crud-fixture-list-viewport"
        onLayout={onViewportLayout}
      >
        {status === 'ready' ? (
          <InventoryContainer
            key={generation}
            bootstrap={bootstrap}
            enableMutations
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
  header: {
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  button: {
    minHeight: 44,
    minWidth: 44,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#C9C5B8',
    borderRadius: 999,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  listViewport: {
    flex: 1,
  },
  diagnostic: {
    fontSize: 12,
    marginTop: 4,
  },
});
