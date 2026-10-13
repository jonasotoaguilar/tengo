/**
 * Bounded item query/read model over catalog + stock (host-fake unit;
 * real SQLite proof is isolated-fixture work).
 *
 * `queryItems(db, filter)` returns the `ItemDetail` read model with one
 * catalog `items` select (`id, name,
 * created_at`, optional membership filter `EXISTS (SELECT 1 FROM stock s
 * WHERE s.item_id = i.id AND s.location_id = ?)` for the location filter,
 * `ORDER BY item id ASC`), then — only when the item page is non-empty —
 * chunked `item_categories JOIN categories` selects constrained to the
 * page ids (`WHERE jc.item_id IN (?,…)` with generated placeholders and
 * bound params, `ORDER BY item/category id ASC`, at most
 * `ITEM_QUERY_IN_CHUNK_SIZE` ids per statement), then — only when rows
 * survive the category-OR predicate — chunked stock+locations joins
 * (`SELECT s.item_id, s.quantity, l.* FROM stock s JOIN locations l ON
 * l.id = s.location_id WHERE s.item_id IN (…) ORDER BY s.item_id, l.id`,
 * same per-statement id bound)
 * that deliver the breakdown AND the location names, so the read count
 * now grows with the chunk count by design: 1 + ceil(pages / chunk) +
 * ceil(survivors / chunk). No unbounded full-table scan is ever issued,
 * and empty intermediate sets skip their follow-up reads (no items → 1
 * read; category eliminates all → 1 + link chunks).
 *
 * Cross-entity text matching means the name-only prefilter cannot decide
 * the result set: a query matches when the folded query is a substring of
 * the folded item name, the folded name of any location where the item
 * has stock, or any folded category name, so the stock/location names
 * must be read before the text predicate runs. The link read therefore
 * covers the whole page (not just name survivors) and the stock read
 * covers every category survivor (an undecided row may still match
 * through a location name). The worst case per keystroke is the same
 * full chunked shape the unfiltered list already pays; a name miss no
 * longer short-circuits after read 1.
 *
 * The text predicate, the category-OR target-set predicate, and the
 * location-name predicate are all decided on raw rows: name filtering runs
 * on the raw item rows, category membership on the raw link id pairs, and
 * location-name matching on the raw stock rows. `ItemDetail`, `Location`,
 * and `StockLevel` are allocated only for rows that survive all three.
 * `Category`/`categoryIds` are allocated for category survivors, which is
 * before the location-name drop, so a row dropped only by its location name
 * has already built its category list: one list per surviving row, discarded
 * by the drop. An item matching in more than one way still appears exactly
 * once (one row per item, stable `id ASC` page order), with its FULL
 * breakdown — even under a location filter, the row shows every location,
 * never just the filtered one. An item with no stock rows is a legitimate
 * "sin stock" result with total 0; it matches no location filter (no
 * membership) and no location-name query.
 *
 * Name matching is a verbatim-preserving JS substring with accent folding,
 * applied to the item name, each stocked location name, and every category
 * name: both the trimmed query and each compared value are normalized with
 * Unicode NFD, combining marks (`\\p{Diacritic}`) are stripped, then the
 * folded text is lowercased and compared with literal `includes`. That keeps
 * ordinary Unicode case (`CAFÉ` matches `café`) and folds accents both
 * directions (`cafe` matches `café`, `CAFÉ` matches stored `cafe`,
 * `melange` matches `mélange`), with literal `%`/`_`/`\` handling
 * (no LIKE wildcards). SQL `LIKE`/`NOCASE`
 * is deliberately unused: SQLite case-folds ASCII only and cannot promise
 * Stored names are returned verbatim.
 *
 * Filters validate before any SQL via `ValidationError`/`validateId`:
 * non-string `query` and non-positive-integer location/category ids reject
 * without touching the driver. `null`/`undefined` location means all
 * locations; `undefined`/empty categories mean no category filter.
 * Duplicate category ids are deduped; valid-but-unknown location or
 * category ids yield `[]`, never errors. The batched stock read MUST
 * return the aliased shape (`stock_item_id`, `quantity`, `location_id`,
 * `location_name`, `location_address`, `location_created_at`); host fakes
 * return that same aliased shape. A stock row that does not match the
 * aliased shape throws `StorageError('item', 'query')` with `cause`
 * instead of silently dropping items, so a dropped column or broken alias
 * surfaces as an error. Driver failures become generic
 * `StorageError('item', 'query')` with `cause`.
 */
import type { RepositoryDb } from './database';
import { StorageError } from './errors';
import type {
  Category,
  ItemDetail,
  ItemFilter,
  Location,
  StockLevel,
} from './types';
import { ValidationError, validateId } from './validation';

export type { ItemFilter } from './types';

/** Validated filter: trimmed query or null, resolved location, deduped cats. */
export interface NormalizedItemFilter {
  query: string | null;
  locationId: number | null;
  categoryIds: number[];
}

/**
 * Pure filter normalization shared by `queryItems` and its tests.
 * Throws `ValidationError` before any SQL on malformed runtime input.
 */
export function normalizeItemFilter(
  filter: ItemFilter = {},
): NormalizedItemFilter {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new ValidationError(
      'filter',
      'invalid',
      'filter must be an object with query, locationId, and categoryIds.',
    );
  }
  const { query, locationId, categoryIds } = filter;
  let normalizedQuery: string | null = null;
  if (query !== undefined) {
    if (typeof query !== 'string') {
      throw new ValidationError('query', 'invalid', 'query must be a string.');
    }
    const trimmed = query.trim();
    normalizedQuery = trimmed.length === 0 ? null : trimmed;
  }
  let normalizedLocation: number | null = null;
  if (locationId !== undefined && locationId !== null) {
    normalizedLocation = validateId(locationId, 'locationId');
  }
  let normalizedCategories: number[] = [];
  if (categoryIds !== undefined) {
    if (!Array.isArray(categoryIds)) {
      throw new ValidationError(
        'categoryIds',
        'invalid',
        'categoryIds must be an array of category ids.',
      );
    }
    // Indexed loop (not map/forEach): holes must validate per position —
    // `validateId(undefined)` rejects instead of slipping into the Set.
    const validated: number[] = [];
    for (let index = 0; index < categoryIds.length; index += 1) {
      validated.push(validateId(categoryIds[index], 'categoryIds'));
    }
    normalizedCategories = [...new Set(validated)];
  }
  return {
    query: normalizedQuery,
    locationId: normalizedLocation,
    categoryIds: normalizedCategories,
  };
}

interface ItemRow {
  item_id: number;
  item_name: string;
  item_created_at: string;
}

interface StockRow {
  stock_item_id: number;
  quantity: number;
  location_id: number;
  location_name: string;
  location_address: string | null;
  location_created_at: string;
}

/**
 * Require the aliased stock shape the batched stock+locations SELECT
 * always produces. Anything else throws `StorageError('item', 'query')`
 * with `cause` so a dropped column or a broken alias fails loudly
 * instead of silently dropping items. Note: `location_address` must be
 * present as `string | null`; a missing (`undefined`) address is
 * malformed, never coalesced to null. `quantity` must be a number (the
 * v4 CHECK guarantees positive integers in a real database).
 */
function requireStockRow(row: StockRow): StockRow {
  if (
    typeof row.stock_item_id !== 'number' ||
    typeof row.quantity !== 'number' ||
    typeof row.location_id !== 'number' ||
    typeof row.location_name !== 'string' ||
    (row.location_address !== null &&
      typeof row.location_address !== 'string') ||
    typeof row.location_created_at !== 'string'
  ) {
    throw new StorageError(
      'item',
      'query',
      new Error(`malformed stock row: ${JSON.stringify(row)}`),
    );
  }
  return row;
}

interface CategoryLinkRow {
  link_item_id: number;
  category_id: number;
  category_name: string;
  category_created_at: string;
}

const ITEMS_SELECT =
  'SELECT i.id AS item_id, i.name AS item_name, i.created_at AS item_created_at ' +
  'FROM items i';

const STOCK_JOIN_SELECT_BASE =
  'SELECT s.item_id AS stock_item_id, s.quantity AS quantity, ' +
  'l.id AS location_id, l.name AS location_name, l.address AS location_address, ' +
  'l.created_at AS location_created_at ' +
  'FROM stock s JOIN locations l ON l.id = s.location_id';

const CATEGORY_LINKS_SELECT_BASE =
  'SELECT jc.item_id AS link_item_id, c.id AS category_id, c.name AS category_name, ' +
  'c.created_at AS category_created_at ' +
  'FROM item_categories jc JOIN categories c ON c.id = jc.category_id';

/** One `?` placeholder per bound id — values are never string-interpolated. */
function inPlaceholders(count: number): string {
  return new Array<string>(count).fill('?').join(', ');
}

/**
 * Max ids per batched `IN` statement. Well under the legacy SQLite
 * variable limit (999) so the link/stock reads keep working at any
 * catalog size — which limit this expo-sqlite build enforces (999 vs
 * 32766) is unconfirmed, so the smaller bound governs — while keeping
 * the chunk (and therefore read) count low.
 */
export const ITEM_QUERY_IN_CHUNK_SIZE = 450;

/**
 * Run one parameterized `IN` select per id chunk and concatenate the rows
 * in chunk order. Chunks partition the already-`id ASC` page, and every
 * chunk carries the same `ORDER BY`, so the concatenated rows match a
 * single unchunked read exactly. Each statement binds at most
 * `ITEM_QUERY_IN_CHUNK_SIZE` ids; the read count grows with the chunk
 * count by design.
 */
async function getAllInIdChunks<Row>(
  db: RepositoryDb,
  buildSource: (chunkLength: number) => string,
  ids: number[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let start = 0; start < ids.length; start += ITEM_QUERY_IN_CHUNK_SIZE) {
    const chunk = ids.slice(start, start + ITEM_QUERY_IN_CHUNK_SIZE);
    const chunkRows = await db.getAllAsync<Row>(buildSource(chunk.length), [
      ...chunk,
    ]);
    rows.push(...chunkRows);
  }
  return rows;
}

/**
 * Fold text for search comparison only: NFD, strip combining marks, then
 * lowercase. Stored names and the returned read model stay verbatim.
 */
function foldSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Query items with bounded-per-statement reads: the catalog item page
 * (with an optional stock-membership location filter), chunked
 * category-link reads for the page ids, and chunked stock+locations joins
 * for the category survivors. Each `IN` statement carries at most
 * `ITEM_QUERY_IN_CHUNK_SIZE` ids and chunk results are concatenated in
 * page (`id ASC`) order, so the merged rows match a single unchunked
 * read. The read count now grows with the chunk count — 1 + ceil(pages /
 * chunk) + ceil(survivors / chunk) — instead of at most three. JS accent-folded
 * substring (NFD + strip Diacritic + lowercase, literal `%_\\`) runs
 * against the raw item, link, and stock rows — matching the item name, a
 * stocked location name, or any category name with OR-with-dedup — and
 * the category-OR runs on the raw link id pairs: all decided on raw rows
 * before any `ItemDetail`/`Location`/`StockLevel` allocation, with
 * category lists built for category survivors (before the location-name
 * drop). Item order is stable `id ASC`; categories and stock levels are
 * `id ASC`. An item with no stock rows is a legitimate sin-stock result
 * with total 0.
 */
export async function queryItems(
  db: RepositoryDb,
  filter: ItemFilter = {},
): Promise<ItemDetail[]> {
  const normalized = normalizeItemFilter(filter);
  let itemRows: ItemRow[];
  try {
    if (normalized.locationId === null) {
      itemRows = await db.getAllAsync<ItemRow>(
        `${ITEMS_SELECT} ORDER BY i.id ASC`,
      );
    } else {
      itemRows = await db.getAllAsync<ItemRow>(
        `${ITEMS_SELECT} WHERE EXISTS (SELECT 1 FROM stock s WHERE s.item_id = i.id AND s.location_id = ?) ` +
          'ORDER BY i.id ASC',
        [normalized.locationId],
      );
    }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('item', 'query', error);
  }
  if (itemRows.length === 0) return [];

  // Cross-entity text predicate inputs, computed on raw rows only — no
  // Location/Category/StockLevel/ItemDetail yet. Accent-folded literal
  // substring: fold the query once, each item name once, each distinct
  // category name once (cached by id), and each distinct stocked location
  // name once (cached by id) after the batched read.
  const foldedQuery =
    normalized.query === null ? null : foldSearchText(normalized.query);
  const foldedItemName = new Map<number, string>();
  for (const row of itemRows) {
    foldedItemName.set(row.item_id, foldSearchText(row.item_name));
  }

  // Category links chunked over the whole page (id ASC order preserved
  // by concatenating chunk results in order). The
  // text predicate needs every row's category names before it can run, so
  // the read-1 name short-circuit is gone: the worst case is the full
  // chunked shape the unfiltered list already pays, and the read count
  // grows with the chunk count by design.
  const pageIds = itemRows.map((row) => row.item_id);
  let linkRows: CategoryLinkRow[];
  try {
    linkRows = await getAllInIdChunks<CategoryLinkRow>(
      db,
      (chunkLength) =>
        `${CATEGORY_LINKS_SELECT_BASE} WHERE jc.item_id IN (${inPlaceholders(chunkLength)}) ` +
        'ORDER BY jc.item_id ASC, c.id ASC',
      pageIds,
    );
  } catch (error) {
    if (error instanceof ValidationError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('item', 'query', error);
  }

  // Category-OR predicate on raw link id pairs — still no entity
  // allocation. Unchanged semantics: empty filter means no filtering, and
  // a miss here still skips the stock read (1 + link chunks total).
  const wanted =
    normalized.categoryIds.length > 0 ? new Set(normalized.categoryIds) : null;
  const foldedCategoryName = new Map<number, string>();
  const categoryNamesByItem = new Map<number, string[]>();
  for (const link of linkRows) {
    let folded = foldedCategoryName.get(link.category_id);
    if (folded === undefined) {
      folded = foldSearchText(link.category_name);
      foldedCategoryName.set(link.category_id, folded);
    }
    const list = categoryNamesByItem.get(link.link_item_id) ?? [];
    list.push(folded);
    categoryNamesByItem.set(link.link_item_id, list);
  }
  const nameOrCategoryHit = new Set<number>();
  if (foldedQuery !== null) {
    for (const row of itemRows) {
      if (
        (foldedItemName.get(row.item_id) ?? '').includes(foldedQuery) ||
        (categoryNamesByItem.get(row.item_id) ?? []).some((name) =>
          name.includes(foldedQuery),
        )
      ) {
        nameOrCategoryHit.add(row.item_id);
      }
    }
  }
  let categorySurvivors: ItemRow[];
  if (wanted === null) {
    categorySurvivors = itemRows;
  } else {
    const matched = new Set<number>();
    for (const link of linkRows) {
      if (wanted.has(link.category_id)) matched.add(link.link_item_id);
    }
    categorySurvivors = itemRows.filter((row) => matched.has(row.item_id));
    if (categorySurvivors.length === 0) return [];
  }

  // Categories allocated only for rows that survived the category
  // predicate, in link order (already item/category id ASC) so
  // `categoryIds` matches.
  const survivorIds = new Set(categorySurvivors.map((row) => row.item_id));
  const byItem = new Map<number, Category[]>();
  for (const link of linkRows) {
    if (!survivorIds.has(link.link_item_id)) continue;
    const list = byItem.get(link.link_item_id) ?? [];
    list.push({
      id: link.category_id,
      name: link.category_name,
      created_at: link.category_created_at,
    });
    byItem.set(link.link_item_id, list);
  }

  // Stock + locations chunked over the category survivors in one join
  // shape per chunk. A
  // row undecided by name/category may still match through a stocked
  // location name, so this read cannot be skipped while survivors remain.
  // The join is inner on the stock level: a stock row whose location is
  // missing contributes no breakdown row, and an item with no stock rows
  // at all is a legitimate sin-stock result (never dropped).
  const survivorPageIds = categorySurvivors.map((row) => row.item_id);
  let rawStockRows: StockRow[];
  try {
    rawStockRows = await getAllInIdChunks<StockRow>(
      db,
      (chunkLength) =>
        `${STOCK_JOIN_SELECT_BASE} WHERE s.item_id IN (${inPlaceholders(chunkLength)}) ` +
        'ORDER BY s.item_id ASC, l.id ASC',
      survivorPageIds,
    );
  } catch (error) {
    if (error instanceof ValidationError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('item', 'query', error);
  }
  // Fail loudly on a malformed stock row (dropped column/broken alias):
  // `requireStockRow` throws StorageError('item', 'query').
  const stockRows = rawStockRows.map((row) => requireStockRow(row));
  const stockByItem = new Map<number, StockRow[]>();
  const foldedLocationName = new Map<number, string>();
  for (const stockRow of stockRows) {
    const list = stockByItem.get(stockRow.stock_item_id) ?? [];
    list.push(stockRow);
    stockByItem.set(stockRow.stock_item_id, list);
    if (!foldedLocationName.has(stockRow.location_id)) {
      // Fold once per distinct location, mirroring the category cache: the
      // final loop compares every surviving row against its stocked
      // location names, so folding inside that loop would repeat the same
      // work once per item.
      foldedLocationName.set(
        stockRow.location_id,
        foldSearchText(stockRow.location_name),
      );
    }
  }

  const details: ItemDetail[] = [];
  // One row per item in stable page (`id ASC`) order: an item matching in
  // more than one way (name, location, category) still appears exactly once.
  for (const row of categorySurvivors) {
    const levels = stockByItem.get(row.item_id) ?? [];
    if (
      foldedQuery !== null &&
      !nameOrCategoryHit.has(row.item_id) &&
      !levels.some((level) =>
        (foldedLocationName.get(level.location_id) ?? '').includes(foldedQuery),
      )
    ) {
      continue;
    }
    const categories = byItem.get(row.item_id) ?? [];
    const categoryIds = categories.map((category) => category.id);
    const stock: StockLevel[] = levels.map((level) => {
      const location: Location = {
        id: level.location_id,
        name: level.location_name,
        address: level.location_address,
        created_at: level.location_created_at,
      };
      return {
        locationId: level.location_id,
        location,
        quantity: level.quantity,
      };
    });
    details.push({
      id: row.item_id,
      name: row.item_name,
      stock,
      totalQuantity: stock.reduce((sum, level) => sum + level.quantity, 0),
      categoryIds,
      categories,
      created_at: row.item_created_at,
    });
  }
  return details;
}
