import {
  getPendingMigrations,
  MIGRATIONS,
  MigrationRequiredError,
  SCHEMA_VERSION,
  UnknownSchemaVersionError,
} from '../src/db/migrations';

describe('database migrations (M1 normalized model)', () => {
  test('schema version is 2 with migrations 1 and 2', () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(Object.keys(MIGRATIONS).sort()).toEqual(['1', '2']);
  });

  test('fresh database (version 0) has migrations 1 and 2 pending in order', () => {
    expect(getPendingMigrations(0)).toEqual([1, 2]);
  });

  test('v1 database has only migration 2 pending', () => {
    expect(getPendingMigrations(1)).toEqual([2]);
  });

  test('migrated database (version 2) has nothing pending', () => {
    expect(getPendingMigrations(2)).toEqual([]);
  });

  test('newer-than-known database version has nothing pending', () => {
    expect(getPendingMigrations(99)).toEqual([]);
  });

  test('migration 1 keeps the minimal v1 items foundation unchanged', () => {
    const sql = MIGRATIONS[1];
    expect(sql).toMatch(/CREATE TABLE/i);
    expect(sql).toMatch(/items/);
    expect(sql).toMatch(/name\s+TEXT NOT NULL/i);
  });

  test('migration 2 creates the normalized location/category/item tables', () => {
    const sql = MIGRATIONS[2];
    expect(sql).toMatch(/CREATE TABLE/i);
    expect(sql).toMatch(/locations/);
    expect(sql).toMatch(/categories/);
    expect(sql).toMatch(/item_categories/);
    // The v1 items table is rebuilt with the required location reference.
    expect(sql).toMatch(/location_id\s+INTEGER NOT NULL/i);
    expect(sql).toMatch(/quantity\s+INTEGER NOT NULL/i);
  });

  test('migration 2 enforces item-location integrity without orphaning', () => {
    const sql = MIGRATIONS[2];
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(\s*location_id\s*\)\s*REFERENCES\s+locations\s*\(\s*id\s*\)\s*ON DELETE RESTRICT/i,
    );
    // Location deletion must never cascade-delete items: no CASCADE before
    // the item_categories join table definition.
    const beforeJoin = sql.split(/item_categories/i)[0];
    expect(beforeJoin).toMatch(/RESTRICT/);
    expect(beforeJoin).not.toMatch(/CASCADE/i);
  });

  test('migration 2 enforces the category join with a composite key', () => {
    const sql = MIGRATIONS[2];
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*item_id\s*,\s*category_id\s*\)/i);
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(\s*item_id\s*\)\s*REFERENCES\s+items\s*\(\s*id\s*\)/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(\s*category_id\s*\)\s*REFERENCES\s+categories\s*\(\s*id\s*\)/i,
    );
  });

  test('migration 2 requires nonblank names and a nullable-only-when-null address', () => {
    const sql = MIGRATIONS[2];
    expect(sql).toMatch(/name\s+TEXT NOT NULL CHECK/i);
    expect(sql).toMatch(/address\s+TEXT CHECK/i);
    expect(sql).toMatch(/address IS NULL OR/i);
  });

  test('migration 2 bounds quantity with the technical safe-integer guard only', () => {
    const sql = MIGRATIONS[2];
    // Integer storage is enforced in SQLite itself: fractional REAL values
    // (e.g. 1.5) fail the CHECK, matching domain normalizeQuantity.
    expect(sql).toMatch(/typeof\s*\(\s*quantity\s*\)\s*=\s*'integer'/i);
    expect(sql).toMatch(/quantity\s*>=\s*0/i);
    // 9007199254740991 is Number.MAX_SAFE_INTEGER: a JS-integer technical
    // bound, not a user-approved product limit.
    expect(sql).toMatch(/9007199254740991/);
  });

  test('migration 2 implements no unapproved product caps, uniqueness, or backfill', () => {
    const sql = MIGRATIONS[2];
    // No VARCHAR length caps such as name(120)/location(80).
    expect(sql).not.toMatch(/VARCHAR/i);
    expect(sql).not.toMatch(/\(120\)/);
    expect(sql).not.toMatch(/\(80\)/);
    // No 999999-style product quantity cap.
    expect(sql).not.toMatch(/999999/);
    // No name/address uniqueness (proposed, not approved).
    expect(sql).not.toMatch(/UNIQUE/i);
    // No synthetic location backfill: migration must fail instead.
    expect(sql).not.toMatch(/unassigned/i);
  });

  test('MigrationRequiredError preserves the blocking row count', () => {
    const error = new MigrationRequiredError(3);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MigrationRequiredError');
    expect(error.rowCount).toBe(3);
    expect(error.message).toMatch(/3/);
    expect(error.message).toMatch(/preserv/i);
  });

  test('UnknownSchemaVersionError reports the unsupported version', () => {
    const error = new UnknownSchemaVersionError(99, 2);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UnknownSchemaVersionError');
    expect(error.foundVersion).toBe(99);
    expect(error.message).toMatch(/99/);
  });
});
