/**
 * Bounded item query over catalog + stock (host fake only, not real
 * SQLite proof).
 *
 * Covers JS accent-folded substring search (ASCII + CAFÉ/café/cafe fold
 * both directions, trim, literal %_\), location membership
 * (all/existing/unknown/invalid, sin-stock exclusion), category
 * []/single/OR/overlap/dedup/duplicate/unknown/invalid, AND
 * cross-filters, zero/many categories, multi-location breakdown with
 * total, sin-stock items as legitimate results, stable id order,
 * validation before SQL, generic storage errors, and the 3-read bound at
 * N=101. Real expo-sqlite behavior is isolated-fixture work. Cross-entity
 * text matching: the folded query matches the item name, the names of
 * locations where the item has stock, or any of its category names (OR
 * with dedup, item appears once).
 */
import type { RepositoryDb } from '../src/inventory/database';
import { StorageError } from '../src/inventory/errors';
import {
  getLastUsedLocationId,
  normalizeItemFilter,
  queryItems,
} from '../src/inventory/itemQuery';
import { ValidationError } from '../src/inventory/validation';

function makeQueryFake() {
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
    {
      id: number;
      name: string;
      lowStockThreshold: number | null;
      barcode: string | null;
      created_at: string;
    }
  >();
  const stock: {
    itemId: number;
    locationId: number;
    quantity: number;
    expiresOn: string | null;
  }[] = [];
  const joins = new Set<string>();
  let nextId = 1;
  const db: RepositoryDb = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    getAllAsync: jest.fn(async (source: string, params: unknown[] = []) => {
      calls.push({ source, params });
      if (/FROM items i/i.test(source)) {
        // Location filter is membership: the item has stock there.
        // (Checked before the stock branch: the EXISTS subquery itself
        // contains `FROM stock s`.)
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
            low_stock_threshold: it.lowStockThreshold,
            barcode: it.barcode,
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
              expires_on: s.expiresOn,
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
    stockRows: {
      locationId: number;
      quantity: number;
      expiresOn?: string | null;
    }[] = [],
    catIds: number[] = [],
    v5: { lowStockThreshold?: number | null; barcode?: string | null } = {},
  ) => {
    const id = nextId++;
    items.set(id, {
      id,
      name,
      lowStockThreshold: v5.lowStockThreshold ?? null,
      barcode: v5.barcode ?? null,
      created_at: `ts-${id}`,
    });
    for (const s of stockRows) {
      stock.push({
        itemId: id,
        locationId: s.locationId,
        quantity: s.quantity,
        expiresOn: s.expiresOn ?? null,
      });
    }
    for (const c of catIds) joins.add(`${id}:${c}`);
    return id;
  };
  return { db, calls, loc, cat, item, joins, stock };
}

test('normalize helper is pure: trim/dedup, null-all, rejects bad runtime input', () => {
  expect(normalizeItemFilter()).toEqual({
    query: null,
    locationId: null,
    categoryIds: [],
  });
  expect(
    normalizeItemFilter({
      query: '  Café ',
      locationId: null,
      categoryIds: [3, 3, 2],
    }),
  ).toEqual({ query: 'Café', locationId: null, categoryIds: [3, 2] });
  expect(normalizeItemFilter({ query: '   ' }).query).toBeNull();
  for (const bad of [
    { query: 42 },
    { locationId: 0 },
    { locationId: -1 },
    { locationId: 'x' },
    { categoryIds: [1, 0] },
    { categoryIds: 'x' },
    { categoryIds: [1.5] },
  ] as never[]) {
    expect(() => normalizeItemFilter(bad)).toThrow(ValidationError);
  }
});

test('search: ASCII/non-ASCII case, trim, accent-folded cafe=café, literal %_\\ preserved verbatim', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  const rice = f.item('Rice', [{ locationId: l, quantity: 1 }]);
  const cafeUpper = f.item('CAFÉ latte', [{ locationId: l, quantity: 2 }]);
  const cafePlain = f.item('cafe noir', [{ locationId: l, quantity: 1 }]);
  const melange = f.item('CAFÉ 100%_\\mélange', [
    { locationId: l, quantity: 1 },
  ]);
  const greek = f.item('Αθήνα honey', [{ locationId: l, quantity: 3 }]);
  f.item('100% cotton_\\weave', [{ locationId: l, quantity: 1 }]);
  f.item("x'); DROP TABLE items; --", [{ locationId: l, quantity: 1 }]);
  expect((await queryItems(f.db, { query: 'rice' })).map((i) => i.id)).toEqual([
    rice,
  ]);
  expect(
    (await queryItems(f.db, { query: '  RICE  ' })).map((i) => i.id),
  ).toEqual([rice]);
  expect((await queryItems(f.db, { query: 'café' })).map((i) => i.id)).toEqual([
    cafeUpper,
    cafePlain,
    melange,
  ]);
  expect((await queryItems(f.db, { query: 'CAFÉ' })).map((i) => i.id)).toEqual([
    cafeUpper,
    cafePlain,
    melange,
  ]);
  // Accent folding both directions: plain cafe matches stored café,
  // and accented CAFÉ matches stored plain cafe.
  expect((await queryItems(f.db, { query: 'cafe' })).map((i) => i.id)).toEqual([
    cafeUpper,
    cafePlain,
    melange,
  ]);
  expect(
    (await queryItems(f.db, { query: 'melange' })).map((i) => i.id),
  ).toEqual([melange]);
  expect(
    (await queryItems(f.db, { query: 'mélange' })).map((i) => i.id),
  ).toEqual([melange]);
  // Genuinely non-matching query still returns nothing.
  expect(await queryItems(f.db, { query: 'no-such-taste' })).toEqual([]);
  expect((await queryItems(f.db, { query: 'αθήνα' })).map((i) => i.id)).toEqual(
    [greek],
  );
  // LIKE wildcards are literal data, not patterns.
  expect(await queryItems(f.db, { query: '%' })).toHaveLength(2);
  expect(await queryItems(f.db, { query: '_' })).toHaveLength(2);
  expect(await queryItems(f.db, { query: '\\' })).toHaveLength(2);
  expect(await queryItems(f.db, { query: 'DROP TABLE' })).toHaveLength(1);
  // Totals ride the breakdown through the query path.
  expect((await queryItems(f.db, { query: 'αθήνα' }))[0].totalQuantity).toBe(3);
});

test('location membership: stocked here matches, stocked elsewhere and sin-stock do not', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const fridge = f.loc('Fridge');
  const bulk = f.cat('Bulk');
  const cold = f.cat('Cold');
  const a = f.item('Rice milk', [{ locationId: pantry, quantity: 1 }], [bulk]);
  const b = f.item(
    'Rice ice',
    [
      { locationId: pantry, quantity: 2 },
      { locationId: fridge, quantity: 3 },
    ],
    [bulk, cold],
  );
  const c = f.item('Oats', [], []);
  expect((await queryItems(f.db)).map((i) => i.id)).toEqual([a, b, c]);
  expect(
    (await queryItems(f.db, { locationId: null })).map((i) => i.id),
  ).toEqual([a, b, c]);
  // b appears once with its full breakdown even under the filter.
  const fridgePage = await queryItems(f.db, { locationId: fridge });
  expect(fridgePage.map((i) => i.id)).toEqual([b]);
  expect(fridgePage[0].stock).toHaveLength(2);
  expect(fridgePage[0].totalQuantity).toBe(5);
  // Sin-stock items match no location filter but stay in the full list.
  expect(await queryItems(f.db, { locationId: pantry })).toHaveLength(2);
  expect(await queryItems(f.db, { locationId: 9999 })).toEqual([]);
  expect(
    (await queryItems(f.db, { categoryIds: [] })).map((i) => i.id),
  ).toEqual([a, b, c]);
  expect(
    (await queryItems(f.db, { categoryIds: [bulk] })).map((i) => i.id),
  ).toEqual([a, b]);
  expect(
    (await queryItems(f.db, { categoryIds: [bulk, cold] })).map((i) => i.id),
  ).toEqual([a, b]);
  // Duplicate filter ids dedupe; item appears once even with overlapping cats.
  expect(
    (await queryItems(f.db, { categoryIds: [bulk, bulk] })).map((i) => i.id),
  ).toEqual([a, b]);
  expect(await queryItems(f.db, { categoryIds: [9999] })).toEqual([]);
  // AND across query + location + any-category.
  expect(
    (
      await queryItems(f.db, {
        query: 'rice',
        locationId: fridge,
        categoryIds: [cold],
      })
    ).map((i) => i.id),
  ).toEqual([b]);
  const detail = (await queryItems(f.db, { query: 'oats' }))[0];
  expect(detail.categoryIds).toEqual([]);
  expect(detail.categories).toEqual([]);
  expect(detail.stock).toEqual([]);
  expect(detail.totalQuantity).toBe(0);
});

test('one answer per product: multi-location breakdown with total, stable order', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const c2 = f.cat('b');
  const c1 = f.cat('a');
  const many = f.item(
    'Many',
    [
      { locationId: garage, quantity: 5 },
      { locationId: pantry, quantity: 2 },
    ],
    [c1, c2],
  );
  const sin = f.item('Zero', [], []);
  const got = await queryItems(f.db);
  expect(got.map((i) => i.id)).toEqual(
    [...got.map((i) => i.id)].sort((x, y) => x - y),
  );
  const manyDetail = got.find((i) => i.id === many);
  if (manyDetail === undefined) throw new Error('test: many item missing');
  expect(manyDetail.totalQuantity).toBe(7);
  expect(manyDetail.stock.map((s) => s.locationId)).toEqual([pantry, garage]);
  expect(manyDetail.stock[0].location.name).toBe('Pantry');
  expect(manyDetail.categoryIds).toEqual([c2, c1]);
  expect(manyDetail.categories.map((x) => x.id)).toEqual([c2, c1]);
  const sinDetail = got.find((i) => i.id === sin);
  expect(sinDetail?.stock).toEqual([]);
  expect(sinDetail?.totalQuantity).toBe(0);
  // Three batched reads: items, links for the page ids, stock+locations join.
  expect(f.calls).toHaveLength(3);
  expect(f.calls[1].source).toContain('WHERE jc.item_id IN');
  expect(f.calls[2].source).toContain('FROM stock');
  expect(f.calls[2].source).toContain('JOIN locations');
  expect(f.calls[2].source).toContain('WHERE s.item_id IN');

  const empty = makeQueryFake();
  empty.loc();
  expect(await queryItems(empty.db)).toEqual([]);
  expect(empty.calls).toHaveLength(1);

  // Selective predicates skip follow-up reads where the names are not
  // needed: an empty page stops after the item read, and a category miss
  // stops after the batched link read. A text miss still pays the full
  // 3-read shape (location/category names are unread at read 1).
  const selective = makeQueryFake();
  const sl = selective.loc();
  const sc = selective.cat('Bulk');
  selective.item('Rice', [{ locationId: sl, quantity: 1 }], [sc]);
  expect(await queryItems(selective.db, { query: 'no-such-item' })).toEqual([]);
  expect(selective.calls).toHaveLength(3);
  expect(await queryItems(selective.db, { categoryIds: [9999] })).toEqual([]);
  expect(selective.calls).toHaveLength(5);

  const big = makeQueryFake();
  const bl = big.loc();
  for (let n = 0; n < 101; n++)
    big.item(`item-${n}`, [{ locationId: bl, quantity: (n % 3) + 1 }], []);
  const all = await queryItems(big.db);
  expect(all).toHaveLength(101);
  // Still one batched links read + one batched stock read, never N+1.
  expect(big.calls).toHaveLength(3);
  expect(big.calls[1].params).toHaveLength(101);
  expect(big.calls[2].params).toHaveLength(101);
  expect(all.map((i) => i.id)).toEqual(
    [...all.map((i) => i.id)].sort((x, y) => x - y),
  );
});

test('SQL shape is fixed/parameterized; invalid filters never touch the driver', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  const rice = f.item('Rice', [{ locationId: l, quantity: 1 }]);
  await queryItems(f.db, { locationId: l, query: "x' OR '1'='1" });
  // No match, but the read still covers the names that could match: the
  // item page, the page links, and the page stock join. The payload stays
  // a JS literal throughout — nothing is interpolated into the SQL.
  expect(f.calls).toHaveLength(3);
  const [first] = f.calls;
  expect(first.source).toContain('FROM items');
  expect(first.source).not.toContain('JOIN locations');
  expect(first.source).toContain('EXISTS');
  expect(first.source).toContain('s.location_id = ?');
  expect(first.source).toContain('ORDER BY i.id ASC');
  expect(first.source).not.toContain("x' OR");
  expect(first.params).toEqual([l]);

  // A matching query exercises the same three batched reads with bound params.
  await queryItems(f.db, { locationId: l, query: 'rice' });
  expect(f.calls).toHaveLength(6);
  const [, links, stockJoin] = f.calls.slice(3);
  expect(links.source).toContain('JOIN categories');
  expect(links.source).toContain('WHERE jc.item_id IN (');
  expect(links.source).toContain('ORDER BY jc.item_id ASC');
  expect(links.source).not.toContain('Rice');
  expect(links.params).toEqual([rice]);
  expect(stockJoin.source).toContain('FROM stock');
  expect(stockJoin.source).toContain('JOIN locations');
  expect(stockJoin.source).toContain('WHERE s.item_id IN (');
  expect(stockJoin.source).toContain('ORDER BY s.item_id ASC');
  expect(stockJoin.source).not.toContain('Pantry');
  expect(stockJoin.params).toEqual([rice]);

  const spy: RepositoryDb = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    getAllAsync: jest.fn(),
  };
  for (const bad of [
    { query: 7 },
    { locationId: 0 },
    { locationId: -2 },
    { categoryIds: [1, 1.5] },
    { categoryIds: 'bulk' },
  ] as never[]) {
    await expect(queryItems(spy, bad)).rejects.toBeInstanceOf(ValidationError);
  }
  expect(spy.getAllAsync).not.toHaveBeenCalled();
});

test('sparse holes and null query reject before any SQL', async () => {
  const singleHole: number[] = new Array(1);
  const midHole: number[] = [1, 9, 2];
  delete midHole[1];
  for (const bad of [
    { categoryIds: singleHole },
    { categoryIds: midHole },
    { categoryIds: [undefined] },
    { categoryIds: [1, undefined, 2] },
    { query: null },
  ] as never[]) {
    expect(() => normalizeItemFilter(bad)).toThrow(ValidationError);
  }
  // Untouched defaults stay valid: absent/empty/blank query means no filter.
  expect(normalizeItemFilter().query).toBeNull();
  expect(normalizeItemFilter({ query: undefined }).query).toBeNull();
  expect(normalizeItemFilter({ query: '' }).query).toBeNull();
  expect(normalizeItemFilter({ query: '   ' }).query).toBeNull();

  const spy: RepositoryDb = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    getAllAsync: jest.fn(),
  };
  for (const bad of [
    { categoryIds: singleHole },
    { categoryIds: midHole },
    { categoryIds: [undefined] },
    { query: null },
  ] as never[]) {
    await expect(queryItems(spy, bad)).rejects.toBeInstanceOf(ValidationError);
  }
  expect(spy.getAllAsync).not.toHaveBeenCalled();
  expect(spy.getFirstAsync).not.toHaveBeenCalled();
  expect(spy.runAsync).not.toHaveBeenCalled();
});

test('driver failures map to generic storage query errors with cause', async () => {
  const failing: RepositoryDb = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    getAllAsync: jest.fn().mockRejectedValue(new Error('disk I/O error 123')),
  };
  const failure = (await queryItems(failing).catch(
    (e: unknown) => e,
  )) as StorageError;
  expect(failure).toBeInstanceOf(StorageError);
  expect(failure).toMatchObject({
    code: 'storage',
    entity: 'item',
    operation: 'query',
  });
  expect(failure.message).not.toContain('disk I/O');
  expect(String(failure.cause ?? failure)).toMatch(/disk I\/O/);
});

test('sin-stock items stay listed: no stock rows is a legitimate result', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  const stocked = f.item('Rice', [{ locationId: l, quantity: 1 }]);
  const sin = f.item('Ghost', [], []);
  const page = await queryItems(f.db);
  expect(page.map((i) => i.id)).toEqual([stocked, sin]);
  expect(page.find((i) => i.id === sin)?.totalQuantity).toBe(0);
  expect(f.calls).toHaveLength(3);
});

test('second and third read faults map to generic storage query errors with cause', async () => {
  const seedOne = () => {
    const f = makeQueryFake();
    const l = f.loc();
    f.item('Rice', [{ locationId: l, quantity: 1 }]);
    return f;
  };
  const faultOnRead = (
    fake: ReturnType<typeof makeQueryFake>,
    readIndex: number,
    message: string,
  ) => {
    const inner = fake.db.getAllAsync as jest.Mock;
    const orig = inner.getMockImplementation() as (
      ...args: never[]
    ) => Promise<unknown>;
    let calls = 0;
    inner.mockImplementation(async (...args: never[]) => {
      calls += 1;
      if (calls === readIndex) throw new Error(message);
      return orig(...args);
    });
  };

  const linkFault = seedOne();
  faultOnRead(linkFault, 2, 'link read boom');
  const linkFailure = (await queryItems(linkFault.db).catch(
    (e: unknown) => e,
  )) as StorageError;
  expect(linkFailure).toBeInstanceOf(StorageError);
  expect(linkFailure).toMatchObject({
    code: 'storage',
    entity: 'item',
    operation: 'query',
  });
  expect(linkFailure.message).not.toContain('link read boom');
  expect(String(linkFailure.cause ?? linkFailure)).toMatch(/link read boom/);

  const stockFault = seedOne();
  faultOnRead(stockFault, 3, 'stock read boom');
  const stockFailure = (await queryItems(stockFault.db).catch(
    (e: unknown) => e,
  )) as StorageError;
  expect(stockFailure).toBeInstanceOf(StorageError);
  expect(stockFailure).toMatchObject({
    code: 'storage',
    entity: 'item',
    operation: 'query',
  });
  expect(stockFailure.message).not.toContain('stock read boom');
  expect(String(stockFailure.cause ?? stockFailure)).toMatch(/stock read boom/);
});

test('malformed stock row throws StorageError with cause instead of dropping', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  f.item('Rice', [{ locationId: l, quantity: 1 }]);
  const inner = f.db.getAllAsync as jest.Mock;
  const orig = inner.getMockImplementation() as (
    ...args: never[]
  ) => Promise<unknown>;
  inner.mockImplementation(async (...args: never[]) => {
    const [source] = args as unknown as [string, unknown[]?];
    const rows = (await orig(...args)) as Record<string, unknown>[];
    if (/FROM stock s/i.test(source)) {
      // Unaliased/broken shape: no `stock_item_id` key, so the shape
      // requirement must reject it loudly rather than drop the item.
      return [{ item_id: 1, quantity: 1 }];
    }
    return rows;
  });
  const failure = (await queryItems(f.db).catch((e: unknown) => e)) as
    | StorageError
    | unknown;
  expect(failure).toBeInstanceOf(StorageError);
  expect(failure).toMatchObject({
    code: 'storage',
    entity: 'item',
    operation: 'query',
  });
  expect(String((failure as StorageError).cause ?? failure)).toMatch(
    /malformed stock row/,
  );
});

test('query matches only a stocked location name, only a category name, or the item name', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const dairy = f.cat('Dairy');
  const tools = f.cat('Tools');
  const rice = f.item('Rice', [{ locationId: pantry, quantity: 1 }], [dairy]);
  const hammer = f.item(
    'Hammer',
    [{ locationId: garage, quantity: 2 }],
    [tools],
  );

  // Location-name-only: no item name or category name contains 'pantry'.
  expect(
    (await queryItems(f.db, { query: 'pantry' })).map((i) => i.id),
  ).toEqual([rice]);
  // Category-name-only: no item name or location name contains 'tools'.
  expect((await queryItems(f.db, { query: 'tools' })).map((i) => i.id)).toEqual(
    [hammer],
  );
  // Item-name-only still matches exactly as before.
  expect((await queryItems(f.db, { query: 'rice' })).map((i) => i.id)).toEqual([
    rice,
  ]);
  expect(
    (await queryItems(f.db, { query: 'hammer' })).map((i) => i.id),
  ).toEqual([hammer]);
});

test('item matching two ways appears exactly once with stable order', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const bulk = f.cat('Pantry Goods');
  // Name AND stocked-location AND category all contain the folded query.
  const beans = f.item(
    'Pantry Beans',
    [{ locationId: pantry, quantity: 1 }],
    [bulk],
  );
  const other = f.item(
    'Pantry Oats',
    [{ locationId: pantry, quantity: 2 }],
    [],
  );
  const page = await queryItems(f.db, { query: 'pantry' });
  expect(page.map((i) => i.id)).toEqual([beans, other]);
  expect(new Set(page.map((i) => i.id)).size).toBe(page.length);
  const detail = page.find((i) => i.id === beans);
  expect(detail?.stock[0].location.name).toBe('Pantry');
  expect(detail?.categories.map((c) => c.name)).toEqual(['Pantry Goods']);
});

test('non-matching query returns nothing; folding applies to stocked location/category names', async () => {
  const f = makeQueryFake();
  const panteon = f.loc('Panteón');
  const garage = f.loc('Garage');
  const grains = f.cat('GRANOS');
  const tools = f.cat('Tools');
  const rice = f.item('Rice', [{ locationId: panteon, quantity: 1 }], [grains]);
  f.item('Hammer', [{ locationId: garage, quantity: 1 }], [tools]);
  // A sin-stock item matches by name but never by a location name.
  const sin = f.item('Rice crackers', [], []);

  expect(await queryItems(f.db, { query: 'no-such-taste' })).toEqual([]);
  // Accent folding on the location name: 'panteon' matches 'Panteón'.
  expect(
    (await queryItems(f.db, { query: 'panteon' })).map((i) => i.id),
  ).toEqual([rice]);
  expect(
    (await queryItems(f.db, { query: 'PANTEÓN' })).map((i) => i.id),
  ).toEqual([rice]);
  // Case folding on the category name: 'granos' matches 'GRANOS'.
  expect(
    (await queryItems(f.db, { query: 'granos' })).map((i) => i.id),
  ).toEqual([rice]);
  // 'rice' matches the stocked item by name AND the sin-stock item by name.
  expect((await queryItems(f.db, { query: 'rice' })).map((i) => i.id)).toEqual([
    rice,
    sin,
  ]);
  // Case-insensitive location substring: 'pantri' matches 'PANTRIES'.
  const g = makeQueryFake();
  const pantries = g.loc('PANTRIES');
  const other = g.loc('Garage');
  const a = g.item('Rice', [{ locationId: pantries, quantity: 1 }], []);
  g.item('Hammer', [{ locationId: other, quantity: 1 }], []);
  expect(
    (await queryItems(g.db, { query: 'pantri' })).map((i) => i.id),
  ).toEqual([a]);
});

test('cross-entity text ANDs with the location filter and category-OR without changing their semantics', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const dairy = f.cat('Dairy');
  const tools = f.cat('Tools');
  const rice = f.item('Rice', [{ locationId: pantry, quantity: 1 }], [dairy]);
  const milk = f.item('Milk', [{ locationId: garage, quantity: 1 }], [dairy]);
  const hammers = f.item(
    'Hammer',
    [{ locationId: garage, quantity: 1 }],
    [tools],
  );

  // Location filter still narrows: 'dairy' matches rice+milk by category,
  // but the pantry filter keeps only rice.
  expect(
    (await queryItems(f.db, { query: 'dairy', locationId: pantry })).map(
      (i) => i.id,
    ),
  ).toEqual([rice]);
  // Category-OR still narrows: 'garage' matches milk+hammer by stocked
  // location, but the dairy filter keeps only milk.
  expect(
    (await queryItems(f.db, { query: 'garage', categoryIds: [dairy] })).map(
      (i) => i.id,
    ),
  ).toEqual([milk]);
  // Blank/whitespace query still means no name filter (all rows, bounded).
  expect((await queryItems(f.db, { query: '   ' })).map((i) => i.id)).toEqual([
    rice,
    milk,
    hammers,
  ]);
});

test('v5 fields ride the bounded read model with no extra reads', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const rice = f.item(
    'Rice',
    [
      { locationId: pantry, quantity: 2, expiresOn: '2027-03-15' },
      { locationId: garage, quantity: 5 },
    ],
    [],
    { lowStockThreshold: 3, barcode: '12345678' },
  );
  const [detail] = await queryItems(f.db);
  expect(detail.id).toBe(rice);
  expect(detail.lowStockThreshold).toBe(3);
  expect(detail.barcode).toBe('12345678');
  expect(detail.totalQuantity).toBe(7);
  expect(detail.stock.map((s) => s.expiresOn)).toEqual(['2027-03-15', null]);
  // Same bounded shape: items, links, stock join — no fourth read.
  expect(f.calls).toHaveLength(3);
  // The new columns travel inside the existing three reads.
  expect(f.calls[0].source).toContain('low_stock_threshold');
  expect(f.calls[0].source).toContain('barcode');
  expect(f.calls[2].source).toContain('expires_on');
});

test('v5 PRESERVE: pre-v5 rows without the new columns read as null', async () => {
  // A legacy-shaped fake (no v5 aliases at all) still yields a full
  // detail with nulls: the additive columns tolerate missing keys.
  const calls: { source: string; params: unknown[] }[] = [];
  const db = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    getAllAsync: jest.fn(async (source: string, params: unknown[] = []) => {
      calls.push({ source, params });
      if (/FROM items i/i.test(source)) {
        return [{ item_id: 1, item_name: 'Rice', item_created_at: 'ts-1' }];
      }
      if (/FROM item_categories/i.test(source)) return [];
      if (/FROM stock s/i.test(source)) {
        return [
          {
            stock_item_id: 1,
            quantity: 2,
            location_id: 7,
            location_name: 'Pantry',
            location_address: null,
            location_created_at: 'ts-7',
          },
        ];
      }
      throw new Error(`fake: unhandled ${source}`);
    }),
  } as unknown as RepositoryDb;
  const [detail] = await queryItems(db);
  expect(detail).toMatchObject({
    id: 1,
    name: 'Rice',
    lowStockThreshold: null,
    barcode: null,
    totalQuantity: 2,
  });
  expect(detail.stock[0].expiresOn).toBeNull();
  expect(calls).toHaveLength(3);
});

test('v5 PRESERVE: one answer per product with total and stable order', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const many = f.item(
    'Many',
    [
      { locationId: garage, quantity: 5, expiresOn: '2028-06-01' },
      { locationId: pantry, quantity: 2 },
    ],
    [],
    { lowStockThreshold: 6, barcode: 'BEANS-001' },
  );
  const got = await queryItems(f.db);
  expect(got).toHaveLength(1);
  expect(got[0].id).toBe(many);
  expect(got[0].totalQuantity).toBe(7);
  expect(got[0].stock.map((s) => s.locationId)).toEqual([pantry, garage]);
  expect(f.calls).toHaveLength(3);
});

/**
 * U1 quick capture: the last-used location is derived from the data —
 * the location of the newest stocked item — with no new table, no
 * preference, and no schema change. These tests run RED before the read
 * exists and GREEN after.
 */
function makeLastUsedFake() {
  const calls: { source: string; params: unknown[] }[] = [];
  const locations = new Map<number, string>();
  const stock: { itemId: number; locationId: number }[] = [];
  let nextId = 1;
  const db = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(async (source: string, params: unknown[] = []) => {
      calls.push({ source, params });
      if (/FROM stock s/i.test(source)) {
        // Honest executor for the U1 shape: only stock whose location
        // still exists ranks, newest item first, smallest location on
        // ties — mirroring the ORDER BY the implementation must carry.
        const ranked = stock
          .filter((s) => locations.has(s.locationId))
          .sort((a, b) => b.itemId - a.itemId || a.locationId - b.locationId);
        const top = ranked[0];
        return top === undefined ? null : { location_id: top.locationId };
      }
      throw new Error(`fake: unhandled ${source}`);
    }),
    getAllAsync: jest.fn(),
  } as unknown as RepositoryDb;
  const loc = (name: string) => {
    const id = nextId++;
    locations.set(id, name);
    return id;
  };
  const item = (stockAt: number[]) => {
    const id = nextId++;
    for (const locationId of stockAt) stock.push({ itemId: id, locationId });
    return id;
  };
  // Cascade-equivalent removal: deleting a location drops its stock rows
  // (stock.location_id ON DELETE CASCADE), never the items.
  const deleteLocation = (locationId: number) => {
    locations.delete(locationId);
    for (let i = stock.length - 1; i >= 0; i -= 1) {
      if (stock[i].locationId === locationId) stock.splice(i, 1);
    }
  };
  return { db, calls, loc, item, deleteLocation };
}

test('U1: last-used location is the newest stocked item location in one bounded read', async () => {
  const f = makeLastUsedFake();
  const pantry = f.loc('Pantry');
  const fridge = f.loc('Fridge');
  f.item([pantry]);
  f.item([fridge]);
  expect(await getLastUsedLocationId(f.db)).toBe(fridge);
  // Bounded by design: exactly one single-row read, no params, and the
  // order that answers "last used" (newest item first) is in the SQL.
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].params).toEqual([]);
  expect(f.calls[0].source).toContain('JOIN locations');
  expect(f.calls[0].source).toContain('ORDER BY');
  expect(f.calls[0].source).toContain('DESC');
  expect(f.calls[0].source).toContain('LIMIT 1');
});

test('U1: a newest item with no stock is skipped; multi-location ties break smallest-first', async () => {
  const f = makeLastUsedFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  f.item([pantry]);
  f.item([garage, pantry]);
  // Newest stocked item holds two locations: deterministic smallest id.
  expect(await getLastUsedLocationId(f.db)).toBe(pantry);
  // A newer catalog-only item contributes no stock, so the answer stands.
  f.item([]);
  expect(await getLastUsedLocationId(f.db)).toBe(pantry);
});

test('U1: a fresh database with no stock reads as null', async () => {
  const empty = makeLastUsedFake();
  empty.loc('Pantry');
  expect(await getLastUsedLocationId(empty.db)).toBeNull();
  // Catalog-only items are legitimate sin-stock rows, never a location.
  const sinStock = makeLastUsedFake();
  const pantry = sinStock.loc('Pantry');
  void pantry;
  sinStock.item([]);
  sinStock.item([]);
  expect(await getLastUsedLocationId(sinStock.db)).toBeNull();
});

test('U1: a deleted location never surfaces — older stock or null wins', async () => {
  const f = makeLastUsedFake();
  const pantry = f.loc('Pantry');
  const fridge = f.loc('Fridge');
  f.item([pantry]);
  f.item([fridge]);
  f.deleteLocation(fridge);
  expect(await getLastUsedLocationId(f.db)).toBe(pantry);
  f.deleteLocation(pantry);
  expect(await getLastUsedLocationId(f.db)).toBeNull();
});

test('U1: driver failure maps to a generic storage query error with cause', async () => {
  const failing = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn().mockRejectedValue(new Error('disk I/O error 9')),
    getAllAsync: jest.fn(),
  } as unknown as RepositoryDb;
  const failure = (await getLastUsedLocationId(failing).catch(
    (e: unknown) => e,
  )) as StorageError;
  expect(failure).toBeInstanceOf(StorageError);
  expect(failure).toMatchObject({
    code: 'storage',
    entity: 'item',
    operation: 'query',
  });
  expect(failure.message).not.toContain('disk I/O');
  expect(String(failure.cause ?? failure)).toMatch(/disk I\/O/);
});

test('U1 PRESERVE: the bounded queryItems shape is unchanged by the new read', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const rice = f.item('Rice', [{ locationId: pantry, quantity: 2 }]);
  f.item('Ghost', [], []);
  const page = await queryItems(f.db);
  expect(page.map((i) => i.id)).toEqual([rice, rice + 1]);
  expect(page[0].totalQuantity).toBe(2);
  expect(page[1].totalQuantity).toBe(0);
  expect(f.calls).toHaveLength(3);
});
