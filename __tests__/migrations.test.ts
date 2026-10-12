import {
  getPendingMigrations,
  MIGRATIONS,
  MigrationRequiredError,
  SCHEMA_VERSION,
  UnknownSchemaVersionError,
} from '../src/db/migrations';

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

/** Apply one migration the way the runner does: SQL + version bump, atomic. */
function applyMigrationReal(
  db: {
    exec(sql: string): void;
  },
  version: number,
): void {
  db.exec(
    `BEGIN;\n${MIGRATIONS[version]}\nPRAGMA user_version = ${version};\nCOMMIT;`,
  );
}

function userVersionReal(db: {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}): number {
  const row = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  return row.user_version;
}

function countReal(
  db: {
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
  },
  table: string,
): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

describe('database migrations (M1 normalized model)', () => {
  test('schema version is 3 with migrations 1, 2, and 3', () => {
    expect(SCHEMA_VERSION).toBe(3);
    expect(Object.keys(MIGRATIONS).sort()).toEqual(['1', '2', '3']);
  });

  test('v2 database has only migration 3 pending', () => {
    expect(getPendingMigrations(2)).toEqual([3]);
  });

  test('fresh database (version 0) has migrations 1, 2, and 3 pending in order', () => {
    expect(getPendingMigrations(0)).toEqual([1, 2, 3]);
  });

  test('v1 database has migrations 2 and 3 pending in order', () => {
    expect(getPendingMigrations(1)).toEqual([2, 3]);
  });

  test('migrated database (version 3) has nothing pending', () => {
    expect(getPendingMigrations(3)).toEqual([]);
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

describe('migration 3 name uniqueness (S11, real SQLite engine)', () => {
  test('v3 SQL carries a UNIQUE normalized-name index per entity table', () => {
    const sql = MIGRATIONS[3];
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(
      /locations\s*\(\s*lower\s*\(\s*trim\s*\(\s*name\s*\)\s*\)\s*\)/i,
    );
    expect(sql).toMatch(
      /categories\s*\(\s*lower\s*\(\s*trim\s*\(\s*name\s*\)\s*\)\s*\)/i,
    );
  });

  test('v3 SQL rewrites no rows and fabricates no data', () => {
    const sql = MIGRATIONS[3];
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/UPDATE\s+(locations|categories|items)\s+SET/i);
    expect(sql).not.toMatch(/INSERT INTO\s+(locations|categories|items)\s*\(/i);
    expect(sql).not.toMatch(/unassigned/i);
  });

  test('S11 RED: empty database migrates cleanly to v3 with enforced indexes', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrationReal(db, 1);
      applyMigrationReal(db, 2);
      applyMigrationReal(db, 3);
      expect(userVersionReal(db)).toBe(3);
      db.prepare("INSERT INTO locations (name) VALUES ('Pantry')").run();
      expect(() =>
        db.prepare("INSERT INTO locations (name) VALUES ('pantry')").run(),
      ).toThrow(/UNIQUE/i);
      expect(() =>
        db.prepare("INSERT INTO locations (name) VALUES ('  Pantry  ')").run(),
      ).toThrow(/UNIQUE/i);
      // The DB index folds case/whitespace only: accent pairs still insert
      // here and stay the domain layer's responsibility (S11 split).
      db.prepare("INSERT INTO categories (name) VALUES ('Café')").run();
      db.prepare("INSERT INTO categories (name) VALUES ('cafe')").run();
      expect(countReal(db, 'locations')).toBe(1);
    } finally {
      db.close();
    }
  });

  test('S11 RED: v2 database holding duplicates fails loudly, rows/version preserved', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrationReal(db, 1);
      applyMigrationReal(db, 2);
      db.prepare("INSERT INTO locations (name) VALUES ('Pantry')").run();
      db.prepare("INSERT INTO locations (name) VALUES (' pantry ')").run();
      db.prepare("INSERT INTO categories (name) VALUES ('Grains')").run();
      expect(userVersionReal(db)).toBe(2);
      let failure: unknown = null;
      try {
        applyMigrationReal(db, 3);
      } catch (error) {
        failure = error;
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Best effort: the preservation assertions below are the point.
        }
      }
      expect(failure).not.toBeNull();
      expect(String((failure as Error)?.message ?? failure)).toMatch(
        /Migration to schema version 3 blocked/,
      );
      // Preserve-and-stop: nothing rewritten, nothing lost, version held.
      expect(countReal(db, 'locations')).toBe(2);
      expect(countReal(db, 'categories')).toBe(1);
      expect(userVersionReal(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test('S11 RED: duplicate categories block v3 even when locations are clean', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrationReal(db, 1);
      applyMigrationReal(db, 2);
      db.prepare("INSERT INTO locations (name) VALUES ('Pantry')").run();
      db.prepare("INSERT INTO categories (name) VALUES ('Tools')").run();
      db.prepare("INSERT INTO categories (name) VALUES ('TOOLS')").run();
      let message = '';
      try {
        applyMigrationReal(db, 3);
      } catch (error) {
        message = String((error as Error)?.message ?? error);
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Preservation below is the assertion that matters.
        }
      }
      expect(message).toMatch(/Migration to schema version 3 blocked/);
      expect(message).toMatch(/categories/);
      expect(countReal(db, 'categories')).toBe(2);
      expect(userVersionReal(db)).toBe(2);
    } finally {
      db.close();
    }
  });
});
