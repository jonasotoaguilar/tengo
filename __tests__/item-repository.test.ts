/**
 * Item persistence over catalog + stock (mocked native boundary).
 *
 * Runs against an in-memory fake `RepositoryDb` with snapshot/rollback
 * exclusive transactions — no native module, no `.db` file. Proves
 * parameterized item CRUD over the v4 shape, the `ItemDetail` read model
 * (per-location breakdown plus total), M1 validation (zero rows dropped,
 * duplicate locations rejected, S10 bounds per row), typed errors
 * (`validation`/`not-found`/`storage` with the `item` kind, never raw
 * SQLite text), atomic stock-set replacement, atomic draft saves (every
 * stock row's location resolved in one transaction, all-or-nothing),
 * fail-closed behavior without the exclusive hook, and that every
 * in-transaction query runs on the scoped handle. Real driver behavior is
 * native proof (isolated test DBs).
 */

import type {
  RepositoryDb,
  TransactionHandle,
} from '../src/inventory/database';
import {
  EntityConflictError,
  EntityNotFoundError,
  StorageError,
} from '../src/inventory/errors';
import {
  createItem,
  createItemFromDraft,
  deleteItem,
  findItemByBarcode,
  getItem,
  listItems,
  updateItem,
  updateItemFromDraft,
} from '../src/inventory/itemRepository';
import type { ItemDraftInput, NewItemInput } from '../src/inventory/types';
import { ValidationError } from '../src/inventory/validation';

interface LocRow {
  id: number;
  name: string;
  address: string | null;
  created_at: string;
}
interface CatRow {
  id: number;
  name: string;
  created_at: string;
}
interface ItemRow {
  id: number;
  name: string;
  low_stock_threshold: number | null;
  barcode: string | null;
  created_at: string;
}
interface StockRow {
  itemId: number;
  locationId: number;
  quantity: number;
  expiresOn: string | null;
}

/** In-memory fake with FK enforcement, stock cascade, and rollback. */
function makeFakeDb(options: { exclusive?: boolean } = {}) {
  const outerCalls: { source: string; params: unknown[] }[] = [];
  const txnCalls: { source: string; params: unknown[] }[] = [];
  const locations = new Map<number, LocRow>();
  const categories = new Map<number, CatRow>();
  const items = new Map<number, ItemRow>();
  const stock: StockRow[] = [];
  const joins = new Set<string>();
  let nextId = 1;
  let failNext: unknown = null;
  let failPattern: { pattern: RegExp; error: unknown } | null = null;

  const maybeFail = (source: string) => {
    if (failNext !== null) {
      const error = failNext;
      failNext = null;
      throw error;
    }
    if (failPattern?.pattern.test(source)) {
      const { error } = failPattern;
      failPattern = null;
      throw error;
    }
  };
  const fkError = () =>
    new Error(
      'SQLite error: FOREIGN KEY constraint failed (code 787 SQLITE_CONSTRAINT_FOREIGNKEY)',
    );
  const uniqueError = (table: string) =>
    new Error(
      `SQLite error: UNIQUE constraint failed: ${table}.name (code 2067 SQLITE_CONSTRAINT_UNIQUE)`,
    );

  const runImpl = async (
    source: string,
    params: unknown[] = [],
  ): Promise<{ lastInsertRowId: number; changes: number }> => {
    maybeFail(source);
    if (/INSERT INTO locations/i.test(source)) {
      // T3: the repository may insert many rows per statement; each
      // `(name, address)` group validates and stores like a single row.
      let lastId = 0;
      let groups = 0;
      for (let i = 0; i < params.length; i += 2) {
        const [name, address] = params.slice(i, i + 2) as [
          string,
          string | null,
        ];
        for (const row of locations.values()) {
          if (
            row.name.trim().toLowerCase() ===
            (name as string).trim().toLowerCase()
          ) {
            throw uniqueError('locations');
          }
        }
        const id = nextId++;
        locations.set(id, { id, name, address, created_at: `ts-${id}` });
        lastId = id;
        groups += 1;
      }
      return { lastInsertRowId: lastId, changes: groups };
    }
    if (/INSERT INTO categories/i.test(source)) {
      // T3: one `(name)` group per new category in a multi-row statement.
      let lastId = 0;
      let groups = 0;
      for (let i = 0; i < params.length; i += 1) {
        const [name] = params.slice(i, i + 1) as [string];
        for (const row of categories.values()) {
          if (
            row.name.trim().toLowerCase() ===
            (name as string).trim().toLowerCase()
          ) {
            throw uniqueError('categories');
          }
        }
        const id = nextId++;
        categories.set(id, { id, name, created_at: `ts-${id}` });
        lastId = id;
        groups += 1;
      }
      return { lastInsertRowId: lastId, changes: groups };
    }
    if (/INSERT INTO items/i.test(source)) {
      // v5: the repository binds (name, low_stock_threshold, barcode).
      const [name, threshold, barcode] = params as [
        string,
        number | null,
        string | null,
      ];
      if (barcode !== null && barcode !== undefined) {
        for (const row of items.values()) {
          if (row.barcode === barcode) throw uniqueError('items');
        }
      }
      const id = nextId++;
      items.set(id, {
        id,
        name,
        low_stock_threshold: threshold ?? null,
        barcode: barcode ?? null,
        created_at: `ts-${id}`,
      });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/INSERT INTO stock/i.test(source)) {
      // T3: one `(item_id, location_id, quantity, expires_on)` group per
      // stock row (v5 appends the optional expiry to the group).
      let groups = 0;
      for (let i = 0; i < params.length; i += 4) {
        const [itemId, locationId, quantity, expiresOn] = params.slice(
          i,
          i + 4,
        ) as [number, number, number, string | null];
        if (!items.has(itemId) || !locations.has(locationId)) throw fkError();
        if (quantity <= 0) {
          throw new Error('CHECK constraint failed: quantity > 0');
        }
        if (
          stock.some((s) => s.itemId === itemId && s.locationId === locationId)
        ) {
          throw new Error(
            'UNIQUE constraint failed: stock.item_id, stock.location_id',
          );
        }
        stock.push({
          itemId,
          locationId,
          quantity,
          expiresOn: expiresOn ?? null,
        });
        groups += 1;
      }
      return { lastInsertRowId: 0, changes: groups };
    }
    if (/INSERT INTO item_categories/i.test(source)) {
      // T3: one `(item_id, category_id)` group per link.
      let groups = 0;
      for (let i = 0; i < params.length; i += 2) {
        const [itemId, categoryId] = params.slice(i, i + 2) as [number, number];
        if (!items.has(itemId) || !categories.has(categoryId)) throw fkError();
        joins.add(`${itemId}:${categoryId}`);
        groups += 1;
      }
      return { lastInsertRowId: 0, changes: groups };
    }
    if (/UPDATE items/i.test(source)) {
      // v5: the repository binds (name, low_stock_threshold, barcode, id).
      const [name, threshold, barcode, id] = params as [
        string,
        number | null,
        string | null,
        number,
      ];
      const row = items.get(id);
      if (!row) return { lastInsertRowId: 0, changes: 0 };
      if (barcode !== null && barcode !== undefined) {
        for (const other of items.values()) {
          if (other.id !== id && other.barcode === barcode) {
            throw uniqueError('items');
          }
        }
      }
      items.set(id, {
        ...row,
        name,
        low_stock_threshold: threshold ?? null,
        barcode: barcode ?? null,
      });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/DELETE FROM stock/i.test(source)) {
      const [id] = params as [number];
      for (let i = stock.length - 1; i >= 0; i -= 1) {
        if (stock[i].itemId === id) stock.splice(i, 1);
      }
      return { lastInsertRowId: 0, changes: 1 };
    }
    if (/DELETE FROM item_categories/i.test(source)) {
      const [id] = params as [number];
      for (const key of [...joins]) {
        if (key.startsWith(`${id}:`)) joins.delete(key);
      }
      return { lastInsertRowId: 0, changes: 1 };
    }
    if (/DELETE FROM items WHERE/i.test(source)) {
      const [id] = params as [number];
      const deleted = items.delete(id);
      if (deleted) {
        for (let i = stock.length - 1; i >= 0; i -= 1) {
          if (stock[i].itemId === id) stock.splice(i, 1);
        }
        for (const key of [...joins]) {
          if (key.startsWith(`${id}:`)) joins.delete(key);
        }
      }
      return { lastInsertRowId: 0, changes: deleted ? 1 : 0 };
    }
    throw new Error(`fake: unhandled write ${source}`);
  };

  const getFirstImpl = async (source: string, params: unknown[] = []) => {
    maybeFail(source);
    if (/FROM locations/i.test(source)) {
      return locations.get(params[0] as number) ?? null;
    }
    // v5 scanner lookup: exact barcode match before the id branch.
    if (/FROM items/i.test(source) && /WHERE barcode/i.test(source)) {
      for (const row of items.values()) {
        if (row.barcode === (params[0] as string)) return row;
      }
      return null;
    }
    if (/FROM items/i.test(source)) {
      return items.get(params[0] as number) ?? null;
    }
    if (/FROM categories/i.test(source)) {
      return categories.get(params[0] as number) ?? null;
    }
    throw new Error(`fake: unhandled read ${source}`);
  };

  const getAllImpl = async (source: string, params: unknown[] = []) => {
    maybeFail(source);
    if (/FROM stock/i.test(source)) {
      const itemId = params[0] as number;
      return stock
        .filter((s) => s.itemId === itemId)
        .sort((a, b) => a.locationId - b.locationId)
        .map((s) => {
          const loc = locations.get(s.locationId);
          if (!loc) throw new Error('fake: dangling stock location');
          return {
            quantity: s.quantity,
            location_id: loc.id,
            location_name: loc.name,
            location_address: loc.address,
            location_created_at: loc.created_at,
            expires_on: s.expiresOn,
          };
        });
    }
    if (/JOIN item_categories/i.test(source)) {
      const itemId = params[0] as number;
      return [...joins]
        .filter((key) => key.startsWith(`${itemId}:`))
        .map((key) => categories.get(Number(key.split(':')[1])))
        .filter((row) => row !== undefined)
        .sort((a, b) => a.id - b.id);
    }
    if (/FROM items/i.test(source)) {
      return [...items.values()].sort((a, b) => a.id - b.id);
    }
    if (/FROM locations/i.test(source)) {
      // T3: `IN` selects filter by bound ids (numbers) or names (strings);
      // the parameterless domain scan still returns every row.
      const all = [...locations.values()].sort((a, b) => a.id - b.id);
      if (/IN \(/i.test(source) && params.length > 0) {
        if (typeof params[0] === 'number') {
          const ids = new Set(params as number[]);
          return all.filter((row) => ids.has(row.id));
        }
        const names = new Set(params as string[]);
        return all.filter((row) => names.has(row.name));
      }
      return all;
    }
    if (/FROM categories/i.test(source)) {
      const all = [...categories.values()].sort((a, b) => a.id - b.id);
      if (/IN \(/i.test(source) && params.length > 0) {
        if (typeof params[0] === 'number') {
          const ids = new Set(params as number[]);
          return all.filter((row) => ids.has(row.id));
        }
        const names = new Set(params as string[]);
        return all.filter((row) => names.has(row.name));
      }
      return all;
    }
    throw new Error(`fake: unhandled scan ${source}`);
  };

  const txn: TransactionHandle = {
    runAsync: jest.fn(async (source: string, params = []) => {
      txnCalls.push({ source, params });
      return runImpl(source, params);
    }),
    getFirstAsync: jest.fn(async (source: string, params = []) => {
      txnCalls.push({ source, params });
      return getFirstImpl(source, params);
    }) as TransactionHandle['getFirstAsync'],
    getAllAsync: jest.fn(async (source: string, params = []) => {
      txnCalls.push({ source, params });
      return getAllImpl(source, params);
    }) as TransactionHandle['getAllAsync'],
  };

  const db: RepositoryDb = {
    runAsync: jest.fn(async (source: string, params = []) => {
      outerCalls.push({ source, params });
      return runImpl(source, params);
    }),
    getFirstAsync: jest.fn(async (source: string, params = []) => {
      outerCalls.push({ source, params });
      return getFirstImpl(source, params);
    }) as RepositoryDb['getFirstAsync'],
    getAllAsync: jest.fn(async (source: string, params = []) => {
      outerCalls.push({ source, params });
      return getAllImpl(source, params);
    }) as RepositoryDb['getAllAsync'],
  };
  if (options.exclusive !== false) {
    db.withExclusiveTransactionAsync = jest.fn(
      async (task: (t: TransactionHandle) => Promise<void>) => {
        const snap = {
          locations: new Map(locations),
          categories: new Map(categories),
          items: new Map(items),
          stock: stock.map((s) => ({ ...s })),
          joins: new Set(joins),
          nextId,
        };
        try {
          await task(txn);
        } catch (error) {
          locations.clear();
          for (const [k, v] of snap.locations) locations.set(k, v);
          categories.clear();
          for (const [k, v] of snap.categories) categories.set(k, v);
          items.clear();
          for (const [k, v] of snap.items) items.set(k, v);
          stock.length = 0;
          for (const s of snap.stock) stock.push(s);
          joins.clear();
          for (const k of snap.joins) joins.add(k);
          nextId = snap.nextId;
          throw error;
        }
      },
    );
  }

  const seedLocation = (name = 'Pantry', address: string | null = null) => {
    const id = nextId++;
    locations.set(id, { id, name, address, created_at: `ts-${id}` });
    return id;
  };
  const seedCategory = (name = 'Bulk') => {
    const id = nextId++;
    categories.set(id, { id, name, created_at: `ts-${id}` });
    return id;
  };
  return {
    db,
    txn,
    outerCalls,
    txnCalls,
    locations,
    categories,
    items,
    stock,
    joins,
    seedLocation,
    seedCategory,
    failNextWith: (error: unknown) => {
      failNext = error;
    },
    failMatchingWith: (pattern: RegExp, error: unknown) => {
      failPattern = { pattern, error };
    },
  };
}

type Fake = ReturnType<typeof makeFakeDb>;

async function seedItem(
  f: Fake,
  locId: number,
  input: Partial<NewItemInput> = {},
) {
  return createItem(f.db, {
    name: 'Rice',
    stock: [{ locationId: locId, quantity: 2 }],
    ...input,
  });
}

describe('item CRUD read model (catalog + stock)', () => {
  test('create/get/list round-trip with breakdown, total, and categories', async () => {
    const f = makeFakeDb();
    const pantry = f.seedLocation('Pantry', 'Aisle 1');
    const garage = f.seedLocation('Garage');
    const catA = f.seedCategory('Bulk');
    const catB = f.seedCategory('lácteos ñ');
    const created = await createItem(f.db, {
      name: '  Rice — integral  ',
      stock: [
        { locationId: pantry, quantity: 2 },
        { locationId: garage, quantity: 5 },
      ],
      categoryIds: [catA, catB],
    });
    expect(created).toMatchObject({
      name: 'Rice — integral',
      totalQuantity: 7,
    });
    expect(created.stock).toHaveLength(2);
    expect(created.stock[0]).toMatchObject({
      locationId: pantry,
      quantity: 2,
      location: { id: pantry, name: 'Pantry', address: 'Aisle 1' },
    });
    expect(created.stock[1]).toMatchObject({
      locationId: garage,
      quantity: 5,
    });
    expect(created.categoryIds).toEqual([catA, catB]);
    expect(created.categories.map((c) => c.name)).toEqual([
      'Bulk',
      'lácteos ñ',
    ]);
    // One answer per product: a single row with the breakdown.
    expect(await getItem(f.db, created.id)).toEqual(created);
    expect(await listItems(f.db)).toEqual([created]);

    const bare = await createItem(f.db, { name: 'Salt' });
    expect(bare.stock).toEqual([]);
    expect(bare.totalQuantity).toBe(0);
    expect(bare.categoryIds).toEqual([]);
    expect((await listItems(f.db)).map((i) => i.id)).toEqual([
      created.id,
      bare.id,
    ]);
  });

  test('zero-quantity rows are dropped: the item stays catalog-only (sin stock)', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const created = await createItem(f.db, {
      name: 'Beans',
      stock: [{ locationId: loc, quantity: 0 }],
    });
    expect(created.stock).toEqual([]);
    expect(created.totalQuantity).toBe(0);
    expect(f.stock).toEqual([]);
    expect(await getItem(f.db, created.id)).toEqual(created);
  });

  test('duplicate locations and bad rows reject before touching the database', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const callsBefore = f.outerCalls.length + f.txnCalls.length;
    await expect(
      createItem(f.db, {
        name: '   ',
        stock: [{ locationId: loc, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createItem(f.db, {
        name: 'x',
        stock: [
          { locationId: loc, quantity: 1 },
          { locationId: loc, quantity: 2 },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createItem(f.db, {
        name: 'x',
        stock: [{ locationId: loc, quantity: -1 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createItem(f.db, {
        name: 'x',
        stock: [{ locationId: loc, quantity: 1.5 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createItem(f.db, {
        name: 'x',
        stock: [{ locationId: loc, quantity: 1000000 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createItem(f.db, {
        name: 'x',
        stock: [{ locationId: loc, quantity: 1 }],
        categoryIds: [1, 1],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(getItem(f.db, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(deleteItem(f.db, -3)).rejects.toBeInstanceOf(ValidationError);
    expect(f.outerCalls.length + f.txnCalls.length).toBe(callsBefore);
    expect(f.db.withExclusiveTransactionAsync).not.toHaveBeenCalled();
  });

  test('missing rows are not-found with the item kind; storage stays generic', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    await expect(getItem(f.db, 99)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(
      updateItem(f.db, 99, {
        name: 'x',
        stock: [{ locationId: loc, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(deleteItem(f.db, 99)).rejects.toMatchObject({
      code: 'not-found',
    });
    const missingLoc = (await createItem(f.db, {
      name: 'x',
      stock: [{ locationId: 999, quantity: 1 }],
    }).catch((e: unknown) => e)) as Error;
    expect(missingLoc).toBeInstanceOf(EntityNotFoundError);
    expect(missingLoc).toMatchObject({ entity: 'location', id: 999 });
    const missingCat = (await createItem(f.db, {
      name: 'x',
      stock: [{ locationId: loc, quantity: 1 }],
      categoryIds: [888],
    }).catch((e: unknown) => e)) as Error;
    expect(missingCat).toBeInstanceOf(EntityNotFoundError);
    expect(missingCat).toMatchObject({ entity: 'category', id: 888 });
    // No partial rows from the rejected creates.
    expect(f.items.size).toBe(0);
    expect(f.stock).toEqual([]);

    f.failNextWith(new Error('disk I/O error on sqlite3_step'));
    const failure = (await listItems(f.db).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({ code: 'storage', entity: 'item' });
    expect(failure.message).not.toContain('disk I/O');
  });

  test('update replaces name, stock set, and categories atomically, keeps created_at', async () => {
    const f = makeFakeDb();
    const locA = f.seedLocation('Pantry');
    const locB = f.seedLocation('Fridge');
    const catA = f.seedCategory('Bulk');
    const catB = f.seedCategory('Cold');
    const catC = f.seedCategory('Fresh');
    const created = await seedItem(f, locA, { categoryIds: [catA] });
    expect(created.totalQuantity).toBe(2);
    const updated = await updateItem(f.db, created.id, {
      name: 'Brown rice',
      stock: [
        { locationId: locA, quantity: 1 },
        { locationId: locB, quantity: 4 },
      ],
      categoryIds: [catB, catC],
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'Brown rice',
      totalQuantity: 5,
      categoryIds: [catB, catC],
      created_at: created.created_at,
    });
    expect(updated.stock.map((s) => s.locationId)).toEqual([locA, locB]);
    expect(await getItem(f.db, created.id)).toEqual(updated);

    // Replacing with an empty stock set leaves a sin-stock catalog item.
    const cleared = await updateItem(f.db, created.id, {
      name: 'Brown rice',
      stock: [],
      categoryIds: [],
    });
    expect(cleared.stock).toEqual([]);
    expect(cleared.totalQuantity).toBe(0);
    expect(cleared.categoryIds).toEqual([]);
    expect(f.stock).toEqual([]);
    expect(f.joins.size).toBe(0);
  });

  test('delete removes the item, its stock, and its joins but keeps entities', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const cat = f.seedCategory();
    const created = await seedItem(f, loc, { categoryIds: [cat] });
    await deleteItem(f.db, created.id);
    await expect(getItem(f.db, created.id)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    expect(await listItems(f.db)).toEqual([]);
    expect(f.locations.has(loc)).toBe(true);
    expect(f.categories.has(cat)).toBe(true);
    expect(f.stock).toEqual([]);
    expect(f.joins.size).toBe(0);
  });

  test('injection-shaped text is bound, never interpolated', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const evil = "x'); DROP TABLE items; --";
    const created = await createItem(f.db, {
      name: evil,
      stock: [{ locationId: loc, quantity: 1 }],
    });
    expect(created.name).toBe(evil);
    expect(f.items.size).toBe(1);
    for (const call of [...f.outerCalls, ...f.txnCalls]) {
      expect(call.source).not.toContain(evil);
      expect(call.source).toMatch(/\?/);
    }
  });
});

describe('item drafts (form atomic saves)', () => {
  test('draft create with new locations per stock row plus existing/new categories', async () => {
    const f = makeFakeDb();
    const existingCat = f.seedCategory('Bulk');
    const draft: ItemDraftInput = {
      name: 'Oats',
      stock: [
        {
          location: {
            kind: 'new',
            location: { name: '  Cellar  ', address: ' ' },
          },
          quantity: 4,
        },
        {
          location: { kind: 'new', location: { name: 'Attic' } },
          quantity: 2,
        },
      ],
      categories: [
        { kind: 'existing', categoryId: existingCat },
        { kind: 'new', category: { name: 'Desayuno' } },
      ],
    };
    const created = await createItemFromDraft(f.db, draft);
    expect(created.name).toBe('Oats');
    expect(created.totalQuantity).toBe(6);
    expect(created.stock).toHaveLength(2);
    expect(created.stock[0].location).toMatchObject({
      name: 'Cellar',
      address: null,
    });
    expect(created.stock.map((s) => s.location.name).sort()).toEqual([
      'Attic',
      'Cellar',
    ]);
    expect(created.categoryIds).toHaveLength(2);
    expect(created.categories.map((c) => c.name).sort()).toEqual([
      'Bulk',
      'Desayuno',
    ]);
    expect(await getItem(f.db, created.id)).toEqual(created);

    const plain = await createItemFromDraft(f.db, {
      name: 'Salt',
      stock: [
        {
          location: {
            kind: 'existing',
            locationId: created.stock[0].locationId,
          },
          quantity: 0,
        },
      ],
    });
    // The zero row is dropped: nothing stored, no new location.
    expect(plain.stock).toEqual([]);
    expect(plain.totalQuantity).toBe(0);
    expect(plain.categoryIds).toEqual([]);
  });

  test('draft update resolves every stock row atomically, keeps created_at', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const created = await seedItem(f, loc);
    const updated = await updateItemFromDraft(f.db, created.id, {
      name: 'Rice+',
      stock: [
        { location: { kind: 'existing', locationId: loc }, quantity: 3 },
        { location: { kind: 'new', location: { name: 'Attic' } }, quantity: 1 },
      ],
      categories: [{ kind: 'new', category: { name: 'Reserva' } }],
    });
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.totalQuantity).toBe(4);
    expect(updated.stock.map((s) => s.location.name).sort()).toEqual([
      'Attic',
      'Pantry',
    ]);
    expect(updated.categories.map((c) => c.name)).toEqual(['Reserva']);
    await expect(
      updateItemFromDraft(f.db, 999, {
        name: 'x',
        stock: [
          { location: { kind: 'existing', locationId: loc }, quantity: 1 },
        ],
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  test('invalid drafts fail validation with no writes and no transaction', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const cat = f.seedCategory();
    const bad: ItemDraftInput[] = [
      { name: 'x', stock: null as never },
      {
        name: 'x',
        stock: [
          {
            location: { kind: 'bogus', locationId: loc } as never,
            quantity: 1,
          },
        ],
      },
      // Duplicate existing locations in one payload reject.
      {
        name: 'x',
        stock: [
          { location: { kind: 'existing', locationId: loc }, quantity: 1 },
          { location: { kind: 'existing', locationId: loc }, quantity: 2 },
        ],
      },
      {
        name: 'x',
        stock: [
          { location: { kind: 'existing', locationId: loc }, quantity: 1 },
        ],
        categories: [
          { kind: 'existing', categoryId: cat },
          { kind: 'existing', categoryId: cat },
        ],
      },
      {
        name: 'x',
        stock: [
          { location: { kind: 'new', location: { name: '   ' } }, quantity: 1 },
        ],
      },
      {
        name: 'x',
        stock: [
          {
            location: { kind: 'existing', locationId: loc },
            quantity: 1000000,
          },
        ],
      },
    ];
    for (const draft of bad) {
      await expect(createItemFromDraft(f.db, draft)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(f.db.withExclusiveTransactionAsync).not.toHaveBeenCalled();
    expect(f.items.size).toBe(0);
    expect(f.stock).toEqual([]);
    expect(f.locations.size).toBe(1);
    expect(f.categories.size).toBe(1);
  });

  test('missing draft references and late failures leave no orphans', async () => {
    const f = makeFakeDb();
    const cat = f.seedCategory();
    const missing = (await createItemFromDraft(f.db, {
      name: 'Ghost',
      stock: [
        {
          location: { kind: 'new', location: { name: 'Nowhere' } },
          quantity: 1,
        },
      ],
      categories: [{ kind: 'existing', categoryId: 4242 }],
    }).catch((e: unknown) => e)) as Error;
    expect(missing).toBeInstanceOf(EntityNotFoundError);
    expect(missing).toMatchObject({ entity: 'category', id: 4242 });
    // The new location rolled back with the failed item.
    expect(f.locations.size).toBe(0);
    expect(f.items.size).toBe(0);
    expect(f.stock).toEqual([]);

    // Late failure at the stock insert: new location + new category roll back.
    f.failMatchingWith(
      /INSERT INTO stock/i,
      new Error('disk I/O error on sqlite3_step'),
    );
    const late = (await createItemFromDraft(f.db, {
      name: 'Late',
      stock: [
        {
          location: { kind: 'new', location: { name: 'Cellar' } },
          quantity: 1,
        },
      ],
      categories: [{ kind: 'existing', categoryId: cat }],
    }).catch((e: unknown) => e)) as Error;
    expect(late).toBeInstanceOf(StorageError);
    expect(late.message).not.toContain('disk I/O');
    expect(f.items.size).toBe(0);
    expect(f.stock).toEqual([]);
    expect(f.locations.size).toBe(0);
    expect(f.categories.size).toBe(1);
  });

  test('three new locations either commit all three or none', async () => {
    const f = makeFakeDb();
    const created = await createItemFromDraft(f.db, {
      name: 'Spread',
      stock: [
        { location: { kind: 'new', location: { name: 'L1' } }, quantity: 1 },
        { location: { kind: 'new', location: { name: 'L2' } }, quantity: 2 },
        { location: { kind: 'new', location: { name: 'L3' } }, quantity: 3 },
      ],
    });
    expect(created.totalQuantity).toBe(6);
    expect(created.stock).toHaveLength(3);

    f.failMatchingWith(
      /INSERT INTO stock/i,
      new Error('disk I/O error on sqlite3_step'),
    );
    const failure = (await createItemFromDraft(f.db, {
      name: 'Spread2',
      stock: [
        { location: { kind: 'new', location: { name: 'M1' } }, quantity: 1 },
        { location: { kind: 'new', location: { name: 'M2' } }, quantity: 2 },
      ],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    // None of the new locations survived the rollback.
    expect(
      [...f.locations.values()].filter((l) => l.name.startsWith('M')).length,
    ).toBe(0);
    expect(f.items.size).toBe(1);
  });
});

describe('draft entity-name conflicts (S11)', () => {
  test('S11 RED: draft with a duplicate new location name fails typed conflict with no rows', async () => {
    const f = makeFakeDb();
    f.seedLocation('Pantry');
    const before = f.items.size;
    const failure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        {
          location: { kind: 'new', location: { name: ' pantry ' } },
          quantity: 1,
        },
      ],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'location' });
    expect(f.locations.size).toBe(1);
    expect(f.items.size).toBe(before);
    expect(f.stock).toEqual([]);
  });

  test('S11 RED: draft with a duplicate new category name fails typed conflict', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    f.seedCategory('café');
    const failure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [{ location: { kind: 'existing', locationId: loc }, quantity: 1 }],
      categories: [{ kind: 'new', category: { name: 'CAFÉ' } }],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'category' });
    expect(f.categories.size).toBe(1);
    expect(f.items.size).toBe(0);
    expect(f.stock).toEqual([]);
  });

  test('S11 RED: two colliding new categories in one draft fail typed conflict', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    await expect(
      createItemFromDraft(f.db, {
        name: 'Rice',
        stock: [
          { location: { kind: 'existing', locationId: loc }, quantity: 1 },
        ],
        categories: [
          { kind: 'new', category: { name: 'Bulk' } },
          { kind: 'new', category: { name: ' bulk ' } },
        ],
      }),
    ).rejects.toMatchObject({ code: 'conflict', entity: 'category' });
    expect(f.categories.size).toBe(0);
    expect(f.items.size).toBe(0);
  });

  test('S11 RED: raw UNIQUE failure on an inline insert maps to conflict without leaking text', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    // Hide the existing rows from the domain pre-check so the driver-level
    // backstop is exercised, then fail the inline write like the v3 index.
    // T3 batches existence checks through getAllAsync too, so only the
    // parameterless domain scan is hidden (the IN existence check keeps
    // its bound ids and still finds the seeded location).
    const txnGetAll = f.txn.getAllAsync as jest.Mock;
    const passthrough = txnGetAll.getMockImplementation();
    txnGetAll.mockImplementation(
      async (source: string, params: unknown[] = []) => {
        if (params.length === 0) return [];
        return (passthrough as (source: string, params: unknown[]) => unknown)(
          source,
          params,
        );
      },
    );
    f.failMatchingWith(
      /INSERT INTO categories/i,
      new Error(
        'SQLite error: UNIQUE constraint failed: categories.name (code 2067 SQLITE_CONSTRAINT_UNIQUE)',
      ),
    );
    const failure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [{ location: { kind: 'existing', locationId: loc }, quantity: 1 }],
      categories: [{ kind: 'new', category: { name: 'Bulk' } }],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'category' });
    expect(failure.message).not.toContain('UNIQUE');
    expect(f.items.size).toBe(0);
  });
});

describe('transaction boundary', () => {
  test('mutations run on the scoped handle, never the outer db', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const cat = f.seedCategory();
    await seedItem(f, loc, { categoryIds: [cat] });
    expect(f.db.withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
    // Reads/writes inside the transaction bypass the outer spies entirely.
    for (const spy of [
      f.db.runAsync,
      f.db.getFirstAsync,
      f.db.getAllAsync,
    ] as jest.Mock[]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(f.txnCalls.length).toBeGreaterThan(0);
    for (const call of f.txnCalls) {
      expect(call.source).toMatch(/\?|SELECT|INSERT|DELETE|UPDATE/);
    }
  });

  test('mutations fail closed when the exclusive hook is absent', async () => {
    const f = makeFakeDb({ exclusive: false });
    const loc = f.seedLocation();
    const draft: ItemDraftInput = {
      name: 'x',
      stock: [{ location: { kind: 'existing', locationId: loc }, quantity: 1 }],
    };
    for (const op of [
      () =>
        createItem(f.db, {
          name: 'x',
          stock: [{ locationId: loc, quantity: 1 }],
        }),
      () =>
        updateItem(f.db, 1, {
          name: 'x',
          stock: [{ locationId: loc, quantity: 1 }],
        }),
      () => deleteItem(f.db, 1),
      () => createItemFromDraft(f.db, draft),
      () => updateItemFromDraft(f.db, 1, draft),
    ]) {
      const failure = (await op().catch((e: unknown) => e)) as Error;
      expect(failure).toBeInstanceOf(StorageError);
      expect(failure).toMatchObject({ code: 'storage', entity: 'item' });
    }
    expect(f.items.size).toBe(0);
    // Reads stay available without the hook; validation still runs first.
    await expect(listItems(f.db)).resolves.toEqual([]);
    await expect(
      createItem(f.db, {
        name: '   ',
        stock: [{ locationId: loc, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('T3 write-path batching (RED: per-row statements today)', () => {
  const count = (calls: { source: string }[], pattern: RegExp) =>
    calls.filter((call) => pattern.test(call.source));

  test('draft with existing relations: one existence select per entity, one insert per table', async () => {
    const f = makeFakeDb();
    const locA = f.seedLocation('Pantry');
    const locB = f.seedLocation('Garage');
    const locC = f.seedLocation('Cellar');
    const catA = f.seedCategory('Bulk');
    const catB = f.seedCategory('Grains');
    const detail = await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        { location: { kind: 'existing', locationId: locA }, quantity: 1 },
        { location: { kind: 'existing', locationId: locB }, quantity: 2 },
        { location: { kind: 'existing', locationId: locC }, quantity: 3 },
      ],
      categories: [
        { kind: 'existing', categoryId: catA },
        { kind: 'existing', categoryId: catB },
      ],
    });
    expect(detail.totalQuantity).toBe(6);
    expect(detail.categoryIds).toEqual([catA, catB]);
    // Batched: exactly one existence SELECT per entity for all rows.
    expect(count(f.txnCalls, /FROM locations WHERE id/i)).toHaveLength(1);
    expect(count(f.txnCalls, /FROM categories WHERE id/i)).toHaveLength(1);
    // Batched: exactly one multi-row INSERT per written table.
    expect(count(f.txnCalls, /INSERT INTO stock/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO item_categories/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO items/i)).toHaveLength(1);
  });

  test('draft with new relations: one uniqueness scan, one insert, one id resolve per entity', async () => {
    const f = makeFakeDb();
    const detail = await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        {
          location: { kind: 'new', location: { name: 'Pantry' } },
          quantity: 1,
        },
        {
          location: {
            kind: 'new',
            location: { name: 'Garage', address: 'Aisle 2' },
          },
          quantity: 2,
        },
        {
          location: { kind: 'new', location: { name: 'Cellar' } },
          quantity: 3,
        },
      ],
      categories: [
        { kind: 'new', category: { name: 'Bulk' } },
        { kind: 'new', category: { name: 'Grains' } },
      ],
    });
    expect(detail.totalQuantity).toBe(6);
    expect(detail.stock.map((level) => level.location.name).sort()).toEqual([
      'Cellar',
      'Garage',
      'Pantry',
    ]);
    expect(detail.categories.map((c) => c.name).sort()).toEqual([
      'Bulk',
      'Grains',
    ]);
    // One domain uniqueness scan per entity no matter how many new names.
    expect(
      count(f.txnCalls, /SELECT id, name FROM locations ORDER BY/i),
    ).toHaveLength(1);
    expect(
      count(f.txnCalls, /SELECT id, name FROM categories ORDER BY/i),
    ).toHaveLength(1);
    // One multi-row INSERT per entity table, then one id resolve each.
    expect(count(f.txnCalls, /INSERT INTO locations/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO categories/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO stock/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO item_categories/i)).toHaveLength(1);
  });

  test('createItem with existing relations batches existence checks and inserts', async () => {
    const f = makeFakeDb();
    const locA = f.seedLocation('Pantry');
    const locB = f.seedLocation('Garage');
    const cat = f.seedCategory('Bulk');
    await createItem(f.db, {
      name: 'Rice',
      stock: [
        { locationId: locA, quantity: 1 },
        { locationId: locB, quantity: 2 },
      ],
      categoryIds: [cat],
    });
    expect(count(f.txnCalls, /FROM locations WHERE id/i)).toHaveLength(1);
    expect(count(f.txnCalls, /FROM categories WHERE id/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO stock/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO item_categories/i)).toHaveLength(1);
  });

  test('updateItemFromDraft batches the replacement stock and link writes', async () => {
    const f = makeFakeDb();
    const locA = f.seedLocation('Pantry');
    const locB = f.seedLocation('Garage');
    const locC = f.seedLocation('Cellar');
    const catA = f.seedCategory('Bulk');
    const catB = f.seedCategory('Grains');
    const created = await seedItem(f, locA);
    f.txnCalls.length = 0;
    await updateItemFromDraft(f.db, created.id, {
      name: 'Rice',
      stock: [
        { location: { kind: 'existing', locationId: locA }, quantity: 1 },
        { location: { kind: 'existing', locationId: locB }, quantity: 2 },
        { location: { kind: 'existing', locationId: locC }, quantity: 3 },
      ],
      categories: [
        { kind: 'existing', categoryId: catA },
        { kind: 'existing', categoryId: catB },
      ],
    });
    expect(count(f.txnCalls, /FROM locations WHERE id/i)).toHaveLength(1);
    expect(count(f.txnCalls, /FROM categories WHERE id/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO stock/i)).toHaveLength(1);
    expect(count(f.txnCalls, /INSERT INTO item_categories/i)).toHaveLength(1);
  });

  test('batched draft still rolls back everything when the stock write fails', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation('Pantry');
    f.failMatchingWith(/INSERT INTO stock/i, new Error('fake io failure'));
    const failure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        { location: { kind: 'existing', locationId: loc }, quantity: 1 },
        {
          location: { kind: 'new', location: { name: 'Garage' } },
          quantity: 2,
        },
      ],
      categories: [{ kind: 'new', category: { name: 'Bulk' } }],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({ code: 'storage', entity: 'item' });
    // All-or-nothing: no item, no new location, no new category survived.
    expect(f.items.size).toBe(0);
    expect(f.locations.size).toBe(1);
    expect(f.categories.size).toBe(0);
    expect(f.stock).toHaveLength(0);
  });

  test('batched existence check still maps a missing location to not-found', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation('Pantry');
    const failure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        { location: { kind: 'existing', locationId: loc }, quantity: 1 },
        { location: { kind: 'existing', locationId: 4242 }, quantity: 2 },
      ],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityNotFoundError);
    expect(failure).toMatchObject({
      code: 'not-found',
      entity: 'location',
      id: 4242,
    });
    expect(f.items.size).toBe(0);
  });

  test('batched existence check still maps a missing category to not-found', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation('Pantry');
    const failure = (await createItem(f.db, {
      name: 'Rice',
      stock: [{ locationId: loc, quantity: 1 }],
      categoryIds: [4242],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityNotFoundError);
    expect(failure).toMatchObject({
      code: 'not-found',
      entity: 'category',
      id: 4242,
    });
    expect(f.items.size).toBe(0);
  });

  test('batched draft still maps a stored name collision to conflict', async () => {
    const f = makeFakeDb();
    f.seedLocation('Pantry');
    f.seedCategory('Bulk');
    const locFailure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        {
          location: { kind: 'new', location: { name: '  pantry ' } },
          quantity: 1,
        },
      ],
    }).catch((e: unknown) => e)) as Error;
    expect(locFailure).toBeInstanceOf(EntityConflictError);
    expect(locFailure).toMatchObject({ code: 'conflict', entity: 'location' });
    const catFailure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [],
      categories: [{ kind: 'new', category: { name: 'BULK' } }],
    }).catch((e: unknown) => e)) as Error;
    expect(catFailure).toBeInstanceOf(EntityConflictError);
    expect(catFailure).toMatchObject({ code: 'conflict', entity: 'category' });
    expect(f.items.size).toBe(0);
    expect(f.locations.size).toBe(1);
    expect(f.categories.size).toBe(1);
  });

  test('batched draft still rejects a duplicate new name inside the draft', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation('Pantry');
    const failure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        {
          location: { kind: 'new', location: { name: 'Garage' } },
          quantity: 1,
        },
        {
          location: { kind: 'new', location: { name: '  GARAGE ' } },
          quantity: 2,
        },
        { location: { kind: 'existing', locationId: loc }, quantity: 3 },
      ],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'location' });
    expect(f.items.size).toBe(0);
    expect(f.locations.size).toBe(1);
  });

  test('batched draft keeps the UNIQUE backstop mapping when the scan races', async () => {
    const f = makeFakeDb();
    f.seedLocation('Pantry');
    // Simulate the race the domain pre-check cannot see: the batched
    // scan reports no rows while the driver rejects the write.
    const scan = f.txn.getAllAsync as jest.Mock;
    scan.mockImplementationOnce(async () => []);
    const failure = (await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        {
          location: { kind: 'new', location: { name: 'Pantry' } },
          quantity: 1,
        },
      ],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'location' });
    expect(failure.message).not.toContain('UNIQUE');
    expect(failure.message).not.toContain('SQLITE_CONSTRAINT');
    expect(f.items.size).toBe(0);
  });

  test('a new location referenced only by a zero row is still never created', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation('Pantry');
    const detail = await createItemFromDraft(f.db, {
      name: 'Rice',
      stock: [
        { location: { kind: 'existing', locationId: loc }, quantity: 2 },
        {
          location: { kind: 'new', location: { name: 'Ghost' } },
          quantity: 0,
        },
      ],
    });
    expect(detail.stock).toHaveLength(1);
    expect(f.locations.size).toBe(1);
    expect(count(f.txnCalls, /INSERT INTO locations/i)).toHaveLength(0);
  });

  test('mutations prefer the shared exclusive path when it exists, else the classic hook', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation('Pantry');
    const shared = jest.fn(
      async (task: (txn: TransactionHandle) => Promise<void>) => {
        await task(f.txn);
      },
    );
    const withBoth = { ...f.db, withSharedExclusiveTransactionAsync: shared };
    await createItem(withBoth, {
      name: 'Rice',
      stock: [{ locationId: loc, quantity: 1 }],
    });
    expect(shared).toHaveBeenCalledTimes(1);
    expect(f.db.withExclusiveTransactionAsync).not.toHaveBeenCalled();
    // Without the shared hook the classic path still runs the mutation.
    const g = makeFakeDb();
    const gloc = g.seedLocation('Pantry');
    await createItem(g.db, {
      name: 'Rice',
      stock: [{ locationId: gloc, quantity: 1 }],
    });
    expect(g.db.withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
  });
});

describe('v5 scanner and reminder fields (mocked native boundary)', () => {
  test('create persists threshold/barcode/expiry and reads them back', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const cat = f.seedCategory();
    const created = await createItem(f.db, {
      name: 'Rice',
      lowStockThreshold: 3,
      barcode: '  12345678  ',
      stock: [{ locationId: loc, quantity: 2, expiresOn: '2027-03-15' }],
      categoryIds: [cat],
    });
    expect(created.lowStockThreshold).toBe(3);
    expect(created.barcode).toBe('12345678');
    expect(created.stock).toHaveLength(1);
    expect(created.stock[0].expiresOn).toBe('2027-03-15');
    expect(created.totalQuantity).toBe(2);
    expect(await getItem(f.db, created.id)).toEqual(created);
    expect((await listItems(f.db)).find((i) => i.id === created.id)).toEqual(
      created,
    );
  });

  test('absent v5 fields stay NULL: old callers behave exactly as before', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const created = await seedItem(f, loc);
    expect(created.lowStockThreshold).toBeNull();
    expect(created.barcode).toBeNull();
    expect(created.stock[0].expiresOn).toBeNull();
    expect(created.totalQuantity).toBe(2);
    const cleared = await updateItem(f.db, created.id, {
      name: 'Rice',
      stock: [],
    });
    expect(cleared.lowStockThreshold).toBeNull();
    expect(cleared.barcode).toBeNull();
    expect(cleared.stock).toEqual([]);
  });

  test('duplicate barcode maps to EntityConflictError without leaking SQL text', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    await createItem(f.db, {
      name: 'Rice',
      barcode: '12345678',
      stock: [{ locationId: loc, quantity: 1 }],
    });
    const failure = (await createItem(f.db, {
      name: 'Beans',
      barcode: '12345678',
      stock: [{ locationId: loc, quantity: 1 }],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'item' });
    expect(failure.message).not.toMatch(/UNIQUE/i);
    expect(failure.message).not.toMatch(/SQLITE_CONSTRAINT/i);
    expect(f.items.size).toBe(1);
  });

  test("update keeps its own barcode but takes another item's as a conflict", async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const rice = await createItem(f.db, {
      name: 'Rice',
      barcode: '11112222',
      stock: [{ locationId: loc, quantity: 1 }],
    });
    const beans = await createItem(f.db, {
      name: 'Beans',
      barcode: '33334444',
      stock: [{ locationId: loc, quantity: 1 }],
    });
    const kept = await updateItem(f.db, rice.id, {
      name: 'Rice grande',
      barcode: '11112222',
      stock: [{ locationId: loc, quantity: 2 }],
    });
    expect(kept.barcode).toBe('11112222');
    expect(kept.name).toBe('Rice grande');
    const clash = (await updateItem(f.db, beans.id, {
      name: 'Beans',
      barcode: '11112222',
      stock: [{ locationId: loc, quantity: 1 }],
    }).catch((e: unknown) => e)) as Error;
    expect(clash).toBeInstanceOf(EntityConflictError);
    expect(clash).toMatchObject({ code: 'conflict', entity: 'item' });
    expect((await getItem(f.db, beans.id)).barcode).toBe('33334444');
  });

  test('race backstop: raw UNIQUE failure on the catalog write maps to conflict', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    // Hide stored rows from the domain pre-check so the driver backstop
    // is exercised (mirrors the S11 race test for categories).
    const txnGetFirst = f.txn.getFirstAsync as jest.Mock;
    txnGetFirst.mockImplementation(async () => null);
    f.failMatchingWith(
      /INSERT INTO items/i,
      new Error(
        'SQLite error: UNIQUE constraint failed: items.barcode (code 2067 SQLITE_CONSTRAINT_UNIQUE)',
      ),
    );
    const failure = (await createItem(f.db, {
      name: 'Rice',
      barcode: '99990000',
      stock: [{ locationId: loc, quantity: 1 }],
    }).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'item' });
    expect(failure.message).not.toContain('UNIQUE');
    expect(f.items.size).toBe(0);
  });

  test('findItemByBarcode returns the detail for a known code', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation('Pantry', 'Aisle 1');
    const created = await createItem(f.db, {
      name: 'Rice',
      lowStockThreshold: 2,
      barcode: '12345678',
      stock: [{ locationId: loc, quantity: 4, expiresOn: '2027-03-15' }],
    });
    // Surrounding whitespace scans the same code (trimmed before binding).
    expect(await findItemByBarcode(f.db, '  12345678  ')).toEqual(created);
  });

  test('findItemByBarcode returns null for an unknown code', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    await seedItem(f, loc);
    expect(await findItemByBarcode(f.db, '00001111')).toBeNull();
  });

  test('findItemByBarcode validates before touching the driver', async () => {
    const f = makeFakeDb();
    const callsBefore = f.outerCalls.length + f.txnCalls.length;
    for (const bad of ['   ', 'ab', 42, null] as never[]) {
      await expect(findItemByBarcode(f.db, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(f.outerCalls.length + f.txnCalls.length).toBe(callsBefore);
  });

  test('findItemByBarcode binds the code: no interpolation, storage stays generic', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    await createItem(f.db, {
      name: 'Rice',
      barcode: '12345678',
      stock: [{ locationId: loc, quantity: 1 }],
    });
    // A shaped-but-unknown code reaches the driver as a bound param.
    expect(await findItemByBarcode(f.db, '87654321')).toBeNull();
    const lookup = f.outerCalls.find((call) => /barcode/i.test(call.source));
    expect(lookup?.source).toMatch(/\?/);
    expect(lookup?.source).not.toContain('87654321');
    expect(lookup?.params).toEqual(['87654321']);
    // An injection-shaped input never reaches SQL: the shape rejects first.
    const evil = "12345678' OR '1'='1";
    const callsBefore = f.outerCalls.length + f.txnCalls.length;
    await expect(findItemByBarcode(f.db, evil)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(f.outerCalls.length + f.txnCalls.length).toBe(callsBefore);
    f.failNextWith(new Error('disk I/O error on sqlite3_step'));
    const failure = (await findItemByBarcode(f.db, '12345678').catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({ code: 'storage', entity: 'item' });
    expect(failure.message).not.toContain('disk I/O');
  });

  test('draft create and update carry the v5 fields atomically', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const created = await createItemFromDraft(f.db, {
      name: 'Oats',
      lowStockThreshold: 1,
      barcode: '55556666',
      stock: [
        {
          location: { kind: 'existing', locationId: loc },
          quantity: 4,
          expiresOn: '2028-01-31',
        },
      ],
    });
    expect(created.lowStockThreshold).toBe(1);
    expect(created.barcode).toBe('55556666');
    expect(created.stock[0].expiresOn).toBe('2028-01-31');
    const updated = await updateItemFromDraft(f.db, created.id, {
      name: 'Oats',
      lowStockThreshold: null,
      barcode: null,
      stock: [
        {
          location: { kind: 'existing', locationId: loc },
          quantity: 2,
        },
      ],
    });
    expect(updated.lowStockThreshold).toBeNull();
    expect(updated.barcode).toBeNull();
    expect(updated.stock[0].expiresOn).toBeNull();
  });

  test('invalid v5 input rejects before any write and leaves no rows', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    for (const input of [
      {
        name: 'x',
        stock: [{ locationId: loc, quantity: 1 }],
        lowStockThreshold: -1,
      },
      {
        name: 'x',
        stock: [{ locationId: loc, quantity: 1 }],
        lowStockThreshold: 1000000,
      },
      { name: 'x', stock: [{ locationId: loc, quantity: 1 }], barcode: 'ab' },
      {
        name: 'x',
        stock: [{ locationId: loc, quantity: 1, expiresOn: 'soon' }],
      },
    ] as NewItemInput[]) {
      await expect(createItem(f.db, input)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(f.items.size).toBe(0);
    expect(f.stock).toEqual([]);
  });

  test('v5 PRESERVE: stock-set replacement still batches one INSERT per chunk', async () => {
    const f = makeFakeDb();
    const locA = f.seedLocation('Pantry');
    const locB = f.seedLocation('Garage');
    const created = await seedItem(f, locA);
    f.txnCalls.length = 0;
    await updateItem(f.db, created.id, {
      name: 'Rice',
      stock: [
        { locationId: locA, quantity: 1, expiresOn: null },
        { locationId: locB, quantity: 2, expiresOn: '2027-12-31' },
      ],
    });
    const inserts = f.txnCalls.filter((call) =>
      /INSERT INTO stock/i.test(call.source),
    );
    expect(inserts).toHaveLength(1);
    // Four bound values per row: item, location, quantity, expiry.
    expect(inserts[0].params).toHaveLength(8);
  });
});
