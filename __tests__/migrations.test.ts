import {
  getPendingMigrations,
  MIGRATIONS,
  SCHEMA_VERSION,
} from '../src/db/migrations';

describe('database migrations', () => {
  test('schema version is 1 with exactly one initial migration', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(Object.keys(MIGRATIONS)).toEqual(['1']);
  });

  test('fresh database (version 0) has migration 1 pending', () => {
    expect(getPendingMigrations(0)).toEqual([1]);
  });

  test('migrated database (version 1) has nothing pending', () => {
    expect(getPendingMigrations(1)).toEqual([]);
  });

  test('newer-than-known database version has nothing pending', () => {
    expect(getPendingMigrations(99)).toEqual([]);
  });

  test('initial migration creates the minimal items foundation', () => {
    const sql = MIGRATIONS[1];
    expect(sql).toMatch(/CREATE TABLE/i);
    expect(sql).toMatch(/items/);
    expect(sql).toMatch(/name\s+TEXT NOT NULL/i);
  });
});
