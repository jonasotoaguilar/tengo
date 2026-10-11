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
  type CrudFixtureDb,
  type CrudFixtureDeps,
  CrudFixtureResetRefusedError,
  closeCrudFixtureHandle,
  isNativeCrudFixtureEnabled,
  openNativeCrudFixture,
  resetNativeCrudFixture,
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
