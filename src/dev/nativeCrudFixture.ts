/**
 * DEV-ONLY native CRUD fixture (M4 form-flow verification infrastructure).
 *
 * Never imported on the normal path: `App.tsx` loads this (via
 * `NativeCrudFixtureScreen`) only inside the guarded
 * `__DEV__ && EXPO_PUBLIC_NATIVE_FIXTURE=1 &&
 * EXPO_PUBLIC_NATIVE_CRUD=1` branch, which bypasses the normal
 * `InventoryContainer` bootstrap entirely and therefore never opens
 * `tengo.db`. Release builds (`__DEV__ === false`) cannot opt in, and the
 * query / repository / sqlite flag combinations keep their existing
 * behavior.
 *
 * This runs the REAL `expo-sqlite` driver through the SHARED
 * `openManagedDatabase` factory with the ACTUAL
 * `initializeDatabase(db)` and returns the real managed handle — the same
 * handle contract `InventoryContainer` expects for its
 * `enableMutations` add/edit/delete path. No direct SQLite opener, no
 * harness FK patch, no fabricated schema. Only the single named fixture
 * file below is ever opened or deleted; production or unexpected names
 * are refused BEFORE any open or delete, so the production name is
 * impossible to reach through this module.
 *
 * The database starts EMPTY on first launch (first-run state owns the
 * empty screen) and persists across relaunches so the Maestro flow can
 * prove force-stop/relaunch persistence. The fixture-only reset deletes
 * ONLY the allowlisted fixture file so the flow is repeatable; the file
 * is otherwise retained for inspection.
 *
 * Unit tests cover orchestration with injected fakes only and never claim
 * native proof.
 */
import { initializeDatabase as realInitializeDatabase } from '../db';
import { openManagedDatabase } from '../db/exclusive';
import type { RepositoryDb } from '../inventory/database';

/**
 * The ONLY database this fixture ever opens or deletes. Distinct from
 * every other fixture file so the M4 flow can never collide with the
 * query/repository/sqlite fixtures, and never production `tengo.db`.
 */
export const CRUD_FIXTURE_DB = 'm1-fixture-crud-m4.db';

/** Real managed handle subset the screen retains for the container. */
export interface CrudFixtureDb extends RepositoryDb {
  execAsync(source: string): Promise<void>;
  closeAsync(): Promise<void>;
}

export interface CrudFixtureDeps {
  openDatabaseAsync(name: string): Promise<CrudFixtureDb>;
  initializeDatabase(db: CrudFixtureDb): Promise<unknown>;
  deleteDatabaseAsync(name: string): Promise<void>;
}

export interface CrudFixtureHandle {
  database: string;
  db: CrudFixtureDb;
}

/**
 * Refusal for a reset that would delete while a fixture connection is
 * still open. Callers must close every tracked handle (through
 * `closeCrudFixtureHandle`) before resetting; the file is never deleted
 * while this is thrown.
 */
export class CrudFixtureResetRefusedError extends Error {
  readonly code = 'CRUD_FIXTURE_RESET_REFUSED';

  constructor(detail: string) {
    super(`Refusing CRUD fixture reset: ${detail}`);
    this.name = 'CrudFixtureResetRefusedError';
  }
}

/**
 * Handles opened through each deps scope that have not yet confirmed
 * their close. A rejected close keeps the handle tracked, so only a
 * RESOLVED close untracks. Keyed by deps identity so injected-fake
 * scopes in tests never share tracking; the native path funnels through
 * the single memoized `defaultDeps()` below and therefore shares one
 * scope, which is exactly the invariant the reset enforces.
 */
const trackedOpenHandles = new WeakMap<CrudFixtureDeps, Set<CrudFixtureDb>>();

function trackedFor(deps: CrudFixtureDeps): Set<CrudFixtureDb> {
  let tracked = trackedOpenHandles.get(deps);
  if (!tracked) {
    tracked = new Set();
    trackedOpenHandles.set(deps, tracked);
  }
  return tracked;
}

let sharedDeps: CrudFixtureDeps | null = null;

function defaultDeps(): CrudFixtureDeps {
  // Memoized so every native open/close/reset shares one tracking scope.
  // Loaded lazily so importing this module never opens a database. Opens
  // through the EXACT production managed factory with the fixture file —
  // no harness-only pragma and no overridden repositories. Deletes go
  // through the real driver delete, and only ever with the allowlisted
  // name validated by the caller first.
  if (!sharedDeps) {
    const SQLite = require('expo-sqlite') as {
      deleteDatabaseAsync(name: string): Promise<void>;
    };
    sharedDeps = {
      openDatabaseAsync: (name) =>
        openManagedDatabase(name) as unknown as Promise<CrudFixtureDb>,
      initializeDatabase: (db) => realInitializeDatabase(db),
      deleteDatabaseAsync: (name) => SQLite.deleteDatabaseAsync(name),
    };
  }
  return sharedDeps;
}

/** True only for dev launches with BOTH public fixture flags. */
export function isNativeCrudFixtureEnabled(): boolean {
  try {
    const dev = (globalThis as Record<string, unknown>).__DEV__ === true;
    return (
      dev &&
      process.env.EXPO_PUBLIC_NATIVE_FIXTURE === '1' &&
      process.env.EXPO_PUBLIC_NATIVE_CRUD === '1'
    );
  } catch {
    return false;
  }
}

/** Only the single named CRUD fixture file; everything else is refused. */
export function isSafeCrudFixtureName(name: string): boolean {
  return name === CRUD_FIXTURE_DB;
}

/** Throw before any open/delete when the name is not the fixture name. */
export function assertSafeCrudFixtureName(name: string): void {
  if (!isSafeCrudFixtureName(name)) {
    throw new Error(
      `Refusing unsafe CRUD fixture database name "${name}": expected ${CRUD_FIXTURE_DB}, never production.`,
    );
  }
}

/**
 * Open the isolated fixture database through the shared real factory and
 * run the real migrations, returning the real managed handle for the
 * container's injected bootstrap. The allowlist is enforced BEFORE any
 * open; a refused name throws with zero open calls. The opened handle is
 * tracked until its close resolves: if initialization fails after a
 * successful open, the opened handle is closed best-effort (never masking
 * the original error) and the error rethrown — a rejected cleanup close
 * keeps the handle tracked so a later reset refuses instead of deleting
 * with it open. The handle is never deleted here.
 */
export async function openNativeCrudFixture(
  database: string = CRUD_FIXTURE_DB,
  injectedDeps?: CrudFixtureDeps,
): Promise<CrudFixtureHandle> {
  const deps = injectedDeps ?? defaultDeps();
  assertSafeCrudFixtureName(database);
  const db = await deps.openDatabaseAsync(database);
  const tracked = trackedFor(deps);
  tracked.add(db);
  try {
    await deps.initializeDatabase(db);
  } catch (error) {
    try {
      await db.closeAsync();
      tracked.delete(db);
    } catch {
      // Best effort only: the close must never mask the original
      // initialization failure, and the handle stays tracked so reset
      // refuses while it is unclosed.
    }
    throw error;
  }
  return { database, db };
}

/**
 * The single choke point for closing fixture handles: the screen closes
 * THROUGH here so tracking stays accurate, never behind the module's
 * back. A resolved close untracks the handle; a rejected close keeps it
 * tracked (and tracks even an unknown handle — the safe direction) so a
 * later reset refuses while the connection may still be open.
 */
export async function closeCrudFixtureHandle(
  db: CrudFixtureDb,
  injectedDeps?: CrudFixtureDeps,
): Promise<void> {
  const deps = injectedDeps ?? defaultDeps();
  const tracked = trackedFor(deps);
  try {
    await db.closeAsync();
  } catch (error) {
    tracked.add(db);
    throw error;
  }
  tracked.delete(db);
}

/**
 * Fixture-only reset: delete ONLY the allowlisted fixture file so the
 * flow is repeatable without touching any other file. The allowlist is
 * enforced BEFORE any delete, so a non-allowlisted path can never be
 * targeted from here — and the reset is refused (never deleting) while
 * any handle this module opened is still tracked as unclosed, no matter
 * what the caller believes. Close every handle through
 * `closeCrudFixtureHandle` first.
 */
export async function resetNativeCrudFixture(
  database: string = CRUD_FIXTURE_DB,
  injectedDeps?: CrudFixtureDeps,
): Promise<void> {
  const deps = injectedDeps ?? defaultDeps();
  assertSafeCrudFixtureName(database);
  const unclosed = trackedFor(deps).size;
  if (unclosed > 0) {
    throw new CrudFixtureResetRefusedError(
      `${unclosed} opened handle(s) still unclosed; close every fixture handle before reset.`,
    );
  }
  await deps.deleteDatabaseAsync(database);
}
