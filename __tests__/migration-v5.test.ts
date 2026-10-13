/**
 * Migration 5: scanner and reminder base (additive, real SQLite engine).
 *
 * U2 adds three optional columns the v4 model cannot express, in ONE
 * additive migration (no rebuild, no preserve-and-stop guard needed):
 * - `items.low_stock_threshold` — optional integer per item (reminder level).
 * - `items.barcode` — optional text code, UNIQUE index (one code, one item;
 *   NULLs do not collide, so many items without a barcode stay legal).
 * - `stock.expires_on` — optional ISO date per stock row.
 *
 * These tests prove the additive shape (ALTERs plus the index, never a
 * rebuild), the runner's additive path (no FK-off envelope: only v4
 * special-cases foreign keys), row preservation, NULL-barcode
 * multiplicity, the UNIQUE conflict, and the new CHECK bounds. Real
 * `node:sqlite` behavior, not the mocked native boundary.
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
 * transaction, rebuild plus bump inside, FK ON after. Copied from the v4
 * suite: v5 must NOT need this envelope (it is additive).
 */
function applyMigrationV4Real(db: RealDb): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`BEGIN;\n${MIGRATIONS[4]}\nPRAGMA user_version = 4;\nCOMMIT;`);
  db.exec('PRAGMA foreign_keys = ON;');
}

/**
 * Apply ONLY the v5 step onto a v4-state database, the way the generic
 * runner path does: one txn, FK untouched. This stays hand-written on
 * purpose: the v4->v5 preservation test below needs a v4-state database
 * to migrate FROM, so the single-step application is its subject, not a
 * fixture shortcut. Every other real-SQLite test uses bringToCurrentSchema.
 */
function applyMigrationV5Real(db: RealDb): void {
  db.exec(`BEGIN;\n${MIGRATIONS[5]}\nPRAGMA user_version = 5;\nCOMMIT;`);
}

function userVersionReal(db: RealDb): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
}

/** Bring a fresh DB to v4 (empty): the v5 starting point. */
function seedV4(db: RealDb): void {
  applyMigrationReal(db, 1);
  applyMigrationReal(db, 2);
  applyMigrationReal(db, 3);
  applyMigrationV4Real(db);
}

function tableInfo(db: RealDb, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }[];
}

/** Minimal fake proving which runner path applies v5 (events, not SQLite). */
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

describe('migration 5 ladder', () => {
  test('schema version is 5 with migrations 1-5', () => {
    expect(SCHEMA_VERSION).toBe(5);
    expect(Object.keys(MIGRATIONS).sort()).toEqual(['1', '2', '3', '4', '5']);
  });

  test('v4 database has only migration 5 pending', () => {
    expect(getPendingMigrations(4)).toEqual([5]);
  });

  test('fresh database has migrations 1-5 pending in order', () => {
    expect(getPendingMigrations(0)).toEqual([1, 2, 3, 4, 5]);
  });

  test('migrated database (version 5) has nothing pending', () => {
    expect(getPendingMigrations(5)).toEqual([]);
  });
});

describe('migration 5 SQL is additive (no rebuild, no guard needed)', () => {
  test('v5 adds the two item columns, the unique barcode index, and the stock column', () => {
    const sql = MIGRATIONS[5];
    expect(sql).toMatch(
      /ALTER TABLE\s+items\s+ADD COLUMN\s+low_stock_threshold\s+INTEGER/i,
    );
    expect(sql).toMatch(/ALTER TABLE\s+items\s+ADD COLUMN\s+barcode\s+TEXT/i);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[^;]*idx_items_barcode[^;]*ON items\s*\(\s*barcode\s*\)/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE\s+stock\s+ADD COLUMN\s+expires_on\s+TEXT/i,
    );
  });

  test('v5 never rebuilds, deletes, updates, or backfills: purely additive', () => {
    const sql = MIGRATIONS[5];
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).not.toMatch(/UPDATE\s+\w+\s+SET/i);
    expect(sql).not.toMatch(/INSERT INTO/i);
    expect(sql).not.toMatch(/unassigned/i);
  });

  test('v5 carries the threshold and expiry shapes next to the columns', () => {
    const sql = MIGRATIONS[5];
    // Same S10 product bound the domain enforces (0-999999, integer storage).
    expect(sql).toMatch(
      /typeof\s*\(\s*low_stock_threshold\s*\)\s*=\s*'integer'/i,
    );
    expect(sql).toMatch(/low_stock_threshold\s*>=\s*0/i);
    expect(sql).toMatch(/low_stock_threshold\s*<=\s*999999/i);
    // ISO YYYY-MM-DD shape; calendar validity stays domain-only (S11 split).
    expect(sql).toMatch(/expires_on\s+GLOB/i);
  });
});

describe('migration 5 preserves v2/v3/v4 (existing behavior still holds)', () => {
  test('v2 still carries the RESTRICT ladder, v3 its guard, v4 its rebuild', () => {
    expect(MIGRATIONS[2]).toMatch(/ON DELETE RESTRICT/i);
    expect(MIGRATIONS[3]).toMatch(/_migration_v3_guard/);
    expect(MIGRATIONS[4]).toMatch(/CREATE TABLE\s+items_new/i);
    expect(MIGRATIONS[4]).toMatch(/Migration to schema version 4 blocked/);
  });
});

describe('migration 5 on real SQLite (empty and populated v4)', () => {
  test('empty v4 migrates to v5 with nullable columns defaulting to NULL', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      expect(userVersionReal(db)).toBe(5);
      const itemCols = tableInfo(db, 'items');
      const byName = new Map(itemCols.map((c) => [c.name, c]));
      expect([...byName.keys()]).toEqual([
        'id',
        'name',
        'created_at',
        'low_stock_threshold',
        'barcode',
      ]);
      expect(byName.get('low_stock_threshold')?.type).toMatch(/INTEGER/i);
      expect(byName.get('barcode')?.type).toMatch(/TEXT/i);
      // Optional at the storage level: nullable, NULL default.
      expect(byName.get('low_stock_threshold')?.notnull).toBe(0);
      expect(byName.get('barcode')?.notnull).toBe(0);
      expect(byName.get('low_stock_threshold')?.dflt_value).toBeNull();
      expect(byName.get('barcode')?.dflt_value).toBeNull();
      const stockCols = tableInfo(db, 'stock');
      const stockByName = new Map(stockCols.map((c) => [c.name, c]));
      expect([...stockByName.keys()]).toEqual([
        'item_id',
        'location_id',
        'quantity',
        'expires_on',
      ]);
      expect(stockByName.get('expires_on')?.type).toMatch(/TEXT/i);
      expect(stockByName.get('expires_on')?.notnull).toBe(0);
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_barcode'",
        )
        .all();
      expect(indexes).toHaveLength(1);
      const unique = db.prepare('PRAGMA index_list(items)').all() as {
        name: string;
        unique: number;
      }[];
      expect(
        unique.find((entry) => entry.name === 'idx_items_barcode')?.unique,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  test('populated v4 rows survive v5 byte-identical with NULL new columns', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      seedV4(db);
      const loc = (
        db.prepare("INSERT INTO locations (name) VALUES ('Casa')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid;
      const rice = (
        db.prepare("INSERT INTO items (name) VALUES ('Rice')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid;
      db.prepare(
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 2)',
      ).run(rice, loc);
      const beforeItems = db
        .prepare('SELECT id, name, created_at FROM items ORDER BY id ASC')
        .all();
      const beforeStock = db
        .prepare('SELECT item_id, location_id, quantity FROM stock')
        .all();
      applyMigrationV5Real(db);
      expect(userVersionReal(db)).toBe(5);
      expect(
        db
          .prepare('SELECT id, name, created_at FROM items ORDER BY id ASC')
          .all(),
      ).toEqual(beforeItems);
      expect(
        db.prepare('SELECT item_id, location_id, quantity FROM stock').all(),
      ).toEqual(beforeStock);
      expect(
        db
          .prepare(
            'SELECT low_stock_threshold, barcode FROM items WHERE id = ?',
          )
          .get(rice),
      ).toEqual({ low_stock_threshold: null, barcode: null });
      expect(
        db.prepare('SELECT expires_on FROM stock WHERE item_id = ?').get(rice),
      ).toEqual({ expires_on: null });
      expect(
        db
          .prepare('SELECT COUNT(*) AS count FROM pragma_foreign_key_check')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  test('many items without a barcode stay legal: NULLs do not collide', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      db.prepare("INSERT INTO items (name) VALUES ('Rice')").run();
      db.prepare("INSERT INTO items (name) VALUES ('Beans')").run();
      db.prepare("INSERT INTO items (name) VALUES ('Salt')").run();
      const count = (
        db.prepare('SELECT COUNT(*) AS count FROM items').get() as {
          count: number;
        }
      ).count;
      expect(count).toBe(3);
    } finally {
      db.close();
    }
  });

  test('a duplicate barcode is rejected by the unique index', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      db.prepare(
        "INSERT INTO items (name, barcode) VALUES ('Rice', '12345678')",
      ).run();
      expect(() =>
        db
          .prepare(
            "INSERT INTO items (name, barcode) VALUES ('Beans', '12345678')",
          )
          .run(),
      ).toThrow(/UNIQUE/i);
      // A distinct code still inserts fine afterwards.
      db.prepare(
        "INSERT INTO items (name, barcode) VALUES ('Beans', '87654321')",
      ).run();
      expect(
        (
          db.prepare('SELECT COUNT(*) AS count FROM items').get() as {
            count: number;
          }
        ).count,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  test('threshold CHECK bounds: 0-999999 integers and NULL pass, the rest fail', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      const id = (
        db.prepare("INSERT INTO items (name) VALUES ('Rice')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid;
      db.prepare('UPDATE items SET low_stock_threshold = 0 WHERE id = ?').run(
        id,
      );
      db.prepare(
        'UPDATE items SET low_stock_threshold = 999999 WHERE id = ?',
      ).run(id);
      db.prepare(
        'UPDATE items SET low_stock_threshold = NULL WHERE id = ?',
      ).run(id);
      for (const bad of [-1, 1000000, 1.5]) {
        expect(() =>
          db
            .prepare('UPDATE items SET low_stock_threshold = ? WHERE id = ?')
            .run(bad, id),
        ).toThrow(/CHECK/i);
      }
    } finally {
      db.close();
    }
  });

  test('expires_on shape CHECK: ISO shape or NULL pass, other text fails', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      await bringToCurrentSchema(db);
      const loc = (
        db.prepare("INSERT INTO locations (name) VALUES ('Casa')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid;
      const item = (
        db.prepare("INSERT INTO items (name) VALUES ('Rice')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid;
      db.prepare(
        'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, 2)',
      ).run(item, loc);
      db.prepare('UPDATE stock SET expires_on = ? WHERE item_id = ?').run(
        '2027-03-15',
        item,
      );
      db.prepare('UPDATE stock SET expires_on = NULL WHERE item_id = ?').run(
        item,
      );
      for (const bad of ['not-a-date', '15-03-2027', '2027-3-5']) {
        expect(() =>
          db
            .prepare('UPDATE stock SET expires_on = ? WHERE item_id = ?')
            .run(bad, item),
        ).toThrow(/CHECK/i);
      }
    } finally {
      db.close();
    }
  });
});

describe('migration 5 runner path (mocked native boundary)', () => {
  test('v5 applies through the additive path: one txn, FK never toggled', async () => {
    const { db, execCalls, events, getVersion } = makeRunnerFake(4);
    await initializeDatabase(db);
    expect(execCalls).toContain(MIGRATIONS[5]);
    expect(getVersion()).toBe(5);
    // The additive path is what runs: the initial enable plus exactly one
    // transaction, and no FK-off envelope (only v4 toggles).
    expect(events).toEqual(['fk-on', 'begin', 'commit']);
    expect(execCalls).toContainEqual(
      expect.stringMatching(/PRAGMA\s+user_version\s*=\s*5/i),
    );
  });

  test('a failing v5 rolls back without recording version 5', async () => {
    const { db, events, getVersion } = makeRunnerFake(4, /ADD COLUMN barcode/);
    await expect(initializeDatabase(db)).rejects.toThrow(/fake sqlite error/);
    expect(events).toContain('rollback');
    expect(getVersion()).toBe(4);
  });
});
