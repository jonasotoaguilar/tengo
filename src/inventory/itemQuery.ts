/**
 * P3a bounded item query/read model (host-fake unit; real SQLite proof is P3b).
 *
 * `queryItems(db, filter)` returns the `ItemDetail` read model with at most
 * two SQL reads regardless of N: one `items JOIN locations` select
 * (optional parameterized `location_id` WHERE, `ORDER BY item id ASC`,
 * every column aliased so `id`/`name` never collide), then — only when item
 * rows exist — one `item_categories JOIN categories` select that reads all
 * links once (`ORDER BY item/category id ASC`) so no unbounded `IN (?,…)`
 * list is ever built. Name search and the category-OR target set filter
 * locally in JS.
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
 * follow the existing read behavior and drop from the list. Driver
 * failures become generic `StorageError('item', 'query')` with `cause`.
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

interface ItemLocationRow {
  item_id: number;
  item_name: string;
  item_quantity: number;
  item_location_id: number;
  item_created_at: string;
  location_id: number;
  location_name: string;
  location_address: string | null;
  location_created_at: string;
}

interface CategoryLinkRow {
  link_item_id: number;
  category_id: number;
  category_name: string;
  category_created_at: string;
}

const ITEM_LOCATION_BASE =
  'SELECT i.id AS item_id, i.name AS item_name, i.quantity AS item_quantity, ' +
  'i.location_id AS item_location_id, i.created_at AS item_created_at, ' +
  'l.id AS location_id, l.name AS location_name, l.address AS location_address, ' +
  'l.created_at AS location_created_at ' +
  'FROM items i JOIN locations l ON l.id = i.location_id';

const CATEGORY_LINKS_SELECT =
  'SELECT jc.item_id AS link_item_id, c.id AS category_id, c.name AS category_name, ' +
  'c.created_at AS category_created_at ' +
  'FROM item_categories jc JOIN categories c ON c.id = jc.category_id ' +
  'ORDER BY jc.item_id ASC, c.id ASC';

/**
 * Query items with bounded reads (max two `getAllAsync` calls): the joined
 * item/location page plus one batched category-link read, then local JS
 * name-substring (Unicode lowercase, literal `%_\\`) and category-OR
 * filtering. Item order is stable `id ASC`; categories are `id ASC` with
 * `categoryIds` matching the entity list. Quantity zero is preserved.
 */
export async function queryItems(
  db: RepositoryDb,
  filter: ItemFilter = {},
): Promise<ItemDetail[]> {
  const normalized = normalizeItemFilter(filter);
  let itemRows: ItemLocationRow[];
  try {
    if (normalized.locationId === null) {
      itemRows = await db.getAllAsync<ItemLocationRow>(
        `${ITEM_LOCATION_BASE} ORDER BY i.id ASC`,
      );
    } else {
      itemRows = await db.getAllAsync<ItemLocationRow>(
        `${ITEM_LOCATION_BASE} WHERE i.location_id = ? ORDER BY i.id ASC`,
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

  let linkRows: CategoryLinkRow[];
  try {
    linkRows = await db.getAllAsync<CategoryLinkRow>(CATEGORY_LINKS_SELECT);
  } catch (error) {
    if (error instanceof ValidationError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('item', 'query', error);
  }

  const byItem = new Map<number, Category[]>();
  for (const link of linkRows) {
    const list = byItem.get(link.link_item_id) ?? [];
    list.push({
      id: link.category_id,
      name: link.category_name,
      created_at: link.category_created_at,
    });
    byItem.set(link.link_item_id, list);
  }

  const queryLower = normalized.query?.toLowerCase() ?? null;
  const wanted =
    normalized.categoryIds.length > 0 ? new Set(normalized.categoryIds) : null;

  const details: ItemDetail[] = [];
  for (const row of itemRows) {
    const categories = byItem.get(row.item_id) ?? [];
    const categoryIds = categories.map((category) => category.id);
    const location: Location = {
      id: row.location_id,
      name: row.location_name,
      address: row.location_address,
      created_at: row.location_created_at,
    };
    const detail: ItemDetail = {
      id: row.item_id,
      name: row.item_name,
      quantity: row.item_quantity,
      locationId: row.item_location_id,
      location,
      categoryIds,
      categories,
      created_at: row.item_created_at,
    };
    if (queryLower !== null) {
      if (!detail.name.toLowerCase().includes(queryLower)) continue;
    }
    if (wanted !== null) {
      if (!detail.categoryIds.some((id) => wanted.has(id))) continue;
    }
    details.push(detail);
  }
  return details;
}
