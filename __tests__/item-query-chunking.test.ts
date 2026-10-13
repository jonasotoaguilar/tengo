/**
 * IN-list chunking for the item query (host fake, not real SQLite proof).
 *
 * Past SQLite's variable limit the page-sized `IN (?,…)` reads fail
 * outright; below it the cost still scales with the catalog. The batched
 * link and stock reads are therefore chunked (`ITEM_QUERY_IN_CHUNK_SIZE`
 * ids per statement), concatenating the chunk results in page order with
 * no semantic change. The read count now grows with the chunk count:
 * 1 + ceil(pages/chunk) + ceil(survivors/chunk) instead of at most three.
 */
import type { RepositoryDb } from '../src/inventory/database';
import {
  ITEM_QUERY_IN_CHUNK_SIZE,
  queryItems,
} from '../src/inventory/itemQuery';

function makeChunkFake() {
  const calls: { source: string; params: unknown[] }[] = [];
  const locations = new Map<
    number,
    { id: number; name: string; address: string | null; created_at: string }
  >();
  const categories = new Map<
    number,
    { id: number; name: string; created_at: string }
  >();
  const items = new Map<
    number,
    { id: number; name: string; created_at: string }
  >();
  const stock: { itemId: number; locationId: number; quantity: number }[] = [];
  const joins = new Set<string>();
  let nextId = 1;
  const db: RepositoryDb = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    getAllAsync: jest.fn(async (source: string, params: unknown[] = []) => {
      calls.push({ source, params });
      if (/FROM items i/i.test(source)) {
        const memberMatch = /EXISTS[\s\S]*location_id = \?/i.test(source)
          ? (params[0] as number)
          : null;
        return [...items.values()]
          .filter((it) =>
            memberMatch === null
              ? true
              : stock.some(
                  (s) => s.itemId === it.id && s.locationId === memberMatch,
                ),
          )
          .sort((a, b) => a.id - b.id)
          .map((it) => ({
            item_id: it.id,
            item_name: it.name,
            item_created_at: it.created_at,
          }));
      }
      if (/FROM stock s/i.test(source)) {
        const onlyItems = /item_id IN/i.test(source)
          ? (params as number[])
          : null;
        return stock
          .filter((s) =>
            onlyItems === null ? true : onlyItems.includes(s.itemId),
          )
          .filter((s) => locations.has(s.locationId))
          .sort((a, b) => a.itemId - b.itemId || a.locationId - b.locationId)
          .map((s) => {
            const loc = locations.get(s.locationId) as {
              id: number;
              name: string;
              address: string | null;
              created_at: string;
            };
            return {
              stock_item_id: s.itemId,
              quantity: s.quantity,
              location_id: loc.id,
              location_name: loc.name,
              location_address: loc.address,
              location_created_at: loc.created_at,
            };
          });
      }
      if (/FROM item_categories/i.test(source)) {
        const onlyItems = /item_id IN/i.test(source)
          ? (params as number[])
          : null;
        return [...joins]
          .map((k) => k.split(':').map(Number) as [number, number])
          .filter(([, c]) => categories.has(c))
          .filter(([i]) => items.has(i))
          .filter(([i]) => (onlyItems === null ? true : onlyItems.includes(i)))
          .sort((a, b) => a[0] - b[0] || a[1] - b[1])
          .map(([i, c]) => {
            const catRow = categories.get(c);
            if (catRow === undefined) throw new Error('fake: missing category');
            return {
              link_item_id: i,
              category_id: c,
              category_name: catRow.name,
              category_created_at: catRow.created_at,
            };
          });
      }
      throw new Error(`fake: unhandled ${source}`);
    }) as RepositoryDb['getAllAsync'],
  };
  const loc = (name = 'Pantry', address: string | null = null) => {
    const id = nextId++;
    locations.set(id, { id, name, address, created_at: `ts-${id}` });
    return id;
  };
  const cat = (name = 'Bulk') => {
    const id = nextId++;
    categories.set(id, { id, name, created_at: `ts-${id}` });
    return id;
  };
  const item = (
    name: string,
    stockRows: { locationId: number; quantity: number }[] = [],
    catIds: number[] = [],
  ) => {
    const id = nextId++;
    items.set(id, { id, name, created_at: `ts-${id}` });
    for (const s of stockRows) {
      stock.push({
        itemId: id,
        locationId: s.locationId,
        quantity: s.quantity,
      });
    }
    for (const c of catIds) joins.add(`${id}:${c}`);
    return id;
  };
  return { db, calls, loc, cat, item };
}

test('oversized pages are chunked and every row still comes back', async () => {
  const f = makeChunkFake();
  const l = f.loc();
  const COUNT = ITEM_QUERY_IN_CHUNK_SIZE * 2 + 300;
  const ids: number[] = [];
  for (let n = 0; n < COUNT; n += 1) {
    ids.push(f.item(`item-${n}`, [{ locationId: l, quantity: 1 }], []));
  }
  const page = await queryItems(f.db);
  expect(page).toHaveLength(COUNT);
  expect(page.map((i) => i.id)).toEqual(ids);
  // No single statement may carry the whole page: every IN read stays
  // within the chunk bound, so the read count grows with the chunk count.
  const inCalls = f.calls.filter((c) => /item_id IN/i.test(c.source));
  expect(inCalls.length).toBeGreaterThan(2);
  for (const c of inCalls) {
    expect(c.params.length).toBeLessThanOrEqual(ITEM_QUERY_IN_CHUNK_SIZE);
  }
  const linkChunks = Math.ceil(COUNT / ITEM_QUERY_IN_CHUNK_SIZE);
  const stockChunks = Math.ceil(COUNT / ITEM_QUERY_IN_CHUNK_SIZE);
  expect(f.calls).toHaveLength(1 + linkChunks + stockChunks);
});

test('accent folding and literal wildcards hold across chunk boundaries', async () => {
  const f = makeChunkFake();
  const l = f.loc();
  const COUNT = ITEM_QUERY_IN_CHUNK_SIZE + 50;
  const cafeIds: number[] = [];
  for (let n = 0; n < COUNT; n += 1) {
    // Alternate stored forms so both fold directions cross chunks.
    const name = n % 2 === 0 ? `CAFÉ latte ${n}` : `cafe noir ${n}`;
    cafeIds.push(f.item(name, [{ locationId: l, quantity: 1 }], []));
  }
  // Literal-wildcard items pinned to the final chunk (past the boundary).
  const pct = f.item('100% cotton', [{ locationId: l, quantity: 1 }], []);
  const under = f.item('under_score', [{ locationId: l, quantity: 1 }], []);
  const back = f.item('back\\slash', [{ locationId: l, quantity: 1 }], []);
  const total = COUNT + 3;

  expect((await queryItems(f.db, { query: 'café' })).map((i) => i.id)).toEqual(
    cafeIds,
  );
  expect((await queryItems(f.db, { query: 'CAFÉ' })).map((i) => i.id)).toEqual(
    cafeIds,
  );
  expect((await queryItems(f.db, { query: 'cafe' })).map((i) => i.id)).toEqual(
    cafeIds,
  );
  // `%`, `_`, `\` stay literal: each matches exactly its stored row, even
  // in the trailing chunk.
  expect((await queryItems(f.db, { query: '%' })).map((i) => i.id)).toEqual([
    pct,
  ]);
  expect((await queryItems(f.db, { query: '_' })).map((i) => i.id)).toEqual([
    under,
  ]);
  expect((await queryItems(f.db, { query: '\\' })).map((i) => i.id)).toEqual([
    back,
  ]);
  // Full unfiltered page still returns every row in stable id order.
  const page = await queryItems(f.db);
  expect(page).toHaveLength(total);
  expect(page.map((i) => i.id)).toEqual(
    [...page.map((i) => i.id)].sort((a, b) => a - b),
  );
});

test('category OR, dedup, sin-stock, and ordering hold at chunked scale', async () => {
  const f = makeChunkFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const bulk = f.cat('Bulk');
  const cold = f.cat('Cold');
  const COUNT = ITEM_QUERY_IN_CHUNK_SIZE + 100;
  const evenIds: number[] = [];
  const allIds: number[] = [];
  for (let n = 0; n < COUNT; n += 1) {
    if (n % 2 === 0) {
      const id = f.item(
        `bulk-item-${n}`,
        [
          { locationId: pantry, quantity: 1 },
          { locationId: garage, quantity: 2 },
        ],
        [bulk, cold],
      );
      evenIds.push(id);
      allIds.push(id);
    } else {
      allIds.push(f.item(`plain-${n}`, [], []));
    }
  }
  // Category OR narrows to the even rows; duplicates dedupe; each item
  // appears once in stable id order with its full breakdown.
  const page = await queryItems(f.db, { categoryIds: [bulk, bulk, cold] });
  expect(page.map((i) => i.id)).toEqual(evenIds);
  expect(new Set(page.map((i) => i.id)).size).toBe(page.length);
  expect(page[0].stock).toHaveLength(2);
  expect(page[0].totalQuantity).toBe(3);
  expect(page[0].categoryIds).toEqual([bulk, cold]);
  // Unknown categories still yield [] at chunked scale.
  expect(await queryItems(f.db, { categoryIds: [9999] })).toEqual([]);
  // Sin-stock rows stay listed in the full page with total 0.
  const full = await queryItems(f.db);
  expect(full.map((i) => i.id)).toEqual(allIds);
  const sin = full.find((i) => !evenIds.includes(i.id));
  expect(sin?.stock).toEqual([]);
  expect(sin?.totalQuantity).toBe(0);
});

test('location-name matches survive chunking, including the trailing chunk', async () => {
  const f = makeChunkFake();
  const panteon = f.loc('Panteón');
  const garage = f.loc('Garage');
  const grains = f.cat('GRANOS');
  // Enough filler rows to push the Panteón item past the first chunk.
  for (let n = 0; n < ITEM_QUERY_IN_CHUNK_SIZE; n += 1) {
    f.item(`filler-${n}`, [{ locationId: garage, quantity: 1 }], []);
  }
  const rice = f.item('Rice', [{ locationId: panteon, quantity: 1 }], [grains]);
  // Accent folding on the stocked location name across the boundary.
  expect(
    (await queryItems(f.db, { query: 'panteon' })).map((i) => i.id),
  ).toEqual([rice]);
  expect(
    (await queryItems(f.db, { query: 'PANTEÓN' })).map((i) => i.id),
  ).toEqual([rice]);
  // Case folding on the category name across the boundary.
  expect(
    (await queryItems(f.db, { query: 'granos' })).map((i) => i.id),
  ).toEqual([rice]);
  // Location filter still ANDs with the text predicate at chunked scale.
  expect(
    (await queryItems(f.db, { query: 'granos', locationId: panteon })).map(
      (i) => i.id,
    ),
  ).toEqual([rice]);
  expect(
    await queryItems(f.db, { query: 'granos', locationId: garage }),
  ).toEqual([]);
});
