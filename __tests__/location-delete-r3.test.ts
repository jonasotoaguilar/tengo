/**
 * R3/R6 end to end on host SQLite (real engine, not a fake driver).
 *
 * R3: deleting a location deletes stock, never items. R6: an item left
 * with no stock anywhere stays visible as "sin stock" (total 0), never
 * hidden. This test builds a real v4 database on `node:sqlite`, seeds one
 * item stocked at two locations plus one item with no stock anywhere,
 * deletes one location through the REAL `deleteLocation`, and proves via
 * the REAL `queryItems` that the deleted location's stock rows are gone,
 * every catalog item survives, and the item left with no stock is still
 * returned with `totalQuantity` 0.
 */
import { MIGRATIONS } from '../src/db/migrations';
import type { RepositoryDb } from '../src/inventory/database';
import { deleteLocation } from '../src/inventory/entityRepository';
import { queryItems } from '../src/inventory/itemQuery';

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      all(...params: unknown[]): Record<string, unknown>[];
      run(...params: unknown[]): {
        lastInsertRowid: number | bigint;
        changes: number | bigint;
      };
    };
    close(): void;
  };
};

type RealDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): {
      lastInsertRowid: number | bigint;
      changes: number | bigint;
    };
  };
  close(): void;
};

/** Thin `node:sqlite` → `RepositoryDb` adapter (test-only). */
function wrapReal(db: RealDb): RepositoryDb {
  return {
    runAsync: async (source: string, params = []) => {
      const info = db.prepare(source).run(...params);
      return {
        lastInsertRowId: Number(info.lastInsertRowid),
        changes: Number(info.changes),
      };
    },
    getFirstAsync: async <T>(source: string, params = []): Promise<T | null> =>
      (db.prepare(source).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(source: string, params = []): Promise<T[]> =>
      db.prepare(source).all(...params) as T[],
  };
}

function countReal(db: RealDb, table: string, where = ''): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get() as {
      count: number;
    }
  ).count;
}

test('deleting a location removes its stock, keeps every item, and leaves sin-stock visible', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(MIGRATIONS[1]);
    db.exec(MIGRATIONS[2]);
    db.exec(MIGRATIONS[3]);
    // v4 under the runner's FK-off envelope (see migrations.test.ts).
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`BEGIN;\n${MIGRATIONS[4]}\nPRAGMA user_version = 4;\nCOMMIT;`);
    // Production opens with foreign keys ON: the R3 cascade is enforced.
    db.exec('PRAGMA foreign_keys = ON;');
    const repo = wrapReal(db);

    const locA = Number(
      (
        db.prepare("INSERT INTO locations (name) VALUES ('Casa')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid,
    );
    const locB = Number(
      (
        db.prepare("INSERT INTO locations (name) VALUES ('Garage')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid,
    );
    const milk = Number(
      (
        db.prepare("INSERT INTO items (name) VALUES ('Milk')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid,
    );
    const ghost = Number(
      (
        db.prepare("INSERT INTO items (name) VALUES ('Ghost')").run() as {
          lastInsertRowid: number;
        }
      ).lastInsertRowid,
    );
    // Milk stocked at BOTH locations; Ghost stocked nowhere (sin stock).
    db.prepare(
      'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
    ).run(milk, locA, 2);
    db.prepare(
      'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
    ).run(milk, locB, 3);
    expect(ghost).toBeGreaterThan(0);

    const before = await queryItems(repo, {});
    expect(before.map((i) => i.id).sort((a, b) => a - b)).toEqual(
      [milk, ghost].sort((a, b) => a - b),
    );
    expect(before.find((i) => i.id === milk)?.totalQuantity).toBe(5);

    await deleteLocation(repo, locA);

    // The deleted location's stock rows are gone; the other side survives.
    expect(countReal(db, 'stock', `WHERE location_id = ${locA}`)).toBe(0);
    expect(countReal(db, 'stock', `WHERE location_id = ${locB}`)).toBe(1);
    expect(countReal(db, 'locations')).toBe(1);
    // R3: every catalog item survives the location delete.
    expect(countReal(db, 'items')).toBe(2);

    const after = await queryItems(repo, {});
    expect(after.map((i) => i.id).sort((a, b) => a - b)).toEqual(
      [milk, ghost].sort((a, b) => a - b),
    );
    const milkAfter = after.find((i) => i.id === milk);
    expect(milkAfter?.stock).toHaveLength(1);
    expect(milkAfter?.stock[0].locationId).toBe(locB);
    expect(milkAfter?.totalQuantity).toBe(3);
    // R6: the item left with no stock anywhere is still returned, total 0.
    const ghostAfter = after.find((i) => i.id === ghost);
    expect(ghostAfter).toBeDefined();
    expect(ghostAfter?.stock).toEqual([]);
    expect(ghostAfter?.totalQuantity).toBe(0);
  } finally {
    db.close();
  }
});
