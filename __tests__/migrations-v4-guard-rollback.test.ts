/**
 * v4 preserve-and-stop guard rollback (real SQLite engine).
 *
 * The shipped-trigger tests in `migrations.test.ts` prove the guard ABORTs
 * on a rigged state, but none of them fires the guard inside the
 * applyMigration shape (BEGIN + rebuild + version bump) and proves the
 * rollback leaves rows and `user_version` untouched. These tests do: a
 * real v3 database (migrations 1-3 plus seeded items and category links)
 * is driven into the state where the SHIPPED v4 TEMP trigger text
 * (extracted verbatim from `MIGRATIONS[4]`, never paraphrased) aborts —
 * once per guard arm — and the assertions prove the ABORT message matches
 * the guard while `PRAGMA user_version`, `items`, and `item_categories`
 * are preserved.
 */
import { MIGRATIONS } from '../src/db/migrations';

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

/** One migration the way the runner does: SQL + version bump, atomic. */
function applyMigrationReal(db: RealDb, version: number): void {
  db.exec(
    `BEGIN;\n${MIGRATIONS[version]}\nPRAGMA user_version = ${version};\nCOMMIT;`,
  );
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

/** Seed a populated v3 database: locations, items (one exhausted), links. */
function seedV3(db: RealDb): void {
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
}

/**
 * Verbatim shipped preamble: everything in MIGRATIONS[4] before the guard
 * scratch table (catalog copy + stock copy). The sabotage DELETE/UPDATE the
 * caller runs next simulates the lost-row / wrong-sum corruption each
 * guard arm exists to catch; the guard trigger text itself is shipped.
 */
function shippedPreamble(): string {
  return MIGRATIONS[4].split('CREATE TEMP TABLE _migration_v4_guard')[0];
}

/** Verbatim shipped guard trigger (same extraction as migrations.test.ts). */
function shippedGuardTrigger(): string {
  const trigger = MIGRATIONS[4].match(
    /CREATE TEMP TRIGGER _migration_v4_guard_check[\s\S]*?^END;/m,
  )?.[0];
  expect(trigger).toBeDefined();
  return trigger as string;
}

/**
 * Run the shipped rebuild inside the applyMigration transaction shape up
 * to the guard INSERT, after the caller's sabotage. Returns the ABORT
 * message; the transaction is left open so the caller can ROLLBACK exactly
 * as the runner's `withTransactionAsync` failure path does.
 */
function runGuardToAbort(db: RealDb, sabotage: string): string {
  db.exec('BEGIN;');
  db.exec(shippedPreamble());
  db.exec(sabotage);
  db.exec('CREATE TEMP TABLE _migration_v4_guard (id INTEGER);');
  db.exec(shippedGuardTrigger());
  let message = '';
  try {
    db.exec('INSERT INTO _migration_v4_guard (id) VALUES (1);');
  } catch (error) {
    message = String((error as Error)?.message ?? error);
  }
  expect(message).not.toBe('');
  return message;
}

function seedV3Database(): RealDb {
  const db = new DatabaseSync(':memory:');
  applyMigrationReal(db, 1);
  applyMigrationReal(db, 2);
  applyMigrationReal(db, 3);
  seedV3(db);
  expect(userVersionReal(db)).toBe(3);
  expect(countReal(db, 'items')).toBe(2);
  expect(countReal(db, 'item_categories')).toBe(2);
  return db;
}

test('v4 catalog-count abort rolls back: guard message, version and rows preserved', () => {
  const db = seedV3Database();
  try {
    // Rig the corruption the first guard arm catches: a lost catalog row
    // (items_new missing one row after the shipped copy).
    const message = runGuardToAbort(
      db,
      "DELETE FROM items_new WHERE name = 'Beans';",
    );
    expect(message).toMatch(/Migration to schema version 4 blocked/);
    expect(message).toMatch(/catalog copy/);
    // The runner rolls the failed migration back; rows and version stay.
    db.exec('ROLLBACK;');
    expect(userVersionReal(db)).toBe(3);
    expect(countReal(db, 'items')).toBe(2);
    expect(countReal(db, 'item_categories')).toBe(2);
    expect(countReal(db, 'locations')).toBe(2);
    expect(countReal(db, 'categories')).toBe(1);
    const names = (
      db.prepare('SELECT name FROM items ORDER BY id ASC').all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(['Rice', 'Beans']);
  } finally {
    db.close();
  }
});

test('v4 stock-sum abort rolls back: guard message, version and rows preserved', () => {
  const db = seedV3Database();
  try {
    // Rig the corruption the second guard arm catches: a wrong stock sum
    // (one stock row inflated after the shipped copy).
    const message = runGuardToAbort(db, 'UPDATE stock SET quantity = 99;');
    expect(message).toMatch(/Migration to schema version 4 blocked/);
    expect(message).toMatch(/stock quantity sum/);
    db.exec('ROLLBACK;');
    expect(userVersionReal(db)).toBe(3);
    expect(countReal(db, 'items')).toBe(2);
    expect(countReal(db, 'item_categories')).toBe(2);
    expect(countReal(db, 'locations')).toBe(2);
    expect(countReal(db, 'categories')).toBe(1);
    const quantities = (
      db.prepare('SELECT quantity FROM items ORDER BY id ASC').all() as {
        quantity: number;
      }[]
    ).map((r) => r.quantity);
    expect(quantities).toEqual([2, 0]);
  } finally {
    db.close();
  }
});
