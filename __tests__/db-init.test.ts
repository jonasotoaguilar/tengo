/**
 * Mocked native boundary test.
 *
 * Everything here runs against an injected fake database object — no
 * `expo-sqlite` native module, no `.db` file, no real persistence. It proves
 * the initialization *logic* (foreign keys first, read version -> apply
 * pending migrations with the version bump in one transaction each ->
 * preserve-and-stop on unmigratable v1 rows -> reject unknown versions).
 * Real SQLite enforcement (constraints, rollback, FK behavior) must be
 * verified against real SQLite (see scripts/verify-inventory-schema.py,
 * host evidence only) and on a native emulator/device build.
 */
import {
  DATABASE_NAME,
  type DatabaseLike,
  initializeDatabase,
  MigrationRequiredError,
  UnknownSchemaVersionError,
} from '../src/db';
import { MIGRATIONS } from '../src/db/migrations';

interface FakeOptions {
  version: number;
  rowCount?: number;
  failOn?: RegExp;
}

function makeFakeDb({ version, rowCount = 0, failOn }: FakeOptions) {
  const execCalls: string[] = [];
  const events: string[] = [];
  let userVersion = version;
  const db: DatabaseLike = {
    execAsync: jest.fn(async (source: string) => {
      if (failOn?.test(source)) {
        throw new Error(`fake sqlite error for: ${source.slice(0, 60)}`);
      }
      execCalls.push(source);
      if (/PRAGMA\s+foreign_keys/i.test(source)) {
        events.push('fk-on');
      }
      const match = /PRAGMA user_version\s*=\s*(\d+)/i.exec(source);
      if (match) {
        userVersion = Number(match[1]);
      }
    }),
    getFirstAsync: jest.fn(async (source: string) => {
      if (/COUNT\s*\(\s*\*\s*\)/i.test(source)) {
        return { count: rowCount };
      }
      return { user_version: userVersion };
    }),
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
      const snapshot = userVersion;
      events.push('begin');
      try {
        await task();
        events.push('commit');
      } catch (error) {
        userVersion = snapshot;
        events.push('rollback');
        throw error;
      }
    }),
  };
  return { db, execCalls, events, getVersion: () => userVersion };
}

describe('initializeDatabase (mocked native boundary)', () => {
  test(`opens the "${DATABASE_NAME}" database when none is injected`, async () => {
    const SQLite = require('expo-sqlite') as {
      openDatabaseAsync: jest.Mock;
    };
    SQLite.openDatabaseAsync.mockClear();
    await initializeDatabase();
    expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith(DATABASE_NAME);
  });

  test('fresh database applies migrations 1 then 2 and 3 and records version 3', async () => {
    const { db, execCalls, getVersion } = makeFakeDb({ version: 0 });
    await initializeDatabase(db);
    expect(execCalls).toContain(MIGRATIONS[1]);
    expect(execCalls).toContain(MIGRATIONS[2]);
    expect(execCalls).toContain(MIGRATIONS[3]);
    expect(execCalls.indexOf(MIGRATIONS[1])).toBeLessThan(
      execCalls.indexOf(MIGRATIONS[2]),
    );
    expect(execCalls.indexOf(MIGRATIONS[2])).toBeLessThan(
      execCalls.indexOf(MIGRATIONS[3]),
    );
    expect(getVersion()).toBe(3);
  });

  test('foreign keys are enabled first, outside any transaction', async () => {
    const { db, execCalls, events } = makeFakeDb({ version: 0 });
    await initializeDatabase(db);
    expect(execCalls[0]).toMatch(/PRAGMA\s+foreign_keys\s*=\s*ON/i);
    expect(events[0]).toBe('fk-on');
    expect(events[1]).toBe('begin');
  });

  test('each migration and its version update share one transaction', async () => {
    const { db, execCalls, events } = makeFakeDb({ version: 0 });
    await initializeDatabase(db);
    expect(events).toEqual([
      'fk-on',
      'begin',
      'commit',
      'begin',
      'commit',
      'begin',
      'commit',
    ]);
    expect(execCalls).toEqual([
      expect.stringMatching(/PRAGMA\s+foreign_keys\s*=\s*ON/i),
      MIGRATIONS[1],
      expect.stringMatching(/PRAGMA\s+user_version\s*=\s*1/i),
      MIGRATIONS[2],
      expect.stringMatching(/PRAGMA\s+user_version\s*=\s*2/i),
      MIGRATIONS[3],
      expect.stringMatching(/PRAGMA\s+user_version\s*=\s*3/i),
    ]);
  });

  test('empty v1 database migrates cleanly to version 3', async () => {
    const { db, execCalls, getVersion } = makeFakeDb({
      version: 1,
      rowCount: 0,
    });
    await initializeDatabase(db);
    expect(execCalls).toContain(MIGRATIONS[2]);
    expect(execCalls).toContain(MIGRATIONS[3]);
    expect(getVersion()).toBe(3);
  });

  test('nonempty v1 blocks migration with a typed error and preserves rows/version', async () => {
    const { db, execCalls, getVersion } = makeFakeDb({
      version: 1,
      rowCount: 3,
    });
    await expect(initializeDatabase(db)).rejects.toBeInstanceOf(
      MigrationRequiredError,
    );
    await expect(initializeDatabase(db)).rejects.toMatchObject({
      name: 'MigrationRequiredError',
      rowCount: 3,
    });
    // Nothing was written: no table rebuild, version untouched.
    expect(execCalls.filter((sql) => /CREATE TABLE/i.test(sql))).toEqual([]);
    expect(execCalls.filter((sql) => /DROP TABLE/i.test(sql))).toEqual([]);
    expect(getVersion()).toBe(1);
  });

  test('migrated database (version 2) executes no migration SQL', async () => {
    const { db, execCalls } = makeFakeDb({ version: 2 });
    await initializeDatabase(db);
    expect(execCalls.filter((sql) => /CREATE TABLE/i.test(sql))).toEqual([]);
    expect(execCalls.filter((sql) => /DROP TABLE/i.test(sql))).toEqual([]);
  });

  test('unknown future version is rejected safely without writing', async () => {
    const { db, execCalls, getVersion } = makeFakeDb({ version: 99 });
    await expect(initializeDatabase(db)).rejects.toBeInstanceOf(
      UnknownSchemaVersionError,
    );
    expect(execCalls.filter((sql) => /CREATE TABLE/i.test(sql))).toEqual([]);
    expect(getVersion()).toBe(99);
  });

  test('a failing migration rolls back without recording the new version', async () => {
    const { db, execCalls, events, getVersion } = makeFakeDb({
      version: 1,
      rowCount: 0,
      failOn: /item_categories/,
    });
    await expect(initializeDatabase(db)).rejects.toThrow(/fake sqlite error/);
    expect(events).toContain('rollback');
    expect(getVersion()).toBe(1);
    expect(
      execCalls.filter((sql) => /PRAGMA\s+user_version\s*=\s*2/i.test(sql)),
    ).toEqual([]);
  });
});
