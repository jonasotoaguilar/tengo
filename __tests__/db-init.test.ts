/**
 * Mocked native boundary test.
 *
 * Everything here runs against an injected fake database object — no
 * `expo-sqlite` native module, no `.db` file, no real persistence. It proves
 * the initialization *logic* (read version -> apply pending migrations in
 * order -> record new version). Real SQLite persistence must be verified on
 * a native emulator/device build (see README "Native testing limits").
 */
import {
  DATABASE_NAME,
  type DatabaseLike,
  initializeDatabase,
} from '../src/db';
import { MIGRATIONS } from '../src/db/migrations';

function makeFakeDb(version: number) {
  const execCalls: string[] = [];
  let userVersion = version;
  const db: DatabaseLike = {
    execAsync: jest.fn(async (source: string) => {
      execCalls.push(source);
      const match = /PRAGMA user_version\s*=\s*(\d+)/i.exec(source);
      if (match) userVersion = Number(match[1]);
    }),
    getFirstAsync: jest.fn(async () => ({ user_version: userVersion })),
  };
  return { db, execCalls, getVersion: () => userVersion };
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

  test('fresh database applies migration 1 and records version 1', async () => {
    const { db, execCalls, getVersion } = makeFakeDb(0);
    await initializeDatabase(db);
    expect(execCalls).toContain(MIGRATIONS[1]);
    expect(getVersion()).toBe(1);
  });

  test('migrated database executes no migration SQL', async () => {
    const { db, execCalls } = makeFakeDb(1);
    await initializeDatabase(db);
    expect(execCalls.filter((sql) => /CREATE TABLE/i.test(sql))).toEqual([]);
  });
});
