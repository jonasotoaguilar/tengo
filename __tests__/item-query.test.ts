/**
 * P3a bounded item query (host fake only, not real SQLite proof).
 *
 * Covers JS Unicode-lowercase substring search (ASCII + CAFÉ/café + Α/α,
 * trim, cafe≠café, literal %_\\), location all/existing/unknown/invalid,
 * category []/single/OR/overlap/dedup/duplicate/unknown/invalid, AND
 * cross-filters, zero/many categories, stable id order, validation before
 * SQL, generic storage errors, and the 2-read bound at N=101. Real
 * expo-sqlite behavior is P3b isolated-fixture work.
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
        return [...items.values()]
          .filter((it) =>
            onlyLoc === null ? true : it.location_id === onlyLoc,
          )
          .filter((it) => locations.has(it.location_id))
          .sort((a, b) => a.id - b.id)
          .map((it) => {
            const loc = locations.get(it.location_id);
            if (loc === undefined) throw new Error('fake: missing location');
            return {
              item_id: it.id,
              item_name: it.name,
              item_quantity: it.quantity,
              item_location_id: it.location_id,
              item_created_at: it.created_at,
              location_id: loc.id,
              location_name: loc.name,
              location_address: loc.address,
              location_created_at: loc.created_at,
            };
          });
      }
      if (/FROM item_categories/i.test(source)) {
        return [...joins]
          .map((k) => k.split(':').map(Number) as [number, number])
          .filter(([, c]) => categories.has(c))
          .filter(([i]) => items.has(i))
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

test('search: ASCII/non-ASCII case, trim, cafe≠café, literal %_\\ preserved verbatim', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  const rice = f.item('Rice', 1, l);
  const cafeUpper = f.item('CAFÉ latte', 2, l);
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
  ]);
  expect((await queryItems(f.db, { query: 'CAFÉ' })).map((i) => i.id)).toEqual([
    cafeUpper,
  ]);
  // No accent folding: plain cafe matches nothing stored as café.
  expect(await queryItems(f.db, { query: 'cafe' })).toEqual([]);
  expect((await queryItems(f.db, { query: 'αθήνα' })).map((i) => i.id)).toEqual(
    [greek],
  );
  // LIKE wildcards are literal data, not patterns.
  expect(await queryItems(f.db, { query: '%' })).toHaveLength(1);
  expect(await queryItems(f.db, { query: '_' })).toHaveLength(1);
  expect(await queryItems(f.db, { query: '\\' })).toHaveLength(1);
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

test('stable order, many-category model, empty skips second read, 101 items stay bounded', async () => {
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
  expect(f.calls).toHaveLength(2);

  const empty = makeQueryFake();
  empty.loc();
  expect(await queryItems(empty.db)).toEqual([]);
  expect(empty.calls).toHaveLength(1);

  const big = makeQueryFake();
  const bl = big.loc();
  for (let n = 0; n < 101; n++) big.item(`item-${n}`, n % 3, bl, []);
  const all = await queryItems(big.db);
  expect(all).toHaveLength(101);
  expect(big.calls).toHaveLength(2);
  expect(all.map((i) => i.id)).toEqual(
    [...all.map((i) => i.id)].sort((x, y) => x - y),
  );
});

test('SQL shape is fixed/parameterized; invalid filters never touch the driver', async () => {
  const f = makeQueryFake();
  const l = f.loc();
  f.item('Rice', 1, l);
  await queryItems(f.db, { locationId: l, query: "x' OR '1'='1" });
  const [first] = f.calls;
  expect(first.source).toContain('JOIN locations');
  expect(first.source).toContain('WHERE i.location_id = ?');
  expect(first.source).toContain('ORDER BY i.id ASC');
  expect(first.source).not.toContain("x' OR");
  expect(first.params).toEqual([l]);
  expect(f.calls[1].source).toContain('JOIN categories');
  expect(f.calls[1].source).toContain('ORDER BY jc.item_id ASC');

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
