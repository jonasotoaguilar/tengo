/**
 * Inventory schema contract (static SQL + domain shape).
 *
 * These tests assert that the v4 migration SQL encodes every approved
 * multi-location rule at the database level: the identity-only catalog,
 * the per-location stock table with its composite key, positive CHECK,
 * both CASCADEs, and the location index. They do NOT prove SQLite
 * enforces them — that proof comes from real SQLite runs
 * (scripts/verify-inventory-schema.py, host evidence only) and the
 * native gate.
 */
import { MIGRATIONS } from '../src/db/migrations';
import { validateItemInput } from '../src/inventory/validation';

const V4_SQL = MIGRATIONS[4];
const V6_SQL = MIGRATIONS[6];

describe('inventory schema contract (v4 SQL encodes the approved rules)', () => {
  test('items are the identity-only catalog: id, name, created_at', () => {
    expect(V4_SQL).toMatch(
      /CREATE TABLE\s+items_new\s*\(\s*id INTEGER PRIMARY KEY AUTOINCREMENT,/i,
    );
    expect(V4_SQL).toMatch(/name\s+TEXT NOT NULL CHECK/i);
    expect(V4_SQL).toMatch(/created_at\s+TEXT NOT NULL/i);
    expect(V4_SQL).toMatch(/ALTER TABLE\s+items_new\s+RENAME TO\s+items/i);
  });

  test('stock carries one row per location with a composite key and cascades', () => {
    expect(V4_SQL).toMatch(
      /CREATE TABLE\s+stock\s*\(\s*item_id INTEGER NOT NULL,/i,
    );
    expect(V4_SQL).toMatch(/location_id\s+INTEGER NOT NULL/i);
    expect(V4_SQL).toMatch(
      /PRIMARY KEY\s*\(\s*item_id\s*,\s*location_id\s*\)/i,
    );
    expect(V4_SQL).toMatch(
      /FOREIGN KEY\s*\(\s*item_id\s*\)\s*REFERENCES\s+items\s*\(\s*id\s*\)\s*ON DELETE CASCADE/i,
    );
    expect(V4_SQL).toMatch(
      /FOREIGN KEY\s*\(\s*location_id\s*\)\s*REFERENCES\s+locations\s*\(\s*id\s*\)\s*ON DELETE CASCADE/i,
    );
    expect(V4_SQL).toMatch(/idx_stock_location_id/i);
    // R3: deleting a location removes stock and is never blocked.
    expect(V4_SQL).not.toMatch(/RESTRICT/i);
  });

  test('a stock row means something is stored there: quantity above zero', () => {
    expect(V4_SQL).toMatch(/typeof\s*\(\s*quantity\s*\)\s*=\s*'integer'/i);
    expect(V4_SQL).toMatch(/quantity\s*>\s*0/i);
  });

  test('one stock row per old item with quantity above zero, never invented', () => {
    expect(V4_SQL).toMatch(
      /INSERT INTO stock[\s\S]*FROM items WHERE quantity > 0/i,
    );
    expect(V4_SQL).not.toMatch(/unassigned/i);
    expect(V4_SQL).not.toMatch(/INSERT INTO\s+locations/i);
  });

  test('zero-quantity input rows validate but are dropped, never stored', () => {
    expect(
      validateItemInput({
        name: 'Rice',
        stock: [{ locationId: 1, quantity: 0 }],
      }).stock,
    ).toEqual([]);
    expect(
      validateItemInput({
        name: 'Rice',
        stock: [
          { locationId: 1, quantity: 0 },
          { locationId: 2, quantity: 3 },
        ],
      }).stock,
    ).toEqual([{ locationId: 2, quantity: 3, expiresOn: null }]);
  });

  test('no item shape validates with a bad location reference', () => {
    expect(() =>
      validateItemInput({
        name: 'Rice',
        stock: [{ locationId: 0, quantity: 1 }],
      }),
    ).toThrow();
    expect(() =>
      validateItemInput({
        name: 'Rice',
        stock: [{ locationId: null as unknown as number, quantity: 1 }],
      }),
    ).toThrow();
  });

  describe('address uniqueness contract (U11: v6 SQL encodes the adopted rule)', () => {
    test('v6 carries a partial unique index over the normalized address', () => {
      expect(V6_SQL).toMatch(/CREATE UNIQUE INDEX/i);
      expect(V6_SQL).toMatch(/idx_locations_address_norm/i);
      expect(V6_SQL).toMatch(
        /locations\s*\(\s*lower\s*\(\s*trim\s*\(\s*address\s*\)\s*\)\s*\)/i,
      );
      // Partial: NULL addresses are excluded, so many address-less
      // locations stay legal.
      expect(V6_SQL).toMatch(/WHERE\s+address\s+IS\s+NOT\s+NULL/i);
    });

    test('v6 blocks on duplicates instead of rewriting them', () => {
      expect(V6_SQL).toMatch(/RAISE\s*\(\s*ABORT/i);
      expect(V6_SQL).toMatch(/Migration to schema version 6 blocked/);
      expect(V6_SQL).not.toMatch(/DROP TABLE/i);
      expect(V6_SQL).not.toMatch(/DELETE FROM/i);
      expect(V6_SQL).not.toMatch(/UPDATE\s+locations\s+SET/i);
      expect(V6_SQL).not.toMatch(/INSERT INTO\s+locations/i);
    });
  });

  test('duplicate locations in one payload are rejected', () => {
    expect(() =>
      validateItemInput({
        name: 'Rice',
        stock: [
          { locationId: 1, quantity: 1 },
          { locationId: 1, quantity: 2 },
        ],
      }),
    ).toThrow();
  });
});
