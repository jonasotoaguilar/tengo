/**
 * Location membership filter unit (host fake, not real SQLite proof).
 *
 * The EXISTS membership predicate is exercised by the DEV query fixture
 * and its device flow, but had no focused unit coverage. This test seeds
 * one item stocked at two locations and proves the dedicated behavior:
 * filtering by a location with no stock returns `[]`, filtering by a
 * stocked location returns the item WITH its full breakdown across ALL
 * its locations (never just the filtered one), the first read's SQL
 * carries the EXISTS membership subquery, and the whole query stays
 * within the three-read bound.
 */
import type { RepositoryDb } from '../src/inventory/database';
import { queryItems } from '../src/inventory/itemQuery';

function makeFilterFake() {
  const calls: { source: string; params: unknown[] }[] = [];
  const locations = new Map<
    number,
    { id: number; name: string; address: string | null; created_at: string }
  >();
  const items = new Map<
    number,
    { id: number; name: string; created_at: string }
  >();
  const stock: { itemId: number; locationId: number; quantity: number }[] = [];
  let nextId = 1;
  const db: RepositoryDb = {
    runAsync: jest.fn(),
    getFirstAsync: jest.fn(),
    getAllAsync: jest.fn(async (source: string, params: unknown[] = []) => {
      calls.push({ source, params });
      if (/FROM items i/i.test(source)) {
        // Membership first: the EXISTS subquery itself contains
        // `FROM stock s`, so this branch must win over the stock branch.
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
        return [];
      }
      throw new Error(`fake: unhandled ${source}`);
    }) as RepositoryDb['getAllAsync'],
  };
  const loc = (name: string) => {
    const id = nextId++;
    locations.set(id, { id, name, address: null, created_at: `ts-${id}` });
    return id;
  };
  const item = (
    name: string,
    stockRows: { locationId: number; quantity: number }[],
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
    return id;
  };
  return { db, calls, loc, item };
}

/**
 * One item stocked at Pantry and Garage only — never at the Attic — so
 * the Attic filter is a genuine membership miss on the same seed shape
 * the hit assertions use.
 */
function seedStockedElsewhere() {
  const f = makeFilterFake();
  const pantry = f.loc('Pantry');
  const garage = f.loc('Garage');
  const attic = f.loc('Attic');
  const milk = f.item('Milk', [
    { locationId: pantry, quantity: 2 },
    { locationId: garage, quantity: 3 },
  ]);
  return { f, pantry, garage, attic, milk };
}

test('a location holding no stock of the item returns [] after one EXISTS read', async () => {
  const { f, attic } = seedStockedElsewhere();
  const page = await queryItems(f.db, { locationId: attic });
  expect(page).toEqual([]);
  // A miss exits after the item read: no links, no stock read.
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].source).toContain('EXISTS');
  expect(f.calls[0].source).toContain('s.location_id = ?');
  expect(f.calls[0].params).toEqual([attic]);
});

test('a stocked location returns the item with its full breakdown across all locations', async () => {
  const { f, pantry, garage, milk } = seedStockedElsewhere();
  const page = await queryItems(f.db, { locationId: pantry });
  expect(page.map((i) => i.id)).toEqual([milk]);
  // Full breakdown: BOTH stocked locations, never just the filtered one.
  expect(page[0].stock).toHaveLength(2);
  expect(page[0].stock.map((s) => s.locationId).sort((a, b) => a - b)).toEqual(
    [pantry, garage].sort((a, b) => a - b),
  );
  expect(page[0].stock.map((s) => s.location.name).sort()).toEqual([
    'Garage',
    'Pantry',
  ]);
  expect(page[0].totalQuantity).toBe(5);
  // The whole filtered query stays within the three-read bound, and the
  // first read binds the location id instead of interpolating it.
  expect(f.calls.length).toBeLessThanOrEqual(3);
  expect(f.calls[0].source).toContain('EXISTS');
  expect(f.calls[0].source).toContain('s.location_id = ?');
  expect(f.calls[0].source).not.toContain('Pantry');
  expect(f.calls[0].params).toEqual([pantry]);
});
