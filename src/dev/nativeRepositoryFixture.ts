/**
 * DEV-ONLY native repository fixture (P2b verification infrastructure).
 *
 * Never imported on the normal path: `App.tsx` loads this (via
 * `NativeRepositoryFixtureScreen`) only inside the guarded
 * `__DEV__ && EXPO_PUBLIC_NATIVE_FIXTURE=1 &&
 * EXPO_PUBLIC_NATIVE_REPOSITORY=1` branch, which bypasses the normal
 * `ReadinessScreen` entirely and therefore never opens `tengo.db`.
 * Release builds (`__DEV__ === false`) cannot opt in, and the M1-only
 * flag combination keeps the existing M1 fixture behavior unchanged.
 *
 * This runs the REAL `expo-sqlite` driver with the ACTUAL
 * `initializeDatabase()` from `src/db` and the ACTUAL M2
 * entity/item repositories — no mocks here. The single fixture database
 * `m1-fixture-repository.db` is validated by `assertSafeFixtureName`
 * before open AND delete; `tengo.db` (`DATABASE_NAME`) is always refused.
 *
 * Multi-launch protocol (the verifier force-stops + relaunches between
 * phases; a restart is NEVER faked with a same-process close/open):
 * - launch 1 (no marker): create locations/categories/items via the real
 *   repos, store ids + `phase=1` in the fixture-local `fixture_state`
 *   table, close WITHOUT deleting => `restart-required`.
 * - launch 2 (`phase=1`): verify the created rows persisted, update one
 *   item, delete another, store `phase=2`, close WITHOUT deleting =>
 *   `restart-required`.
 * - launch 3 (`phase=2`): verify the edit/deletion persisted, then prove
 *   typed `RESTRICT`, invalid-reference and late-failure rollback (no
 *   orphans), zero/many-category + native-query mapping, and the scoped
 *   exclusive-connection FK state. Full pass => close + delete ONLY the
 *   fixture file. Any failure keeps the DB for inspection.
 *
 * Observed device bug: phase 3 failed with the deleted item absent and an
 * orphan `item_categories` row retained — the driver's
 * `withExclusiveTransactionAsync` (`SQLiteDatabase.js:155-176`) runs every
 * item mutation on a `Transaction` created by `Transaction.createAsync`
 * (`SQLiteDatabase.js:561-567`), which opens a NEW native connection on
 * the same path with `useNewConnection: true` and only `initAsync()` —
 * no `PRAGMA foreign_keys = ON` anywhere in that path. SQLite enforces
 * foreign keys per connection and defaults to OFF, and the old init only
 * enabled them on the outer connection, so scoped transactions ran FK-OFF.
 * Production now opens through the shared managed factory
 * (`src/db/exclusive.ts`): the isolated exclusive connection enables
 * `PRAGMA foreign_keys = ON`, verifies `=== 1`, and only then runs
 * `BEGIN IMMEDIATE` — the pragma is a no-op after `BEGIN`, so it must run
 * before. This fixture uses that EXACT factory with the fresh
 * `m1-fixture-repository-fk.db` file (the failed legacy fixture DB stays
 * untouched); it adds no harness-only pragma and overrides no repos.
 * Phase 3 still asserts the join cleanup (`orphans === 0`), the scoped
 * `PRAGMA foreign_keys === 1` plus bogus-join rejection, and the raw
 * mapping — those assertions are unchanged and must keep passing.
 *
 * Unit tests cover orchestration with injected fakes only and never claim
 * native proof.
 */

import { initializeDatabase as realInitializeDatabase } from '../db';
import { openManagedDatabase } from '../db/exclusive';
import {
  EntityNotFoundError,
  isForeignKeyViolation,
  LocationInUseError,
  type RepositoryDb,
  createCategory as realCreateCategory,
  createItem as realCreateItem,
  createItemFromDraft as realCreateItemFromDraft,
  createLocation as realCreateLocation,
  deleteItem as realDeleteItem,
  deleteLocation as realDeleteLocation,
  getItem as realGetItem,
  listItems as realListItems,
  updateItem as realUpdateItem,
  StorageError,
} from '../inventory';
import { assertSafeFixtureName } from './nativeSqliteFixture';

/**
 * The only database this fixture ever opens or deletes.
 *
 * Fresh `fk` name: the prior `m1-fixture-repository.db` file failed phase 3
 * on device (deleted item absent, orphan join retained) and is preserved
 * untouched for inspection — this fixture never clears or reuses it.
 */
export const REPOSITORY_FIXTURE_DB = 'm1-fixture-repository-fk.db';

export interface FixtureRepositoryDb extends RepositoryDb {
  execAsync(source: string): Promise<void>;
  closeAsync(): Promise<void>;
}

export interface RepositoryFixtureRepos {
  createLocation: typeof realCreateLocation;
  createCategory: typeof realCreateCategory;
  createItem: typeof realCreateItem;
  getItem: typeof realGetItem;
  updateItem: typeof realUpdateItem;
  deleteItem: typeof realDeleteItem;
  deleteLocation: typeof realDeleteLocation;
  listItems: typeof realListItems;
  createItemFromDraft: typeof realCreateItemFromDraft;
}

export interface RepositoryFixtureDeps {
  openDatabaseAsync(name: string): Promise<FixtureRepositoryDb>;
  deleteDatabaseAsync(name: string): Promise<void>;
  initializeDatabase(db: FixtureRepositoryDb): Promise<unknown>;
  repos: RepositoryFixtureRepos;
}

export interface RepositoryFixtureCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export type RepositoryFixtureStatus = 'restart-required' | 'pass' | 'fail';

export interface RepositoryFixtureResult {
  phase: 1 | 2 | 3;
  status: RepositoryFixtureStatus;
  checks: RepositoryFixtureCheck[];
}

const LATE_FAIL_ITEM = '__LATE_FAIL__';
const ORPHAN_PROBE_LOCATION = 'OrphanProbeLoc';
const PROBE_ROLLBACK = 'fixture-probe-rollback';

function defaultDeps(): RepositoryFixtureDeps {
  // Loaded lazily so importing this module never opens a database. Opens
  // through the EXACT production managed factory with the fixture file —
  // no harness-only pragma and no overridden repositories.
  const SQLite = require('expo-sqlite') as {
    deleteDatabaseAsync(name: string): Promise<void>;
  };
  return {
    openDatabaseAsync: (name) =>
      openManagedDatabase(name) as unknown as Promise<FixtureRepositoryDb>,
    deleteDatabaseAsync: (name) => SQLite.deleteDatabaseAsync(name),
    initializeDatabase: (db) => realInitializeDatabase(db),
    repos: {
      createLocation: realCreateLocation,
      createCategory: realCreateCategory,
      createItem: realCreateItem,
      getItem: realGetItem,
      updateItem: realUpdateItem,
      deleteItem: realDeleteItem,
      deleteLocation: realDeleteLocation,
      listItems: realListItems,
      createItemFromDraft: realCreateItemFromDraft,
    },
  };
}

/** True only for dev launches with BOTH public fixture flags. */
export function isNativeRepositoryFixtureEnabled(): boolean {
  try {
    const dev = (globalThis as Record<string, unknown>).__DEV__ === true;
    return (
      dev &&
      process.env.EXPO_PUBLIC_NATIVE_FIXTURE === '1' &&
      process.env.EXPO_PUBLIC_NATIVE_REPOSITORY === '1'
    );
  } catch {
    return false;
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeQuietly(db: FixtureRepositoryDb): Promise<void> {
  try {
    await db.closeAsync();
  } catch {
    // Inspection of the kept DB matters more than a close error here.
  }
}

async function readState(
  db: FixtureRepositoryDb,
  key: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value AS value FROM fixture_state WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

async function writeState(
  db: FixtureRepositoryDb,
  key: string,
  value: string,
): Promise<void> {
  await db.runAsync(
    'INSERT OR REPLACE INTO fixture_state (key, value) VALUES (?, ?)',
    [key, value],
  );
}

async function countRows(
  db: FixtureRepositoryDb,
  sql: string,
  params?: (string | number | null)[],
): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(sql, params);
  return row?.count ?? -1;
}

/** `PRAGMA foreign_keys` on any handle; handles number vs row shapes. */
async function readForeignKeys(handle: {
  getFirstAsync<T>(
    source: string,
    params?: (string | number | null)[],
  ): Promise<T | null>;
}): Promise<number> {
  const raw = await handle.getFirstAsync<unknown>('PRAGMA foreign_keys');
  if (typeof raw === 'number') return raw;
  const value = (raw as { foreign_keys?: unknown } | null)?.foreign_keys;
  return typeof value === 'number' ? value : -1;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

interface FixtureIds {
  locA: number;
  locB: number;
  catA: number;
  catB: number;
  edit: number;
  gone: number;
}

/** Launch 1: create everything via the real repos, keep the DB. */
async function runPhase1(
  deps: RepositoryFixtureDeps,
  db: FixtureRepositoryDb,
): Promise<RepositoryFixtureResult> {
  const checks: RepositoryFixtureCheck[] = [];
  try {
    const version = (
      (await db.getFirstAsync('PRAGMA user_version')) as {
        user_version: number;
      } | null
    )?.user_version;
    assert(version === 3, `user_version=${version}, want 3`);
    assert(
      (await readForeignKeys(db)) === 1,
      'outer connection must enforce FK',
    );
    checks.push({
      name: 'phase-1 initialized fixture database to v3 with FK ON',
      pass: true,
      detail: 'user_version=3 foreign_keys=1 on the outer connection',
    });
    const { repos } = deps;
    const locA = await repos.createLocation(db, { name: 'Fixture Kitchen' });
    const locB = await repos.createLocation(db, {
      name: 'Fixture Pantry',
      address: 'Shelf 2',
    });
    const catA = await repos.createCategory(db, { name: 'Fixture Grains' });
    const catB = await repos.createCategory(db, { name: 'Fixture Staples' });
    checks.push({
      name: 'phase-1 created locations and categories via entity repository',
      pass: true,
      detail: `loc=${locA.id},${locB.id} cat=${catA.id},${catB.id}`,
    });
    const edit = await repos.createItem(db, {
      name: 'Rice',
      quantity: 2,
      locationId: locA.id,
      categoryIds: [catA.id, catB.id],
    });
    assert(
      edit.categoryIds.length === 2,
      'two-category item must map both ids',
    );
    checks.push({
      name: 'phase-1 created item with two categories via item repository',
      pass: true,
      detail: `item=${edit.id} categories=${edit.categoryIds.join(',')}`,
    });
    const gone = await repos.createItem(db, {
      name: 'Beans',
      quantity: 0,
      locationId: locB.id,
      categoryIds: [catB.id],
    });
    assert(gone.quantity === 0, 'zero quantity must survive the round trip');
    checks.push({
      name: 'phase-1 created zero-quantity item with one category',
      pass: true,
      detail: `item=${gone.id} qty=0 categories=${gone.categoryIds.join(',')}`,
    });
    const ids: FixtureIds = {
      locA: locA.id,
      locB: locB.id,
      catA: catA.id,
      catB: catB.id,
      edit: edit.id,
      gone: gone.id,
    };
    await writeState(db, 'ids', JSON.stringify(ids));
    await writeState(db, 'phase', '1');
    checks.push({
      name: 'phase-1 stored ids + marker; force-stop and relaunch for phase 2',
      pass: true,
      detail: `ids=${JSON.stringify(ids)}`,
    });
    await db.closeAsync();
    return { phase: 1, status: 'restart-required', checks };
  } catch (error) {
    await closeQuietly(db);
    checks.push({ name: 'phase-1', pass: false, detail: detailOf(error) });
    return { phase: 1, status: 'fail', checks };
  }
}

/** Launch 2: verify persistence, update one item, delete another, keep DB. */
async function runPhase2(
  deps: RepositoryFixtureDeps,
  db: FixtureRepositoryDb,
): Promise<RepositoryFixtureResult> {
  const checks: RepositoryFixtureCheck[] = [];
  try {
    const ids = JSON.parse(
      (await readState(db, 'ids')) ?? 'null',
    ) as FixtureIds | null;
    assert(ids !== null, 'phase-1 ids missing from fixture_state');
    const { repos } = deps;
    const edit = await repos.getItem(db, (ids as FixtureIds).edit);
    assert(
      edit.name === 'Rice' && edit.quantity === 2,
      `edit row changed: ${edit.name}/${edit.quantity}`,
    );
    assert(
      edit.categoryIds.length === 2,
      `edit categories lost: ${edit.categoryIds.join(',')}`,
    );
    const gone = await repos.getItem(db, (ids as FixtureIds).gone);
    assert(
      gone.name === 'Beans' && gone.quantity === 0,
      'gone row changed before its delete',
    );
    checks.push({
      name: 'phase-2 created rows persisted across restart',
      pass: true,
      detail: `edit=${edit.id} Rice/2/cats=2 gone=${gone.id} Beans/0/cats=1`,
    });
    const updated = await repos.updateItem(db, (ids as FixtureIds).edit, {
      name: 'EditedRice',
      quantity: 5,
      locationId: (ids as FixtureIds).locA,
      categoryIds: [(ids as FixtureIds).catA],
    });
    assert(
      updated.name === 'EditedRice' && updated.quantity === 5,
      'update did not apply',
    );
    assert(
      updated.categoryIds.join(',') === String((ids as FixtureIds).catA),
      'category set not replaced',
    );
    checks.push({
      name: 'phase-2 updated one item via item repository',
      pass: true,
      detail: `item=${updated.id} EditedRice/5/cats=${updated.categoryIds.join(',')}`,
    });
    await repos.deleteItem(db, (ids as FixtureIds).gone);
    checks.push({
      name: 'phase-2 deleted another item; force-stop and relaunch for phase 3',
      pass: true,
      detail: `deleted=${(ids as FixtureIds).gone}`,
    });
    await writeState(db, 'phase', '2');
    await db.closeAsync();
    return { phase: 2, status: 'restart-required', checks };
  } catch (error) {
    await closeQuietly(db);
    checks.push({ name: 'phase-2', pass: false, detail: detailOf(error) });
    return { phase: 2, status: 'fail', checks };
  }
}

/** Launch 3: verify everything persisted + schema/runtime proof; delete only on full pass. */
async function runPhase3(
  deps: RepositoryFixtureDeps,
  db: FixtureRepositoryDb,
): Promise<RepositoryFixtureResult> {
  const checks: RepositoryFixtureCheck[] = [];
  const { repos } = deps;
  const pass = (name: string, detail: string) =>
    checks.push({ name, pass: true, detail });
  try {
    const ids = JSON.parse(
      (await readState(db, 'ids')) ?? 'null',
    ) as FixtureIds | null;
    assert(ids !== null, 'phase-2 ids missing from fixture_state');
    const safeIds = ids as FixtureIds;

    const edit = await repos.getItem(db, safeIds.edit);
    assert(
      edit.name === 'EditedRice' && edit.quantity === 5,
      `edit lost: ${edit.name}/${edit.quantity}`,
    );
    assert(
      edit.categoryIds.join(',') === String(safeIds.catA),
      `edit cats lost: ${edit.categoryIds.join(',')}`,
    );
    let goneStillThere = true;
    try {
      await repos.getItem(db, safeIds.gone);
    } catch (error) {
      if (error instanceof EntityNotFoundError) goneStillThere = false;
      else throw error;
    }
    assert(!goneStillThere, 'deleted item still readable after restart');
    pass(
      'phase-3 edit and deletion persisted across restart',
      `edit=${edit.id} EditedRice/5 gone=${safeIds.gone} not-found`,
    );

    const orphans = await countRows(
      db,
      'SELECT COUNT(*) AS count FROM item_categories WHERE item_id = ?',
      [safeIds.gone],
    );
    assert(
      orphans === 0,
      `orphan join rows=${orphans} for deleted item ${safeIds.gone}: item delete did NOT cascade (exclusive-connection FK is OFF — production blocker, see module header)`,
    );
    pass(
      'phase-3 item delete cascaded to join rows',
      `joins for item ${safeIds.gone}=0`,
    );

    let restrict: unknown = null;
    try {
      await repos.deleteLocation(db, safeIds.locA);
    } catch (error) {
      restrict = error;
    }
    assert(
      restrict instanceof LocationInUseError,
      `location delete not RESTRICT-blocked: ${detailOf(restrict)}`,
    );
    pass(
      'phase-3 location delete blocked with typed in-use',
      `loc ${safeIds.locA} still referenced`,
    );

    let rawError: unknown = null;
    let rawAccepted = false;
    try {
      await db.runAsync(
        'INSERT INTO items (name, quantity, location_id) VALUES (?, ?, ?)',
        ['__probe__', 1, 999999],
      );
      rawAccepted = true;
    } catch (error) {
      rawError = error;
    }
    if (rawAccepted) {
      await db
        .runAsync('DELETE FROM items WHERE location_id = ?', [999999])
        .catch(() => {});
    }
    assert(
      !rawAccepted && isForeignKeyViolation(rawError),
      `raw FK violation not mapped: accepted=${rawAccepted} err=${detailOf(rawError)}`,
    );
    pass(
      'phase-3 raw FK violation maps via isForeignKeyViolation',
      `code 787 shape rejected on outer connection`,
    );

    const before = await countRows(db, 'SELECT COUNT(*) AS count FROM items');
    let invalid: unknown = null;
    try {
      await repos.createItem(db, {
        name: 'Ghost',
        quantity: 1,
        locationId: 999999,
      });
    } catch (error) {
      invalid = error;
    }
    const after = await countRows(db, 'SELECT COUNT(*) AS count FROM items');
    assert(
      invalid instanceof EntityNotFoundError,
      `invalid location not not-found: ${detailOf(invalid)}`,
    );
    assert(before === after, `orphan item rows: count ${before} -> ${after}`);
    pass(
      'phase-3 invalid location reference rejected with no orphan rows',
      `items=${before} unchanged`,
    );

    await db.execAsync('DROP TRIGGER IF EXISTS fixture_late_fail');
    await db.execAsync(
      `CREATE TRIGGER fixture_late_fail AFTER INSERT ON items WHEN NEW.name = '${LATE_FAIL_ITEM}' BEGIN SELECT RAISE(ABORT, 'fixture-late-failure'); END`,
    );
    let late: unknown = null;
    try {
      await repos.createItemFromDraft(db, {
        name: LATE_FAIL_ITEM,
        quantity: 1,
        location: { kind: 'new', location: { name: ORPHAN_PROBE_LOCATION } },
        categories: [],
      });
    } catch (error) {
      late = error;
    } finally {
      await db.execAsync('DROP TRIGGER IF EXISTS fixture_late_fail');
    }
    const lateText = `${detailOf(late)} ${detailOf((late as { cause?: unknown } | null)?.cause)}`;
    assert(
      late instanceof StorageError && /fixture-late-failure/.test(lateText),
      `late failure not surfaced: ${lateText}`,
    );
    const orphanItems = await countRows(
      db,
      'SELECT COUNT(*) AS count FROM items WHERE name = ?',
      [LATE_FAIL_ITEM],
    );
    const orphanLocs = await countRows(
      db,
      'SELECT COUNT(*) AS count FROM locations WHERE name = ?',
      [ORPHAN_PROBE_LOCATION],
    );
    assert(
      orphanItems === 0 && orphanLocs === 0,
      `late failure orphaned rows: items=${orphanItems} locs=${orphanLocs}`,
    );
    pass(
      'phase-3 late failure rolled back with no orphans; trigger cleaned',
      'items=0 locs=0 trigger dropped',
    );

    const zero = await repos.createItem(db, {
      name: 'ZeroCats',
      quantity: 0,
      locationId: safeIds.locB,
      categoryIds: [],
    });
    assert(
      zero.categoryIds.length === 0 && zero.categories.length === 0,
      'zero-category mapping broken',
    );
    const listed = await repos.listItems(db);
    const rawRows = await db.getAllAsync<{
      id: number;
      name: string;
      quantity: number;
      location_id: number;
    }>('SELECT id, name, quantity, location_id FROM items ORDER BY id ASC');
    assert(
      listed.length === rawRows.length,
      `list/raw count diverge: ${listed.length} vs ${rawRows.length}`,
    );
    for (const item of listed) {
      const raw = rawRows.find((row) => row.id === item.id);
      assert(
        raw !== undefined &&
          raw.name === item.name &&
          raw.quantity === item.quantity &&
          raw.location_id === item.locationId,
        `native mapping diverge for item ${item.id}`,
      );
    }
    pass(
      'phase-3 zero-category item and native query mapping hold',
      `items=${listed.length} mapped 1:1 with raw SELECT`,
    );

    assert(
      typeof db.withExclusiveTransactionAsync === 'function',
      'exclusive hook missing: mutations must fail closed',
    );
    let txnFk = -1;
    let bogusAccepted = false;
    try {
      await (
        db.withExclusiveTransactionAsync as NonNullable<
          RepositoryDb['withExclusiveTransactionAsync']
        >
      )(async (txn) => {
        txnFk = await readForeignKeys({
          getFirstAsync: (source, params) => txn.getFirstAsync(source, params),
        });
        try {
          await txn.runAsync(
            'INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)',
            [safeIds.edit, 999999],
          );
          bogusAccepted = true;
        } catch {
          // Expected when the scoped connection enforces FK.
        }
        throw new Error(PROBE_ROLLBACK);
      });
    } catch (error) {
      if ((error as Error).message !== PROBE_ROLLBACK) throw error;
    }
    assert(
      txnFk === 1 && !bogusAccepted,
      `scoped exclusive connection does NOT enforce FK (PRAGMA foreign_keys=${txnFk}, bogus join accepted=${bogusAccepted}): Transaction.createAsync opens a NEW connection without the FK pragma (SQLiteDatabase.js:561-567) — production item deletes cannot cascade; narrow driver/open-path fix required, harness must not mask it`,
    );
    pass(
      'phase-3 scoped exclusive connection enforces foreign keys',
      `txn foreign_keys=${txnFk} bogus join rejected`,
    );

    await db.closeAsync();
    await deps.deleteDatabaseAsync(REPOSITORY_FIXTURE_DB);
    return { phase: 3, status: 'pass', checks };
  } catch (error) {
    await closeQuietly(db);
    checks.push({ name: 'phase-3', pass: false, detail: detailOf(error) });
    return { phase: 3, status: 'fail', checks };
  }
}

/**
 * Run one launch of the repository fixture: open the validated fixture DB,
 * dispatch on the stored phase marker, and close (deleting only on a full
 * phase-3 pass). Never throws; every failure is a `fail` result.
 */
export async function runNativeRepositoryFixture(
  injectedDeps?: RepositoryFixtureDeps,
): Promise<RepositoryFixtureResult> {
  const deps = injectedDeps ?? defaultDeps();
  try {
    assertSafeFixtureName(REPOSITORY_FIXTURE_DB);
  } catch (error) {
    return {
      phase: 1,
      status: 'fail',
      checks: [{ name: 'fixture name', pass: false, detail: detailOf(error) }],
    };
  }
  let db: FixtureRepositoryDb;
  try {
    db = await deps.openDatabaseAsync(REPOSITORY_FIXTURE_DB);
  } catch (error) {
    return {
      phase: 1,
      status: 'fail',
      checks: [
        { name: 'harness launch', pass: false, detail: detailOf(error) },
      ],
    };
  }
  try {
    await deps.initializeDatabase(db);
    await db.execAsync(
      'CREATE TABLE IF NOT EXISTS fixture_state (key TEXT PRIMARY KEY, value TEXT)',
    );
    const marker = await readState(db, 'phase');
    if (marker === '1') return await runPhase2(deps, db);
    if (marker === '2') return await runPhase3(deps, db);
    return await runPhase1(deps, db);
  } catch (error) {
    await closeQuietly(db);
    return {
      phase: 1,
      status: 'fail',
      checks: [
        { name: 'harness launch', pass: false, detail: detailOf(error) },
      ],
    };
  }
}
