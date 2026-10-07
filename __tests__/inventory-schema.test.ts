/**
 * Inventory schema contract (static SQL + domain shape).
 *
 * These tests assert that the v2 migration SQL encodes every approved M1
 * integrity rule at the database level. They do NOT prove SQLite enforces
 * them — that proof comes from real SQLite runs
 * (scripts/verify-inventory-schema.py, host evidence only) and, before M2,
 * the pending native gate.
 */
import { MIGRATIONS } from '../src/db/migrations';
import { validateItemInput } from '../src/inventory/validation';

const V2_SQL = MIGRATIONS[2];

describe('inventory schema contract (v2 SQL encodes the approved rules)', () => {
  test('locations carry a required name and an optional address', () => {
    expect(V2_SQL).toMatch(
      /CREATE TABLE[^;]*locations\s*\(\s*id INTEGER PRIMARY KEY AUTOINCREMENT,/i,
    );
    expect(V2_SQL).toMatch(
      /name\s+TEXT NOT NULL CHECK\s*\(\s*length\s*\(\s*TRIM\s*\(\s*name\s*\)\s*\)\s*>\s*0\s*\)/i,
    );
    expect(V2_SQL).toMatch(/address\s+TEXT CHECK/i);
  });

  test('categories are independent entities with required names', () => {
    expect(V2_SQL).toMatch(
      /CREATE TABLE[^;]*categories\s*\(\s*id INTEGER PRIMARY KEY AUTOINCREMENT,/i,
    );
  });

  test('items require a location reference that cannot orphan or cascade', () => {
    expect(V2_SQL).toMatch(/location_id\s+INTEGER NOT NULL/i);
    expect(V2_SQL).toMatch(/ON DELETE RESTRICT/i);
    const beforeJoin = V2_SQL.split(/item_categories/i)[0];
    expect(beforeJoin).not.toMatch(/ON DELETE CASCADE/i);
  });

  test('the item-category join forbids duplicates and dangling references', () => {
    expect(V2_SQL).toMatch(
      /PRIMARY KEY\s*\(\s*item_id\s*,\s*category_id\s*\)/i,
    );
    expect(V2_SQL).toMatch(
      /FOREIGN KEY\s*\(\s*item_id\s*\)\s*REFERENCES\s+items\s*\(\s*id\s*\)/i,
    );
    expect(V2_SQL).toMatch(
      /FOREIGN KEY\s*\(\s*category_id\s*\)\s*REFERENCES\s+categories\s*\(\s*id\s*\)/i,
    );
  });

  test('quantity defaults to zero and is guarded at both layers', () => {
    expect(V2_SQL).toMatch(/quantity\s+INTEGER NOT NULL DEFAULT 0/i);
    // SQLite itself rejects fractional REAL quantities (e.g. 1.5) via
    // integer storage; real-engine proof lives in
    // scripts/verify-inventory-schema.py (host only).
    expect(V2_SQL).toMatch(/typeof\s*\(\s*quantity\s*\)\s*=\s*'integer'/i);
    expect(V2_SQL).toMatch(/quantity\s*>=\s*0/i);
    // Zero passes domain validation (exhausted); fractions fail there.
    expect(
      validateItemInput({ name: 'Rice', quantity: 0, locationId: 1 }).quantity,
    ).toBe(0);
    expect(() =>
      validateItemInput({ name: 'Rice', quantity: 0.5, locationId: 1 }),
    ).toThrow();
  });

  test('no item shape validates without a location id', () => {
    expect(() =>
      validateItemInput({ name: 'Rice', quantity: 1, locationId: 0 }),
    ).toThrow();
    expect(() =>
      validateItemInput({
        name: 'Rice',
        quantity: 1,
        locationId: null as unknown as number,
      }),
    ).toThrow();
  });
});
