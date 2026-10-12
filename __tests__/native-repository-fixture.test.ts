/**
 * Tests for the DEV-ONLY native repository fixture (P2b).
 *
 * Hermetic orchestration tests with injected fakes only: consecutive
 * `runNativeRepositoryFixture()` calls share one in-memory file store to
 * model force-stop + relaunch (every launch gets a FRESH fake connection —
 * never a same-process close/open fake restart). Phase 1 and 2 must end
 * `restart-required` WITHOUT deleting the fixture DB; only a passing
 * phase 3 deletes it. Production `tengo.db` is never opened. Nothing here
 * claims native/device proof.
 */
import { DATABASE_NAME } from '../src/db';
import {
  isNativeRepositoryFixtureEnabled,
  REPOSITORY_FIXTURE_DB,
  type RepositoryFixtureDeps,
  runNativeRepositoryFixture,
} from '../src/dev/nativeRepositoryFixture';
import {
  EntityNotFoundError,
  LocationInUseError,
  StorageError,
} from '../src/inventory/errors';

const DEV = globalThis as Record<string, unknown>;
const ENV = process.env;

function setRepoEnv(
  dev: boolean,
  fixture: string | undefined,
  repo: string | undefined,
) {
  DEV.__DEV__ = dev;
  if (fixture === undefined) delete ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
  else ENV.EXPO_PUBLIC_NATIVE_FIXTURE = fixture;
  if (repo === undefined) delete ENV.EXPO_PUBLIC_NATIVE_REPOSITORY;
  else ENV.EXPO_PUBLIC_NATIVE_REPOSITORY = repo;
}

interface Row {
  id: number;
  name: string;
  quantity?: number;
  locationId?: number;
  address?: string | null;
}

/** Shared "file store": survives across fake launches like a real .db file. */
interface FakeStore {
  phase: string | null;
  ids: Record<string, number> | null;
  opened: string[];
  deleted: string[];
  nextId: number;
  locs: Map<number, Row>;
  cats: Map<number, Row>;
  items: Map<number, Row>;
  joins: Map<number, number[]>;
}

function freshStore(): FakeStore {
  return {
    phase: null,
    ids: null,
    opened: [],
    deleted: [],
    nextId: 1,
    locs: new Map(),
    cats: new Map(),
    items: new Map(),
    joins: new Map(),
  };
}

function toDetail(store: FakeStore, item: Row) {
  const loc = store.locs.get(item.locationId as number) as Row;
  const catIds = store.joins.get(item.id) ?? [];
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity as number,
    locationId: item.locationId as number,
    location: {
      id: loc.id,
      name: loc.name,
      address: loc.address ?? null,
      created_at: 't',
    },
    categoryIds: [...catIds],
    categories: catIds.map((id) => ({
      id,
      name: (store.cats.get(id) as Row).name,
      created_at: 't',
    })),
    created_at: 't',
  };
}

/** One fake launch: fresh connection object over the shared store. */
function makeDeps(store: FakeStore): RepositoryFixtureDeps {
  const fkError = () => new Error('FOREIGN KEY constraint failed (code 787)');
  const fakeTxn = {
    runAsync: jest.fn(async (sql: string) => {
      if (/item_categories/.test(sql)) throw fkError();
      return { lastInsertRowId: 1, changes: 1 };
    }),
    getFirstAsync: jest.fn(async (sql: string) => {
      if (/PRAGMA foreign_keys/.test(sql)) return { foreign_keys: 1 };
      return null;
    }),
    getAllAsync: jest.fn(async () => []),
  };
  const fakeDb = {
    runAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      if (/fixture_state/.test(sql)) {
        if (params?.[0] === 'phase') store.phase = String(params[1]);
        if (params?.[0] === 'ids') store.ids = JSON.parse(String(params[1]));
        return { lastInsertRowId: 1, changes: 1 };
      }
      if (/INSERT INTO items/.test(sql)) throw fkError();
      if (/INSERT INTO item_categories/.test(sql)) throw fkError();
      if (/DELETE FROM items WHERE location_id/.test(sql))
        return { lastInsertRowId: 0, changes: 0 };
      return { lastInsertRowId: 1, changes: 1 };
    }),
    getFirstAsync: jest.fn(async (sql: string, params?: unknown[]) => {
      if (/fixture_state/.test(sql)) {
        if (params?.[0] === 'phase')
          return store.phase ? { value: store.phase } : null;
        if (params?.[0] === 'ids')
          return store.ids ? { value: JSON.stringify(store.ids) } : null;
        return null;
      }
      if (/COUNT.*item_categories/.test(sql)) {
        return { count: (store.joins.get(params?.[0] as number) ?? []).length };
      }
      if (/COUNT.*items WHERE name/.test(sql)) {
        const name = params?.[0] as string;
        return {
          count: [...store.items.values()].filter((i) => i.name === name)
            .length,
        };
      }
      if (/COUNT.*locations WHERE name/.test(sql)) {
        const name = params?.[0] as string;
        return {
          count: [...store.locs.values()].filter((l) => l.name === name).length,
        };
      }
      if (/COUNT.*items/.test(sql)) return { count: store.items.size };
      if (/PRAGMA foreign_keys/.test(sql)) return { foreign_keys: 1 };
      if (/user_version/.test(sql)) return { user_version: 3 };
      return null;
    }),
    getAllAsync: jest.fn(async (sql: string) => {
      if (/FROM items/.test(sql)) {
        return [...store.items.values()].map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          location_id: i.locationId,
        }));
      }
      return [];
    }),
    execAsync: jest.fn(async () => {}),
    closeAsync: jest.fn(async () => {}),
    withExclusiveTransactionAsync: jest.fn(
      async (task: (txn: unknown) => Promise<void>) => {
        try {
          await task(fakeTxn);
        } catch (error) {
          if ((error as Error).message === 'fixture-probe-rollback') return;
          throw error;
        }
      },
    ),
  };
  const repos = {
    createLocation: jest.fn(
      async (
        _db: unknown,
        input: { name: string; address?: string | null },
      ) => {
        const id = store.nextId++;
        store.locs.set(id, {
          id,
          name: input.name,
          address: input.address ?? null,
        });
        return {
          id,
          name: input.name,
          address: input.address ?? null,
          created_at: 't',
        };
      },
    ),
    createCategory: jest.fn(async (_db: unknown, input: { name: string }) => {
      const id = store.nextId++;
      store.cats.set(id, { id, name: input.name });
      return { id, name: input.name, created_at: 't' };
    }),
    createItem: jest.fn(
      async (
        _db: unknown,
        input: {
          name: string;
          quantity: number;
          locationId: number;
          categoryIds?: number[];
        },
      ) => {
        if (!store.locs.has(input.locationId))
          throw new EntityNotFoundError('location', input.locationId);
        for (const cid of input.categoryIds ?? []) {
          if (!store.cats.has(cid))
            throw new EntityNotFoundError('category', cid);
        }
        const id = store.nextId++;
        store.items.set(id, {
          id,
          name: input.name,
          quantity: input.quantity,
          locationId: input.locationId,
        });
        store.joins.set(id, [...(input.categoryIds ?? [])]);
        return toDetail(store, store.items.get(id) as Row);
      },
    ),
    getItem: jest.fn(async (_db: unknown, id: number) => {
      const item = store.items.get(id);
      if (!item) throw new EntityNotFoundError('item', id);
      return toDetail(store, item);
    }),
    updateItem: jest.fn(
      async (
        _db: unknown,
        id: number,
        input: {
          name: string;
          quantity: number;
          locationId: number;
          categoryIds?: number[];
        },
      ) => {
        const item = store.items.get(id);
        if (!item) throw new EntityNotFoundError('item', id);
        item.name = input.name;
        item.quantity = input.quantity;
        item.locationId = input.locationId;
        store.joins.set(id, [...(input.categoryIds ?? [])]);
        return toDetail(store, item);
      },
    ),
    deleteItem: jest.fn(async (_db: unknown, id: number) => {
      if (!store.items.has(id)) throw new EntityNotFoundError('item', id);
      store.items.delete(id);
      store.joins.delete(id);
    }),
    deleteLocation: jest.fn(async (_db: unknown, id: number) => {
      if ([...store.items.values()].some((i) => i.locationId === id))
        throw new LocationInUseError(id);
      store.locs.delete(id);
    }),
    listItems: jest.fn(async () =>
      [...store.items.values()].map((i) => toDetail(store, i)),
    ),
    createItemFromDraft: jest.fn(async () => {
      throw new StorageError(
        'item',
        'create',
        new Error('fixture-late-failure'),
      );
    }),
  };
  return {
    openDatabaseAsync: jest.fn(async (name: string) => {
      store.opened.push(name);
      return fakeDb;
    }),
    deleteDatabaseAsync: jest.fn(async (name: string) => {
      store.deleted.push(name);
    }),
    initializeDatabase: jest.fn(async () => ({})),
    repos,
  } as unknown as RepositoryFixtureDeps;
}

describe('repository fixture gate (mocked, not native proof)', () => {
  const origDev = DEV.__DEV__;
  const origFixture = ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
  const origRepo = ENV.EXPO_PUBLIC_NATIVE_REPOSITORY;

  afterEach(() => {
    DEV.__DEV__ = origDev;
    if (origFixture === undefined) delete ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
    else ENV.EXPO_PUBLIC_NATIVE_FIXTURE = origFixture;
    if (origRepo === undefined) delete ENV.EXPO_PUBLIC_NATIVE_REPOSITORY;
    else ENV.EXPO_PUBLIC_NATIVE_REPOSITORY = origRepo;
  });

  test('enabled only when DEV + fixture flag + repository flag are all set', () => {
    setRepoEnv(true, '1', '1');
    expect(isNativeRepositoryFixtureEnabled()).toBe(true);
    setRepoEnv(true, '1', undefined);
    expect(isNativeRepositoryFixtureEnabled()).toBe(false);
    setRepoEnv(true, undefined, '1');
    expect(isNativeRepositoryFixtureEnabled()).toBe(false);
    setRepoEnv(false, '1', '1');
    expect(isNativeRepositoryFixtureEnabled()).toBe(false);
  });

  test('fixture database is a validated m1-fixture name, never tengo.db', () => {
    expect(REPOSITORY_FIXTURE_DB).toBe('m1-fixture-repository-fk.db');
    expect(REPOSITORY_FIXTURE_DB).not.toBe(DATABASE_NAME);
    expect(REPOSITORY_FIXTURE_DB.startsWith('m1-fixture-')).toBe(true);
  });
});

describe('repository fixture multi-launch protocol (mocked)', () => {
  test('phase 1 creates via real repo shapes and keeps the DB for relaunch', async () => {
    const store = freshStore();
    const result = await runNativeRepositoryFixture(makeDeps(store));
    expect(result.phase).toBe(1);
    expect(result.status).toBe('restart-required');
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(store.opened).toEqual([REPOSITORY_FIXTURE_DB]);
    expect(store.deleted).toEqual([]);
    expect(store.items.size).toBe(2);
    expect(store.phase).toBe('1');
  });

  test('phase 2 verifies persistence, updates one, deletes another, keeps DB', async () => {
    const store = freshStore();
    const first = makeDeps(store);
    await runNativeRepositoryFixture(first);
    const second = makeDeps(store);
    const result = await runNativeRepositoryFixture(second);
    expect(result.phase).toBe(2);
    expect(result.status).toBe('restart-required');
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(store.deleted).toEqual([]);
    expect(second.repos.updateItem).toHaveBeenCalled();
    expect(second.repos.deleteItem).toHaveBeenCalled();
    expect(store.phase).toBe('2');
  });

  test('passing phase 3 deletes only the fixture database', async () => {
    const store = freshStore();
    await runNativeRepositoryFixture(makeDeps(store));
    await runNativeRepositoryFixture(makeDeps(store));
    const result = await runNativeRepositoryFixture(makeDeps(store));
    expect(result.phase).toBe(3);
    expect(result.status).toBe('pass');
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(store.deleted).toEqual([REPOSITORY_FIXTURE_DB]);
    for (const name of [...store.opened, ...store.deleted]) {
      expect(name).not.toBe(DATABASE_NAME);
    }
  });

  test('orphan joins fail phase 3 and keep the DB for inspection', async () => {
    const store = freshStore();
    await runNativeRepositoryFixture(makeDeps(store));
    await runNativeRepositoryFixture(makeDeps(store));
    // Simulate the FK-OFF device bug: re-attach a join row to the deleted item.
    const goneId = store.ids?.gone as number;
    store.joins.set(goneId, [store.ids?.catB as number]);
    const result = await runNativeRepositoryFixture(makeDeps(store));
    expect(result.phase).toBe(3);
    expect(result.status).toBe('fail');
    expect(result.checks.some((c) => !c.pass)).toBe(true);
    expect(store.deleted).toEqual([]);
  });

  test('failed opens surface, never claim a pass', async () => {
    const store = freshStore();
    const deps = makeDeps(store);
    deps.openDatabaseAsync = jest.fn(async () => {
      throw new Error('forced open failure');
    });
    const result = await runNativeRepositoryFixture(deps);
    expect(result.status).toBe('fail');
    expect(result.checks.some((c) => !c.pass)).toBe(true);
  });
});
