import {
  getPendingMigrations,
  MIGRATIONS,
  MigrationIntegrityError,
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
      all(...params: unknown[]): Record<string, unknown>[];
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type RealDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
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

/**
 * Apply v4 the way the runner envelope does: `PRAGMA foreign_keys=OFF`
 * OUTSIDE the transaction (inside it the pragma is a no-op), then the
 * rebuild plus the version bump in one transaction with an empty
 * `foreign_key_check`, then commit, then `PRAGMA foreign_keys=ON`.
 */
function applyMigrationV4Real(db: RealDb): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`BEGIN;\n${MIGRATIONS[4]}\nPRAGMA user_version = 4;\nCOMMIT;`);
  const violations = db
    .prepare('SELECT COUNT(*) AS count FROM pragma_foreign_key_check')
    .get() as { count: number };
  if (violations.count !== 0) {
    throw new Error(
      `foreign_key_check reported ${violations.count} violation(s) after v4`,
    );
  }
  db.exec('PRAGMA foreign_keys = ON;');
}

function userVersionReal(db: RealDb): number {
  const row = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  return row.user_version;
}

function countReal(db: RealDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function tableNamesReal(db: RealDb): string {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
    )
    .all()
    .map((r) => r.name)
    .join(',');
}

/** Seed a populated v3 database: locations, items (one exhausted), links. */
function seedV3(db: RealDb): { locA: number; locB: number; itemIds: number[] } {
  const locA = (
    db.prepare("INSERT INTO locations (name) VALUES ('Casa')").run() as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  const locB = (
    db.prepare("INSERT INTO locations (name) VALUES ('Garage')").run() as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  const cat = (
    db.prepare("INSERT INTO categories (name) VALUES ('Grains')").run() as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  const rice = (
    db
      .prepare(
        'INSERT INTO items (name, quantity, location_id) VALUES (?, ?, ?)',
      )
      .run('Rice', 2, locA) as { lastInsertRowid: number }
  ).lastInsertRowid;
  const beans = (
    db
      .prepare(
        'INSERT INTO items (name, quantity, location_id) VALUES (?, ?, ?)',
      )
      .run('Beans', 0, locB) as { lastInsertRowid: number }
  ).lastInsertRowid;
  db.prepare(
    'INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)',
  ).run(rice, cat);
  db.prepare(
    'INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)',
  ).run(beans, cat);
  return { locA, locB, itemIds: [rice, beans] };
}

describe('database migrations (M1 normalized model)', () => {
  test('schema version is 5 with migrations 1, 2, 3, 4, and 5', () => {
    expect(SCHEMA_VERSION).toBe(5);
    expect(Object.keys(MIGRATIONS).sort()).toEqual(['1', '2', '3', '4', '5']);
  });

  test('v4 database has only migration 5 pending', () => {
    expect(getPendingMigrations(4)).toEqual([5]);
  });

  test('v3 database has migrations 4 and 5 pending in order', () => {
    expect(getPendingMigrations(3)).toEqual([4, 5]);
  });

  test('v2 database has migrations 3, 4, and 5 pending in order', () => {
    expect(getPendingMigrations(2)).toEqual([3, 4, 5]);
  });

  test('fresh database (version 0) has migrations 1-5 pending in order', () => {
    expect(getPendingMigrations(0)).toEqual([1, 2, 3, 4, 5]);
  });

  test('v1 database has migrations 2, 3, 4, and 5 pending in order', () => {
    expect(getPendingMigrations(1)).toEqual([2, 3, 4, 5]);
  });

  test('migrated database (version 5) has nothing pending', () => {
    expect(getPendingMigrations(5)).toEqual([]);
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

  test('MigrationIntegrityError carries the typed v4 block', () => {
    const error = new MigrationIntegrityError(
      'Migration to schema version 4 blocked: catalog count differs',
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MigrationIntegrityError');
    expect(error.code).toBe('MIGRATION_INTEGRITY');
    expect(error.message).toMatch(/Migration to schema version 4 blocked/);
  });

  test('UnknownSchemaVersionError reports the unsupported version', () => {
    const error = new UnknownSchemaVersionError(99, 3);
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

describe('migration 4 catalog + stock (real SQLite engine)', () => {
  test('v4 SQL rebuilds items as the identity-only catalog', () => {
    const sql = MIGRATIONS[4];
    expect(sql).toMatch(/CREATE TABLE\s+items_new/i);
    expect(sql).toMatch(
      /items_new\s*\(\s*id INTEGER PRIMARY KEY AUTOINCREMENT,/i,
    );
    expect(sql).toMatch(/ALTER TABLE\s+items_new\s+RENAME TO\s+items/i);
    expect(sql).toMatch(/DROP TABLE\s+items/i);
    // The catalog keeps id, name, created_at byte-identical: the copy
    // selects exactly those three columns.
    expect(sql).toMatch(
      /INSERT INTO items_new\s*\(\s*id\s*,\s*name\s*,\s*created_at\s*\)\s*SELECT\s+id\s*,\s*name\s*,\s*created_at\s+FROM items/i,
    );
    // One stock row per old item WITH quantity > 0: exhausted items become
    // catalog-only ("sin stock"), never a zero row.
    expect(sql).toMatch(
      /INSERT INTO stock[\s\S]*SELECT[\s\S]*FROM items WHERE quantity > 0/i,
    );
  });

  test('v4 SQL carries the stock shape: composite key, positive CHECK, both cascades, location index', () => {
    const sql = MIGRATIONS[4];
    expect(sql).toMatch(
      /CREATE TABLE\s+stock\s*\(\s*item_id INTEGER NOT NULL,\s*location_id INTEGER NOT NULL,/i,
    );
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*item_id\s*,\s*location_id\s*\)/i);
    expect(sql).toMatch(/typeof\s*\(\s*quantity\s*\)\s*=\s*'integer'/i);
    expect(sql).toMatch(/quantity\s*>\s*0/i);
    expect(sql).toMatch(/9007199254740991/);
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(\s*item_id\s*\)\s*REFERENCES\s+items\s*\(\s*id\s*\)\s*ON DELETE CASCADE/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(\s*location_id\s*\)\s*REFERENCES\s+locations\s*\(\s*id\s*\)\s*ON DELETE CASCADE/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX[^;]*idx_stock_location_id[^;]*\(\s*location_id\s*\)/i,
    );
    // No RESTRICT survives: a location delete cascades stock (R3).
    expect(sql).not.toMatch(/RESTRICT/i);
  });

  test('v4 SQL carries the preserve-and-stop guard on both comparisons', () => {
    const sql = MIGRATIONS[4];
    expect(sql).toMatch(/RAISE\s*\(\s*ABORT/i);
    expect(sql).toMatch(/Migration to schema version 4 blocked/);
    // Catalog count guard: every old item row survives as a catalog row.
    expect(sql).toMatch(/COUNT\(\*\)\)?\s*FROM items_new/i);
    expect(sql).toMatch(/COUNT\(\*\)\)?\s*FROM items/i);
    // Stock sum guard: no quantity invented or lost.
    expect(sql).toMatch(/SUM\s*\(\s*quantity\s*\)[\s\S]*FROM stock/i);
    expect(sql).toMatch(/SUM\s*\(\s*quantity\s*\)[\s\S]*FROM items/i);
    // Never rewrite, never invent a location, never backfill.
    expect(sql).toMatch(/DROP TRIGGER/i);
    expect(sql).not.toMatch(/unassigned/i);
    expect(sql).not.toMatch(/UPDATE\s+(locations|categories)\s+SET/i);
    expect(sql).not.toMatch(/INSERT INTO\s+locations/i);
  });

  test('v4 never renumbers or edits v2/v3: the RESTRICT ladder is untouched', () => {
    expect(MIGRATIONS[2]).toMatch(/ON DELETE RESTRICT/i);
    expect(MIGRATIONS[3]).toMatch(/_migration_v3_guard/);
    expect(MIGRATIONS[3]).not.toMatch(/stock/i);
  });

  test('empty v3 database migrates cleanly to v4 with the new shape', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrationReal(db, 1);
      applyMigrationReal(db, 2);
      applyMigrationReal(db, 3);
      applyMigrationV4Real(db);
      expect(userVersionReal(db)).toBe(4);
      expect(tableNamesReal(db)).toBe(
        'categories,item_categories,items,locations,stock',
      );
      const itemsInfo = db.prepare('PRAGMA table_info(items)').all() as {
        name: string;
      }[];
      expect(itemsInfo.map((c) => c.name)).toEqual([
        'id',
        'name',
        'created_at',
      ]);
      const stockInfo = db.prepare('PRAGMA table_info(stock)').all() as {
        name: string;
      }[];
      expect(stockInfo.map((c) => c.name)).toEqual([
        'item_id',
        'location_id',
        'quantity',
      ]);
      const fk = db.prepare('PRAGMA foreign_key_list(stock)').all() as {
        table: string;
        on_delete: string;
      }[];
      expect(new Set(fk.map((r) => `${r.table}:${r.on_delete}`))).toEqual(
        new Set(['items:CASCADE', 'locations:CASCADE']),
      );
      // Zero-quantity and negative stock rows are rejected by the CHECK.
      const locId = (
        db.prepare("INSERT INTO locations (name) VALUES ('Casa')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid;
      const itemId = (
        db.prepare("INSERT INTO items (name) VALUES ('Rice')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid;
      expect(() =>
        db
          .prepare(
            'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 0)',
          )
          .run(itemId, locId),
      ).toThrow(/CHECK/i);
      db.prepare(
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 2)',
      ).run(itemId, locId);
      expect(() =>
        db
          .prepare(
            'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 2)',
          )
          .run(itemId, locId),
      ).toThrow(/PRIMARYKEY|CONSTRAINT/i);
    } finally {
      db.close();
    }
  });

  test('populated v3 maps to catalog + stock with links preserved and version bumped', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrationReal(db, 1);
      applyMigrationReal(db, 2);
      applyMigrationReal(db, 3);
      db.exec('PRAGMA foreign_keys = ON;');
      const before = db
        .prepare('SELECT id, name, created_at FROM items ORDER BY id ASC')
        .all();
      const beforeSum = (
        db
          .prepare('SELECT COALESCE(SUM(quantity), 0) AS s FROM items')
          .get() as {
          s: number;
        }
      ).s;
      const beforeLinks = (
        db.prepare('SELECT COUNT(*) AS count FROM item_categories').get() as {
          count: number;
        }
      ).count;
      void seedV3(db);
      const seeded = db
        .prepare('SELECT id, name, created_at FROM items ORDER BY id ASC')
        .all();
      expect(seeded.length).toBeGreaterThan(before.length);
      void beforeSum;
      void beforeLinks;
      applyMigrationV4Real(db);
      expect(userVersionReal(db)).toBe(4);
      // Catalog byte-identical: same ids, names, timestamps.
      expect(
        db
          .prepare('SELECT id, name, created_at FROM items ORDER BY id ASC')
          .all(),
      ).toEqual(seeded);
      // One stock row per old item with quantity > 0; the exhausted item
      // (Beans, qty 0) is catalog-only: "sin stock".
      const stock = db
        .prepare(
          'SELECT item_id, location_id, quantity FROM stock ORDER BY item_id ASC',
        )
        .all() as { item_id: number; location_id: number; quantity: number }[];
      expect(stock).toHaveLength(1);
      expect(stock[0]).toMatchObject({ quantity: 2 });
      const names = db
        .prepare('SELECT name FROM items ORDER BY id ASC')
        .all() as { name: string }[];
      expect(names.map((r) => r.name)).toEqual(['Rice', 'Beans']);
      const sinStock = db
        .prepare(
          'SELECT i.name AS name FROM items i LEFT JOIN stock s ON s.item_id = i.id WHERE s.item_id IS NULL',
        )
        .all() as { name: string }[];
      expect(sinStock.map((r) => r.name)).toEqual(['Beans']);
      // Category links survive the rebuild (FK OFF outside the txn, so the
      // DROP cannot cascade them away).
      expect(countReal(db, 'item_categories')).toBe(2);
      const violations = db
        .prepare('SELECT COUNT(*) AS count FROM pragma_foreign_key_check')
        .get() as { count: number };
      expect(violations.count).toBe(0);
      // Autoincrement continues past the preserved max id.
      const maxId = (
        db.prepare('SELECT MAX(id) AS m FROM items').get() as { m: number }
      ).m;
      const next = (
        db.prepare("INSERT INTO items (name) VALUES ('Salt')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid;
      expect(next).toBeGreaterThan(maxId);
    } finally {
      db.close();
    }
  });

  test('the FK trap: DROP with foreign keys ON destroys every category link', () => {
    // This is the procedure the runner envelope exists to avoid. With FK
    // ON, `DROP TABLE items` cascade-deletes all item_categories rows
    // through `item_categories.item_id ... ON DELETE CASCADE`.
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrationReal(db, 1);
      applyMigrationReal(db, 2);
      applyMigrationReal(db, 3);
      seedV3(db);
      expect(countReal(db, 'item_categories')).toBe(2);
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec(`BEGIN;\n${MIGRATIONS[4]}\nCOMMIT;`);
      expect(countReal(db, 'item_categories')).toBe(0);
    } finally {
      db.close();
    }
  });

  test('the shipped guard aborts when the catalog copy loses a row', () => {
    // Runs the REAL guard trigger text extracted from MIGRATIONS[4]
    // against a rigged state (items_new missing one row): the ABORT with
    // the typed 'blocked' message must fire before any DROP runs.
    const sql = MIGRATIONS[4];
    const trigger = sql.match(
      /CREATE TEMP TRIGGER _migration_v4_guard_check[\s\S]*?^END;/m,
    )?.[0];
    expect(trigger).toBeDefined();
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT, quantity INTEGER, location_id INTEGER);
         CREATE TABLE items_new (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT);
         CREATE TABLE stock (item_id INTEGER, location_id INTEGER, quantity INTEGER);
         INSERT INTO items (id, name, created_at, quantity, location_id) VALUES (1, 'Rice', 't', 2, 1), (2, 'Beans', 't', 0, 1);
         INSERT INTO items_new (id, name, created_at) VALUES (1, 'Rice', 't');`,
      );
      db.exec('CREATE TEMP TABLE _migration_v4_guard (id INTEGER);');
      db.exec(trigger as string);
      let message = '';
      try {
        db.exec('INSERT INTO _migration_v4_guard (id) VALUES (1);');
      } catch (error) {
        message = String((error as Error)?.message ?? error);
      }
      expect(message).toMatch(/Migration to schema version 4 blocked/);
    } finally {
      db.close();
    }
  });

  test('the shipped guard aborts when the stock sum differs', () => {
    const sql = MIGRATIONS[4];
    const trigger = sql.match(
      /CREATE TEMP TRIGGER _migration_v4_guard_check[\s\S]*?^END;/m,
    )?.[0];
    expect(trigger).toBeDefined();
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT, quantity INTEGER, location_id INTEGER);
         CREATE TABLE items_new (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT);
         CREATE TABLE stock (item_id INTEGER, location_id INTEGER, quantity INTEGER);
         INSERT INTO items (id, name, created_at, quantity, location_id) VALUES (1, 'Rice', 't', 2, 1);
         INSERT INTO items_new (id, name, created_at) VALUES (1, 'Rice', 't');
         INSERT INTO stock (item_id, location_id, quantity) VALUES (1, 1, 5);`,
      );
      db.exec('CREATE TEMP TABLE _migration_v4_guard (id INTEGER);');
      db.exec(trigger as string);
      let message = '';
      try {
        db.exec('INSERT INTO _migration_v4_guard (id) VALUES (1);');
      } catch (error) {
        message = String((error as Error)?.message ?? error);
      }
      expect(message).toMatch(/Migration to schema version 4 blocked/);
    } finally {
      db.close();
    }
  });

  test('stale items_new from an aborted attempt blocks instead of merging', () => {
    // A leftover items_new (e.g. process death between attempts) makes the
    // rebuild fail loudly inside the transaction: rows and version stay
    // untouched, never silently merged.
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrationReal(db, 1);
      applyMigrationReal(db, 2);
      applyMigrationReal(db, 3);
      seedV3(db);
      db.exec('CREATE TABLE items_new (id INTEGER PRIMARY KEY, name TEXT);');
      let failed = false;
      try {
        applyMigrationV4Real(db);
      } catch {
        failed = true;
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Preservation below is the assertion that matters.
        }
      }
      expect(failed).toBe(true);
      expect(userVersionReal(db)).toBe(3);
      expect(countReal(db, 'items')).toBe(2);
      expect(countReal(db, 'item_categories')).toBe(2);
    } finally {
      db.close();
    }
  });
});
