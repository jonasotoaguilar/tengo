/**
 * Location/category persistence with v4 cascade semantics (mocked native
 * boundary).
 *
 * Runs against an in-memory fake `RepositoryDb` — no native module, no
 * `.db` file. Proves parameterized CRUD, domain normalization, typed errors
 * (validation/not-found/conflict/storage), location-delete cascades stock
 * but never items (R3), category-delete cascades only join rows (R4), and
 * the delete-impact reads the confirmations need. Real driver behavior is
 * native proof (isolated test DBs).
 */

import type { RepositoryDb, RunResult } from '../src/inventory/database';
import {
  categoryDeleteImpact,
  createCategory,
  createLocation,
  deleteCategory,
  deleteLocation,
  getCategory,
  getLocation,
  listCategories,
  listLocations,
  locationDeleteImpact,
  updateCategory,
  updateLocation,
} from '../src/inventory/entityRepository';
import {
  EntityConflictError,
  EntityNotFoundError,
  StorageError,
} from '../src/inventory/errors';
import type { Category, Location } from '../src/inventory/types';
import { ValidationError } from '../src/inventory/validation';

interface FakeRow {
  id: number;
  name: string;
  address?: string | null;
  created_at: string;
}

interface StockRow {
  itemId: number;
  locationId: number;
  quantity: number;
}

/** In-memory fake: enforces stock/location/category CASCADE, join CASCADE. */
function makeFakeDb() {
  const calls: { source: string; params: unknown[] }[] = [];
  const locations = new Map<number, FakeRow>();
  const categories = new Map<number, FakeRow>();
  const items = new Map<number, { id: number }>();
  const stock: StockRow[] = [];
  const joins = new Set<string>();
  let nextId = 1;
  let failNext: unknown = null;

  const tableOf = (source: string) =>
    /locations/i.test(source)
      ? locations
      : /categories/i.test(source)
        ? categories
        : null;

  const maybeFail = (source: string, params: unknown[]) => {
    calls.push({ source, params });
    if (failNext !== null) {
      const error = failNext;
      failNext = null;
      throw error;
    }
  };

  const db: RepositoryDb = {
    runAsync: jest.fn(async (source: string, params: unknown[] = []) => {
      maybeFail(source, params);
      if (/INSERT INTO locations/i.test(source)) {
        const [name, address] = params as [string, string | null];
        const id = nextId++;
        locations.set(id, { id, name, address, created_at: 'now' });
        return { lastInsertRowId: id, changes: 1 } satisfies RunResult;
      }
      if (/INSERT INTO categories/i.test(source)) {
        const [name] = params as [string];
        const id = nextId++;
        categories.set(id, { id, name, created_at: `now` });
        return { lastInsertRowId: id, changes: 1 } satisfies RunResult;
      }
      if (/UPDATE locations/i.test(source)) {
        const [name, address, id] = params as [string, string | null, number];
        const row = locations.get(id);
        if (!row) return { lastInsertRowId: 0, changes: 0 } satisfies RunResult;
        locations.set(id, { ...row, name, address });
        return { lastInsertRowId: id, changes: 1 } satisfies RunResult;
      }
      if (/UPDATE categories/i.test(source)) {
        const [name, id] = params as [string, number];
        const row = categories.get(id);
        if (!row) return { lastInsertRowId: 0, changes: 0 } satisfies RunResult;
        categories.set(id, { ...row, name });
        return { lastInsertRowId: id, changes: 1 } satisfies RunResult;
      }
      if (/DELETE FROM locations/i.test(source)) {
        const [id] = params as [number];
        if (!locations.has(id)) {
          return { lastInsertRowId: 0, changes: 0 } satisfies RunResult;
        }
        // v4 CASCADE: stock rows go, catalog items survive.
        for (let i = stock.length - 1; i >= 0; i -= 1) {
          if (stock[i].locationId === id) stock.splice(i, 1);
        }
        locations.delete(id);
        return { lastInsertRowId: 0, changes: 1 } satisfies RunResult;
      }
      if (/DELETE FROM categories/i.test(source)) {
        const [id] = params as [number];
        // Join links cascade with the category; items themselves survive.
        for (const key of [...joins]) {
          if (key.endsWith(`:${id}`)) joins.delete(key);
        }
        const deleted = categories.delete(id);
        return {
          lastInsertRowId: 0,
          changes: deleted ? 1 : 0,
        } satisfies RunResult;
      }
      throw new Error(`fake: unhandled write ${source}`);
    }),
    getFirstAsync: (async <T>(source: string, params: unknown[] = []) => {
      maybeFail(source, params);
      const table = tableOf(source);
      if (table && /WHERE id = \?/i.test(source)) {
        return (table.get(params[0] as number) ?? null) as T | null;
      }
      if (/FROM stock/i.test(source) && /COUNT\(\*\)/i.test(source)) {
        const id = params[0] as number;
        if (/NOT EXISTS/i.test(source)) {
          // Unstocked-items count: items with stock at id and nowhere else.
          const atLoc = new Set(
            stock.filter((s) => s.locationId === id).map((s) => s.itemId),
          );
          let unstocked = 0;
          for (const itemId of atLoc) {
            if (
              !stock.some((s) => s.itemId === itemId && s.locationId !== id)
            ) {
              unstocked += 1;
            }
          }
          return { count: unstocked } as T;
        }
        return {
          count: stock.filter((s) => s.locationId === id).length,
        } as T;
      }
      if (/FROM item_categories/i.test(source) && /COUNT\(\*\)/i.test(source)) {
        const id = params[0] as number;
        let n = 0;
        for (const key of joins) {
          if (key.endsWith(`:${id}`)) n += 1;
        }
        return { count: n } as T;
      }
      return null as T | null;
    }) as RepositoryDb['getFirstAsync'],
    getAllAsync: (async <T>(source: string, params: unknown[] = []) => {
      maybeFail(source, params);
      const table = tableOf(source);
      if (table) return [...table.values()] as T[];
      return [] as T[];
    }) as RepositoryDb['getAllAsync'],
  };
  return {
    db,
    calls,
    locations,
    categories,
    items,
    stock,
    joins,
    addStock: (itemId: number, locationId: number, quantity: number) => {
      items.set(itemId, { id: itemId });
      stock.push({ itemId, locationId, quantity });
    },
    failNextWith: (error: unknown) => {
      failNext = error;
    },
  };
}

describe('location repository', () => {
  test('create/list/fetch round-trip with normalization, unicode intact', async () => {
    const f = makeFakeDb();
    const created = await createLocation(f.db, {
      name: '  café Bogotá — ático ñ  ',
      address: '  Calle 1  ',
    });
    expect(created.name).toBe('café Bogotá — ático ñ');
    expect(created.address).toBe('Calle 1');
    expect(await getLocation(f.db, created.id)).toEqual(created);
    expect(await listLocations(f.db)).toEqual([created]);
    const blank = await createLocation(f.db, { name: 'Base', address: '   ' });
    expect(blank.address).toBeNull();
  });

  test('injection-shaped text is stored verbatim, never interpolated', async () => {
    const f = makeFakeDb();
    const evil = "x'); DROP TABLE locations; --";
    const created = await createLocation(f.db, { name: evil });
    expect(created.name).toBe(evil);
    expect(f.locations.size).toBe(1);
    // User text travels only in bound params, never in the SQL source.
    // The fixed S11 uniqueness scan carries no params by construction, so
    // the placeholder assertion applies only to calls that bind values.
    for (const call of f.calls) {
      expect(call.source).not.toContain(evil);
      if (call.params.length > 0) {
        expect(call.source).toMatch(/\?/);
      }
    }
    expect(await listLocations(f.db)).toHaveLength(1);
  });

  test('invalid ids throw validation before touching the database', async () => {
    const f = makeFakeDb();
    for (const bad of [0, -1, 1.5, Number.NaN, '1' as unknown as number]) {
      await expect(getLocation(f.db, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(deleteLocation(f.db, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(locationDeleteImpact(f.db, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(f.calls).toEqual([]);
  });

  test('missing rows throw typed not-found; storage failures stay generic', async () => {
    const f = makeFakeDb();
    await expect(getLocation(f.db, 99)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    await expect(
      updateLocation(f.db, 99, { name: 'Gone' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(deleteLocation(f.db, 99)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(locationDeleteImpact(f.db, 99)).rejects.toMatchObject({
      code: 'not-found',
    });
    f.failNextWith(new Error('disk I/O error on sqlite3_step'));
    const failure = (await getLocation(f.db, 1).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({ code: 'storage' });
    expect(failure.message).not.toContain('disk I/O');
  });

  test('deleting a location with stock cascades the rows and keeps the items', async () => {
    const f = makeFakeDb();
    const loc = await createLocation(f.db, { name: 'Pantry' });
    const other = await createLocation(f.db, { name: 'Garage' });
    // Two items stocked at Pantry; one of them also stocked at Garage.
    f.addStock(101, loc.id, 2);
    f.addStock(102, loc.id, 1);
    f.addStock(102, other.id, 4);
    await deleteLocation(f.db, loc.id);
    await expect(getLocation(f.db, loc.id)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    // Stock at Pantry is gone; stock elsewhere and catalog items survive.
    expect(f.stock).toEqual([
      { itemId: 102, locationId: other.id, quantity: 4 },
    ]);
    expect(f.items.has(101)).toBe(true);
    expect(f.items.has(102)).toBe(true);
    expect(await getLocation(f.db, other.id)).toMatchObject({
      name: 'Garage',
    });
  });

  test('deleting the last location is allowed: zero locations stays valid', async () => {
    const f = makeFakeDb();
    const loc = await createLocation(f.db, { name: 'Only' });
    await deleteLocation(f.db, loc.id);
    expect(await listLocations(f.db)).toEqual([]);
  });

  test('locationDeleteImpact counts stock rows and newly unstocked items', async () => {
    const f = makeFakeDb();
    const pantry = await createLocation(f.db, { name: 'Pantry' });
    const garage = await createLocation(f.db, { name: 'Garage' });
    // Item 101 only at Pantry (becomes sin stock); 102 at both (survives
    // on Garage); 103 only at Garage (untouched by a Pantry delete).
    f.addStock(101, pantry.id, 2);
    f.addStock(102, pantry.id, 1);
    f.addStock(102, garage.id, 4);
    f.addStock(103, garage.id, 7);
    await expect(locationDeleteImpact(f.db, pantry.id)).resolves.toEqual({
      stockRows: 2,
      unstockedItems: 1,
    });
    await expect(locationDeleteImpact(f.db, garage.id)).resolves.toEqual({
      stockRows: 2,
      unstockedItems: 1,
    });
  });

  test('locationDeleteImpact on an empty location reports zeros', async () => {
    const f = makeFakeDb();
    const loc = await createLocation(f.db, { name: 'Empty' });
    await expect(locationDeleteImpact(f.db, loc.id)).resolves.toEqual({
      stockRows: 0,
      unstockedItems: 0,
    });
  });

  test('a non-FK failure on delete stays storage, never a silent cascade', async () => {
    const f = makeFakeDb();
    const loc = await createLocation(f.db, { name: 'Pantry' });
    f.failNextWith(
      new Error('CHECK constraint failed: length(TRIM(name)) > 0'),
    );
    const failure = (await deleteLocation(f.db, loc.id).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure.message).not.toContain('CHECK constraint');
    expect(await getLocation(f.db, loc.id)).toEqual(loc);
  });

  test('update normalizes and returns the stored row', async () => {
    const f = makeFakeDb();
    const loc: Location = await createLocation(f.db, { name: 'Old' });
    const updated = await updateLocation(f.db, loc.id, {
      name: '  Nuevo  ',
      address: null,
    });
    expect(updated).toMatchObject({ id: loc.id, name: 'Nuevo', address: null });
  });
});

describe('category repository', () => {
  test('create/list/fetch round-trip preserves unicode names', async () => {
    const f = makeFakeDb();
    const created = await createCategory(f.db, { name: '  lácteos ñ  ' });
    expect(created.name).toBe('lácteos ñ');
    expect(await getCategory(f.db, created.id)).toEqual(created);
    const listed: Category[] = await listCategories(f.db);
    expect(listed).toEqual([created]);
  });

  test('injection-shaped names are bound, not interpolated', async () => {
    const f = makeFakeDb();
    const evil = 'c" OR "1"="1';
    await createCategory(f.db, { name: evil });
    for (const call of f.calls) {
      expect(call.source).not.toContain(evil);
    }
    expect(await listCategories(f.db)).toHaveLength(1);
  });

  test('invalid ids, missing rows, and storage failures are typed', async () => {
    const f = makeFakeDb();
    await expect(getCategory(f.db, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(getCategory(f.db, 42)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(updateCategory(f.db, 42, { name: 'x' })).rejects.toMatchObject(
      { code: 'not-found' },
    );
    await expect(deleteCategory(f.db, 42)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(categoryDeleteImpact(f.db, 42)).rejects.toMatchObject({
      code: 'not-found',
    });
    f.failNextWith(new Error('SQLITE_FULL: database or disk is full'));
    const failure = (await listCategories(f.db).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure.message).not.toContain('SQLITE_FULL');
  });

  test('deleting a category removes join links but keeps items', async () => {
    const f = makeFakeDb();
    const cat = await createCategory(f.db, { name: 'Bulk' });
    f.joins.add(`3:${cat.id}`);
    f.items.set(3, { id: 3 });
    await deleteCategory(f.db, cat.id);
    expect(f.joins.size).toBe(0);
    expect(f.items.has(3)).toBe(true);
    await expect(getCategory(f.db, cat.id)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });

  test('categoryDeleteImpact counts the items that would lose the link', async () => {
    const f = makeFakeDb();
    const cat = await createCategory(f.db, { name: 'Bulk' });
    const other = await createCategory(f.db, { name: 'Fresh' });
    f.joins.add(`11:${cat.id}`);
    f.joins.add(`12:${cat.id}`);
    f.joins.add(`12:${other.id}`);
    await expect(categoryDeleteImpact(f.db, cat.id)).resolves.toEqual({
      items: 2,
    });
    await expect(categoryDeleteImpact(f.db, other.id)).resolves.toEqual({
      items: 1,
    });
  });

  test('S10 RED: over-80 location and category names are rejected', async () => {
    const f = makeFakeDb();
    await expect(
      createLocation(f.db, { name: 'b'.repeat(81) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createCategory(f.db, { name: 'c'.repeat(81) }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await createLocation(f.db, { name: 'b'.repeat(80) })).toMatchObject({
      name: 'b'.repeat(80),
    });
    expect(await createCategory(f.db, { name: 'c'.repeat(80) })).toMatchObject({
      name: 'c'.repeat(80),
    });
  });
});

describe('entity name uniqueness (S11)', () => {
  test('S11 RED: duplicate location insert is rejected with a typed conflict', async () => {
    const f = makeFakeDb();
    await createLocation(f.db, { name: 'Pantry' });
    const failure = (await createLocation(f.db, { name: 'Pantry' }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'location' });
    expect(await listLocations(f.db)).toHaveLength(1);
  });

  test('S11 RED: duplicate category insert is rejected with a typed conflict', async () => {
    const f = makeFakeDb();
    await createCategory(f.db, { name: 'Grains' });
    await expect(
      createCategory(f.db, { name: 'Grains' }),
    ).rejects.toMatchObject({ code: 'conflict', entity: 'category' });
    expect(await listCategories(f.db)).toHaveLength(1);
  });

  test('S11 RED: uniqueness ignores case, accents, and surrounding whitespace', async () => {
    const f = makeFakeDb();
    await createLocation(f.db, { name: 'Café' });
    await expect(createLocation(f.db, { name: 'cafe' })).rejects.toBeInstanceOf(
      EntityConflictError,
    );
    await expect(
      createLocation(f.db, { name: '  CAFÉ  ' }),
    ).rejects.toBeInstanceOf(EntityConflictError);
    await createCategory(f.db, { name: 'Pantry' });
    await expect(
      createCategory(f.db, { name: ' pantry ' }),
    ).rejects.toBeInstanceOf(EntityConflictError);
    expect(await listLocations(f.db)).toHaveLength(1);
    expect(await listCategories(f.db)).toHaveLength(1);
  });

  test('S11 RED: conflicting update is rejected and the stored row survives', async () => {
    const f = makeFakeDb();
    const a = await createLocation(f.db, { name: 'Kitchen' });
    const b = await createLocation(f.db, { name: 'Pantry' });
    await expect(
      updateLocation(f.db, b.id, { name: ' kitchen ' }),
    ).rejects.toMatchObject({ code: 'conflict', entity: 'location' });
    expect((await getLocation(f.db, b.id)).name).toBe('Pantry');
    const c = await createCategory(f.db, { name: 'Bulk' });
    const d = await createCategory(f.db, { name: 'Grains' });
    await expect(
      updateCategory(f.db, d.id, { name: 'BULK' }),
    ).rejects.toMatchObject({
      code: 'conflict',
      entity: 'category',
    });
    expect((await getCategory(f.db, d.id)).name).toBe('Grains');
    expect(a.id).toBeGreaterThan(0);
    expect(c.id).toBeGreaterThan(0);
  });

  test('S11 RED: renaming a row to its own name (trim/case variant) succeeds', async () => {
    const f = makeFakeDb();
    const loc = await createLocation(f.db, { name: 'Pantry' });
    const updated = await updateLocation(f.db, loc.id, { name: '  pantry  ' });
    expect(updated.name).toBe('pantry');
    const cat = await createCategory(f.db, { name: 'Grains' });
    await expect(
      updateCategory(f.db, cat.id, { name: 'grains' }),
    ).resolves.toMatchObject({ id: cat.id });
  });

  test('S11 RED: a raw UNIQUE driver failure maps to conflict without leaking SQL text', async () => {
    const f = makeFakeDb();
    await createLocation(f.db, { name: 'Pantry' });
    // Simulate the race the domain pre-check cannot see: the pre-check
    // scan reports no rows while the driver rejects the write.
    f.db.getAllAsync = jest.fn(async () => []);
    f.failNextWith(
      new Error(
        'SQLite error: UNIQUE constraint failed: locations.name (code 2067 SQLITE_CONSTRAINT_UNIQUE)',
      ),
    );
    const failure = (await createLocation(f.db, { name: 'Pantry' }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'location' });
    expect(failure.message).not.toContain('UNIQUE');
    expect(failure.message).not.toContain('SQLITE_CONSTRAINT');
  });
});
