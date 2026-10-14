/**
 * U6 transfer boundary regression (mocked native boundary).
 *
 * Pins the verification boundary: every refusal case rejects with its
 * typed `TransferError` AND never opens a write (the exclusive-transaction
 * hook is never called, no statement runs, counts are unchanged) —
 * malformed envelope, unsupported version, unknown location, zero
 * quantity, duplicate barcode in one file. Also pins the expiry
 * normalization contract: a blank or space-padded `expiresOn` is
 * normalized (blank to null, padding trimmed) before anything reaches
 * SQL, so the v5 `GLOB` CHECK never sees it; a misshapen value refuses
 * as typed `validation`, never `storage`.
 *
 * Runs against an in-memory fake whose `stock` INSERT enforces the real
 * v5 shape (`expires_on IS NULL OR GLOB 'YYYY-MM-DD'`), quantity
 * positivity, foreign keys, and name/barcode uniqueness — no native
 * module, no `.db` file.
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

/** In-memory fake enforcing the v5 write contract (CHECK/GLOB/FK/UNIQUE). */
function makeBoundaryDb() {
  const locations = new Map<number, LocRow>();
  const categories = new Map<number, CatRow>();
  const items = new Map<number, ItemRow>();
  const stock: StockRow[] = [];
  const joins = new Set<string>();
  let nextId = 1;

  const uniqueError = (table: string) =>
    new Error(
      `SQLite error: UNIQUE constraint failed: ${table} (code 2067 SQLITE_CONSTRAINT_UNIQUE)`,
    );
  const fkError = () =>
    new Error(
      'SQLite error: FOREIGN KEY constraint failed (code 787 SQLITE_CONSTRAINT_FOREIGNKEY)',
    );
  const checkError = (what: string) =>
    new Error(`SQLite error: CHECK constraint failed: ${what}`);

  // Mirrors the v5 migration CHECK: NULL or exactly YYYY-MM-DD digits.
  const storedExpiryOk = (value: string | null): boolean =>
    value === null || /^\d{4}-\d{2}-\d{2}$/.test(value);

  const runImpl = async (
    source: string,
    params: unknown[] = [],
  ): Promise<{ lastInsertRowId: number; changes: number }> => {
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
      items.set(id, { id, name, low_stock_threshold: threshold, barcode });
      return { lastInsertRowId: id, changes: 1 };
    }
    if (/INSERT INTO stock/i.test(source)) {
      const [itemId, locationId, quantity, expiresOn] = params as [
        number,
        number,
        number,
        string | null,
      ];
      if (!items.has(itemId) || !locations.has(locationId)) throw fkError();
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw checkError('stock.quantity > 0');
      }
      if (!storedExpiryOk(expiresOn)) {
        throw checkError('stock.expires_on GLOB YYYY-MM-DD');
      }
      stock.push({ itemId, locationId, quantity, expiresOn });
      return { lastInsertRowId: 0, changes: 1 };
    }
    if (/INSERT INTO item_categories/i.test(source)) {
      const [itemId, categoryId] = params as [number, number];
      if (!items.has(itemId) || !categories.has(categoryId)) throw fkError();
      joins.add(`${itemId}:${categoryId}`);
      return { lastInsertRowId: 0, changes: 1 };
    }
    throw new Error(`fake: unhandled write ${source}`);
  };

  const getAllImpl = async (source: string, params: unknown[] = []) => {
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
    getFirstAsync: jest.fn(async (source: string) => {
      throw new Error(`fake: unexpected txn read ${source}`);
    }) as TransactionHandle['getFirstAsync'],
    getAllAsync: jest.fn(async (source: string, params = []) =>
      getAllImpl(source, params),
    ) as TransactionHandle['getAllAsync'],
  };

  const hook = jest.fn(
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

  const db: RepositoryDb = {
    runAsync: jest.fn(async (source: string, params = []) =>
      runImpl(source, params),
    ),
    getFirstAsync: jest.fn(async (source: string) => {
      throw new Error(`fake: unexpected read ${source}`);
    }) as RepositoryDb['getFirstAsync'],
    getAllAsync: jest.fn(async (source: string, params = []) =>
      getAllImpl(source, params),
    ) as RepositoryDb['getAllAsync'],
    withExclusiveTransactionAsync: hook,
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
  const seedItem = (name: string) => {
    const id = nextId++;
    items.set(id, {
      id,
      name,
      low_stock_threshold: null,
      barcode: null,
    });
    return id;
  };
  const seedStock = (itemId: number, locationId: number, quantity: number) => {
    stock.push({ itemId, locationId, quantity, expiresOn: null });
  };
  const counts = async () => {
    const details = await listItems(db);
    return {
      items: details.length,
      locations: (await listLocations(db)).length,
      categories: (await listCategories(db)).length,
      stockRows: details.reduce((sum, item) => sum + item.stock.length, 0),
    };
  };
  return { db, hook, seedLocation, seedCategory, seedItem, seedStock, counts };
}

function baseDoc(): TransferDocument {
  return {
    format: 'tengo-inventory',
    version: TRANSFER_FORMAT_VERSION,
    exportedAt: '2026-10-14T00:00:00.000Z',
    locations: [{ name: 'Pantry', address: null }],
    categories: [{ name: 'Bulk' }],
    items: [
      {
        name: 'Rice',
        barcode: null,
        lowStockThreshold: null,
        categories: ['Bulk'],
        stock: [{ location: 'Pantry', quantity: 2, expiresOn: null }],
      },
    ],
  };
}

/** A database holding something else, so "untouched" is observable. */
async function seedOther(fake: ReturnType<typeof makeBoundaryDb>) {
  const cellar = fake.seedLocation('Cellar');
  fake.seedCategory('Seeds');
  const beans = fake.seedItem('Beans');
  fake.seedStock(beans, cellar, 4);
}

async function expectUntouched(
  fake: ReturnType<typeof makeBoundaryDb>,
  before: {
    items: number;
    locations: number;
    categories: number;
    stockRows: number;
  },
): Promise<void> {
  expect(fake.hook).not.toHaveBeenCalled();
  expect(fake.db.runAsync).not.toHaveBeenCalled();
  expect(await fake.counts()).toEqual(before);
}

test('a malformed envelope refuses without opening a write', async () => {
  const fake = makeBoundaryDb();
  await seedOther(fake);
  const before = await fake.counts();
  const failure = await applyTransferDocument(fake.db, {
    format: 'not-tengo',
  } as unknown as TransferDocument).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(TransferError);
  expect((failure as TransferError).code).toBe('malformed');
  await expectUntouched(fake, before);
});

test('an unsupported version refuses without opening a write', async () => {
  const fake = makeBoundaryDb();
  await seedOther(fake);
  const before = await fake.counts();
  const failure = await applyTransferDocument(fake.db, {
    ...baseDoc(),
    version: TRANSFER_FORMAT_VERSION + 1,
  } as unknown as TransferDocument).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(TransferError);
  expect((failure as TransferError).code).toBe('version-mismatch');
  await expectUntouched(fake, before);
});

test('an unknown location refuses without opening a write', async () => {
  const fake = makeBoundaryDb();
  await seedOther(fake);
  const before = await fake.counts();
  const doc = baseDoc();
  doc.items[0].stock = [{ location: 'Attic', quantity: 1, expiresOn: null }];
  const failure = await applyTransferDocument(fake.db, doc).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(TransferError);
  expect((failure as TransferError).code).toBe('validation');
  await expectUntouched(fake, before);
});

test('a zero quantity refuses without opening a write', async () => {
  const fake = makeBoundaryDb();
  await seedOther(fake);
  const before = await fake.counts();
  const doc = baseDoc();
  doc.items[0].stock = [{ location: 'Pantry', quantity: 0, expiresOn: null }];
  const failure = await applyTransferDocument(fake.db, doc).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(TransferError);
  expect((failure as TransferError).code).toBe('validation');
  await expectUntouched(fake, before);
});

test('a duplicate barcode in one file refuses without opening a write', async () => {
  const fake = makeBoundaryDb();
  await seedOther(fake);
  const before = await fake.counts();
  const doc = baseDoc();
  doc.items = [
    {
      name: 'Rice',
      barcode: 'RICE-1',
      lowStockThreshold: null,
      categories: [],
      stock: [],
    },
    {
      name: 'Rice copy',
      barcode: 'RICE-1',
      lowStockThreshold: null,
      categories: [],
      stock: [],
    },
  ];
  const failure = await applyTransferDocument(fake.db, doc).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(TransferError);
  expect((failure as TransferError).code).toBe('conflict');
  await expectUntouched(fake, before);
});

test('a blank expiry is normalized to null before SQL, not rejected', async () => {
  const fake = makeBoundaryDb();
  const doc = baseDoc();
  doc.items[0].stock = [{ location: 'Pantry', quantity: 2, expiresOn: '' }];
  const summary = await applyTransferDocument(fake.db, doc);
  expect(summary.stockRows).toBe(1);
  const stored = await buildTransferDocument(fake.db);
  expect(stored.items).toHaveLength(1);
  expect(stored.items[0].stock).toEqual([
    { location: 'Pantry', quantity: 2, expiresOn: null },
  ]);
});

test('a space-padded expiry is trimmed before SQL, not rejected', async () => {
  const fake = makeBoundaryDb();
  const doc = baseDoc();
  doc.items[0].stock = [
    { location: 'Pantry', quantity: 2, expiresOn: ' 2031-05-06 ' },
  ];
  const summary = await applyTransferDocument(fake.db, doc);
  expect(summary.stockRows).toBe(1);
  const stored = await buildTransferDocument(fake.db);
  expect(stored.items).toHaveLength(1);
  expect(stored.items[0].stock).toEqual([
    { location: 'Pantry', quantity: 2, expiresOn: '2031-05-06' },
  ]);
});

test('a misshapen expiry refuses as validation without opening a write', async () => {
  const fake = makeBoundaryDb();
  await seedOther(fake);
  const before = await fake.counts();
  const doc = baseDoc();
  doc.items[0].stock = [
    { location: 'Pantry', quantity: 2, expiresOn: 'yesterday' },
  ];
  const failure = await applyTransferDocument(fake.db, doc).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(TransferError);
  expect((failure as TransferError).code).toBe('validation');
  await expectUntouched(fake, before);
});
