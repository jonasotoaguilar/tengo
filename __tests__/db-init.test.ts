/**
 * Mocked native boundary test.
 *
 * Everything here runs against an injected fake database object — no
 * `expo-sqlite` native module, no `.db` file, no real persistence. It proves
 * the initialization *logic* (foreign keys first, read version -> apply
 * pending migrations with the version bump in one transaction each ->
 * preserve-and-stop on unmigratable v1 rows -> the v4 FK-off envelope with
 * its integrity guard -> reject unknown versions). Real SQLite enforcement
 * (constraints, rollback, FK behavior) must be verified against real SQLite
 * (see scripts/verify-inventory-schema.py, host evidence only) and on a
 * native emulator/device build.
 */
import {
  DATABASE_NAME,
  type DatabaseLike,
  initializeDatabase,
  MigrationIntegrityError,
  MigrationRequiredError,
  UnknownSchemaVersionError,
} from '../src/db';
import { MIGRATIONS } from '../src/db/migrations';

interface FakeOptions {
  version: number;
  rowCount?: number;
  failOn?: RegExp;
  fkCheckCount?: number;
  failFkToggle?: boolean;
  /** Throw this message when the v4 script runs (the guard ABORT shape). */
  failV4With?: string;
}

function makeFakeDb({
  version,
  rowCount = 0,
  failOn,
  fkCheckCount = 0,
  failFkToggle = false,
  failV4With,
}: FakeOptions) {
  const execCalls: string[] = [];
  const events: string[] = [];
  let userVersion = version;
  const db: DatabaseLike = {
    execAsync: jest.fn(async (source: string) => {
      if (failV4With !== undefined && source === MIGRATIONS[4]) {
        throw new Error(failV4With);
      }
      if (failOn?.test(source)) {
        throw new Error(`fake sqlite error for: ${source.slice(0, 60)}`);
      }
      if (failFkToggle && /PRAGMA\s+foreign_keys/i.test(source)) {
        throw new Error('fake FK toggle failure');
      }
      execCalls.push(source);
      if (/PRAGMA\s+foreign_keys\s*=\s*ON/i.test(source)) {
        events.push('fk-on');
      }
      if (/PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(source)) {
        events.push('fk-off');
      }
      const match = /PRAGMA user_version\s*=\s*(\d+)/i.exec(source);
      if (match) {
        userVersion = Number(match[1]);
      }
    }),
    getFirstAsync: jest.fn(async (source: string) => {
      if (/pragma_foreign_key_check/i.test(source)) {
        return { count: fkCheckCount };
      }
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

  test('fresh database applies migrations 1-6 in order and records version 6', async () => {
    const { db, execCalls, getVersion } = makeFakeDb({ version: 0 });
    await initializeDatabase(db);
    for (const version of [1, 2, 3, 4, 5, 6]) {
      expect(execCalls).toContain(MIGRATIONS[version]);
    }
    expect(execCalls.indexOf(MIGRATIONS[1])).toBeLessThan(
      execCalls.indexOf(MIGRATIONS[2]),
    );
    expect(execCalls.indexOf(MIGRATIONS[2])).toBeLessThan(
      execCalls.indexOf(MIGRATIONS[3]),
    );
    expect(execCalls.indexOf(MIGRATIONS[3])).toBeLessThan(
      execCalls.indexOf(MIGRATIONS[4]),
    );
    expect(execCalls.indexOf(MIGRATIONS[4])).toBeLessThan(
      execCalls.indexOf(MIGRATIONS[5]),
    );
    expect(execCalls.indexOf(MIGRATIONS[5])).toBeLessThan(
      execCalls.indexOf(MIGRATIONS[6]),
    );
    expect(getVersion()).toBe(6);
  });

  test('foreign keys are enabled first, outside any transaction', async () => {
    const { db, execCalls, events } = makeFakeDb({ version: 0 });
    await initializeDatabase(db);
    expect(execCalls[0]).toMatch(/PRAGMA\s+foreign_keys\s*=\s*ON/i);
    expect(events[0]).toBe('fk-on');
    expect(events[1]).toBe('begin');
  });

  test('each migration and its version update share one transaction', async () => {
    const { db, execCalls, events } = makeFakeDb({ version: 3 });
    await initializeDatabase(db);
    // The v4 envelope only: FK OFF outside the txn, rebuild + check +
    // bump inside, FK ON after commit. The additive v5 and v6 follow on
    // the generic path: one transaction each with the version bump, no
    // toggling.
    expect(events).toEqual([
      'fk-on',
      'fk-off',
      'begin',
      'commit',
      'fk-on',
      'begin',
      'commit',
      'begin',
      'commit',
    ]);
    expect(execCalls).toEqual([
      expect.stringMatching(/PRAGMA\s+foreign_keys\s*=\s*ON/i),
      expect.stringMatching(/PRAGMA\s+foreign_keys\s*=\s*OFF/i),
      MIGRATIONS[4],
      expect.stringMatching(/PRAGMA\s+user_version\s*=\s*4/i),
      expect.stringMatching(/PRAGMA\s+foreign_keys\s*=\s*ON/i),
      MIGRATIONS[5],
      expect.stringMatching(/PRAGMA\s+user_version\s*=\s*5/i),
      MIGRATIONS[6],
      expect.stringMatching(/PRAGMA\s+user_version\s*=\s*6/i),
    ]);
    // The empty-check read runs inside the transaction via getFirstAsync.
    expect(db.getFirstAsync).toHaveBeenCalledWith(
      expect.stringMatching(/pragma_foreign_key_check/i),
    );
  });

  test('migrations 2 and 3 keep their exact shape: FK ON, one txn, no toggling', async () => {
    const { db, execCalls, events } = makeFakeDb({ version: 1, rowCount: 0 });
    await initializeDatabase(db);
    expect(execCalls).toContain(MIGRATIONS[2]);
    expect(execCalls).toContain(MIGRATIONS[3]);
    // Exactly one fk-on (the initial enable) plus the v4 envelope's
    // off/on pair: v2/v3 themselves never toggle.
    expect(events.filter((e) => e === 'fk-on')).toHaveLength(2);
    expect(events.filter((e) => e === 'fk-off')).toHaveLength(1);
    const v2Index = execCalls.indexOf(MIGRATIONS[2]);
    const v3Index = execCalls.indexOf(MIGRATIONS[3]);
    for (const sql of execCalls.slice(0, v2Index)) {
      expect(sql).not.toMatch(/foreign_keys\s*=\s*OFF/i);
    }
    expect(v2Index).toBeLessThan(v3Index);
  });

  test('empty v1 database migrates cleanly to version 6', async () => {
    const { db, execCalls, getVersion } = makeFakeDb({
      version: 1,
      rowCount: 0,
    });
    await initializeDatabase(db);
    expect(execCalls).toContain(MIGRATIONS[2]);
    expect(execCalls).toContain(MIGRATIONS[4]);
    expect(execCalls).toContain(MIGRATIONS[5]);
    expect(execCalls).toContain(MIGRATIONS[6]);
    expect(getVersion()).toBe(6);
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

  test('migrated database (version 6) executes no migration SQL', async () => {
    const { db, execCalls } = makeFakeDb({ version: 6 });
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

  test('v4 guard failure maps to a typed integrity error with version untouched', async () => {
    // Fail the v4 script with the exact ABORT text the TEMP trigger
    // produces, so the typed mapping is exercised through the real shape.
    const { db, events, getVersion } = makeFakeDb({
      version: 3,
      failV4With:
        'Migration to schema version 4 blocked: catalog copy holds a different row count than the old items table.',
    });
    const failure = (await initializeDatabase(db).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(MigrationIntegrityError);
    expect(failure).toMatchObject({ code: 'MIGRATION_INTEGRITY' });
    expect(failure.message).toMatch(/Migration to schema version 4 blocked/);
    expect(getVersion()).toBe(3);
    expect(events).toContain('rollback');
    // FK enforcement is restored even on failure.
    expect(events[events.length - 1]).toBe('fk-on');
  });

  test('v4 foreign_key_check violations abort with rows and version untouched', async () => {
    const { db, events, getVersion } = makeFakeDb({
      version: 3,
      fkCheckCount: 2,
    });
    await expect(initializeDatabase(db)).rejects.toBeInstanceOf(
      MigrationIntegrityError,
    );
    const second = (await initializeDatabase(db).catch(
      (e: unknown) => e,
    )) as Error;
    expect(second.message).toMatch(/Migration to schema version 4 blocked/);
    expect(getVersion()).toBe(3);
    expect(events).toContain('rollback');
    expect(events[events.length - 1]).toBe('fk-on');
  });
});
