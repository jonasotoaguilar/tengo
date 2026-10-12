/**
 * DEV-ONLY native SQLite fixture runner (T3 verification infrastructure).
 *
 * Never imported on the normal path: `App.tsx` loads this (via
 * `NativeSqliteFixtureScreen`) only inside the guarded
 * `__DEV__ && EXPO_PUBLIC_NATIVE_FIXTURE=1` branch, which bypasses the
 * normal `ReadinessScreen` entirely and therefore never opens `tengo.db`.
 * Release builds (`__DEV__ === false`) cannot opt in: the public env flag
 * alone does nothing.
 *
 * Every fixture database uses a unique `m1-fixture-*.db` name validated by
 * `assertSafeFixtureName` before open AND delete; `tengo.db`
 * (`DATABASE_NAME`) is always refused. Each case closes its database before
 * deleting the fixture file, in `finally`, so reruns never leak handles.
 *
 * Cases target schema v4 (catalog `items` plus `stock`): the catalog
 * survives a location delete while its stock rows cascade (R3).
 *
 * This runs the REAL `expo-sqlite` driver with the ACTUAL
 * `initializeDatabase(db)` from `src/db` — no mocks here. Unit tests cover
 * orchestration with injected fakes only and never claim native proof.
 */
import {
  DATABASE_NAME,
  type DatabaseLike,
  MigrationRequiredError,
  initializeDatabase as realInitializeDatabase,
} from '../db';
import { MIGRATIONS } from '../db/migrations';

/** Real-database handle subset needed by the fixture cases. */
export interface FixtureDb extends Omit<DatabaseLike, 'getFirstAsync'> {
  getFirstAsync(source: string, params?: unknown): Promise<unknown>;
  getAllAsync?<T>(source: string, params?: unknown): Promise<T[]>;
  runAsync?(
    source: string,
    params?: unknown,
  ): Promise<{ lastInsertRowId: number; changes: number }>;
  closeAsync?(): Promise<void>;
}

export interface FixtureDeps {
  openDatabaseAsync(name: string): Promise<FixtureDb>;
  deleteDatabaseAsync(name: string): Promise<void>;
  initializeDatabase(db: DatabaseLike): Promise<unknown>;
}

export interface FixtureCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface FixtureResult {
  pass: boolean;
  checks: FixtureCheck[];
}

function defaultDeps(): FixtureDeps {
  // Loaded lazily so importing this module never opens a database; the
  // real driver is only touched when the guarded fixture screen runs.
  const SQLite = require('expo-sqlite') as {
    openDatabaseAsync(name: string): Promise<FixtureDb>;
    deleteDatabaseAsync(name: string): Promise<void>;
  };
  return {
    openDatabaseAsync: (name) => SQLite.openDatabaseAsync(name),
    deleteDatabaseAsync: (name) => SQLite.deleteDatabaseAsync(name),
    initializeDatabase: (db) => realInitializeDatabase(db),
  };
}

/** True only for dev launches with the explicit public fixture flag. */
export function isNativeFixtureEnabled(): boolean {
  try {
    const dev = (globalThis as Record<string, unknown>).__DEV__ === true;
    return dev && process.env.EXPO_PUBLIC_NATIVE_FIXTURE === '1';
  } catch {
    return false;
  }
}

/** Fixture names only: `m1-fixture-<alnum-dash-underscore>.db`, never else. */
export function isSafeFixtureName(name: string): boolean {
  if (name === DATABASE_NAME) return false;
  return /^m1-fixture-[A-Za-z0-9_-]+\.db$/.test(name);
}

/** Throw before any open/delete when the name is not a fixture name. */
export function assertSafeFixtureName(name: string): void {
  if (!isSafeFixtureName(name)) {
    throw new Error(
      `Refusing unsafe fixture database name "${name}": expected m1-fixture-*.db, never ${DATABASE_NAME}.`,
    );
  }
}

async function getCount(
  db: FixtureDb,
  sql: string,
  params?: unknown,
): Promise<number> {
  const row = (await db.getFirstAsync(sql, params as never)) as {
    count: number;
  } | null;
  return row?.count ?? -1;
}

async function insert(
  db: FixtureDb,
  sql: string,
  params?: unknown[],
): Promise<number> {
  if (typeof db.runAsync === 'function') {
    const res = await db.runAsync(sql, (params ?? []) as never);
    return res.lastInsertRowId;
  }
  await db.execAsync(sql);
  return 1;
}

async function expectRejects(
  db: FixtureDb,
  sql: string,
  params?: unknown[],
): Promise<string> {
  try {
    await insert(db, sql, params);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected rejection but insert succeeded: ${sql}`);
}

/**
 * Open a validated fixture database, run `task`, then close it BEFORE
 * deleting the fixture file. Pre-deletes stale files from aborted runs.
 */
async function withFixtureDb(
  deps: FixtureDeps,
  name: string,
  task: (db: FixtureDb) => Promise<{ name: string; detail: string }>,
  checks: FixtureCheck[],
): Promise<void> {
  assertSafeFixtureName(name);
  try {
    await deps.deleteDatabaseAsync(name).catch(() => {});
    const db = await deps.openDatabaseAsync(name);
    try {
      const done = await task(db);
      checks.push({ name: done.name, pass: true, detail: done.detail });
    } finally {
      try {
        await db.closeAsync?.();
      } catch {
        // Close failures must not skip fixture cleanup below.
      }
      await deps.deleteDatabaseAsync(name).catch(() => {});
    }
  } catch (error) {
    checks.push({
      name,
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Run every M1 fixture case against real `expo-sqlite`; never throws. */
export async function runNativeSqliteFixture(
  injectedDeps?: FixtureDeps,
): Promise<FixtureResult> {
  const deps = injectedDeps ?? defaultDeps();
  const checks: FixtureCheck[] = [];

  await withFixtureDb(
    deps,
    'm1-fixture-fresh.db',
    async (db) => {
      await deps.initializeDatabase(db);
      const version = (
        (await db.getFirstAsync('PRAGMA user_version')) as {
          user_version: number;
        } | null
      )?.user_version;
      const tableRows =
        typeof db.getAllAsync === 'function'
          ? await db.getAllAsync<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
          : [];
      const tableNames = tableRows
        .map((r) => r.name)
        .sort()
        .join(',');
      if (version !== 4) throw new Error(`user_version=${version}, want 4`);
      for (const t of [
        'locations',
        'categories',
        'items',
        'item_categories',
        'stock',
      ]) {
        if (!tableNames.includes(t)) throw new Error(`missing table ${t}`);
      }
      return {
        name: 'fresh database migrates to v4',
        detail: `v4 tables: ${tableNames}`,
      };
    },
    checks,
  );

  await withFixtureDb(
    deps,
    'm1-fixture-empty-v1.db',
    async (db) => {
      await db.execAsync(MIGRATIONS[1]);
      await db.execAsync('PRAGMA user_version = 1');
      await deps.initializeDatabase(db);
      const version = (
        (await db.getFirstAsync('PRAGMA user_version')) as {
          user_version: number;
        } | null
      )?.user_version;
      if (version !== 4) throw new Error(`user_version=${version}, want 4`);
      return { name: 'empty v1 migrates to v4', detail: 'user_version=4' };
    },
    checks,
  );

  await withFixtureDb(
    deps,
    'm1-fixture-constraints.db',
    async (db) => {
      await deps.initializeDatabase(db);
      const fkRaw = await db.getFirstAsync('PRAGMA foreign_keys');
      const fkOn =
        typeof fkRaw === 'number'
          ? fkRaw
          : (fkRaw as { foreign_keys?: number } | null)?.foreign_keys;
      if (fkOn !== 1) throw new Error(`PRAGMA foreign_keys=${fkOn}, want 1`);
      const locId = await insert(
        db,
        "INSERT INTO locations (name) VALUES ('Casa')",
      );
      // The catalog holds identity only: no quantity, no location.
      const itemId = await insert(
        db,
        "INSERT INTO items (name) VALUES ('Rice')",
      );
      const items = await getCount(db, 'SELECT COUNT(*) AS count FROM items');
      if (items !== 1) throw new Error(`items=${items}, want 1`);
      // Stock carries the quantity at the location.
      await insert(
        db,
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
        [itemId, locId, 2],
      );
      const stockRows = await getCount(
        db,
        'SELECT COUNT(*) AS count FROM stock',
      );
      if (stockRows !== 1) throw new Error(`stock=${stockRows}, want 1`);
      const catA = await insert(
        db,
        "INSERT INTO categories (name) VALUES ('Grains')",
      );
      const catB = await insert(
        db,
        "INSERT INTO categories (name) VALUES ('Staples')",
      );
      await insert(
        db,
        'INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)',
        [itemId, catA],
      );
      await insert(
        db,
        'INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)',
        [itemId, catB],
      );
      const joins = await getCount(
        db,
        'SELECT COUNT(*) AS count FROM item_categories',
      );
      if (joins < 2) throw new Error(`joins=${joins}, want >= 2`);
      const dupError = await expectRejects(
        db,
        'INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)',
        [itemId, catA],
      );
      // A stock row means something is stored there: zero is rejected.
      const zeroError = await expectRejects(
        db,
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
        [itemId, locId, 0],
      );
      const dupStockError = await expectRejects(
        db,
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
        [itemId, locId, 3],
      );
      const absentItemError = await expectRejects(
        db,
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
        [9999, locId, 1],
      );
      const absentLocError = await expectRejects(
        db,
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
        [itemId, 9999, 1],
      );
      const fracError = await expectRejects(
        db,
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
        [itemId, locId, 1.5],
      );
      const textError = await expectRejects(
        db,
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
        [itemId, locId, 'not-a-number'],
      );
      // R3: deleting the location removes its stock rows; the catalog
      // item survives (and keeps its category links). `locId` is a
      // driver-returned integer from our own insert above, never user
      // input; `execAsync` takes no params so interpolation is safe here.
      await db.execAsync(`DELETE FROM locations WHERE id = ${locId}`);
      const stockAfter = await getCount(
        db,
        'SELECT COUNT(*) AS count FROM stock',
      );
      const itemsAfter = await getCount(
        db,
        'SELECT COUNT(*) AS count FROM items',
      );
      const joinsAfter = await getCount(
        db,
        'SELECT COUNT(*) AS count FROM item_categories',
      );
      if (stockAfter !== 0 || itemsAfter !== 1 || joinsAfter !== 2) {
        throw new Error(
          `location delete: stock=${stockAfter} items=${itemsAfter} joins=${joinsAfter}, want 0/1/2`,
        );
      }
      return {
        name: 'constraints hold on device SQLite',
        detail:
          `fk=ON, catalog+stock ok, joins=${joins}, duplicate rejected (${dupError.slice(0, 40)}), ` +
          `zero/dup stock rejected, absent item/location rejected, 1.5 + text qty rejected (${fracError.slice(0, 30)} / ${textError.slice(0, 30)}; ${zeroError.slice(0, 20)} / ${dupStockError.slice(0, 20)} / ${absentItemError.slice(0, 20)} / ${absentLocError.slice(0, 20)}), ` +
          `location delete cascades stock only (stock=0 items=1 joins=2)`,
      };
    },
    checks,
  );

  await withFixtureDb(
    deps,
    'm1-fixture-populated-v1.db',
    async (db) => {
      await db.execAsync(MIGRATIONS[1]);
      await db.execAsync("INSERT INTO items (name) VALUES ('LegacyRice')");
      await db.execAsync('PRAGMA user_version = 1');
      let blocked = false;
      try {
        await deps.initializeDatabase(db);
      } catch (error) {
        if (error instanceof MigrationRequiredError) blocked = true;
        else throw error;
      }
      if (!blocked)
        throw new Error('populated v1 was migrated instead of blocked');
      const rows = await getCount(db, 'SELECT COUNT(*) AS count FROM items');
      const version = (
        (await db.getFirstAsync('PRAGMA user_version')) as {
          user_version: number;
        } | null
      )?.user_version;
      if (rows !== 1 || version !== 1) {
        throw new Error(`rows=${rows} version=${version}, want 1/1 preserved`);
      }
      return {
        name: 'populated v1 safe stop preserves rows/version',
        detail: 'rows=1 version=1',
      };
    },
    checks,
  );

  await withFixtureDb(
    deps,
    'm1-fixture-rollback.db',
    async (db) => {
      await deps.initializeDatabase(db);
      if (typeof db.withTransactionAsync !== 'function') {
        throw new Error('withTransactionAsync unavailable on this driver');
      }
      try {
        await db.withTransactionAsync(async () => {
          await insert(
            db,
            "INSERT INTO locations (name) VALUES ('RollbackProbe')",
          );
          await db.execAsync('PRAGMA user_version = 99');
          throw new Error('forced-transaction-failure');
        });
      } catch (error) {
        if ((error as Error).message !== 'forced-transaction-failure')
          throw error;
      }
      const version = (
        (await db.getFirstAsync('PRAGMA user_version')) as {
          user_version: number;
        } | null
      )?.user_version;
      const probes = await getCount(
        db,
        "SELECT COUNT(*) AS count FROM locations WHERE name = 'RollbackProbe'",
      );
      if (version !== 4 || probes !== 0) {
        throw new Error(
          `version=${version} probes=${probes}, want 4/0 rolled back`,
        );
      }
      return {
        name: 'forced transaction failure rolls back',
        detail: 'version=4 probes=0',
      };
    },
    checks,
  );

  return { pass: checks.length > 0 && checks.every((c) => c.pass), checks };
}
