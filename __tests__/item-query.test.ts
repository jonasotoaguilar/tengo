/**
 * P3a bounded item query (host fake only, not real SQLite proof).
 *
 * Covers JS accent-folded substring search (ASCII + CAFÉ/café/cafe fold both
 * directions + Α/α, trim, literal %_\\), location all/existing/unknown/invalid,
 * category []/single/OR/overlap/dedup/duplicate/unknown/invalid, AND
 * cross-filters, zero/many categories, stable id order, validation before
 * SQL, generic storage errors, and the 3-read bound at N=101. Real
 * expo-sqlite behavior is P3b isolated-fixture work. S9 adds cross-entity
 * text matching: the folded query matches the item name, its location
 * name, or any of its category names (OR with dedup, item appears once).
 */
import type { RepositoryDb } from '../src/inventory/database';
import { StorageError } from '../src/inventory/errors';
import { normalizeItemFilter, queryItems } from '../src/inventory/itemQuery';
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
      quantity: number;
      location_id: number;
      created_at: string;
    }
  >();
  const joins = new Set<string>();
  let nextId = 1;
  const db: RepositoryDb = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    getAllAsync: jest.fn(async (source: string, params: unknown[] = []) => {
      calls.push({ source, params });
      if (/FROM items/i.test(source)) {
        const onlyLoc = /WHERE i\.location_id/i.test(source)
          ? (params[0] as number)
          : null;
        // Raw item page without the location join: dangling items are
        // returned here and dropped by the batched location read instead.
        return [...items.values()]
          .filter((it) =>
            onlyLoc === null ? true : it.location_id === onlyLoc,
          )
          .sort((a, b) => a.id - b.id)
          .map((it) => ({
            item_id: it.id,
            item_name: it.name,
            item_quantity: it.quantity,
            item_location_id: it.location_id,
            item_created_at: it.created_at,
          }));
      }
      if (/FROM locations/i.test(source)) {
        const onlyLocs = /id IN/i.test(source) ? (params as number[]) : null;
        return [...locations.values()]
          .filter((loc) =>
            onlyLocs === null ? true : onlyLocs.includes(loc.id),
          )
          .sort((a, b) => a.id - b.id)
          .map((loc) => ({
            location_id: loc.id,
            location_name: loc.name,
            location_address: loc.address,
            location_created_at: loc.created_at,
          }));
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
    quantity: number,
    locationId: number,
    catIds: number[] = [],
  ) => {
    const id = nextId++;
    items.set(id, {
      id,
      name,
      quantity,
      location_id: locationId,
      created_at: `ts-${id}`,
    });
    for (const c of catIds) joins.add(`${id}:${c}`);
    return id;
  };
  return { db, calls, loc, cat, item, joins };
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
  const rice = f.item('Rice', 1, l);
  const cafeUpper = f.item('CAFÉ latte', 2, l);
  const cafePlain = f.item('cafe noir', 1, l);
  const melange = f.item('CAFÉ 100%_\\mélange', 1, l);
  const greek = f.item('Αθήνα honey', 0, l);
  f.item('100% cotton_\\weave', 1, l);
  f.item("x'); DROP TABLE items; --", 1, l);
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
  // Zero quantity preserved through the query path.
  expect((await queryItems(f.db, { query: 'αθήνα' }))[0].quantity).toBe(0);
});

test('location: all/existing/unknown + categories OR/dedup/unknown + AND cross-filter', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const fridge = f.loc('Fridge');
  const bulk = f.cat('Bulk');
  const cold = f.cat('Cold');
  const a = f.item('Rice milk', 1, pantry, [bulk]);
  const b = f.item('Rice ice', 0, fridge, [bulk, cold]);
  const c = f.item('Oats', 3, fridge, []);
  expect((await queryItems(f.db)).map((i) => i.id)).toEqual([a, b, c]);
  expect(
    (await queryItems(f.db, { locationId: null })).map((i) => i.id),
  ).toEqual([a, b, c]);
  expect(
    (await queryItems(f.db, { locationId: fridge })).map((i) => i.id),
  ).toEqual([b, c]);
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
  expect(detail.location).toMatchObject({ id: fridge, name: 'Fridge' });
});

test('stable order, many-category model, empty skips follow-up reads, 101 items stay bounded', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  const c2 = f.cat('b');
  const c1 = f.cat('a');
  const many = f.item('Many', 5, l, [c1, c2]);
  f.item('Zero', 0, l, []);
  const got = await queryItems(f.db);
  expect(got.map((i) => i.id)).toEqual(
    [...got.map((i) => i.id)].sort((x, y) => x - y),
  );
  const manyDetail = got.find((i) => i.id === many);
  if (manyDetail === undefined) throw new Error('test: many item missing');
  expect(manyDetail.categoryIds).toEqual([c2, c1]);
  expect(manyDetail.categories.map((x) => x.id)).toEqual([c2, c1]);
  // Three batched reads: items, links for the surviving ids, locations.
  expect(f.calls).toHaveLength(3);
  expect(f.calls[1].source).toContain('WHERE jc.item_id IN');
  expect(f.calls[2].source).toContain('WHERE l.id IN');

  const empty = makeQueryFake();
  empty.loc();
  expect(await queryItems(empty.db)).toEqual([]);
  expect(empty.calls).toHaveLength(1);

  // Selective predicates skip follow-up reads where the names are not
  // needed: an empty page stops after the item read, and a category miss
  // stops after the batched link read. S9 cross-entity matching means a
  // text miss can no longer stop after read 1 — the location/category names
  // are unread at that point — so it pays the full 3-read shape.
  const selective = makeQueryFake();
  const sl = selective.loc();
  const sc = selective.cat('Bulk');
  selective.item('Rice', 1, sl, [sc]);
  expect(await queryItems(selective.db, { query: 'no-such-item' })).toEqual([]);
  expect(selective.calls).toHaveLength(3);
  expect(await queryItems(selective.db, { categoryIds: [9999] })).toEqual([]);
  expect(selective.calls).toHaveLength(5);

  const big = makeQueryFake();
  const bl = big.loc();
  for (let n = 0; n < 101; n++) big.item(`item-${n}`, n % 3, bl, []);
  const all = await queryItems(big.db);
  expect(all).toHaveLength(101);
  // Still one batched links read + one batched locations read, never N+1.
  expect(big.calls).toHaveLength(3);
  expect(big.calls[1].params).toHaveLength(101);
  expect(big.calls[2].params).toEqual([bl]);
  expect(all.map((i) => i.id)).toEqual(
    [...all.map((i) => i.id)].sort((x, y) => x - y),
  );
});

test('SQL shape is fixed/parameterized; invalid filters never touch the driver', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  const rice = f.item('Rice', 1, l);
  await queryItems(f.db, { locationId: l, query: "x' OR '1'='1" });
  // No match, but S9 still reads the names that could match: the item page,
  // the page links, and the surviving locations. The payload stays a JS
  // literal throughout — nothing is interpolated into the SQL.
  expect(f.calls).toHaveLength(3);
  const [first] = f.calls;
  expect(first.source).toContain('FROM items');
  expect(first.source).not.toContain('JOIN locations');
  expect(first.source).toContain('WHERE i.location_id = ?');
  expect(first.source).toContain('ORDER BY i.id ASC');
  expect(first.source).not.toContain("x' OR");
  expect(first.params).toEqual([l]);

  // A matching query exercises the same three batched reads with bound params.
  await queryItems(f.db, { locationId: l, query: 'rice' });
  expect(f.calls).toHaveLength(6);
  const [, links, locs] = f.calls.slice(3);
  expect(links.source).toContain('JOIN categories');
  expect(links.source).toContain('WHERE jc.item_id IN (');
  expect(links.source).toContain('ORDER BY jc.item_id ASC');
  expect(links.source).not.toContain('Rice');
  expect(links.params).toEqual([rice]);
  expect(locs.source).toContain('FROM locations');
  expect(locs.source).toContain('WHERE l.id IN (');
  expect(locs.source).toContain('ORDER BY l.id ASC');
  expect(locs.source).not.toContain('Pantry');
  expect(locs.params).toEqual([l]);

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

test('dangling location drops the item while keeping the 3-read bound', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  const good = f.item('Rice', 1, l);
  // Dangling: location 9999 has no location row. The unjoined items page
  // returns it, but the batched location read cannot, so inner-join
  // semantics drop it exactly as the pre-refactor JOIN did.
  const dangling = f.item('Ghost', 1, 9999);
  expect(dangling).not.toBe(good);
  const page = await queryItems(f.db);
  expect(page.map((i) => i.id)).toEqual([good]);
  expect(page.find((i) => i.id === dangling)).toBeUndefined();
  expect(f.calls).toHaveLength(3);
});

test('second and third read faults map to generic storage query errors with cause', async () => {
  const seedOne = () => {
    const f = makeQueryFake();
    const l = f.loc();
    f.item('Rice', 1, l);
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

  const locFault = seedOne();
  faultOnRead(locFault, 3, 'location read boom');
  const locFailure = (await queryItems(locFault.db).catch(
    (e: unknown) => e,
  )) as StorageError;
  expect(locFailure).toBeInstanceOf(StorageError);
  expect(locFailure).toMatchObject({
    code: 'storage',
    entity: 'item',
    operation: 'query',
  });
  expect(locFailure.message).not.toContain('location read boom');
  expect(String(locFailure.cause ?? locFailure)).toMatch(/location read boom/);
});

test('malformed location row throws StorageError with cause instead of dropping', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  f.item('Rice', 1, l);
  const inner = f.db.getAllAsync as jest.Mock;
  const orig = inner.getMockImplementation() as (
    ...args: never[]
  ) => Promise<unknown>;
  inner.mockImplementation(async (...args: never[]) => {
    const [source] = args as unknown as [string, unknown[]?];
    const rows = (await orig(...args)) as Record<string, unknown>[];
    if (/FROM locations/i.test(source)) {
      // Bare/unaliased shape: no `location_*` keys, so the aliased-shape
      // requirement must reject it loudly rather than drop the item.
      return [{ id: l, name: 'Pantry', address: null, created_at: `ts-${l}` }];
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
    /malformed location row/,
  );
});

test('S9: query matches only the location name, only a category name, or the item name', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const dairy = f.cat('Dairy');
  const tools = f.cat('Tools');
  const rice = f.item('Rice', 1, pantry, [dairy]);
  const hammer = f.item('Hammer', 2, garage, [tools]);

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

test('S9: item matching two ways appears exactly once with stable order', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const bulk = f.cat('Pantry Goods');
  // Name AND location AND category all contain the folded query.
  const beans = f.item('Pantry Beans', 1, pantry, [bulk]);
  const other = f.item('Pantry Oats', 2, pantry, []);
  const page = await queryItems(f.db, { query: 'pantry' });
  expect(page.map((i) => i.id)).toEqual([beans, other]);
  expect(new Set(page.map((i) => i.id)).size).toBe(page.length);
  const detail = page.find((i) => i.id === beans);
  expect(detail?.location.name).toBe('Pantry');
  expect(detail?.categories.map((c) => c.name)).toEqual(['Pantry Goods']);
});

test('S9: non-matching query returns nothing; folding applies to location/category names', async () => {
  const f = makeQueryFake();
  const panteon = f.loc('Panteón');
  const garage = f.loc('Garage');
  const grains = f.cat('GRANOS');
  const tools = f.cat('Tools');
  const rice = f.item('Rice', 1, panteon, [grains]);
  f.item('Hammer', 1, garage, [tools]);

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
  // Case-insensitive location substring: 'pantri' matches 'PANTRIES'.
  const g = makeQueryFake();
  const pantries = g.loc('PANTRIES');
  const other = g.loc('Garage');
  const a = g.item('Rice', 1, pantries, []);
  g.item('Hammer', 1, other, []);
  expect(
    (await queryItems(g.db, { query: 'pantri' })).map((i) => i.id),
  ).toEqual([a]);
});

test('S9: cross-entity text ANDs with the location filter and category-OR without changing their semantics', async () => {
  const f = makeQueryFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const dairy = f.cat('Dairy');
  const tools = f.cat('Tools');
  const rice = f.item('Rice', 1, pantry, [dairy]);
  const milk = f.item('Milk', 1, garage, [dairy]);
  const beans2 = f.item('Hammer', 1, garage, [tools]);

  // Location filter still narrows: 'dairy' matches rice+milk by category,
  // but the pantry filter keeps only rice.
  expect(
    (await queryItems(f.db, { query: 'dairy', locationId: pantry })).map(
      (i) => i.id,
    ),
  ).toEqual([rice]);
  // Category-OR still narrows: 'garage' matches milk+hammer by location,
  // but the dairy filter keeps only milk.
  expect(
    (await queryItems(f.db, { query: 'garage', categoryIds: [dairy] })).map(
      (i) => i.id,
    ),
  ).toEqual([milk]);
  // Blank/whitespace query still means no name filter (all rows, bounded).
  expect((await queryItems(f.db, { query: '   ' })).map((i) => i.id)).toEqual([
    rice,
    milk,
    beans2,
  ]);
});
