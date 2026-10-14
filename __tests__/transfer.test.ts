/**
 * U6 export/import round trip (mocked native boundary).
 *
 * Runs the versioned transfer document (`src/inventory/transfer.ts`)
 * against an in-memory fake `RepositoryDb` with snapshot/rollback
 * exclusive transactions — no native module, no `.db` file. Proves the
 * export covers locations, categories, items and their per-location
 * stock rows including the schema-v5 fields (barcode, low-stock
 * threshold, per-row expiry); the export → serialize → parse → apply
 * round trip preserves every value; a version mismatch and malformed
 * input are refused with typed errors; and a refused import leaves
 * item/location/category counts unchanged (atomic: validated before any
 * write, applied in a single transaction, rolled back on a mid-write
 * driver failure). Error messages never leak raw driver text.
 */
import type {
  RepositoryDb,
  TransactionHandle,
} from '../src/inventory/database';
import {
  listCategories,
  listLocations,
} from '../src/inventory/entityRepository';
import { listItems } from '../src/inventory/itemRepository';
import {
  applyTransferDocument,
  buildTransferDocument,
  parseTransferDocument,
  serializeTransferDocument,
  TRANSFER_FORMAT_VERSION,
  type TransferDocument,
  TransferError,
} from '../src/inventory/transfer';

interface LocRow {
  id: number;
  name: string;
  address: string | null;
}
interface CatRow {
  id: number;
  name: string;
}
interface ItemRow {
  id: number;
  name: string;
  low_stock_threshold: number | null;
  barcode: string | null;
}
interface StockRow {
  itemId: number;
  locationId: number;
  quantity: number;
  expiresOn: string | null;
}

/** In-memory fake: catalog + stock shape with rollback transactions. */
function makeFakeDb() {
  const locations = new Map<number, LocRow>();
  const categories = new Map<number, CatRow>();
  const items = new Map<number, ItemRow>();
  const stock: StockRow[] = [];
  const joins = new Set<string>();
  let nextId = 1;
  let failNext: { pattern: RegExp; error: unknown } | null = null;

  const failOnNext = (pattern: RegExp, error: unknown) => {
    failNext = { pattern, error };
  };
  const maybeFail = (source: string) => {
    if (failNext?.pattern.test(source)) {
      const { error } = failNext;
      failNext = null;
      throw error;
    }
  };
  const uniqueError = (table: string) =>
    new Error(
      `SQLite error: UNIQUE constraint failed: ${table}.name (code 2067 SQLITE_CONSTRAINT_UNIQUE)`,
    );

  const runImpl = async (
    source: string,
    params: unknown[] = [],
  ): Promise<{ lastInsertRowId: number; changes: number }> => {
    maybeFail(source);
    if (/DELETE FROM item_categories/i.test(source)) {
      const count = joins.size;
      joins.clear();
      return { lastInsertRowId: 0, changes: count };
    }
    if (/DELETE FROM stock/i.test(source)) {
      const count = stock.length;
      stock.length = 0;
      return { lastInsertRowId: 0, changes: count };
    }
    if (/DELETE FROM items/i.test(source)) {
      const count = items.size;
      items.clear();
      return { lastInsertRowId: 0, changes: count };
    }
    if (/DELETE FROM locations/i.test(source)) {
      const count = locations.size;
      locations.clear();
      return { lastInsertRowId: 0, changes: count };
    }
    if (/DELETE FROM categories/i.test(source)) {
      const count = categories.size;
      categories.clear();
      return { lastInsertRowId: 0, changes: count };
    }
    if (/INSERT INTO locations/i.test(source)) {
      const [name, address] = params as [string, string | null];
      for (const row of locations.values()) {
        if (row.name.trim().toLowerCase() === name.trim().toLowerCase()) {
          throw uniqueError('locations');
        }
      }
      const id = nextId++;
      locations.set(id, { id, name, address });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/INSERT INTO categories/i.test(source)) {
      const [name] = params as [string];
      for (const row of categories.values()) {
        if (row.name.trim().toLowerCase() === name.trim().toLowerCase()) {
          throw uniqueError('categories');
        }
      }
      const id = nextId++;
      categories.set(id, { id, name });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/INSERT INTO items/i.test(source)) {
      const [name, threshold, barcode] = params as [
        string,
        number | null,
        string | null,
      ];
      if (barcode !== null) {
        for (const row of items.values()) {
          if (row.barcode === barcode) throw uniqueError('items');
        }
      }
      const id = nextId++;
      items.set(id, {
        id,
        name,
        low_stock_threshold: threshold,
        barcode,
      });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/INSERT INTO stock/i.test(source)) {
      const [itemId, locationId, quantity, expiresOn] = params as [
        number,
        number,
        number,
        string | null,
      ];
      if (!items.has(itemId) || !locations.has(locationId)) {
        throw new Error('SQLite error: FOREIGN KEY constraint failed (787)');
      }
      if (!(Number.isInteger(quantity) && quantity > 0)) {
        throw new Error('CHECK constraint failed: quantity > 0');
      }
      stock.push({ itemId, locationId, quantity, expiresOn });
      return { lastInsertRowId: 0, changes: 1 };
    }
    if (/INSERT INTO item_categories/i.test(source)) {
      const [itemId, categoryId] = params as [number, number];
      if (!items.has(itemId) || !categories.has(categoryId)) {
        throw new Error('SQLite error: FOREIGN KEY constraint failed (787)');
      }
      joins.add(`${itemId}:${categoryId}`);
      return { lastInsertRowId: 0, changes: 1 };
    }
    throw new Error(`fake: unhandled write ${source}`);
  };

  const getFirstImpl = async (source: string, params: unknown[] = []) => {
    maybeFail(source);
    throw new Error(`fake: unhandled read ${source} ${JSON.stringify(params)}`);
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
            location_created_at: `ts-${loc.id}`,
            expires_on: s.expiresOn,
          };
        });
    }
    if (/JOIN item_categories/i.test(source)) {
      const itemId = params[0] as number;
      return [...joins]
        .filter((key) => key.startsWith(`${itemId}:`))
        .map((key) => {
          const row = categories.get(Number(key.split(':')[1]));
          if (!row) throw new Error('fake: dangling category link');
          return { ...row, created_at: `ts-${row.id}` };
        })
        .sort((a, b) => a.id - b.id);
    }
    if (/FROM items/i.test(source)) {
      return [...items.values()]
        .sort((a, b) => a.id - b.id)
        .map((row) => ({ ...row, created_at: `ts-${row.id}` }));
    }
    if (/FROM locations/i.test(source)) {
      return [...locations.values()]
        .sort((a, b) => a.id - b.id)
        .map((row) => ({ ...row, created_at: `ts-${row.id}` }));
    }
    if (/FROM categories/i.test(source)) {
      return [...categories.values()]
        .sort((a, b) => a.id - b.id)
        .map((row) => ({ ...row, created_at: `ts-${row.id}` }));
    }
    throw new Error(`fake: unhandled scan ${source}`);
  };

  const txn: TransactionHandle = {
    runAsync: jest.fn(async (source: string, params = []) =>
      runImpl(source, params),
    ),
    getFirstAsync: jest.fn(async (source: string, params = []) =>
      getFirstImpl(source, params),
    ) as TransactionHandle['getFirstAsync'],
    getAllAsync: jest.fn(async (source: string, params = []) =>
      getAllImpl(source, params),
    ) as TransactionHandle['getAllAsync'],
  };

  const db: RepositoryDb = {
    runAsync: jest.fn(async (source: string, params = []) =>
      runImpl(source, params),
    ),
    getFirstAsync: jest.fn(async (source: string, params = []) =>
      getFirstImpl(source, params),
    ) as RepositoryDb['getFirstAsync'],
    getAllAsync: jest.fn(async (source: string, params = []) =>
      getAllImpl(source, params),
    ) as RepositoryDb['getAllAsync'],
    withExclusiveTransactionAsync: jest.fn(
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
    ),
  };

  const seedLocation = (name: string, address: string | null = null) => {
    const id = nextId++;
    locations.set(id, { id, name, address });
    return id;
  };
  const seedCategory = (name: string) => {
    const id = nextId++;
    categories.set(id, { id, name });
    return id;
  };
  const seedItem = (
    name: string,
    options: {
      barcode?: string | null;
      lowStockThreshold?: number | null;
    } = {},
  ) => {
    const id = nextId++;
    items.set(id, {
      id,
      name,
      low_stock_threshold: options.lowStockThreshold ?? null,
      barcode: options.barcode ?? null,
    });
    return id;
  };
  const seedStock = (
    itemId: number,
    locationId: number,
    quantity: number,
    expiresOn: string | null = null,
  ) => {
    stock.push({ itemId, locationId, quantity, expiresOn });
  };
  const seedLink = (itemId: number, categoryId: number) => {
    joins.add(`${itemId}:${categoryId}`);
  };
  const counts = async () => ({
    items: (await listItems(db)).length,
    locations: (await listLocations(db)).length,
    categories: (await listCategories(db)).length,
  });
  return {
    db,
    txn,
    seedLocation,
    seedCategory,
    seedItem,
    seedStock,
    seedLink,
    counts,
    failOnNext,
  };
}

/** A populated source database: every transfer field carries a value. */
function seedFullSource(fake: ReturnType<typeof makeFakeDb>) {
  const pantry = fake.seedLocation('Pantry', 'Main Street 12');
  const fridge = fake.seedLocation('Fridge');
  const bulk = fake.seedCategory('Bulk');
  const grains = fake.seedCategory('Grains');
  const rice = fake.seedItem('Rice', {
    barcode: 'RICE-0001',
    lowStockThreshold: 2,
  });
  fake.seedStock(rice, pantry, 3, '2027-05-01');
  fake.seedStock(rice, fridge, 1);
  fake.seedLink(rice, bulk);
  fake.seedLink(rice, grains);
  // Catalog-only item: no stock anywhere, no barcode, no reminder.
  fake.seedItem('Lentils');
}

test('export is a versioned, self-describing document covering the whole inventory', async () => {
  const fake = makeFakeDb();
  seedFullSource(fake);
  const doc = await buildTransferDocument(fake.db);
  expect(doc.format).toBe('tengo-inventory');
  expect(doc.version).toBe(TRANSFER_FORMAT_VERSION);
  expect(typeof doc.exportedAt).toBe('string');
  expect(doc.locations).toEqual([
    { name: 'Pantry', address: 'Main Street 12' },
    { name: 'Fridge', address: null },
  ]);
  expect(doc.categories).toEqual([{ name: 'Bulk' }, { name: 'Grains' }]);
  expect(doc.items).toHaveLength(2);
  const [rice, lentils] = doc.items;
  expect(rice).toEqual({
    name: 'Rice',
    barcode: 'RICE-0001',
    lowStockThreshold: 2,
    categories: ['Bulk', 'Grains'],
    stock: [
      { location: 'Pantry', quantity: 3, expiresOn: '2027-05-01' },
      { location: 'Fridge', quantity: 1, expiresOn: null },
    ],
  });
  expect(lentils).toEqual({
    name: 'Lentils',
    barcode: null,
    lowStockThreshold: null,
    categories: [],
    stock: [],
  });
  // The serialized file carries the explicit format version.
  const text = serializeTransferDocument(doc);
  expect(text).toContain('"version": 1');
  expect(text).toContain('"format": "tengo-inventory"');
});

test('round trip: export → serialize → parse → apply preserves every value', async () => {
  const source = makeFakeDb();
  seedFullSource(source);
  const text = serializeTransferDocument(
    await buildTransferDocument(source.db),
  );

  const target = makeFakeDb();
  const parsed = parseTransferDocument(text);
  const summary = await applyTransferDocument(target.db, parsed);
  expect(summary).toEqual({
    locations: 2,
    categories: 2,
    items: 2,
    stockRows: 2,
  });

  const roundTripped = serializeTransferDocument(
    await buildTransferDocument(target.db),
  );
  // Same content modulo the export timestamp.
  const stripTimestamp = (value: string) =>
    JSON.parse(value) as TransferDocument;
  const before = stripTimestamp(text);
  const after = stripTimestamp(roundTripped);
  expect({ ...after, exportedAt: before.exportedAt }).toEqual(before);
});

test('a version mismatch is refused with a typed error and applies nothing', async () => {
  const fake = makeFakeDb();
  seedFullSource(fake);
  const before = await fake.counts();
  const doc = await buildTransferDocument(fake.db);
  const future = serializeTransferDocument({
    ...doc,
    version: TRANSFER_FORMAT_VERSION + 1,
  } as unknown as TransferDocument);
  const failure = await Promise.resolve()
    .then(() => parseTransferDocument(future))
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(TransferError);
  expect((failure as TransferError).code).toBe('version-mismatch');
  // A parsed-then-tampered document is refused at apply time too.
  const tampered = {
    ...doc,
    version: TRANSFER_FORMAT_VERSION + 1,
  } as unknown as TransferDocument;
  await expect(applyTransferDocument(fake.db, tampered)).rejects.toMatchObject({
    code: 'version-mismatch',
  });
  expect(await fake.counts()).toEqual(before);
});

test('malformed input is refused with a typed error and applies nothing', async () => {
  const fake = makeFakeDb();
  seedFullSource(fake);
  const before = await fake.counts();
  for (const text of [
    'not json at all',
    '{"format":"tengo-inventory"}',
    '[]',
    '{"format":"other","version":1,"exportedAt":"x","locations":[],"categories":[],"items":[]}',
    '{"format":"tengo-inventory","version":1,"exportedAt":"x","locations":{},"categories":[],"items":[]}',
  ]) {
    const failure = await Promise.resolve()
      .then(() => parseTransferDocument(text))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransferError);
    expect((failure as TransferError).code).toBe('malformed');
  }
  const nonString = await Promise.resolve()
    .then(() => parseTransferDocument(null))
    .catch((error: unknown) => error);
  expect(nonString).toBeInstanceOf(TransferError);
  expect((nonString as TransferError).code).toBe('malformed');
  expect(await fake.counts()).toEqual(before);
});

test('an import that fails validation leaves counts unchanged (no half-apply)', async () => {
  const fake = makeFakeDb();
  seedFullSource(fake);
  const before = await fake.counts();
  const doc = await buildTransferDocument(fake.db);

  // Unknown location reference: never fabricated.
  const danglingLocation: TransferDocument = {
    ...doc,
    items: [
      {
        name: 'Quinoa',
        barcode: null,
        lowStockThreshold: null,
        categories: [],
        stock: [{ location: 'Cellar', quantity: 1, expiresOn: null }],
      },
    ],
  };
  await expect(
    applyTransferDocument(fake.db, danglingLocation),
  ).rejects.toMatchObject({ code: 'validation' });

  // Unknown category reference: never fabricated.
  const danglingCategory: TransferDocument = {
    ...doc,
    items: [
      {
        name: 'Quinoa',
        barcode: null,
        lowStockThreshold: null,
        categories: ['Seeds'],
        stock: [{ location: 'Pantry', quantity: 1, expiresOn: null }],
      },
    ],
  };
  await expect(
    applyTransferDocument(fake.db, danglingCategory),
  ).rejects.toMatchObject({ code: 'validation' });

  // Out-of-range quantity and misshapen barcode/threshold/expiry.
  const badValues: TransferDocument = {
    ...doc,
    locations: [{ name: 'Pantry', address: null }],
    categories: [],
    items: [
      {
        name: 'Quinoa',
        barcode: '!!!',
        lowStockThreshold: -1,
        categories: [],
        stock: [
          { location: 'Pantry', quantity: 1000000, expiresOn: 'yesterday' },
        ],
      },
    ],
  };
  await expect(applyTransferDocument(fake.db, badValues)).rejects.toMatchObject(
    { code: 'validation' },
  );

  expect(await fake.counts()).toEqual(before);
});

test('a zero-quantity stock row is refused, never silently dropped', async () => {
  const fake = makeFakeDb();
  const before = await fake.counts();
  const doc: TransferDocument = {
    format: 'tengo-inventory',
    version: TRANSFER_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    locations: [{ name: 'Pantry', address: null }],
    categories: [],
    items: [
      {
        name: 'Rice',
        barcode: null,
        lowStockThreshold: null,
        categories: [],
        stock: [{ location: 'Pantry', quantity: 0, expiresOn: null }],
      },
    ],
  };
  // Shape-valid, so parsing accepts it; the refusal happens at apply.
  expect(() =>
    parseTransferDocument(serializeTransferDocument(doc)),
  ).not.toThrow();
  await expect(applyTransferDocument(fake.db, doc)).rejects.toMatchObject({
    code: 'validation',
  });
  expect(await fake.counts()).toEqual(before);
});

test('duplicate names or barcodes in the file conflict without touching the database', async () => {
  const fake = makeFakeDb();
  seedFullSource(fake);
  const before = await fake.counts();
  const doc = await buildTransferDocument(fake.db);

  const duplicateLocation: TransferDocument = {
    ...doc,
    locations: [
      { name: 'Pantry', address: null },
      { name: ' pantry ', address: null },
    ],
  };
  await expect(
    applyTransferDocument(fake.db, duplicateLocation),
  ).rejects.toMatchObject({ code: 'conflict' });

  const duplicateBarcode: TransferDocument = {
    ...doc,
    items: [
      {
        name: 'Rice',
        barcode: 'RICE-0001',
        lowStockThreshold: null,
        categories: [],
        stock: [],
      },
      {
        name: 'Rice copy',
        barcode: 'RICE-0001',
        lowStockThreshold: null,
        categories: [],
        stock: [],
      },
    ],
  };
  await expect(
    applyTransferDocument(fake.db, duplicateBarcode),
  ).rejects.toMatchObject({ code: 'conflict' });

  expect(await fake.counts()).toEqual(before);
});

test('a mid-write driver failure rolls back so counts are unchanged', async () => {
  const fake = makeFakeDb();
  seedFullSource(fake);
  const before = await fake.counts();
  const target = makeFakeDb();
  const text = serializeTransferDocument(await buildTransferDocument(fake.db));
  const parsed = parseTransferDocument(text);
  // Inject the failure on the TARGET database, not the source.
  target.failOnNext(/INSERT INTO items/i, new Error('disk I/O error'));
  const failure = await applyTransferDocument(target.db, parsed).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(TransferError);
  expect((failure as TransferError).code).toBe('storage');
  // The generic message never leaks the driver text.
  expect((failure as Error).message).not.toContain('disk I/O');
  expect(await target.counts()).toEqual({
    items: 0,
    locations: 0,
    categories: 0,
  });
  // The source database is untouched throughout.
  expect(await fake.counts()).toEqual(before);
});

test('apply fails closed with a typed error when no exclusive transaction exists', async () => {
  const fake = makeFakeDb();
  seedFullSource(fake);
  const before = await fake.counts();
  const parsed = parseTransferDocument(
    serializeTransferDocument(await buildTransferDocument(fake.db)),
  );
  const noTxn = { ...fake.db };
  delete (noTxn as { withExclusiveTransactionAsync?: unknown })
    .withExclusiveTransactionAsync;
  await expect(applyTransferDocument(noTxn, parsed)).rejects.toMatchObject({
    code: 'storage',
  });
  expect(await fake.counts()).toEqual(before);
});
