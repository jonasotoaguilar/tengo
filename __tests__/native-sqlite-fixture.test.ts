/**
 * RED tests for the DEV-ONLY native SQLite fixture harness (T3).
 *
 * These prove the required gate BEFORE implementation exists:
 * - flagged + DEV path bypasses the default initializeDatabase() open,
 * - production (__DEV__ false) ignores the public flag,
 * - fixture names are validated and always refuse tengo.db.
 *
 * Fixture orchestration itself is tested with injected mocks only;
 * this file never claims native/device proof.
 */
import { DATABASE_NAME } from '../src/db';
import {
  assertSafeFixtureName,
  isNativeFixtureEnabled,
  isSafeFixtureName,
  runNativeSqliteFixture,
} from '../src/dev/nativeSqliteFixture';

const DEV = globalThis as Record<string, unknown>;
const ENV = process.env;

function setFixtureEnv(dev: boolean, flag: string | undefined) {
  DEV.__DEV__ = dev;
  if (flag === undefined) {
    delete ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
  } else {
    ENV.EXPO_PUBLIC_NATIVE_FIXTURE = flag;
  }
}

describe('native fixture gate (mocked, not native proof)', () => {
  const origDev = DEV.__DEV__;
  const origFlag = ENV.EXPO_PUBLIC_NATIVE_FIXTURE;

  afterEach(() => {
    DEV.__DEV__ = origDev;
    if (origFlag === undefined) {
      delete ENV.EXPO_PUBLIC_NATIVE_FIXTURE;
    } else {
      ENV.EXPO_PUBLIC_NATIVE_FIXTURE = origFlag;
    }
  });

  test('enabled only when DEV and the public flag are both set', () => {
    setFixtureEnv(true, '1');
    expect(isNativeFixtureEnabled()).toBe(true);
    setFixtureEnv(true, undefined);
    expect(isNativeFixtureEnabled()).toBe(false);
    setFixtureEnv(false, '1');
    expect(isNativeFixtureEnabled()).toBe(false);
  });

  test('fixture names are unique m1-fixture-*.db and always refuse tengo.db', () => {
    expect(isSafeFixtureName('m1-fixture-fresh.db')).toBe(true);
    expect(isSafeFixtureName(DATABASE_NAME)).toBe(false);
    expect(isSafeFixtureName('tengo.db')).toBe(false);
    expect(isSafeFixtureName('m1-fixture-x.db')).toBe(true);
    expect(isSafeFixtureName('other.db')).toBe(false);
    expect(isSafeFixtureName('../m1-fixture-x.db')).toBe(false);
    expect(() => assertSafeFixtureName(DATABASE_NAME)).toThrow();
    expect(() => assertSafeFixtureName('m1-fixture-ok.db')).not.toThrow();
  });

  test('orchestration never opens tengo.db and closes before cleanup', async () => {
    const opened: string[] = [];
    const deleted: string[] = [];
    const events: string[] = [];
    const fakeDb = {
      execAsync: jest.fn(async () => {}),
      getFirstAsync: jest.fn(async (sql: string) => {
        if (/foreign_keys/.test(sql)) return 1;
        if (/COUNT/.test(sql)) return { count: 1 };
        return { user_version: 4 };
      }),
      getAllAsync: jest.fn(async () => []),
      runAsync: jest.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
      closeAsync: jest.fn(async () => {
        events.push('close');
      }),
      withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
        await task();
      }),
    };
    const deps = {
      openDatabaseAsync: jest.fn(async (name: string) => {
        opened.push(name);
        return fakeDb;
      }),
      deleteDatabaseAsync: jest.fn(async (name: string) => {
        deleted.push(name);
        events.push(`delete:${name}`);
      }),
      initializeDatabase: jest.fn(async (db: unknown) => db),
    };
    const result = await runNativeSqliteFixture(deps);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(opened.length).toBeGreaterThan(0);
    for (const name of [...opened, ...deleted]) {
      expect(name).not.toBe(DATABASE_NAME);
      expect(isSafeFixtureName(name)).toBe(true);
    }
    const closeIdx = events.indexOf('close');
    const deleteIdxs = events
      .map((e, i) => (e.startsWith('delete:') ? i : -1))
      .filter((i) => i >= 0);
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    // The finally-block cleanup delete runs after close (a pre-run stale
    // delete may legitimately precede it).
    expect(deleteIdxs.length).toBeGreaterThan(0);
    expect(deleteIdxs[deleteIdxs.length - 1]).toBeGreaterThan(closeIdx);
  });

  test('failed assertions are surfaced, never swallowed', async () => {
    const deps = {
      openDatabaseAsync: jest.fn(async () => {
        throw new Error('forced open failure');
      }),
      deleteDatabaseAsync: jest.fn(async () => {}),
      initializeDatabase: jest.fn(async (db: unknown) => db),
    };
    const result = await runNativeSqliteFixture(deps);
    expect(result.pass).toBe(false);
    expect(result.checks.some((c) => !c.pass)).toBe(true);
  });
});
