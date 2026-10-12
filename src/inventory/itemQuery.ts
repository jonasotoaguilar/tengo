/**
 * P3a bounded item query/read model (host-fake unit; real SQLite proof is P3b).
 *
 * `queryItems(db, filter)` returns the `ItemDetail` read model with at most
 * three SQL reads regardless of N: one `items` select WITHOUT the location
 * join (`id, name, quantity, location_id, created_at`, optional
 * parameterized `location_id` WHERE, `ORDER BY item id ASC`), then — only
 * when name-surviving item ids exist — one batched
 * `item_categories JOIN categories` select constrained to those ids
 * (`WHERE jc.item_id IN (?,…)` with generated placeholders and bound params,
 * `ORDER BY item/category id ASC`), then — only when rows survive both the
 * name and the category-OR predicates — one batched `locations` select for
 * the distinct surviving location ids (`WHERE l.id IN (?,…)` with generated
 * placeholders and bound params, `ORDER BY location id ASC`). No unbounded
 * full-table link/location scan is ever issued, and empty intermediate sets
 * skip their follow-up reads (no items → 1 read; name eliminates all → 1
 * read; category eliminates all → 2 reads).
 *
 * The name predicate and the category-OR target-set predicate are evaluated
 * BEFORE any `Location`, `Category`/`categoryIds`, or `ItemDetail`
 * allocation: name filtering runs on the raw item rows, category membership
 * runs on the raw link id pairs, and only surviving rows allocate entities.
 * Inner-join semantics are preserved exactly: an item whose location row is
 * missing from the batched location read is dropped, because the previous
 * `JOIN locations` shape excluded it.
 *
 * Name matching is a verbatim-preserving JS substring:
 * `name.toLowerCase().includes(query.trim().toLowerCase())`. That keeps
 * ordinary Unicode case (`CAFÉ` matches `café`, `Α` matches `α`) with no
 * accent folding (`cafe` never matches `café`), no Unicode normalization,
 * and literal `%`/`_`/`\` handling (no LIKE wildcards). SQL `LIKE`/`NOCASE`
 * is deliberately unused: SQLite case-folds ASCII only and cannot promise
 * the Unicode behavior above. Stored names are returned verbatim.
 *
 * Filters validate before any SQL via `ValidationError`/`validateId`:
 * non-string `query` and non-positive-integer location/category ids reject
 * without touching the driver. `null`/`undefined` location means all
 * locations; `undefined`/empty categories mean no category filter.
 * Duplicate category ids are deduped; valid-but-unknown location or
 * category ids yield `[]`, never errors. Missing locations cannot be
 * synthesized (the v2 FK guarantees the join); dangling category links
 * follow the existing read behavior and drop from the list. The batched
 * locations read MUST return the aliased shape (`location_id`,
 * `location_name`, `location_address`, `location_created_at`); host fakes
 * return that same aliased shape. A location row that does not match the
 * aliased shape throws `StorageError('item', 'query')` with `cause`
 * instead of silently dropping items, so a dropped column or broken alias
 * surfaces as an error. Driver failures become generic
 * `StorageError('item', 'query')` with `cause`.
 */
import type { RepositoryDb } from './database';
import { StorageError } from './errors';
import type { Category, ItemDetail, ItemFilter, Location } from './types';
import { ValidationError, validateId } from './validation';

export type { ItemFilter } from './types';

/** Validated P3a filter: trimmed query or null, resolved location, deduped cats. */
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
  item_quantity: number;
  item_location_id: number;
  item_created_at: string;
}

interface LocationRow {
  location_id: number;
  location_name: string;
  location_address: string | null;
  location_created_at: string;
}

/**
 * Require the aliased location shape the batched `locations` SELECT always
 * produces. Bare `{id, name, address, created_at}` rows are NOT accepted
 * (host fakes return the aliased shape too). Anything else throws
 * `StorageError('item', 'query')` with `cause` so a dropped column or a
 * broken alias fails loudly instead of silently dropping items. Note:
 * `location_address` must be present as `string | null`; a missing
 * (`undefined`) address is malformed, never coalesced to null.
 */
function requireLocationRow(row: LocationRow): LocationRow {
  if (
    typeof row.location_id !== 'number' ||
    typeof row.location_name !== 'string' ||
    (row.location_address !== null &&
      typeof row.location_address !== 'string') ||
    typeof row.location_created_at !== 'string'
  ) {
    throw new StorageError(
      'item',
      'query',
      new Error(`malformed location row: ${JSON.stringify(row)}`),
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
  'SELECT i.id AS item_id, i.name AS item_name, i.quantity AS item_quantity, ' +
  'i.location_id AS item_location_id, i.created_at AS item_created_at ' +
  'FROM items i';

const LOCATIONS_SELECT_BASE =
  'SELECT l.id AS location_id, l.name AS location_name, l.address AS location_address, ' +
  'l.created_at AS location_created_at ' +
  'FROM locations l';

const CATEGORY_LINKS_SELECT_BASE =
  'SELECT jc.item_id AS link_item_id, c.id AS category_id, c.name AS category_name, ' +
  'c.created_at AS category_created_at ' +
  'FROM item_categories jc JOIN categories c ON c.id = jc.category_id';

/** One `?` placeholder per bound id — values are never string-interpolated. */
function inPlaceholders(count: number): string {
  return new Array<string>(count).fill('?').join(', ');
}

/**
 * Query items with bounded reads (max three `getAllAsync` calls): the
 * unjoined item page, one batched category-link read for the name-surviving
 * ids, and one batched location read for the distinct surviving location
 * ids. JS name-substring (Unicode lowercase, literal `%_\\`) runs on the
 * raw item rows and the category-OR runs on the raw link id pairs, both
 * before any entity allocation. Item order is stable `id ASC`; categories
 * are `id ASC` with `categoryIds` matching the entity list. Quantity zero
 * is preserved. Items whose location row is absent stay excluded.
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
        `${ITEMS_SELECT} WHERE i.location_id = ? ORDER BY i.id ASC`,
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

  // Name predicate on raw rows only — no Location/Category/ItemDetail yet.
  const queryLower = normalized.query?.toLowerCase() ?? null;
  const nameSurvivors =
    queryLower === null
      ? itemRows
      : itemRows.filter((row) =>
          row.item_name.toLowerCase().includes(queryLower),
        );
  if (nameSurvivors.length === 0) return [];

  // Category links batched to the name survivors (id ASC order preserved).
  const survivorIds = nameSurvivors.map((row) => row.item_id);
  let linkRows: CategoryLinkRow[];
  try {
    linkRows = await db.getAllAsync<CategoryLinkRow>(
      `${CATEGORY_LINKS_SELECT_BASE} WHERE jc.item_id IN (${inPlaceholders(survivorIds.length)}) ` +
        'ORDER BY jc.item_id ASC, c.id ASC',
      [...survivorIds],
    );
  } catch (error) {
    if (error instanceof ValidationError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('item', 'query', error);
  }

  // Category-OR predicate on raw link id pairs — still no entity allocation.
  const wanted =
    normalized.categoryIds.length > 0 ? new Set(normalized.categoryIds) : null;
  let finalRows: ItemRow[];
  if (wanted === null) {
    finalRows = nameSurvivors;
  } else {
    const matched = new Set<number>();
    for (const link of linkRows) {
      if (wanted.has(link.category_id)) matched.add(link.link_item_id);
    }
    finalRows = nameSurvivors.filter((row) => matched.has(row.item_id));
    if (finalRows.length === 0) return [];
  }

  // Categories allocated only for rows that survived both predicates, in
  // link order (already item/category id ASC) so `categoryIds` matches.
  const finalIds = new Set(finalRows.map((row) => row.item_id));
  const byItem = new Map<number, Category[]>();
  for (const link of linkRows) {
    if (!finalIds.has(link.link_item_id)) continue;
    const list = byItem.get(link.link_item_id) ?? [];
    list.push({
      id: link.category_id,
      name: link.category_name,
      created_at: link.category_created_at,
    });
    byItem.set(link.link_item_id, list);
  }

  // Locations batched to the distinct surviving location ids; a missing
  // location row drops its item, preserving the old inner-join semantics.
  const locationIds = [
    ...new Set(finalRows.map((row) => row.item_location_id)),
  ].sort((a, b) => a - b);
  let locationRows: LocationRow[];
  try {
    locationRows = await db.getAllAsync<LocationRow>(
      `${LOCATIONS_SELECT_BASE} WHERE l.id IN (${inPlaceholders(locationIds.length)}) ` +
        'ORDER BY l.id ASC',
      [...locationIds],
    );
  } catch (error) {
    if (error instanceof ValidationError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('item', 'query', error);
  }
  const locationById = new Map<number, LocationRow>();
  for (const raw of locationRows) {
    // Fail loudly on a malformed location row (dropped column/broken
    // alias): `requireLocationRow` throws StorageError('item', 'query').
    // A merely missing location row still drops its item (inner join).
    const locationRow = requireLocationRow(raw);
    locationById.set(locationRow.location_id, locationRow);
  }

  const details: ItemDetail[] = [];
  for (const row of finalRows) {
    const locationRow = locationById.get(row.item_location_id);
    if (locationRow === undefined) continue;
    const categories = byItem.get(row.item_id) ?? [];
    const categoryIds = categories.map((category) => category.id);
    const location: Location = {
      id: locationRow.location_id,
      name: locationRow.location_name,
      address: locationRow.location_address,
      created_at: locationRow.location_created_at,
    };
    details.push({
      id: row.item_id,
      name: row.item_name,
      quantity: row.item_quantity,
      locationId: row.item_location_id,
      location,
      categoryIds,
      categories,
      created_at: row.item_created_at,
    });
  }
  return details;
}
