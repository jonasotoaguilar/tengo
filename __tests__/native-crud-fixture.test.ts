/**
 * DEV-ONLY native CRUD fixture orchestration tests (M4, Jest/RNTL only).
 *
 * Hermetic tests with injected fakes: nothing here opens a real database,
 * deletes a real file, or proves native behavior. The native path (real
 * `openManagedDatabase` + real `initializeDatabase` + real
 * `deleteDatabaseAsync`) runs only on device under the guarded
 * `NativeCrudFixtureScreen` branch.
 */
import { DATABASE_NAME } from '../src/db';
import {
  assertSafeCrudFixtureName,
  CRUD_FIXTURE_DB,
  CRUD_MEASURE_LABEL_FIRST_VIEWPORT,
  CRUD_MEASURE_LABEL_SEARCH,
  CRUD_MEASURE_LABEL_SEED,
  CRUD_MEASURE_LABEL_WRITE,
  type CrudFixtureDb,
  type CrudFixtureDeps,
  CrudFixtureResetRefusedError,
  type CrudMeasureDeps,
  closeCrudFixtureHandle,
  isNativeCrudFixtureEnabled,
  openNativeCrudFixture,
  resetNativeCrudFixture,
  runCrudMeasurePass,
} from '../src/dev/nativeCrudFixture';

const DEV = globalThis as Record<string, unknown>;
const ENV = process.env;

function setCrudEnv(
  dev: boolean,
  fixture: string | undefined,
  crud: string | undefined,
) {
  DEV.__DEV__ = dev;
  if (fixture === undefined) delete ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
  else ENV.EXPO_PUBLIC_NATIVE_FIXTURE = fixture;
  if (crud === undefined) delete ENV.EXPO_PUBLIC_NATIVE_CRUD;
  else ENV.EXPO_PUBLIC_NATIVE_CRUD = crud;
}

function makeDeps(calls: string[]): CrudFixtureDeps & { db: CrudFixtureDb } {
  const db = {
    runAsync: jest.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
    getFirstAsync: jest.fn(async () => null),
    getAllAsync: jest.fn(async () => []),
    execAsync: jest.fn(async () => {}),
    closeAsync: jest.fn(async () => {}),
  } as unknown as CrudFixtureDb;
  return {
    db,
    openDatabaseAsync: jest.fn(async (name: string) => {
      calls.push(`open:${name}`);
      return db;
    }),
    initializeDatabase: jest.fn(async () => {
      calls.push('initialize');
      return {};
    }),
    deleteDatabaseAsync: jest.fn(async (name: string) => {
      calls.push(`delete:${name}`);
    }),
  };
}

describe('CRUD fixture gate (mocked, not native proof)', () => {
  const origDev = DEV.__DEV__;
  const origFixture = ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
  const origCrud = ENV.EXPO_PUBLIC_NATIVE_CRUD;

  afterEach(() => {
    DEV.__DEV__ = origDev;
    if (origFixture === undefined) delete ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
    else ENV.EXPO_PUBLIC_NATIVE_FIXTURE = origFixture;
    if (origCrud === undefined) delete ENV.EXPO_PUBLIC_NATIVE_CRUD;
    else ENV.EXPO_PUBLIC_NATIVE_CRUD = origCrud;
  });

  test('enabled only when DEV + fixture flag + CRUD flag are all set', () => {
    setCrudEnv(true, '1', '1');
    expect(isNativeCrudFixtureEnabled()).toBe(true);
    setCrudEnv(true, '1', undefined);
    expect(isNativeCrudFixtureEnabled()).toBe(false);
    setCrudEnv(true, undefined, '1');
    expect(isNativeCrudFixtureEnabled()).toBe(false);
    setCrudEnv(true, '1', '0');
    expect(isNativeCrudFixtureEnabled()).toBe(false);
    setCrudEnv(false, '1', '1');
    expect(isNativeCrudFixtureEnabled()).toBe(false);
  });

  test('exactly one fixture database name is allowlisted, never production', () => {
    expect(CRUD_FIXTURE_DB).toBe('m1-fixture-crud-m4.db');
    expect(CRUD_FIXTURE_DB).not.toBe(DATABASE_NAME);
    expect(() => assertSafeCrudFixtureName(CRUD_FIXTURE_DB)).not.toThrow();
    for (const bad of [
      DATABASE_NAME,
      'tengo.db',
      'm1-fixture-query-m3.db',
      'm1-fixture-query-m3-empty.db',
      'm1-fixture-repository-fk.db',
      'm1-fixture-fresh.db',
      'm1-fixture-crud-m4.db-journal',
      '../m1-fixture-crud-m4.db',
      '',
    ]) {
      expect(() => assertSafeCrudFixtureName(bad)).toThrow();
    }
  });

  test('refused name fails BEFORE any open with zero open calls', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    await expect(openNativeCrudFixture('tengo.db', deps)).rejects.toThrow(
      /Refusing unsafe CRUD fixture/,
    );
    expect(deps.openDatabaseAsync).not.toHaveBeenCalled();
    expect(deps.initializeDatabase).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test('production database name is impossible to reach through this module', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    await expect(openNativeCrudFixture(DATABASE_NAME, deps)).rejects.toThrow();
    expect(deps.openDatabaseAsync).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('CRUD fixture open (mocked)', () => {
  test('allowlisted open runs the real-factory seam in order and returns the handle', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const handle = await openNativeCrudFixture(CRUD_FIXTURE_DB, deps);
    expect(calls).toEqual([`open:${CRUD_FIXTURE_DB}`, 'initialize']);
    expect(handle.database).toBe(CRUD_FIXTURE_DB);
    expect(handle.db).toBe(deps.db);
    expect(deps.openDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(deps.initializeDatabase).toHaveBeenCalledTimes(1);
  });
});

describe('CRUD fixture open failure (mocked)', () => {
  test('initialize failure closes the opened handle and rethrows without deleting', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const failure = new Error('migrate boom');
    (deps.initializeDatabase as jest.Mock).mockRejectedValueOnce(failure);
    await expect(openNativeCrudFixture(CRUD_FIXTURE_DB, deps)).rejects.toBe(
      failure,
    );
    expect(deps.openDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(deps.db.closeAsync).toHaveBeenCalledTimes(1);
    expect(deps.deleteDatabaseAsync).not.toHaveBeenCalled();
  });

  test('a failing close never masks the original initialize error', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const failure = new Error('migrate boom');
    (deps.initializeDatabase as jest.Mock).mockRejectedValueOnce(failure);
    (deps.db.closeAsync as jest.Mock).mockRejectedValueOnce(
      new Error('close boom'),
    );
    await expect(openNativeCrudFixture(CRUD_FIXTURE_DB, deps)).rejects.toBe(
      failure,
    );
    expect(deps.deleteDatabaseAsync).not.toHaveBeenCalled();
  });
});

describe('CRUD fixture reset (mocked)', () => {
  test('reset deletes ONLY the allowlisted fixture file', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    await resetNativeCrudFixture(CRUD_FIXTURE_DB, deps);
    expect(calls).toEqual([`delete:${CRUD_FIXTURE_DB}`]);
    expect(deps.deleteDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(deps.deleteDatabaseAsync).toHaveBeenCalledWith(CRUD_FIXTURE_DB);
    expect(deps.openDatabaseAsync).not.toHaveBeenCalled();
  });

  test('reset can never target a non-allowlisted path', async () => {
    for (const bad of [DATABASE_NAME, 'tengo.db', 'm1-fixture-query-m3.db']) {
      const calls: string[] = [];
      const deps = makeDeps(calls);
      await expect(resetNativeCrudFixture(bad, deps)).rejects.toThrow(
        /Refusing unsafe CRUD fixture/,
      );
      expect(deps.deleteDatabaseAsync).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  });
});

describe('CRUD fixture reset refusal (mocked)', () => {
  test('reset refuses while a tracked handle has not confirmed its close', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const handle = await openNativeCrudFixture(CRUD_FIXTURE_DB, deps);
    await expect(resetNativeCrudFixture(CRUD_FIXTURE_DB, deps)).rejects.toThrow(
      CrudFixtureResetRefusedError,
    );
    expect(deps.deleteDatabaseAsync).not.toHaveBeenCalled();
    await closeCrudFixtureHandle(handle.db, deps);
    await resetNativeCrudFixture(CRUD_FIXTURE_DB, deps);
    expect(deps.deleteDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(deps.deleteDatabaseAsync).toHaveBeenCalledWith(CRUD_FIXTURE_DB);
  });

  test('a rejected module close keeps the handle tracked so reset still refuses', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const handle = await openNativeCrudFixture(CRUD_FIXTURE_DB, deps);
    const boom = new Error('close boom');
    (deps.db.closeAsync as jest.Mock).mockRejectedValueOnce(boom);
    await expect(closeCrudFixtureHandle(handle.db, deps)).rejects.toBe(boom);
    await expect(resetNativeCrudFixture(CRUD_FIXTURE_DB, deps)).rejects.toThrow(
      CrudFixtureResetRefusedError,
    );
    expect(deps.deleteDatabaseAsync).not.toHaveBeenCalled();
    await closeCrudFixtureHandle(handle.db, deps);
    await resetNativeCrudFixture(CRUD_FIXTURE_DB, deps);
    expect(deps.deleteDatabaseAsync).toHaveBeenCalledTimes(1);
  });

  test('init failure with rejecting cleanup close leaves reset refusing', async () => {
    const calls: string[] = [];
    const deps = makeDeps(calls);
    const failure = new Error('migrate boom');
    (deps.initializeDatabase as jest.Mock).mockRejectedValueOnce(failure);
    (deps.db.closeAsync as jest.Mock).mockRejectedValueOnce(
      new Error('close boom'),
    );
    await expect(openNativeCrudFixture(CRUD_FIXTURE_DB, deps)).rejects.toBe(
      failure,
    );
    await expect(resetNativeCrudFixture(CRUD_FIXTURE_DB, deps)).rejects.toThrow(
      CrudFixtureResetRefusedError,
    );
    expect(deps.deleteDatabaseAsync).not.toHaveBeenCalled();
  });
});

describe('CRUD fixture production isolation (mocked)', () => {
  test('the module is never reached by the production path', () => {
    // Production (`__DEV__ === false`) disables the gate even with both
    // flags set; the default launch takes the normal `tengo.db` bootstrap
    // in `App.tsx`, which never imports this module.
    setCrudEnv(false, '1', '1');
    expect(isNativeCrudFixtureEnabled()).toBe(false);
    setCrudEnv(true, '1', undefined);
    expect(isNativeCrudFixtureEnabled()).toBe(false);
    expect(CRUD_FIXTURE_DB).not.toBe(DATABASE_NAME);
    expect(CRUD_FIXTURE_DB).not.toBe('tengo.db');
    const SQLite = require('expo-sqlite') as {
      openDatabaseAsync: jest.Mock;
    };
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalledWith(DATABASE_NAME);
    expect(SQLite.openDatabaseAsync).not.toHaveBeenCalledWith(CRUD_FIXTURE_DB);
  });
});

/**
 * P5b measurement battery (mocked, not native proof).
 *
 * The pass never opens a database itself: the caller hands it the already
 * open isolated fixture handle plus the fixture name, and the allowlist is
 * enforced before any repository or driver call. Numbers here come from the
 * injected `now()` seam, so budgets are exercised deterministically; real
 * milliseconds are observed only on device.
 */
function makeMeasureDb(order: string[]) {
  const db = {
    runAsync: jest.fn(async (source: string) => {
      order.push(`cleanup:${source.split(' ')[2]}`);
      return { lastInsertRowId: 1, changes: 0 };
    }),
    getFirstAsync: jest.fn(async () => null),
    getAllAsync: jest.fn(async () => []),
    execAsync: jest.fn(async () => {}),
    closeAsync: jest.fn(async () => {}),
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
      order.push('seed-transaction-begin');
      await task();
      order.push('seed-transaction-commit');
    }),
  } as unknown as CrudFixtureDb & {
    runAsync: jest.Mock;
    withTransactionAsync: jest.Mock;
  };
  return db;
}

function makeMeasureDeps(
  order: string[],
  nowValues: number[],
): CrudMeasureDeps {
  let tick = 0;
  let locationId = 0;
  let categoryId = 0;
  let itemId = 0;
  const now = () => nowValues[Math.min(tick++, nowValues.length - 1)];
  return {
    now,
    createLocation: jest.fn(async (_db: unknown, input: { name: string }) => {
      order.push(`createLocation:${input.name}`);
      locationId += 1;
      return {
        id: locationId,
        name: input.name,
        address: null,
        created_at: '',
      };
    }) as unknown as CrudMeasureDeps['createLocation'],
    createCategory: jest.fn(async (_db: unknown, input: { name: string }) => {
      order.push(`createCategory:${input.name}`);
      categoryId += 1;
      return { id: categoryId, name: input.name, created_at: '' };
    }) as unknown as CrudMeasureDeps['createCategory'],
    createItem: jest.fn(async () => {
      order.push('createItem');
      itemId += 1;
      return { id: itemId };
    }) as unknown as CrudMeasureDeps['createItem'],
    queryItems: jest.fn(async (_db: unknown, filter: unknown) => {
      order.push(`queryItems:${JSON.stringify(filter)}`);
      return [];
    }) as unknown as CrudMeasureDeps['queryItems'],
  };
}

/** Eight `now()` reads: seed, first-viewport, search, single write. */
function flatNow(msPerPhase: [number, number, number, number]): number[] {
  let cursor = 0;
  const values: number[] = [];
  for (const elapsed of msPerPhase) {
    values.push(cursor);
    cursor += elapsed;
    values.push(cursor);
  }
  return values;
}

describe('CRUD measurement pass (mocked)', () => {
  test('runs the documented order through the injected deps seam with a value per check', async () => {
    const order: string[] = [];
    const db = makeMeasureDb(order);
    const deps = makeMeasureDeps(order, flatNow([400, 120, 45, 20]));
    const result = await runCrudMeasurePass(db, CRUD_FIXTURE_DB, deps);
    expect(result.database).toBe(CRUD_FIXTURE_DB);
    expect(result.status).toBe('pass');
    expect(result.checks.map((check) => check.name)).toEqual([
      CRUD_MEASURE_LABEL_SEED,
      CRUD_MEASURE_LABEL_FIRST_VIEWPORT,
      CRUD_MEASURE_LABEL_SEARCH,
      CRUD_MEASURE_LABEL_WRITE,
    ]);
    // Every check reports its measured milliseconds in the detail text.
    for (const check of result.checks) {
      expect(check.detail).toMatch(/\d+(\.\d+)?ms/);
    }
    // Documented order: cleanup, then the transactional seed (locations,
    // categories, 500 items), then first-viewport read, filtered search
    // read, and finally the single-row probe write.
    const firstCreate = order.findIndex((entry) =>
      entry.startsWith('createLocation:'),
    );
    expect(firstCreate).toBeGreaterThan(0);
    expect(
      order
        .slice(0, firstCreate)
        .every((entry) => entry.startsWith('cleanup:')),
    ).toBe(true);
    // The seed never opens a batch transaction on the handle: on device the
    // repository's exclusive transaction runs on its own native connection,
    // so nesting it inside `withTransactionAsync` aborts the pass.
    expect(order).not.toContain('seed-transaction-begin');
    expect(order).not.toContain('seed-transaction-commit');
    expect(db.withTransactionAsync).not.toHaveBeenCalled();
    expect(order.filter((entry) => entry === 'createItem').length).toBe(501);
    const viewportIndex = order.findIndex((entry) => entry === 'queryItems:{}');
    const searchIndex = order.findIndex((entry) =>
      entry.startsWith('queryItems:{"query"'),
    );
    expect(viewportIndex).toBeGreaterThan(-1);
    expect(searchIndex).toBeGreaterThan(viewportIndex);
    expect(order.lastIndexOf('createItem')).toBeGreaterThan(searchIndex);
    expect(deps.queryItems).toHaveBeenCalledTimes(2);
  });

  test('the seed never nests a batch transaction around repository writes', async () => {
    // Device-observed failure this test locks in: the repository creates each
    // item inside an exclusive transaction on an isolated native connection,
    // so wrapping the 500 seed inserts in the handle's batch transaction
    // aborted the whole pass with "Could not create item: storage
    // unavailable." The handle below refuses to nest exactly like the device.
    const order: string[] = [];
    const db = makeMeasureDb(order);
    (db.withTransactionAsync as jest.Mock).mockImplementation(async () => {
      order.push('seed-transaction-begin');
      throw new Error('Could not create item: storage unavailable.');
    });
    const deps = makeMeasureDeps(order, flatNow([10, 5, 5, 5]));
    const result = await runCrudMeasurePass(db, CRUD_FIXTURE_DB, deps);
    expect(db.withTransactionAsync).not.toHaveBeenCalled();
    expect(result.checks.map((check) => check.name)).toEqual([
      CRUD_MEASURE_LABEL_SEED,
      CRUD_MEASURE_LABEL_FIRST_VIEWPORT,
      CRUD_MEASURE_LABEL_SEARCH,
      CRUD_MEASURE_LABEL_WRITE,
    ]);
    expect(result.status).toBe('pass');
    expect(order.filter((entry) => entry === 'createItem').length).toBe(501);
  });

  test('an over-budget check fails while the pass still completes the remaining checks', async () => {
    const order: string[] = [];
    const db = makeMeasureDb(order);
    // Search costs 350ms against its 200ms budget; everything else fits.
    const deps = makeMeasureDeps(order, flatNow([400, 120, 350, 20]));
    const result = await runCrudMeasurePass(db, CRUD_FIXTURE_DB, deps);
    expect(result.status).toBe('fail');
    expect(result.checks).toHaveLength(4);
    const [seed, viewport, search, write] = result.checks;
    expect(seed.pass).toBe(true);
    expect(viewport.pass).toBe(true);
    expect(search.pass).toBe(false);
    expect(search.detail).toContain('FAIL');
    expect(search.detail).toMatch(/350/);
    // The missed budget never aborts the pass: the write probe still ran.
    expect(write.pass).toBe(true);
    expect(write.detail).toContain('PASS');
    expect(order.lastIndexOf('createItem')).toBeGreaterThan(
      order.findIndex((entry) => entry.startsWith('queryItems:{"query"')),
    );
  });

  test('a second pass cleans its own rows first and never widens the deletes', async () => {
    const order: string[] = [];
    const db = makeMeasureDb(order);
    const first = await runCrudMeasurePass(
      db,
      CRUD_FIXTURE_DB,
      makeMeasureDeps(order, flatNow([10, 5, 5, 5])),
    );
    expect(first.status).toBe('pass');
    const afterFirst = order.length;
    expect(afterFirst).toBeGreaterThan(0);
    const second = await runCrudMeasurePass(
      db,
      CRUD_FIXTURE_DB,
      makeMeasureDeps(order, flatNow([10, 5, 5, 5])),
    );
    expect(second.status).toBe('pass');
    const secondPassOrder = order.slice(afterFirst);
    // Cleanup deletes target exactly the three entity tables and the
    // measurement prefix — never an unscoped delete.
    const cleanups = order.filter((entry) => entry.startsWith('cleanup:'));
    expect(cleanups.length).toBeGreaterThan(0);
    expect(
      cleanups.every((entry) =>
        ['cleanup:items', 'cleanup:locations', 'cleanup:categories'].includes(
          entry,
        ),
      ),
    ).toBe(true);
    for (const call of db.runAsync.mock.calls) {
      expect(String(call[1])).toContain('Perf p5b ');
    }
    // Second-pass cleanup runs after the first pass writes and before the
    // second pass seeds, so repeated passes cannot duplicate or corrupt.
    const creates = order.filter((entry) => entry === 'createItem');
    expect(creates.length).toBe(2 * 501);
    const secondPassFirstCreate = secondPassOrder.findIndex(
      (entry) => entry === 'createItem',
    );
    expect(secondPassFirstCreate).toBeGreaterThan(0);
    const secondPassFirstCleanup = secondPassOrder.findIndex((entry) =>
      entry.startsWith('cleanup:'),
    );
    expect(secondPassFirstCleanup).toBeGreaterThanOrEqual(0);
    expect(secondPassFirstCleanup).toBeLessThan(secondPassFirstCreate);
  });

  test('a refused database name throws before any driver or repository call', async () => {
    const order: string[] = [];
    const db = makeMeasureDb(order);
    const deps = makeMeasureDeps(order, flatNow([10, 5, 5, 5]));
    await expect(runCrudMeasurePass(db, 'tengo.db', deps)).rejects.toThrow(
      /Refusing unsafe CRUD fixture/,
    );
    expect(order).toEqual([]);
    expect(db.runAsync).not.toHaveBeenCalled();
    expect(deps.createItem).not.toHaveBeenCalled();
    expect(deps.queryItems).not.toHaveBeenCalled();
  });

  test('seeding still completes when the driver has no batch-transaction hook', async () => {
    const order: string[] = [];
    const full = makeMeasureDb(order);
    const { withTransactionAsync, ...rest } = full as unknown as Record<
      string,
      unknown
    >;
    void withTransactionAsync;
    const db = rest as unknown as CrudFixtureDb;
    const deps = makeMeasureDeps(order, flatNow([10, 5, 5, 5]));
    const result = await runCrudMeasurePass(db, CRUD_FIXTURE_DB, deps);
    expect(result.status).toBe('pass');
    expect(result.checks).toHaveLength(4);
    expect(order.filter((entry) => entry === 'createItem').length).toBe(501);
  });
});
