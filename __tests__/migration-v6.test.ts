/**
 * Migration 6: location address uniqueness (U11, adopted now).
 *
 * The one rule of the uniqueness family that was never adopted is adopted
 * here: a location's address is unique after the same trim/normalization
 * discipline name uniqueness uses. The database enforces the
 * case/whitespace part with a partial UNIQUE expression index
 * (`lower(trim(address))`, NULL addresses excluded so many address-less
 * locations stay legal); the accent part is enforced in the domain layer
 * (`normalizeAddressKey`), which runs before every write — the same
 * split migration 3 uses for names. A v5 database that already holds
 * duplicate addresses fails loudly with a `Migration to schema version 6
 * blocked` message instead of being rewritten (TEMP scratch table plus a
 * single-firing TEMP trigger, inside the runner's transaction), leaving
 * rows and `user_version` untouched. Never rewritten, never nulled out,
 * never fabricated.
 *
 * Real `node:sqlite` behavior, not the mocked native boundary.
 */

import { type DatabaseLike, initializeDatabase } from '../src/db';
import {
  getPendingMigrations,
  MIGRATIONS,
  SCHEMA_VERSION,
} from '../src/db/migrations';
import { bringToCurrentSchema } from '../test-utils/schema';

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      all(...params: unknown[]): Record<string, unknown>[];
      run(...params: unknown[]): { lastInsertRowid: number | bigint };
    };
    close(): void;
  };
};

type RealDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
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
 * Apply v4 the way the runner envelope does: FK OFF outside the
 * transaction, rebuild plus bump inside, FK ON after. v6 must NOT need
 * this envelope (it is additive, like v5).
 */
function applyMigrationV4Real(db: RealDb): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`BEGIN;\n${MIGRATIONS[4]}\nPRAGMA user_version = 4;\nCOMMIT;`);
  db.exec('PRAGMA foreign_keys = ON;');
}

/**
 * Apply ONLY the v6 step onto a v5-state database, the way the generic
 * runner path does: one txn, FK untouched.
 */
function applyMigrationV6Real(db: RealDb): void {
  db.exec(`BEGIN;\n${MIGRATIONS[6]}\nPRAGMA user_version = 6;\nCOMMIT;`);
}

function userVersionReal(db: RealDb): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
}

function countReal(db: RealDb, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

/** Bring a fresh DB to v5 (empty): the v6 starting point. */
function seedV5(db: RealDb): void {
  applyMigrationReal(db, 1);
  applyMigrationReal(db, 2);
  applyMigrationReal(db, 3);
  applyMigrationV4Real(db);
  applyMigrationReal(db, 5);
}

/** Minimal fake proving which runner path applies v6 (events, not SQLite). */
function makeRunnerFake(version: number, failOn?: RegExp) {
  const execCalls: string[] = [];
  const events: string[] = [];
  let userVersion = version;
  const db: DatabaseLike = {
    execAsync: jest.fn(async (source: string) => {
      if (failOn?.test(source)) {
        throw new Error(`fake sqlite error for: ${source.slice(0, 60)}`);
      }
      execCalls.push(source);
      if (/PRAGMA\s+foreign_keys\s*=\s*ON/i.test(source)) events.push('fk-on');
      if (/PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(source))
        events.push('fk-off');
      const match = /PRAGMA user_version\s*=\s*(\d+)/i.exec(source);
      if (match) userVersion = Number(match[1]);
    }),
    getFirstAsync: jest.fn(async () => ({ user_version: userVersion })),
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

describe('migration 6 ladder', () => {
  test('schema version is 6 with migrations 1-6', () => {
    expect(SCHEMA_VERSION).toBe(6);
    expect(Object.keys(MIGRATIONS).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
  });

  test('v5 database has only migration 6 pending', () => {
    expect(getPendingMigrations(5)).toEqual([6]);
  });

  test('v4 database has migrations 5 and 6 pending in order', () => {
    expect(getPendingMigrations(4)).toEqual([5, 6]);
  });

  test('fresh database has migrations 1-6 pending in order', () => {
    expect(getPendingMigrations(0)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('migrated database (version 6) has nothing pending', () => {
    expect(getPendingMigrations(6)).toEqual([]);
  });
});

describe('migration 6 SQL is additive (no rebuild, no rewrite, no backfill)', () => {
  test('v6 creates a partial unique address index over the normalized address', () => {
    const sql = MIGRATIONS[6];
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(/idx_locations_address_norm/i);
    expect(sql).toMatch(
      /locations\s*\(\s*lower\s*\(\s*trim\s*\(\s*address\s*\)\s*\)\s*\)/i,
    );
    // Partial: NULL addresses are excluded, so many address-less
    // locations stay legal.
    expect(sql).toMatch(/WHERE\s+address\s+IS\s+NOT\s+NULL/i);
  });

  test('v6 carries the typed v6 block in its guard', () => {
    const sql = MIGRATIONS[6];
    expect(sql).toMatch(/RAISE\s*\(\s*ABORT/i);
    expect(sql).toMatch(/Migration to schema version 6 blocked/);
    expect(sql).toMatch(/_migration_v6_guard/);
    expect(sql).toMatch(/DROP TRIGGER/i);
  });

  test('v6 never rebuilds, drops, deletes, updates, or backfills', () => {
    const sql = MIGRATIONS[6];
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/UPDATE\s+locations\s+SET/i);
    expect(sql).not.toMatch(/INSERT INTO\s+locations/i);
    expect(sql).not.toMatch(/unassigned/i);
  });
});

describe('migration 6 on real SQLite (empty and populated v5)', () => {
  test('empty v5 migrates to v6 with the partial unique index', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      expect(userVersionReal(db)).toBe(6);
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_locations_address_norm'",
        )
        .all();
      expect(indexes).toHaveLength(1);
      const unique = db.prepare('PRAGMA index_list(locations)').all() as {
        name: string;
        unique: number;
      }[];
      expect(
        unique.find((entry) => entry.name === 'idx_locations_address_norm')
          ?.unique,
      ).toBe(1);
      const ddl = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE name = 'idx_locations_address_norm'",
          )
          .get() as { sql: string }
      ).sql;
      expect(ddl).toMatch(/WHERE\s+address\s+IS\s+NOT\s+NULL/i);
    } finally {
      db.close();
    }
  });

  test('populated v5 rows survive v6 with addresses byte-identical', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      seedV5(db);
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Casa', 'Main Street 12')",
      ).run();
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Garage', NULL)",
      ).run();
      const before = db
        .prepare('SELECT id, name, address FROM locations ORDER BY id ASC')
        .all();
      applyMigrationV6Real(db);
      expect(userVersionReal(db)).toBe(6);
      expect(
        db
          .prepare('SELECT id, name, address FROM locations ORDER BY id ASC')
          .all(),
      ).toEqual(before);
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM pragma_foreign_key_check')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test('the database itself rejects a duplicate address (index backstop)', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Casa', 'Main Street 12')",
      ).run();
      expect(() =>
        db
          .prepare(
            "INSERT INTO locations (name, address) VALUES ('Other', 'Main Street 12')",
          )
          .run(),
      ).toThrow(/UNIQUE/i);
      expect(countReal(db, 'locations')).toBe(1);
    } finally {
      db.close();
    }
  });

  test('the database itself rejects a trim/case collision on the address', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Casa', 'Main Street 12')",
      ).run();
      expect(() =>
        db
          .prepare(
            "INSERT INTO locations (name, address) VALUES ('Other', '  main street 12  ')",
          )
          .run(),
      ).toThrow(/UNIQUE/i);
      expect(countReal(db, 'locations')).toBe(1);
    } finally {
      db.close();
    }
  });

  test('many locations with no address stay legal: NULLs never collide', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      db.prepare("INSERT INTO locations (name) VALUES ('Casa')").run();
      db.prepare("INSERT INTO locations (name) VALUES ('Garage')").run();
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Shed', NULL)",
      ).run();
      expect(countReal(db, 'locations')).toBe(3);
    } finally {
      db.close();
    }
  });

  test('v5 database holding duplicate addresses fails loudly, rows/version preserved', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      seedV5(db);
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Casa', 'Main Street 12')",
      ).run();
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Other', '  MAIN street 12 ')",
      ).run();
      db.prepare("INSERT INTO locations (name) VALUES ('Garage')").run();
      expect(userVersionReal(db)).toBe(5);
      let message = '';
      try {
        applyMigrationV6Real(db);
      } catch (error) {
        message = String((error as Error)?.message ?? error);
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Preservation below is the assertion that matters.
        }
      }
      expect(message).toMatch(/Migration to schema version 6 blocked/);
      // Preserve-and-stop: nothing rewritten, nothing nulled, version held.
      expect(countReal(db, 'locations')).toBe(3);
      expect(
        db.prepare('SELECT address FROM locations WHERE name = ?').get('Other'),
      ).toEqual({ address: '  MAIN street 12 ' });
      expect(userVersionReal(db)).toBe(5);
    } finally {
      db.close();
    }
  });

  test('exact-duplicate addresses block v6 even when names differ', () => {
    const db = new DatabaseSync(':memory:');
    try {
      seedV5(db);
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Casa', 'Main Street 12')",
      ).run();
      db.prepare(
        "INSERT INTO locations (name, address) VALUES ('Other', 'Main Street 12')",
      ).run();
      let message = '';
      try {
        applyMigrationV6Real(db);
      } catch (error) {
        message = String((error as Error)?.message ?? error);
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Preservation below is the assertion that matters.
        }
      }
      expect(message).toMatch(/Migration to schema version 6 blocked/);
      expect(message).toMatch(/address/i);
      expect(countReal(db, 'locations')).toBe(2);
      expect(userVersionReal(db)).toBe(5);
    } finally {
      db.close();
    }
  });
});

describe('migration 6 runner path (mocked native boundary)', () => {
  test('v6 applies through the additive path: one txn, FK never toggled', async () => {
    const { db, execCalls, events, getVersion } = makeRunnerFake(5);
    await initializeDatabase(db);
    expect(execCalls).toContain(MIGRATIONS[6]);
    expect(getVersion()).toBe(6);
    // The additive path is what runs: the initial enable plus exactly one
    // transaction, and no FK-off envelope (only v4 toggles).
    expect(events).toEqual(['fk-on', 'begin', 'commit']);
    expect(execCalls).toContainEqual(
      expect.stringMatching(/PRAGMA\s+user_version\s*=\s*6/i),
    );
  });

  test('a failing v6 rolls back without recording version 6', async () => {
    const { db, events, getVersion } = makeRunnerFake(
      5,
      /idx_locations_address_norm/,
    );
    await expect(initializeDatabase(db)).rejects.toThrow(/fake sqlite error/);
    expect(events).toContain('rollback');
    expect(getVersion()).toBe(5);
  });
});
