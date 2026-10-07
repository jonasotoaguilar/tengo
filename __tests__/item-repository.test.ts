/**
 * M2 item persistence (mocked native boundary).
 *
 * Runs against an in-memory fake `RepositoryDb` with snapshot/rollback
 * exclusive transactions — no native module, no `.db` file. Proves
 * parameterized item CRUD, the location-plus-categories read model, M1
 * validation, typed errors (`validation`/`not-found`/`storage` with the
 * `item` kind, never raw SQLite text), atomic category-set replacement,
 * atomic draft saves (new location/categories with the item, no orphans
 * on failure), fail-closed behavior without the exclusive hook, and that
 * every in-transaction query runs on the scoped handle. Real driver
 * behavior is P2b native proof (isolated test DBs).
 */

import type {
  RepositoryDb,
  TransactionHandle,
} from '../src/inventory/database';
import { EntityNotFoundError, StorageError } from '../src/inventory/errors';
import {
  createItem,
  createItemFromDraft,
  deleteItem,
  getItem,
  listItems,
  updateItem,
  updateItemFromDraft,
} from '../src/inventory/itemRepository';
import type { ItemDraftInput } from '../src/inventory/types';
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
  quantity: number;
  location_id: number;
  created_at: string;
}

/** In-memory fake with FK enforcement, join cascade, and rollback. */
function makeFakeDb(options: { exclusive?: boolean } = {}) {
  const outerCalls: { source: string; params: unknown[] }[] = [];
  const txnCalls: { source: string; params: unknown[] }[] = [];
  const locations = new Map<number, LocRow>();
  const categories = new Map<number, CatRow>();
  const items = new Map<number, ItemRow>();
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

  const runImpl = async (
    source: string,
    params: unknown[] = [],
  ): Promise<{ lastInsertRowId: number; changes: number }> => {
    maybeFail(source);
    if (/INSERT INTO locations/i.test(source)) {
      const [name, address] = params as [string, string | null];
      const id = nextId++;
      locations.set(id, { id, name, address, created_at: `ts-${id}` });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/INSERT INTO categories/i.test(source)) {
      const [name] = params as [string];
      const id = nextId++;
      categories.set(id, { id, name, created_at: `ts-${id}` });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/INSERT INTO items/i.test(source)) {
      const [name, quantity, locationId] = params as [string, number, number];
      if (!locations.has(locationId)) throw fkError();
      const id = nextId++;
      items.set(id, {
        id,
        name,
        quantity,
        location_id: locationId,
        created_at: `ts-${id}`,
      });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/INSERT INTO item_categories/i.test(source)) {
      const [itemId, categoryId] = params as [number, number];
      if (!items.has(itemId) || !categories.has(categoryId)) throw fkError();
      joins.add(`${itemId}:${categoryId}`);
      return { lastInsertRowId: 0, changes: 1 };
    }
    if (/UPDATE items/i.test(source)) {
      const [name, quantity, locationId, id] = params as [
        string,
        number,
        number,
        number,
      ];
      const row = items.get(id);
      if (!row) return { lastInsertRowId: 0, changes: 0 };
      if (!locations.has(locationId)) throw fkError();
      items.set(id, { ...row, name, quantity, location_id: locationId });
      return { lastInsertRowId: id, changes: 1 };
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
  catIds: number[] = [],
  name = 'Rice',
) {
  return createItem(f.db, {
    name,
    quantity: 2,
    locationId: locId,
    categoryIds: catIds,
  });
}

describe('item CRUD read model', () => {
  test('create/get/list round-trip with location entity, categories, zero qty', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation('Pantry', 'Aisle 1');
    const catA = f.seedCategory('Bulk');
    const catB = f.seedCategory('lácteos ñ');
    const created = await createItem(f.db, {
      name: '  Rice — integral  ',
      quantity: 0,
      locationId: loc,
      categoryIds: [catA, catB],
    });
    expect(created).toMatchObject({
      name: 'Rice — integral',
      quantity: 0,
      locationId: loc,
      categoryIds: [catA, catB],
    });
    expect(created.location).toMatchObject({ id: loc, name: 'Pantry' });
    expect(created.categories.map((c) => c.name)).toEqual([
      'Bulk',
      'lácteos ñ',
    ]);
    expect(await getItem(f.db, created.id)).toEqual(created);
    expect(await listItems(f.db)).toEqual([created]);

    const bare = await createItem(f.db, {
      name: 'Salt',
      quantity: 1,
      locationId: loc,
    });
    expect(bare.categoryIds).toEqual([]);
    expect(bare.categories).toEqual([]);
    expect((await listItems(f.db)).map((i) => i.id)).toEqual([
      created.id,
      bare.id,
    ]);
  });

  test('invalid inputs throw validation before touching the database', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const callsBefore = f.outerCalls.length + f.txnCalls.length;
    await expect(
      createItem(f.db, { name: '   ', quantity: 1, locationId: loc }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createItem(f.db, { name: 'x', quantity: -1, locationId: loc }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createItem(f.db, { name: 'x', quantity: 1.5, locationId: loc }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createItem(f.db, {
        name: 'x',
        quantity: 1,
        locationId: loc,
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
      updateItem(f.db, 99, { name: 'x', quantity: 1, locationId: loc }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(deleteItem(f.db, 99)).rejects.toMatchObject({
      code: 'not-found',
    });
    const missingLoc = (await createItem(f.db, {
      name: 'x',
      quantity: 1,
      locationId: 999,
    }).catch((e: unknown) => e)) as Error;
    expect(missingLoc).toBeInstanceOf(EntityNotFoundError);
    expect(missingLoc).toMatchObject({ entity: 'location', id: 999 });
    const missingCat = (await createItem(f.db, {
      name: 'x',
      quantity: 1,
      locationId: loc,
      categoryIds: [888],
    }).catch((e: unknown) => e)) as Error;
    expect(missingCat).toBeInstanceOf(EntityNotFoundError);
    expect(missingCat).toMatchObject({ entity: 'category', id: 888 });
    // No partial rows from the rejected creates.
    expect(f.items.size).toBe(0);

    f.failNextWith(new Error('disk I/O error on sqlite3_step'));
    const failure = (await listItems(f.db).catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({ code: 'storage', entity: 'item' });
    expect(failure.message).not.toContain('disk I/O');
  });

  test('update replaces fields and category set atomically, keeps created_at', async () => {
    const f = makeFakeDb();
    const locA = f.seedLocation('Pantry');
    const locB = f.seedLocation('Fridge');
    const catA = f.seedCategory('Bulk');
    const catB = f.seedCategory('Cold');
    const catC = f.seedCategory('Fresh');
    const created = await seedItem(f, locA, [catA]);
    const updated = await updateItem(f.db, created.id, {
      name: 'Brown rice',
      quantity: 0,
      locationId: locB,
      categoryIds: [catB, catC],
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'Brown rice',
      quantity: 0,
      locationId: locB,
      categoryIds: [catB, catC],
      created_at: created.created_at,
    });
    expect(updated.location).toMatchObject({ id: locB, name: 'Fridge' });
    expect(await getItem(f.db, created.id)).toEqual(updated);

    const cleared = await updateItem(f.db, created.id, {
      name: 'Brown rice',
      quantity: 3,
      locationId: locB,
      categoryIds: [],
    });
    expect(cleared.categoryIds).toEqual([]);
    expect(f.joins.size).toBe(0);
  });

  test('delete removes the item and its joins but keeps entities', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const cat = f.seedCategory();
    const created = await seedItem(f, loc, [cat]);
    await deleteItem(f.db, created.id);
    await expect(getItem(f.db, created.id)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    expect(await listItems(f.db)).toEqual([]);
    expect(f.locations.has(loc)).toBe(true);
    expect(f.categories.has(cat)).toBe(true);
    expect(f.joins.size).toBe(0);
  });

  test('injection-shaped text is bound, never interpolated', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const evil = "x'); DROP TABLE items; --";
    const created = await createItem(f.db, {
      name: evil,
      quantity: 1,
      locationId: loc,
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
  test('draft create with new location plus existing/new categories', async () => {
    const f = makeFakeDb();
    const existingCat = f.seedCategory('Bulk');
    const draft: ItemDraftInput = {
      name: 'Oats',
      quantity: 4,
      location: { kind: 'new', location: { name: '  Cellar  ', address: ' ' } },
      categories: [
        { kind: 'existing', categoryId: existingCat },
        { kind: 'new', category: { name: 'Desayuno' } },
      ],
    };
    const created = await createItemFromDraft(f.db, draft);
    expect(created.name).toBe('Oats');
    expect(created.location).toMatchObject({ name: 'Cellar', address: null });
    expect(created.categoryIds).toHaveLength(2);
    expect(created.categories.map((c) => c.name).sort()).toEqual([
      'Bulk',
      'Desayuno',
    ]);
    expect(await getItem(f.db, created.id)).toEqual(created);

    const plain = await createItemFromDraft(f.db, {
      name: 'Salt',
      quantity: 0,
      location: { kind: 'existing', locationId: created.locationId },
    });
    expect(plain.categoryIds).toEqual([]);
    expect(plain.locationId).toBe(created.locationId);
  });

  test('draft update creates new related rows atomically, keeps created_at', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const created = await seedItem(f, loc);
    const updated = await updateItemFromDraft(f.db, created.id, {
      name: 'Rice+',
      quantity: 9,
      location: { kind: 'new', location: { name: 'Attic' } },
      categories: [{ kind: 'new', category: { name: 'Reserva' } }],
    });
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.location).toMatchObject({ name: 'Attic' });
    expect(updated.categories.map((c) => c.name)).toEqual(['Reserva']);
    await expect(
      updateItemFromDraft(f.db, 999, {
        name: 'x',
        quantity: 1,
        location: { kind: 'existing', locationId: loc },
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  test('invalid drafts fail validation with no writes and no transaction', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const cat = f.seedCategory();
    const bad: ItemDraftInput[] = [
      { name: 'x', quantity: 1, location: null as never },
      {
        name: 'x',
        quantity: 1,
        location: { kind: 'bogus', locationId: loc } as never,
      },
      {
        name: 'x',
        quantity: 1,
        location: { kind: 'existing', locationId: loc },
        categories: [
          { kind: 'existing', categoryId: cat },
          { kind: 'existing', categoryId: cat },
        ],
      },
      {
        name: 'x',
        quantity: 1,
        location: { kind: 'new', location: { name: '   ' } },
      },
    ];
    for (const draft of bad) {
      await expect(createItemFromDraft(f.db, draft)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(f.db.withExclusiveTransactionAsync).not.toHaveBeenCalled();
    expect(f.items.size).toBe(0);
    expect(f.locations.size).toBe(1);
    expect(f.categories.size).toBe(1);
  });

  test('missing draft references and late failures leave no orphans', async () => {
    const f = makeFakeDb();
    const cat = f.seedCategory();
    const missing = (await createItemFromDraft(f.db, {
      name: 'Ghost',
      quantity: 1,
      location: { kind: 'new', location: { name: 'Nowhere' } },
      categories: [{ kind: 'existing', categoryId: 4242 }],
    }).catch((e: unknown) => e)) as Error;
    expect(missing).toBeInstanceOf(EntityNotFoundError);
    expect(missing).toMatchObject({ entity: 'category', id: 4242 });
    // The new location rolled back with the failed item.
    expect(f.locations.size).toBe(0);
    expect(f.items.size).toBe(0);

    // Late failure at the join insert: new location + new category roll back.
    f.failMatchingWith(
      /INSERT INTO item_categories/i,
      new Error('disk I/O error on sqlite3_step'),
    );
    const late = (await createItemFromDraft(f.db, {
      name: 'Late',
      quantity: 1,
      location: { kind: 'new', location: { name: 'Cellar' } },
      categories: [{ kind: 'existing', categoryId: cat }],
    }).catch((e: unknown) => e)) as Error;
    expect(late).toBeInstanceOf(StorageError);
    expect(late.message).not.toContain('disk I/O');
    expect(f.items.size).toBe(0);
    expect(f.locations.size).toBe(0);
    expect(f.categories.size).toBe(1);
  });
});

describe('transaction boundary', () => {
  test('mutations run on the scoped handle, never the outer db', async () => {
    const f = makeFakeDb();
    const loc = f.seedLocation();
    const cat = f.seedCategory();
    await seedItem(f, loc, [cat]);
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
      quantity: 1,
      location: { kind: 'existing', locationId: loc },
    };
    for (const op of [
      () => createItem(f.db, { name: 'x', quantity: 1, locationId: loc }),
      () => updateItem(f.db, 1, { name: 'x', quantity: 1, locationId: loc }),
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
      createItem(f.db, { name: '   ', quantity: 1, locationId: loc }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
