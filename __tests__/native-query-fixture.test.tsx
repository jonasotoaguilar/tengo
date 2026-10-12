/**
 * DEV-ONLY native query fixture orchestration tests (P3b3, Jest/RNTL only).
 *
 * Hermetic tests with injected fakes: the real `queryItems`,
 * `listLocations`, and `listCategories` run against a canned fake driver,
 * while seed writes go through injected repo fakes. Nothing here opens a
 * real database and nothing here is native proof.
 */
import { DATABASE_NAME } from '../src/db';
import {
  armQueryReadFault,
  assertSafeQueryFixtureName,
  createQueryReadFault,
  isNativeQueryFixtureEnabled,
  makeFaultableQueryDb,
  QUERY_FIXTURE_EMPTY_DB,
  QUERY_FIXTURE_SEEDED_DB,
  type QueryFixtureDeps,
  runNativeQueryFixture,
} from '../src/dev/nativeQueryFixture';
import type { RepositoryDb } from '../src/inventory/database';
import {
  listCategories as realListCategories,
  listLocations as realListLocations,
} from '../src/inventory/entityRepository';
import { EntityNotFoundError } from '../src/inventory/errors';
import { queryItems as realQueryItems } from '../src/inventory/itemQuery';

const DEV = globalThis as Record<string, unknown>;
const ENV = process.env;

function setQueryEnv(
  dev: boolean,
  fixture: string | undefined,
  query: string | undefined,
) {
  DEV.__DEV__ = dev;
  if (fixture === undefined) delete ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
  else ENV.EXPO_PUBLIC_NATIVE_FIXTURE = fixture;
  if (query === undefined) delete ENV.EXPO_PUBLIC_NATIVE_QUERY;
  else ENV.EXPO_PUBLIC_NATIVE_QUERY = query;
}

interface Store {
  marker: string | null;
  nextId: number;
  locations: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  itemRows: Record<string, unknown>[];
  stockRows: Record<string, unknown>[];
  linkRows: Record<string, unknown>[];
}

function freshStore(): Store {
  return {
    marker: null,
    nextId: 1,
    locations: [],
    categories: [],
    itemRows: [],
    stockRows: [],
    linkRows: [],
  };
}

function makeDeps(store: Store, calls: string[]): QueryFixtureDeps {
  const fakeDb = {
    execAsync: jest.fn(async () => {}),
    runAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      if (/fixture_state/.test(sql)) {
        if ((params as unknown[])[0] === 'query-m3-seed') {
          store.marker = String((params as unknown[])[1]);
        }
        return { lastInsertRowId: 1, changes: 1 };
      }
      return { lastInsertRowId: 1, changes: 1 };
    }),
    getFirstAsync: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (/fixture_state/.test(sql)) {
        return store.marker ? { value: store.marker } : null;
      }
      if (/PRAGMA user_version/.test(sql)) return { user_version: 4 };
      if (/PRAGMA foreign_keys/.test(sql)) return { foreign_keys: 1 };
      return null;
    }),
    getAllAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('item_categories')) return store.linkRows;
      // The catalog read comes first: its EXISTS membership subquery
      // itself contains `FROM stock s`, so `FROM items i` must route here.
      if (sql.includes('FROM items i')) {
        if (/EXISTS[\s\S]*location_id = \?/i.test(sql)) {
          const member = (params as number[])[0];
          const memberIds = new Set(
            store.stockRows
              .filter((row) => row.location_id === member)
              .map((row) => row.stock_item_id),
          );
          return store.itemRows.filter((row) =>
            memberIds.has(row.item_id as number),
          );
        }
        return store.itemRows;
      }
      // The batched stock+locations join replaces the old separate
      // locations read: breakdown rows plus location names in one read.
      if (sql.includes('FROM stock s')) {
        const ids = new Set((params as number[]) ?? []);
        return store.stockRows.filter((row) =>
          ids.has(row.stock_item_id as number),
        );
      }
      // `listLocations`/`listCategories` select the bare shape.
      if (sql.includes('FROM locations')) return store.locations;
      if (sql.includes('FROM categories')) return store.categories;
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    closeAsync: jest.fn(async () => {}),
  };
  const locById = (id: number) =>
    store.locations.find((row) => row.id === id) as
      | { id: number; name: string }
      | undefined;
  const catById = (id: number) =>
    store.categories.find((row) => row.id === id) as
      | { id: number; name: string }
      | undefined;
  return {
    openDatabaseAsync: jest.fn(async (name: string) => {
      calls.push(name);
      return fakeDb;
    }),
    initializeDatabase: jest.fn(async () => ({})),
    repos: {
      createLocation: jest.fn(async (_db: unknown, input: { name: string }) => {
        calls.push(`createLocation:${input.name}`);
        const id = store.nextId++;
        const row = { id, name: input.name, address: null, created_at: 't' };
        store.locations.push(row);
        return row;
      }),
      createCategory: jest.fn(async (_db: unknown, input: { name: string }) => {
        calls.push(`createCategory:${input.name}`);
        const id = store.nextId++;
        const row = { id, name: input.name, created_at: 't' };
        store.categories.push(row);
        return row;
      }),
      createItem: jest.fn(
        async (
          _db: unknown,
          input: {
            name: string;
            stock?: { locationId: number; quantity: number }[];
            categoryIds?: number[];
          },
        ) => {
          calls.push(`createItem:${input.name}`);
          for (const row of input.stock ?? []) {
            if (!locById(row.locationId))
              throw new EntityNotFoundError('location', row.locationId);
          }
          for (const cid of input.categoryIds ?? []) {
            if (!catById(cid)) throw new EntityNotFoundError('category', cid);
          }
          const id = store.nextId++;
          store.itemRows.push({
            item_id: id,
            item_name: input.name,
            item_created_at: 't',
          });
          for (const row of input.stock ?? []) {
            const loc = locById(row.locationId) as {
              id: number;
              name: string;
            };
            store.stockRows.push({
              stock_item_id: id,
              quantity: row.quantity,
              location_id: loc.id,
              location_name: loc.name,
              location_address: null,
              location_created_at: 't',
            });
          }
          for (const cid of input.categoryIds ?? []) {
            const cat = catById(cid) as { id: number; name: string };
            store.linkRows.push({
              link_item_id: id,
              category_id: cat.id,
              category_name: cat.name,
              category_created_at: 't',
            });
          }
          return { id };
        },
      ),
    },
    queryItems: realQueryItems,
    listLocations: realListLocations,
    listCategories: realListCategories,
    now: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
  } as unknown as QueryFixtureDeps;
}

describe('query fixture gate (mocked, not native proof)', () => {
  const origDev = DEV.__DEV__;
  const origFixture = ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
  const origQuery = ENV.EXPO_PUBLIC_NATIVE_QUERY;

  afterEach(() => {
    DEV.__DEV__ = origDev;
    if (origFixture === undefined) delete ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
    else ENV.EXPO_PUBLIC_NATIVE_FIXTURE = origFixture;
    if (origQuery === undefined) delete ENV.EXPO_PUBLIC_NATIVE_QUERY;
    else ENV.EXPO_PUBLIC_NATIVE_QUERY = origQuery;
  });

  test('enabled only when DEV + fixture flag + query flag are all set', () => {
    setQueryEnv(true, '1', '1');
    expect(isNativeQueryFixtureEnabled()).toBe(true);
    setQueryEnv(true, '1', undefined);
    expect(isNativeQueryFixtureEnabled()).toBe(false);
    setQueryEnv(true, undefined, '1');
    expect(isNativeQueryFixtureEnabled()).toBe(false);
    setQueryEnv(true, '1', '0');
    expect(isNativeQueryFixtureEnabled()).toBe(false);
    setQueryEnv(false, '1', '1');
    expect(isNativeQueryFixtureEnabled()).toBe(false);
  });

  test('only the two named fixture files are accepted', () => {
    expect(QUERY_FIXTURE_SEEDED_DB).toBe('m1-fixture-query-m3.db');
    expect(QUERY_FIXTURE_EMPTY_DB).toBe('m1-fixture-query-m3-empty.db');
    expect(() =>
      assertSafeQueryFixtureName(QUERY_FIXTURE_SEEDED_DB),
    ).not.toThrow();
    expect(() =>
      assertSafeQueryFixtureName(QUERY_FIXTURE_EMPTY_DB),
    ).not.toThrow();
    for (const bad of [
      DATABASE_NAME,
      'tengo.db',
      'm1-fixture-repository-fk.db',
      'm1-fixture-fresh.db',
      'm1-fixture-query-m3.db-journal',
      '../m1-fixture-query-m3.db',
      '',
    ]) {
      expect(() => assertSafeQueryFixtureName(bad)).toThrow();
    }
  });

  test('unsafe name fails before any open and never opens tengo.db', async () => {
    const store = freshStore();
    const calls: string[] = [];
    const deps = makeDeps(store, calls);
    const result = await runNativeQueryFixture('tengo.db', deps);
    expect(result.status).toBe('fail');
    expect(deps.openDatabaseAsync).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('query fixture seed planning (mocked)', () => {
  test('fresh seeded run creates the exact dataset and keeps the DB open', async () => {
    const store = freshStore();
    const calls: string[] = [];
    const result = await runNativeQueryFixture(
      QUERY_FIXTURE_SEEDED_DB,
      makeDeps(store, calls),
    );
    expect(result.status).toBe('pass');
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(calls).toContain(`createLocation:${'Küche'}`);
    expect(calls).toContain('createLocation:Garage');
    expect(store.locations).toHaveLength(2);
    expect(store.categories).toHaveLength(3);
    expect(store.itemRows).toHaveLength(5);
    expect(store.marker).not.toBeNull();
    // Kept for the native verifier: the open handle is returned, never closed/deleted.
    expect(result.db).not.toBeNull();
  });

  test('second run is idempotent: no duplicate creates', async () => {
    const store = freshStore();
    const first: string[] = [];
    await runNativeQueryFixture(
      QUERY_FIXTURE_SEEDED_DB,
      makeDeps(store, first),
    );
    const second: string[] = [];
    const result = await runNativeQueryFixture(
      QUERY_FIXTURE_SEEDED_DB,
      makeDeps(store, second),
    );
    expect(result.status).toBe('pass');
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(second.filter((c) => c.startsWith('create'))).toEqual([]);
    expect(store.itemRows).toHaveLength(5);
  });

  test('partial state with a marker mismatch fails closed without overwrite', async () => {
    const store = freshStore();
    store.marker = JSON.stringify({ items: 5 });
    store.locations.push({
      id: 1,
      name: 'Stray',
      address: null,
      created_at: 't',
    });
    const calls: string[] = [];
    const result = await runNativeQueryFixture(
      QUERY_FIXTURE_SEEDED_DB,
      makeDeps(store, calls),
    );
    expect(result.status).toBe('fail');
    expect(calls.filter((c) => c.startsWith('create'))).toEqual([]);
    expect(store.locations).toHaveLength(1);
  });

  test('empty variant seeds nothing and passes first-run checks', async () => {
    const store = freshStore();
    const calls: string[] = [];
    const result = await runNativeQueryFixture(
      QUERY_FIXTURE_EMPTY_DB,
      makeDeps(store, calls),
    );
    expect(result.status).toBe('pass');
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(calls.filter((c) => c.startsWith('create'))).toEqual([]);
    expect(store.itemRows).toHaveLength(0);
  });
});

describe('query fixture behavior checks (mocked, real query model)', () => {
  async function seededStore(): Promise<Store> {
    const store = freshStore();
    const calls: string[] = [];
    const result = await runNativeQueryFixture(
      QUERY_FIXTURE_SEEDED_DB,
      makeDeps(store, calls),
    );
    expect(result.status).toBe('pass');
    return store;
  }

  test('accent folding matches both directions', async () => {
    const store = await seededStore();
    const deps = makeDeps(store, []);
    const handle = await deps.openDatabaseAsync(QUERY_FIXTURE_SEEDED_DB);
    const accented = await realQueryItems(handle, { query: 'café' });
    expect(accented).toHaveLength(3);
    expect(accented.map((item) => item.name)).toContain('Cafe Napkin');
    expect(await realQueryItems(handle, { query: 'CAFÉ' })).toHaveLength(3);
    const folded = await realQueryItems(handle, { query: 'cafe' });
    expect(folded).toHaveLength(3);
    expect(folded.map((item) => item.name)).toEqual(
      expect.arrayContaining(['Café Grinder', 'CAFÉ filter']),
    );
  });

  test('literal 100% and backslash match verbatim', async () => {
    const store = await seededStore();
    const deps = makeDeps(store, []);
    const handle = await deps.openDatabaseAsync(QUERY_FIXTURE_SEEDED_DB);
    expect(await realQueryItems(handle, { query: '100%' })).toHaveLength(1);
    expect(await realQueryItems(handle, { query: '\\' })).toHaveLength(1);
  });

  test('location AND category-OR matches without duplicates', async () => {
    const store = await seededStore();
    const deps = makeDeps(store, []);
    const handle = await deps.openDatabaseAsync(QUERY_FIXTURE_SEEDED_DB);
    const garage = (await realListLocations(handle)).find(
      (loc) => loc.name === 'Garage',
    ) as { id: number };
    const cats = await realListCategories(handle);
    const tools = cats.find((c) => c.name === 'Tools') as { id: number };
    const stock = cats.find((c) => c.name === '100%_stock') as { id: number };
    const page = await realQueryItems(handle, {
      locationId: garage.id,
      categoryIds: [tools.id, stock.id],
    });
    const names = page.map((item) => item.name).sort();
    expect(names).toHaveLength(2);
    expect(new Set(page.map((item) => item.id)).size).toBe(page.length);
    const all = await realQueryItems(handle, {});
    expect(all).toHaveLength(5);
    expect(new Set(all.map((item) => item.id)).size).toBe(5);
    const hammer = all.filter((item) => item.name === 'Hammer');
    expect(hammer).toHaveLength(1);
    expect(hammer[0].categoryIds).toHaveLength(2);
  });

  test('sin-stock totals and per-location group counts hold', async () => {
    const store = await seededStore();
    const deps = makeDeps(store, []);
    const handle = await deps.openDatabaseAsync(QUERY_FIXTURE_SEEDED_DB);
    const all = await realQueryItems(handle, {});
    expect(
      all
        .filter((item) => item.totalQuantity === 0)
        .map((item) => item.name)
        .sort(),
    ).toEqual(['CAFÉ filter', 'Cafe Napkin']);
    const napkin = all.find((item) => item.name === 'Cafe Napkin') as {
      categoryIds: number[];
    };
    expect(napkin.categoryIds).toEqual([]);
    const hammer = all.find((item) => item.name === 'Hammer') as {
      stock: unknown[];
      totalQuantity: number;
    };
    expect(hammer.stock).toHaveLength(2);
    expect(hammer.totalQuantity).toBe(6);
    const kueche = (await realListLocations(handle)).find(
      (loc) => loc.name === 'Küche',
    ) as { id: number };
    const garage = (await realListLocations(handle)).find(
      (loc) => loc.name === 'Garage',
    ) as { id: number };
    expect(
      await realQueryItems(handle, { locationId: kueche.id }),
    ).toHaveLength(2);
    expect(
      await realQueryItems(handle, { locationId: garage.id }),
    ).toHaveLength(2);
  });
});

describe('controlled read-fault wrapper (mocked)', () => {
  test('armed fault rejects the next read once, then passes through', async () => {
    const inner = {
      getAllAsync: jest.fn(async () => [{ item_id: 1 }]),
    };
    const { fault, db } = makeFaultableQueryDb(
      inner as unknown as RepositoryDb,
      createQueryReadFault(),
    );
    expect(await db.getAllAsync('SELECT 1')).toEqual([{ item_id: 1 }]);
    armQueryReadFault(fault);
    await expect(db.getAllAsync('SELECT 1')).rejects.toThrow();
    expect(await db.getAllAsync('SELECT 1')).toEqual([{ item_id: 1 }]);
    expect(inner.getAllAsync).toHaveBeenCalledTimes(2);
  });
});

describe('query fixture S9 cross-entity checks (mocked, real query model)', () => {
  async function seededDeps(): Promise<{
    deps: QueryFixtureDeps;
    handle: RepositoryDb;
  }> {
    const store = freshStore();
    const calls: string[] = [];
    const seedResult = await runNativeQueryFixture(
      QUERY_FIXTURE_SEEDED_DB,
      makeDeps(store, calls),
    );
    expect(seedResult.status).toBe('pass');
    const deps = makeDeps(store, []);
    const handle = (await deps.openDatabaseAsync(
      QUERY_FIXTURE_SEEDED_DB,
    )) as unknown as RepositoryDb;
    return { deps, handle };
  }

  test('seeded run carries the location-only and category-only checks, all passing', async () => {
    const store = freshStore();
    const calls: string[] = [];
    const result = await runNativeQueryFixture(
      QUERY_FIXTURE_SEEDED_DB,
      makeDeps(store, calls),
    );
    expect(result.status).toBe('pass');
    expect(result.checks.every((c) => c.pass)).toBe(true);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain(
      'search matches location names only, with accent folding',
    );
    expect(names).toContain(
      'search matches category names only, each item once',
    );
  });

  test('location-name-only matches with folding and no duplicates', async () => {
    const { handle } = await seededDeps();
    // Only stocked sites match: the sin-stock Napkin never matches a
    // location name, and the two-site Hammer appears once.
    const garage = await realQueryItems(handle, { query: 'garage' });
    expect(garage.map((item) => item.name).sort()).toEqual([
      '100%_literal\\blend',
      'Hammer',
    ]);
    expect(new Set(garage.map((item) => item.id)).size).toBe(2);
    const kuche = await realQueryItems(handle, { query: 'kuche' });
    expect(kuche.map((item) => item.name).sort()).toEqual([
      'Café Grinder',
      'Hammer',
    ]);
  });

  test('category-name-only matches with OR-dedup', async () => {
    const { handle } = await seededDeps();
    const kitchen = await realQueryItems(handle, { query: 'kitchen' });
    expect(kitchen.map((item) => item.name).sort()).toEqual([
      'Café Grinder',
      'Hammer',
    ]);
    expect(new Set(kitchen.map((item) => item.id)).size).toBe(2);
    const tools = await realQueryItems(handle, { query: 'tools' });
    expect(tools.map((item) => item.name).sort()).toEqual([
      'CAFÉ filter',
      'Hammer',
    ]);
  });
});
