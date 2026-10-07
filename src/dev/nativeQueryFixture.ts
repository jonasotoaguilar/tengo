/**
 * DEV-ONLY native query fixture (P3b3 verification infrastructure).
 *
 * Never imported on the normal path: `App.tsx` loads this (via
 * `NativeQueryFixtureScreen`) only inside the guarded
 * `__DEV__ && EXPO_PUBLIC_NATIVE_FIXTURE=1 &&
 * EXPO_PUBLIC_NATIVE_QUERY=1` branch, which bypasses the normal
 * `InventoryContainer` bootstrap entirely and therefore never opens
 * `tengo.db`. Release builds (`__DEV__ === false`) cannot opt in, and the
 * M1-only / repository flag combinations keep their existing behavior.
 *
 * This runs the REAL `expo-sqlite` driver through the SHARED
 * `openManagedDatabase` factory with the ACTUAL
 * `initializeDatabase(db)` and the ACTUAL entity/item/query repository
 * APIs — no direct SQLite opener, no harness FK patch, no fabricated
 * schema or results. Only the two named fixture files below are ever
 * opened; production or unexpected names are refused BEFORE open.
 *
 * The seeded database keeps an exact-dataset marker in the fixture-local
 * `fixture_state` table. A second launch with the marker AND the exact
 * dataset passes without duplicating rows; a marker mismatch or any
 * unexpected pre-existing rows fail closed WITHOUT overwriting. The
 * fixture database is retained on pass AND fail for the native verifier —
 * this module never deletes, resets, or closes the returned handle.
 *
 * Unit tests cover orchestration with injected fakes only and never claim
 * native proof.
 */
import { initializeDatabase as realInitializeDatabase } from '../db';
import { openManagedDatabase } from '../db/exclusive';
import {
  type RepositoryDb,
  createCategory as realCreateCategory,
  createItem as realCreateItem,
  createLocation as realCreateLocation,
} from '../inventory';
import {
  listCategories as realListCategories,
  listLocations as realListLocations,
} from '../inventory/entityRepository';
import { queryItems as realQueryItems } from '../inventory/itemQuery';

/** Seeded query dataset for the M3 read-model checks. */
export const QUERY_FIXTURE_SEEDED_DB = 'm1-fixture-query-m3.db';
/** Unseeded variant for the first-run empty state. */
export const QUERY_FIXTURE_EMPTY_DB = 'm1-fixture-query-m3-empty.db';

const SEED_MARKER = 'query-m3-seed';

const LOC_KUECHE = 'Küche';
const LOC_GARAGE = 'Garage';
const CAT_TOOLS = 'Tools';
const CAT_KITCHEN = 'Kitchen';
const CAT_STOCK = '100%_stock';

export interface QueryFixtureDb extends RepositoryDb {
  execAsync(source: string): Promise<void>;
  closeAsync(): Promise<void>;
}

export interface QueryFixtureRepos {
  createLocation: typeof realCreateLocation;
  createCategory: typeof realCreateCategory;
  createItem: typeof realCreateItem;
}

export interface QueryFixtureDeps {
  openDatabaseAsync(name: string): Promise<QueryFixtureDb>;
  initializeDatabase(db: QueryFixtureDb): Promise<unknown>;
  repos: QueryFixtureRepos;
  queryItems: typeof realQueryItems;
  listLocations: typeof realListLocations;
  listCategories: typeof realListCategories;
  now: () => number;
}

export interface QueryFixtureCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface QueryFixtureResult {
  database: string;
  status: 'pass' | 'fail';
  checks: QueryFixtureCheck[];
  /** Open fixture handle, retained for the embedded list; null on failure. */
  db: QueryFixtureDb | null;
}

function defaultDeps(): QueryFixtureDeps {
  // Loaded lazily so importing this module never opens a database. Opens
  // through the EXACT production managed factory with the fixture file —
  // no harness-only pragma and no overridden repositories.
  return {
    openDatabaseAsync: (name) =>
      openManagedDatabase(name) as unknown as Promise<QueryFixtureDb>,
    initializeDatabase: (db) => realInitializeDatabase(db),
    repos: {
      createLocation: realCreateLocation,
      createCategory: realCreateCategory,
      createItem: realCreateItem,
    },
    queryItems: realQueryItems,
    listLocations: realListLocations,
    listCategories: realListCategories,
    now: () => performance.now(),
  };
}

/** True only for dev launches with BOTH public fixture flags. */
export function isNativeQueryFixtureEnabled(): boolean {
  try {
    const dev = (globalThis as Record<string, unknown>).__DEV__ === true;
    return (
      dev &&
      process.env.EXPO_PUBLIC_NATIVE_FIXTURE === '1' &&
      process.env.EXPO_PUBLIC_NATIVE_QUERY === '1'
    );
  } catch {
    return false;
  }
}

/** Only the two named query fixture files; everything else is refused. */
export function isSafeQueryFixtureName(name: string): boolean {
  return name === QUERY_FIXTURE_SEEDED_DB || name === QUERY_FIXTURE_EMPTY_DB;
}

/** Throw before any open when the name is not a query fixture name. */
export function assertSafeQueryFixtureName(name: string): void {
  if (!isSafeQueryFixtureName(name)) {
    throw new Error(
      `Refusing unsafe query fixture database name "${name}": expected ${QUERY_FIXTURE_SEEDED_DB} or ${QUERY_FIXTURE_EMPTY_DB}, never production.`,
    );
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(checks: QueryFixtureCheck[], name: string, error: unknown): void {
  checks.push({ name, pass: false, detail: detailOf(error) });
}

/** Read `PRAGMA foreign_keys` / `user_version` across driver row shapes. */
async function readPragmaNumber(
  db: QueryFixtureDb,
  pragma: string,
): Promise<number> {
  const raw = await db.getFirstAsync<unknown>(`PRAGMA ${pragma}`);
  if (typeof raw === 'number') return raw;
  const value = (raw as Record<string, unknown> | null)?.[pragma];
  return typeof value === 'number' ? value : -1;
}

async function readMarker(db: QueryFixtureDb): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value AS value FROM fixture_state WHERE key = ?',
    [SEED_MARKER],
  );
  return row?.value ?? null;
}

async function writeMarker(db: QueryFixtureDb, value: string): Promise<void> {
  await db.runAsync(
    'INSERT OR REPLACE INTO fixture_state (key, value) VALUES (?, ?)',
    [SEED_MARKER, value],
  );
}

/**
 * Seed the exact M3 dataset via the real repositories: 2 locations, 3
 * categories, 5 items. Runs inside the adapter's own transactional repo
 * APIs — never nested exclusive transactions from the harness.
 */
async function seedExactDataset(
  deps: QueryFixtureDeps,
  db: QueryFixtureDb,
): Promise<void> {
  const { repos } = deps;
  const kueche = await repos.createLocation(db, { name: LOC_KUECHE });
  const garage = await repos.createLocation(db, { name: LOC_GARAGE });
  const tools = await repos.createCategory(db, { name: CAT_TOOLS });
  const kitchen = await repos.createCategory(db, { name: CAT_KITCHEN });
  const stock = await repos.createCategory(db, { name: CAT_STOCK });
  await repos.createItem(db, {
    name: 'Café Grinder',
    quantity: 2,
    locationId: kueche.id,
    categoryIds: [kitchen.id],
  });
  await repos.createItem(db, {
    name: 'CAFÉ filter',
    quantity: 0,
    locationId: kueche.id,
    categoryIds: [tools.id],
  });
  await repos.createItem(db, {
    name: '100%_literal\\blend',
    quantity: 1,
    locationId: garage.id,
    categoryIds: [stock.id],
  });
  await repos.createItem(db, {
    name: 'Hammer',
    quantity: 5,
    locationId: garage.id,
    categoryIds: [tools.id, kitchen.id],
  });
  await repos.createItem(db, {
    name: 'Nail',
    quantity: 0,
    locationId: garage.id,
    categoryIds: [],
  });
  await writeMarker(
    db,
    JSON.stringify({
      locations: 2,
      categories: 3,
      items: 5,
    }),
  );
}

interface DatasetSnapshot {
  locationNames: string[];
  categoryNames: string[];
  itemSummaries: string[];
}

/** Exact-dataset verification: names, quantities, and relations verbatim. */
async function snapshotDataset(
  deps: QueryFixtureDeps,
  db: QueryFixtureDb,
): Promise<DatasetSnapshot> {
  const locations = await deps.listLocations(db);
  const categories = await deps.listCategories(db);
  const items = await deps.queryItems(db, {});
  return {
    locationNames: locations.map((loc) => loc.name).sort(),
    categoryNames: categories.map((cat) => cat.name).sort(),
    itemSummaries: items
      .map(
        (item) =>
          `${item.name}|${item.quantity}|${item.location.name}|${[...item.categoryIds].sort((a, b) => a - b).join('+')}`,
      )
      .sort(),
  };
}

function isExactDataset(snapshot: DatasetSnapshot): boolean {
  if (
    snapshot.locationNames.join('\u0000') !==
    [LOC_GARAGE, LOC_KUECHE].sort().join('\u0000')
  ) {
    return false;
  }
  if (
    snapshot.categoryNames.join('\u0000') !==
    [CAT_KITCHEN, CAT_STOCK, CAT_TOOLS].sort().join('\u0000')
  ) {
    return false;
  }
  if (snapshot.itemSummaries.length !== 5) return false;
  const byName = new Map(
    snapshot.itemSummaries.map((summary) => [summary.split('|')[0], summary]),
  );
  if (
    !byName.has('Café Grinder') ||
    !byName.has('CAFÉ filter') ||
    !byName.has('100%_literal\\blend') ||
    !byName.has('Hammer') ||
    !byName.has('Nail')
  ) {
    return false;
  }
  const quantityOf = (name: string): string =>
    (byName.get(name) ?? '').split('|')[1] ?? '';
  const categoriesOf = (name: string): string =>
    (byName.get(name) ?? '').split('|')[3] ?? 'missing';
  return (
    quantityOf('Café Grinder') === '2' &&
    quantityOf('CAFÉ filter') === '0' &&
    quantityOf('100%_literal\\blend') === '1' &&
    quantityOf('Hammer') === '5' &&
    quantityOf('Nail') === '0' &&
    categoriesOf('Nail') === '' &&
    categoriesOf('Hammer').split('+').length === 2
  );
}

/**
 * Run the query fixture for one named database: validate the name, open
 * through the shared factory, run real migrations, ensure or verify the
 * seed (seeded variant only), then run every read-model check through the
 * real query APIs. Never throws; the handle stays open for the verifier.
 */
export async function runNativeQueryFixture(
  database: string = QUERY_FIXTURE_SEEDED_DB,
  injectedDeps?: QueryFixtureDeps,
): Promise<QueryFixtureResult> {
  const deps = injectedDeps ?? defaultDeps();
  const checks: QueryFixtureCheck[] = [];
  const failResult = (name: string, error: unknown): QueryFixtureResult => {
    fail(checks, name, error);
    return { database, status: 'fail', checks, db: null };
  };
  try {
    assertSafeQueryFixtureName(database);
  } catch (error) {
    return failResult('fixture name', error);
  }
  let db: QueryFixtureDb;
  try {
    db = await deps.openDatabaseAsync(database);
  } catch (error) {
    return failResult('harness launch', error);
  }
  const pass = (name: string, detail: string) =>
    checks.push({ name, pass: true, detail });
  try {
    await deps.initializeDatabase(db);
    await db.execAsync(
      'CREATE TABLE IF NOT EXISTS fixture_state (key TEXT PRIMARY KEY, value TEXT)',
    );
    const version = await readPragmaNumber(db, 'user_version');
    if (version !== 2) throw new Error(`user_version=${version}, want 2`);
    const fk = await readPragmaNumber(db, 'foreign_keys');
    if (fk !== 1) throw new Error(`PRAGMA foreign_keys=${fk}, want 1`);
    pass(
      'fixture database initialized to v2 with FK ON',
      `user_version=2 foreign_keys=1 ${database}`,
    );

    if (database === QUERY_FIXTURE_EMPTY_DB) {
      const items = await deps.queryItems(db, {});
      if (items.length !== 0) {
        throw new Error(
          `empty variant holds ${items.length} items: refusing seeded state`,
        );
      }
      pass(
        'empty database has no seeded rows for first-run',
        'items=0 locations/categories unread (first-run owns the empty state)',
      );
      return { database, status: 'pass', checks, db };
    }

    const marker = await readMarker(db);
    if (marker === null) {
      const before = await snapshotDataset(deps, db);
      if (
        before.locationNames.length > 0 ||
        before.categoryNames.length > 0 ||
        before.itemSummaries.length > 0
      ) {
        throw new Error(
          'unseeded fixture holds unexpected rows: refusing to overwrite partial state',
        );
      }
      await seedExactDataset(deps, db);
      pass(
        'seeded exact dataset via repository APIs',
        'locations=2 categories=3 items=5 marker stored',
      );
    } else {
      const snapshot = await snapshotDataset(deps, db);
      if (!isExactDataset(snapshot)) {
        throw new Error(
          'seed marker present but dataset differs: refusing to overwrite partial state',
        );
      }
      pass(
        'seed already present with exact dataset, no duplicates',
        'locations=2 categories=3 items=5 marker verified',
      );
    }

    const timed = async <T>(
      label: string,
      task: () => Promise<T>,
    ): Promise<T> => {
      const start = deps.now();
      try {
        return await task();
      } finally {
        const elapsed = deps.now() - start;
        checks.push({
          name: `timing (diagnostic): ${label}`,
          pass: true,
          detail: `${elapsed.toFixed(1)}ms wall time, no budget asserted`,
        });
      }
    };

    const lower = await timed('unicode query', () =>
      deps.queryItems(db, { query: 'café' }),
    );
    if (lower.length !== 2) {
      throw new Error(`unicode café matched ${lower.length} items, want 2`);
    }
    const upper = await deps.queryItems(db, { query: 'CAFÉ' });
    if (upper.length !== 2) {
      throw new Error(`unicode CAFÉ matched ${upper.length} items, want 2`);
    }
    pass(
      'unicode café matches 2 items',
      `${lower.map((item) => item.name).join(' + ')}`,
    );

    const folded = await deps.queryItems(db, { query: 'cafe' });
    if (folded.length !== 0) {
      throw new Error(
        `no-accent-folding violated: cafe matched ${folded.length} items`,
      );
    }
    pass('no accent folding: cafe matches 0', 'verbatim substring only');

    const literal = await deps.queryItems(db, { query: '100%' });
    if (literal.length !== 1) {
      throw new Error(`literal 100% matched ${literal.length} items, want 1`);
    }
    const backslash = await deps.queryItems(db, { query: '\\' });
    if (backslash.length !== 1) {
      throw new Error(
        `backslash literal matched ${backslash.length} items, want 1`,
      );
    }
    pass(
      'literal 100% and backslash match verbatim',
      `${literal[0].name}: no LIKE wildcards`,
    );

    const locations = await deps.listLocations(db);
    const categories = await deps.listCategories(db);
    const garage = locations.find((loc) => loc.name === LOC_GARAGE);
    const tools = categories.find((cat) => cat.name === CAT_TOOLS);
    const kitchen = categories.find((cat) => cat.name === CAT_KITCHEN);
    const stock = categories.find((cat) => cat.name === CAT_STOCK);
    if (!garage || !tools || !kitchen || !stock) {
      throw new Error('seeded locations/categories missing for AND/OR check');
    }
    const andOr = await deps.queryItems(db, {
      locationId: garage.id,
      categoryIds: [tools.id, stock.id],
    });
    const andOrNames = andOr.map((item) => item.name).sort();
    if (
      andOrNames.length !== 2 ||
      !andOrNames.some((name) => name.includes('100%')) ||
      !andOrNames.includes('Hammer')
    ) {
      throw new Error(
        `location-AND category-OR matched [${andOrNames.join(', ')}], want 100%-item + Hammer`,
      );
    }
    pass(
      'location AND category-OR matches',
      `Garage × (Tools OR 100%_stock) = ${andOrNames.join(' + ')}`,
    );

    const all = await deps.queryItems(db, {});
    if (all.length !== 5) {
      throw new Error(`unfiltered query returned ${all.length} items, want 5`);
    }
    const ids = all.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error('duplicate rows in unfiltered query');
    }
    const hammer = all.filter((item) => item.name === 'Hammer');
    if (hammer.length !== 1 || hammer[0].categoryIds.length !== 2) {
      throw new Error('multicategory Hammer duplicated or split');
    }
    pass(
      'no duplicates including multicategory Hammer',
      '5 rows, 5 distinct ids, Hammer once with 2 categories',
    );

    const exhausted = all
      .filter((item) => item.quantity === 0)
      .map((item) => item.name)
      .sort();
    if (exhausted.join('\u0000') !== ['CAFÉ filter', 'Nail'].join('\u0000')) {
      throw new Error(
        `exhausted=[${exhausted.join(', ')}], want CAFÉ filter + Nail`,
      );
    }
    const nail = all.find((item) => item.name === 'Nail');
    if (nail?.categoryIds.length !== 0) {
      throw new Error('zero-many mapping broken for Nail');
    }
    const kueche = locations.find((loc) => loc.name === LOC_KUECHE);
    if (!kueche) throw new Error('Küche location missing for group counts');
    const kuecheItems = await deps.queryItems(db, { locationId: kueche.id });
    const garageItems = await deps.queryItems(db, { locationId: garage.id });
    if (kuecheItems.length !== 2 || garageItems.length !== 3) {
      throw new Error(
        `group counts Küche=${kuecheItems.length} Garage=${garageItems.length}, want 2/3`,
      );
    }
    pass(
      'exhausted zero quantities map with group counts',
      'exhausted=CAFÉ filter+Nail zero-many Nail=[] groups Küche=2 Garage=3',
    );

    return { database, status: 'pass', checks, db };
  } catch (error) {
    // Retain the database file for the native verifier: never delete or
    // reset here. The handle stays open only on success; a failed launch
    // keeps the file on disk for inspection.
    fail(checks, database, error);
    return { database, status: 'fail', checks, db: null };
  }
}

export interface QueryReadFault {
  armed: boolean;
}

/** Explicit fault-injection flag: never real database corruption. */
export function createQueryReadFault(): QueryReadFault {
  return { armed: false };
}

/** Arm a single next-read failure for the generic error/retry path. */
export function armQueryReadFault(fault: QueryReadFault): void {
  fault.armed = true;
}

/**
 * Wrap a real fixture handle: `getAllAsync` rejects ONCE while the fault
 * is armed (surfacing the generic list error + retry), otherwise every
 * call passes straight through to the actual driver. The database is
 * never killed or closed to force the error.
 */
export function makeFaultableQueryDb<TDb extends RepositoryDb>(
  db: TDb,
  fault: QueryReadFault,
): { fault: QueryReadFault; db: TDb } {
  const wrapped = Object.create(
    Object.getPrototypeOf(db),
    Object.getOwnPropertyDescriptors(db),
  ) as TDb;
  const realGetAll = db.getAllAsync.bind(db);
  wrapped.getAllAsync = (async <T>(
    source: string,
    params?: (string | number | null)[],
  ): Promise<T[]> => {
    if (fault.armed) {
      fault.armed = false;
      throw new Error('query-fixture injected read failure');
    }
    return realGetAll(source, params as never) as Promise<T[]>;
  }) as TDb['getAllAsync'];
  return { fault, db: wrapped };
}
