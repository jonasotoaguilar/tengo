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
import {
  createCategory as realCreateCategory,
  createItem as realCreateItem,
  createLocation as realCreateLocation,
  queryItems as realQueryItems,
} from '../inventory';
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

/**
 * P5b measurement battery (DEV-only, on demand from the fixture screen).
 *
 * Runs against the already-open isolated fixture handle and reports real
 * wall-clock numbers with PASS/FAIL against the ROADMAP section 7 budgets.
 * Never runs automatically; never opens a database itself. The allowlist is
 * enforced BEFORE any driver or repository call, so a refused name throws
 * with zero calls — production `tengo.db` is unreachable here.
 *
 * Documented pass order: prefix-scoped cleanup of prior measurement rows,
 * then the timed seed (setup diagnostic, no budget), then the timed
 * first-viewport read, the timed filtered search read, and finally the
 * timed single-row probe write. A missed budget records its check as
 * failing with the measured value and the pass still runs the remaining
 * checks; only an unexpected driver/repository error aborts the pass.
 *
 * Seeding semantics (idempotent reseed): every measurement row carries the
 * stable `Perf p5b ` name prefix and dedicated locations and categories, so
 * the pass deletes exactly its own prior rows (items first — the delete
 * cascades their stock and join rows — then locations, then categories)
 * before seeding. The 500
 * inserts run sequentially through the real repository, one atomic exclusive
 * transaction per insert. The seed is deliberately NOT wrapped in the
 * handle's batch transaction (`withTransactionAsync`): the repository's
 * exclusive transaction runs on its own native connection on the same file,
 * so nesting it inside a driver batch transaction fails on device (observed:
 * `Could not create item: storage unavailable.`). Setup time is unbudgeted,
 * so a per-insert transaction costs nothing the battery reports. A failed
 * pass may leave partial `Perf p5b ` rows, but the next pass removes exactly
 * those rows before reseeding — repeated passes never duplicate measurement
 * rows and never touch non-measurement (M4 flow) data.
 *
 * The search figure is the DATA-LAYER cost of one keystroke (the filtered
 * `queryItems` call); the UI-per-keystroke figure adds render on top and
 * is not separately instrumented.
 */

/** Rows seeded per measurement pass (setup, not budgeted). */
export const CRUD_MEASURE_SEED_COUNT = 500;

/** Stable name prefix for every measurement row; cleanup matches only this. */
export const CRUD_MEASURE_NAME_PREFIX = 'Perf p5b ';

/** ROADMAP budget: first-viewport data readiness, under 1000 ms. */
export const CRUD_MEASURE_FIRST_VIEWPORT_BUDGET_MS = 1000;
/** ROADMAP budget: search data-layer cost per keystroke, under 200 ms. */
export const CRUD_MEASURE_SEARCH_BUDGET_MS = 200;
/** ROADMAP budget: single-row write end to end, under 100 ms. */
export const CRUD_MEASURE_WRITE_BUDGET_MS = 100;

/** Name query matching a realistic subset (~111 of the 500 seeded rows). */
export const CRUD_MEASURE_SEARCH_QUERY = 'Perf p5b item 1';

/** Stable check labels (screen, `adb` logcat, and docs share these). */
export const CRUD_MEASURE_LABEL_SEED =
  'seed 500 items (diagnostic setup, no budget)';
export const CRUD_MEASURE_LABEL_FIRST_VIEWPORT =
  'first-viewport data readiness (budget 1000ms)';
export const CRUD_MEASURE_LABEL_SEARCH =
  'search per keystroke, data layer only (budget 200ms)';
export const CRUD_MEASURE_LABEL_WRITE = 'single-row write (budget 100ms)';

export interface CrudMeasureDeps {
  createLocation: typeof realCreateLocation;
  createCategory: typeof realCreateCategory;
  createItem: typeof realCreateItem;
  queryItems: typeof realQueryItems;
  now: () => number;
}

export interface CrudMeasureCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface CrudMeasureResult {
  database: string;
  status: 'pass' | 'fail';
  checks: CrudMeasureCheck[];
}

function defaultCrudMeasureDeps(): CrudMeasureDeps {
  return {
    createLocation: realCreateLocation,
    createCategory: realCreateCategory,
    createItem: realCreateItem,
    queryItems: realQueryItems,
    now: () => performance.now(),
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function budgetDetail(measuredMs: number, budgetMs: number): string {
  const verdict = measuredMs < budgetMs ? 'PASS' : 'FAIL';
  return `${formatMs(measuredMs)} vs budget ${budgetMs}ms: ${verdict}`;
}

/**
 * Run one measurement pass against the open isolated fixture handle.
 * Never throws except for a refused database name (allowlist first); every
 * other failure — including missed budgets — is reported in `checks`.
 */
export async function runCrudMeasurePass(
  db: CrudFixtureDb,
  database: string = CRUD_FIXTURE_DB,
  injectedDeps?: CrudMeasureDeps,
): Promise<CrudMeasureResult> {
  assertSafeCrudFixtureName(database);
  const deps = injectedDeps ?? defaultCrudMeasureDeps();
  const checks: CrudMeasureCheck[] = [];
  const timed = async <T>(
    task: () => Promise<T>,
  ): Promise<{ value: T; measuredMs: number }> => {
    const start = deps.now();
    const value = await task();
    return { value, measuredMs: deps.now() - start };
  };
  try {
    // Cleanup-first reseed: remove exactly this battery's prior rows.
    // Items go first (their delete cascades stock and join rows), then
    // locations, then categories.
    const like = `${CRUD_MEASURE_NAME_PREFIX}%`;
    await db.runAsync('DELETE FROM items WHERE name LIKE ?', [like]);
    await db.runAsync('DELETE FROM locations WHERE name LIKE ?', [like]);
    await db.runAsync('DELETE FROM categories WHERE name LIKE ?', [like]);

    const seedTask = async (): Promise<void> => {
      const locations = [
        await deps.createLocation(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}location 0`,
        }),
        await deps.createLocation(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}location 1`,
        }),
        await deps.createLocation(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}location 2`,
        }),
        await deps.createLocation(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}location 3`,
        }),
        await deps.createLocation(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}location 4`,
        }),
      ];
      const categories = [
        await deps.createCategory(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}category 0`,
        }),
        await deps.createCategory(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}category 1`,
        }),
        await deps.createCategory(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}category 2`,
        }),
      ];
      for (let index = 0; index < CRUD_MEASURE_SEED_COUNT; index += 1) {
        const padded = String(index).padStart(3, '0');
        await deps.createItem(db, {
          name: `${CRUD_MEASURE_NAME_PREFIX}item ${padded}`,
          stock: [
            {
              locationId: locations[index % locations.length].id,
              quantity: (index % 7) + 1,
            },
          ],
          categoryIds: [categories[index % categories.length].id],
        });
      }
    };
    // One exclusive transaction per insert; never nested inside a batch
    // transaction on the same handle (device-observed failure).
    const seed = await timed(seedTask);
    checks.push({
      name: CRUD_MEASURE_LABEL_SEED,
      pass: true,
      detail: `${formatMs(seed.measuredMs)} setup: ${CRUD_MEASURE_SEED_COUNT} items with locations/categories, no budget asserted`,
    });

    const viewport = await timed(() => deps.queryItems(db, {}));
    checks.push({
      name: CRUD_MEASURE_LABEL_FIRST_VIEWPORT,
      pass: viewport.measuredMs < CRUD_MEASURE_FIRST_VIEWPORT_BUDGET_MS,
      detail: budgetDetail(
        viewport.measuredMs,
        CRUD_MEASURE_FIRST_VIEWPORT_BUDGET_MS,
      ),
    });

    const search = await timed(() =>
      deps.queryItems(db, { query: CRUD_MEASURE_SEARCH_QUERY }),
    );
    checks.push({
      name: CRUD_MEASURE_LABEL_SEARCH,
      pass: search.measuredMs < CRUD_MEASURE_SEARCH_BUDGET_MS,
      detail: `${budgetDetail(search.measuredMs, CRUD_MEASURE_SEARCH_BUDGET_MS)} (data-layer cost of one keystroke; UI render on top is not separately instrumented)`,
    });

    // Untimed probe setup (prefixed, so the next pass cleans it up); only
    // the single `createItem` below is timed against the write budget.
    const probeLocation = await deps.createLocation(db, {
      name: `${CRUD_MEASURE_NAME_PREFIX}probe location`,
    });
    const write = await timed(() =>
      deps.createItem(db, {
        name: `${CRUD_MEASURE_NAME_PREFIX}single-write`,
        stock: [{ locationId: probeLocation.id, quantity: 1 }],
        categoryIds: [],
      }),
    );
    checks.push({
      name: CRUD_MEASURE_LABEL_WRITE,
      pass: write.measuredMs < CRUD_MEASURE_WRITE_BUDGET_MS,
      detail: budgetDetail(write.measuredMs, CRUD_MEASURE_WRITE_BUDGET_MS),
    });

    const failed = checks.some((check) => !check.pass);
    return { database, status: failed ? 'fail' : 'pass', checks };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'measurement pass aborted',
      pass: false,
      detail,
    });
    return { database, status: 'fail', checks };
  }
}
