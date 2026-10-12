/**
 * M2 item persistence: parameterized CRUD plus atomic draft saves.
 *
 * Items reference exactly one location entity and zero-to-many categories
 * via the v2 `item_categories` join. All user text (including ids) travels
 * as bound `?` params; SQL sources are fixed strings. Inputs run through
 * the existing M1 domain normalization (`validateItemInput`, draft checks
 * below), so zero quantity stays valid, duplicate category ids are
 * rejected, and verbatim text is preserved.
 *
 * Reads return the `ItemDetail` read model (stored row plus the resolved
 * location entity and category list/ids). Every mutation runs inside the
 * driver's exclusive transaction on its scoped `txn` handle — never on the
 * outer db — so the item row, new related rows, and join writes commit or
 * roll back together with no orphan rows and no interleaved unrelated
 * writes. When the exclusive hook is absent the mutation fails closed with
 * a typed `storage` error instead of running non-atomically. Updates never
 * touch `created_at`. Location deletes stay `RESTRICT` (see
 * `./entityRepository`); deleting an item cascades only to its join rows.
 */
import type { RepositoryDb, RunResult, TransactionHandle } from './database';
import {
  assertUniqueCategoryName,
  assertUniqueLocationName,
} from './entityRepository';
import {
  EntityConflictError,
  EntityNotFoundError,
  isUniqueConstraintViolation,
  StorageError,
} from './errors';
import type {
  Category,
  ItemDetail,
  ItemDraftInput,
  Location,
  NewItemInput,
} from './types';
import {
  normalizeName,
  normalizeNameKey,
  normalizeQuantity,
  ValidationError,
  validateCategoryInput,
  validateId,
  validateItemInput,
  validateLocationInput,
} from './validation';

interface ItemRow {
  id: number;
  name: string;
  quantity: number;
  location_id: number;
  created_at: string;
}

interface LocationRow {
  id: number;
  name: string;
  address: string | null;
  created_at: string;
}

interface CategoryRow {
  id: number;
  name: string;
  created_at: string;
}

const ITEM_COLUMNS = 'id, name, quantity, location_id, created_at';
const LOCATION_COLUMNS = 'id, name, address, created_at';
const CATEGORY_COLUMNS = 'id, name, created_at';
const CATEGORY_JOIN_SELECT = `SELECT c.${CATEGORY_COLUMNS} FROM categories c JOIN item_categories jc ON jc.category_id = c.id WHERE jc.item_id = ? ORDER BY c.id ASC`;

function toLocation(row: LocationRow): Location {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    created_at: row.created_at,
  };
}

function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, created_at: row.created_at };
}

/**
 * Run a multi-statement mutation inside the driver's exclusive
 * transaction, issuing every query on the scoped `txn` handle. Typed
 * domain errors (including S11 `conflict`) pass through; driver failures
 * become generic `storage` errors that never embed raw SQLite text.
 * Missing hook fails closed.
 */
async function runExclusive(
  db: RepositoryDb,
  operation: string,
  task: (txn: TransactionHandle) => Promise<void>,
): Promise<void> {
  const exclusive = db.withExclusiveTransactionAsync;
  if (typeof exclusive !== 'function') {
    throw new StorageError(
      'item',
      operation,
      new Error('exclusive transaction unavailable'),
    );
  }
  try {
    await exclusive.call(db, task);
  } catch (error) {
    if (
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    throw new StorageError('item', operation, error);
  }
}

/** Fetch a location row inside a mutation; missing rows reject `not-found`. */
async function requireLocation(
  txn: RepositoryDb,
  locationId: number,
): Promise<LocationRow> {
  try {
    const row = await txn.getFirstAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM locations WHERE id = ?`,
      [locationId],
    );
    if (row === null) throw new EntityNotFoundError('location', locationId);
    return row;
  } catch (error) {
    if (error instanceof EntityNotFoundError) throw error;
    throw new StorageError('item', 'fetch', error);
  }
}

/** Fetch a category row inside a mutation; missing rows reject `not-found`. */
async function requireCategory(
  txn: RepositoryDb,
  categoryId: number,
): Promise<CategoryRow> {
  try {
    const row = await txn.getFirstAsync<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = ?`,
      [categoryId],
    );
    if (row === null) throw new EntityNotFoundError('category', categoryId);
    return row;
  } catch (error) {
    if (error instanceof EntityNotFoundError) throw error;
    throw new StorageError('item', 'fetch', error);
  }
}

/** Assemble the read model for a known item row (location + categories). */
async function detailForRow(
  db: RepositoryDb,
  row: ItemRow,
): Promise<ItemDetail> {
  try {
    const locationRow = await db.getFirstAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM locations WHERE id = ?`,
      [row.location_id],
    );
    if (locationRow === null) {
      throw new StorageError('item', 'fetch');
    }
    const categoryRows = await db.getAllAsync<CategoryRow>(
      CATEGORY_JOIN_SELECT,
      [row.id],
    );
    const categories = categoryRows.map(toCategory);
    return {
      id: row.id,
      name: row.name,
      quantity: row.quantity,
      locationId: row.location_id,
      location: toLocation(locationRow),
      categoryIds: categories.map((category) => category.id),
      categories,
      created_at: row.created_at,
    };
  } catch (error) {
    if (error instanceof EntityNotFoundError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('item', 'fetch', error);
  }
}

/** Fetch one item row; rejects `not-found` when the row is missing. */
async function requireItemRow(db: RepositoryDb, id: number): Promise<ItemRow> {
  try {
    const row = await db.getFirstAsync<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`,
      [id],
    );
    if (row === null) throw new EntityNotFoundError('item', id);
    return row;
  } catch (error) {
    if (error instanceof EntityNotFoundError) throw error;
    throw new StorageError('item', 'fetch', error);
  }
}

/** Replace an item's category set: delete-then-insert, zero allowed. */
async function replaceCategoryLinks(
  txn: TransactionHandle,
  itemId: number,
  categoryIds: number[],
): Promise<void> {
  await txn.runAsync('DELETE FROM item_categories WHERE item_id = ?', [itemId]);
  for (const categoryId of categoryIds) {
    await txn.runAsync(
      'INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)',
      [itemId, categoryId],
    );
  }
}

interface NormalizedDraft {
  name: string;
  quantity: number;
  locationId: number | null;
  newLocation: { name: string; address: string | null } | null;
  categoryIds: number[];
  newCategories: { name: string }[];
}

/**
 * Validate the full add/edit draft before any write or transaction
 * starts: item fields via the M1 rules, the location selector (exactly
 * one of an existing id or a new name/address), and the zero-to-many
 * category selectors. Duplicate existing category ids are rejected like
 * `validateItemInput` rejects them.
 */
function validateDraftInput(draft: ItemDraftInput): NormalizedDraft {
  if (draft === null || typeof draft !== 'object') {
    throw new ValidationError(
      'item',
      'invalid',
      'item must be an object with a name, quantity, and location.',
    );
  }
  const name = normalizeName(draft.name, 'name');
  const quantity = normalizeQuantity(draft.quantity);
  const selector = draft.location;
  if (selector === null || typeof selector !== 'object') {
    throw new ValidationError(
      'location',
      'missing',
      'every item must reference a valid location.',
    );
  }
  let locationId: number | null = null;
  let newLocation: NormalizedDraft['newLocation'] = null;
  if (selector.kind === 'existing') {
    locationId = validateId(selector.locationId, 'locationId');
  } else if (selector.kind === 'new') {
    newLocation = validateLocationInput(selector.location);
  } else {
    throw new ValidationError(
      'location',
      'invalid',
      'location must select an existing id or a new name/address.',
    );
  }
  const raw = draft.categories ?? [];
  if (!Array.isArray(raw)) {
    throw new ValidationError(
      'categories',
      'invalid',
      'categories must be an array of existing/new category selectors.',
    );
  }
  const categoryIds: number[] = [];
  const newCategories: { name: string }[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      throw new ValidationError(
        'categories',
        'invalid',
        'each category must select an existing id or a new name.',
      );
    }
    if (entry.kind === 'existing') {
      categoryIds.push(validateId(entry.categoryId, 'categories'));
    } else if (entry.kind === 'new') {
      newCategories.push(validateCategoryInput(entry.category));
    } else {
      throw new ValidationError(
        'categories',
        'invalid',
        'each category must select an existing id or a new name.',
      );
    }
  }
  if (new Set(categoryIds).size !== categoryIds.length) {
    throw new ValidationError(
      'categories',
      'duplicate',
      'categories must not select the same existing category twice.',
    );
  }
  return {
    name,
    quantity,
    locationId,
    newLocation,
    categoryIds,
    newCategories,
  };
}

/**
 * Resolve a validated draft inside the transaction: reuse the existing
 * location/categories after confirming they exist, or insert the new
 * ones. New names pass the S11 domain uniqueness check first (against
 * stored rows and, for categories, against each other); the v3 `UNIQUE`
 * index stays the authority for races and its violations map to the same
 * typed `conflict`. Every statement runs on `txn`, so any failure rolls
 * back with no orphan item, location, or category rows.
 */
async function resolveDraftRelations(
  txn: TransactionHandle,
  draft: NormalizedDraft,
): Promise<{ locationId: number; categoryIds: number[] }> {
  let locationId: number;
  if (draft.locationId !== null) {
    await requireLocation(txn, draft.locationId);
    locationId = draft.locationId;
  } else if (draft.newLocation !== null) {
    const newLocationName = draft.newLocation.name;
    await assertUniqueLocationName(txn, newLocationName);
    let created: RunResult;
    try {
      created = await txn.runAsync(
        'INSERT INTO locations (name, address) VALUES (?, ?)',
        [draft.newLocation.name, draft.newLocation.address],
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new EntityConflictError('location', newLocationName);
      }
      throw error;
    }
    locationId = created.lastInsertRowId;
    await requireLocation(txn, locationId);
  } else {
    throw new ValidationError(
      'location',
      'missing',
      'every item must reference a valid location.',
    );
  }
  const categoryIds: number[] = [];
  for (const categoryId of draft.categoryIds) {
    await requireCategory(txn, categoryId);
    categoryIds.push(categoryId);
  }
  const seenNewCategoryKeys = new Set<string>();
  for (const category of draft.newCategories) {
    await assertUniqueCategoryName(txn, category.name);
    const key = normalizeNameKey(category.name);
    if (seenNewCategoryKeys.has(key)) {
      throw new EntityConflictError('category', category.name);
    }
    seenNewCategoryKeys.add(key);
    let created: RunResult;
    try {
      created = await txn.runAsync('INSERT INTO categories (name) VALUES (?)', [
        category.name,
      ]);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new EntityConflictError('category', category.name);
      }
      throw error;
    }
    await requireCategory(txn, created.lastInsertRowId);
    categoryIds.push(created.lastInsertRowId);
  }
  return { locationId, categoryIds };
}

/**
 * Create an item with an explicit location id and category id set.
 * Runs atomically: missing references reject typed `not-found` with
 * no partial rows.
 */
export async function createItem(
  db: RepositoryDb,
  input: NewItemInput,
): Promise<ItemDetail> {
  const normalized = validateItemInput(input);
  let detail: ItemDetail | null = null;
  await runExclusive(db, 'create', async (txn) => {
    await requireLocation(txn, normalized.locationId);
    for (const categoryId of normalized.categoryIds) {
      await requireCategory(txn, categoryId);
    }
    const created = await txn.runAsync(
      'INSERT INTO items (name, quantity, location_id) VALUES (?, ?, ?)',
      [normalized.name, normalized.quantity, normalized.locationId],
    );
    await replaceCategoryLinks(
      txn,
      created.lastInsertRowId,
      normalized.categoryIds,
    );
    detail = await detailForRow(
      txn,
      await requireItemRow(txn, created.lastInsertRowId),
    );
  });
  if (detail === null) throw new StorageError('item', 'create');
  return detail;
}

/** Fetch one item with its location and categories. */
export async function getItem(
  db: RepositoryDb,
  id: number,
): Promise<ItemDetail> {
  const validId = validateId(id, 'id');
  return detailForRow(db, await requireItemRow(db, validId));
}

/** List items in insertion order with their locations and categories. */
export async function listItems(db: RepositoryDb): Promise<ItemDetail[]> {
  try {
    const rows = await db.getAllAsync<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items ORDER BY id ASC`,
    );
    const details: ItemDetail[] = [];
    for (const row of rows) {
      details.push(await detailForRow(db, row));
    }
    return details;
  } catch (error) {
    if (error instanceof EntityNotFoundError || error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('item', 'list', error);
  }
}

/**
 * Update an item (full replacement including its category set) without
 * changing `created_at`. Missing rows or references reject typed
 * `not-found`; the category delete+insert is atomic.
 */
export async function updateItem(
  db: RepositoryDb,
  id: number,
  input: NewItemInput,
): Promise<ItemDetail> {
  const validId = validateId(id, 'id');
  const normalized = validateItemInput(input);
  let detail: ItemDetail | null = null;
  await runExclusive(db, 'update', async (txn) => {
    await requireItemRow(txn, validId);
    await requireLocation(txn, normalized.locationId);
    for (const categoryId of normalized.categoryIds) {
      await requireCategory(txn, categoryId);
    }
    await txn.runAsync(
      'UPDATE items SET name = ?, quantity = ?, location_id = ? WHERE id = ?',
      [normalized.name, normalized.quantity, normalized.locationId, validId],
    );
    await replaceCategoryLinks(txn, validId, normalized.categoryIds);
    detail = await detailForRow(txn, await requireItemRow(txn, validId));
  });
  if (detail === null) throw new StorageError('item', 'update');
  return detail;
}

/**
 * Delete an item; its join rows cascade per the v2 schema while
 * locations and categories survive. Missing rows reject `not-found`.
 */
export async function deleteItem(db: RepositoryDb, id: number): Promise<void> {
  const validId = validateId(id, 'id');
  await runExclusive(db, 'delete', async (txn) => {
    const result = await txn.runAsync('DELETE FROM items WHERE id = ?', [
      validId,
    ]);
    if (result.changes === 0) {
      throw new EntityNotFoundError('item', validId);
    }
  });
}

/**
 * Create an item from an add-form draft, atomically inserting a new
 * location and/or new categories first when the draft selects them.
 * The whole draft is validated before the transaction starts; any
 * invalid/missing reference or write failure rolls back with no orphan
 * item, location, or category rows.
 */
export async function createItemFromDraft(
  db: RepositoryDb,
  draft: ItemDraftInput,
): Promise<ItemDetail> {
  const normalized = validateDraftInput(draft);
  let detail: ItemDetail | null = null;
  await runExclusive(db, 'create', async (txn) => {
    const relations = await resolveDraftRelations(txn, normalized);
    const created = await txn.runAsync(
      'INSERT INTO items (name, quantity, location_id) VALUES (?, ?, ?)',
      [normalized.name, normalized.quantity, relations.locationId],
    );
    await replaceCategoryLinks(
      txn,
      created.lastInsertRowId,
      relations.categoryIds,
    );
    detail = await detailForRow(
      txn,
      await requireItemRow(txn, created.lastInsertRowId),
    );
  });
  if (detail === null) throw new StorageError('item', 'create');
  return detail;
}

/**
 * Update an item from an edit-form draft with the same atomic
 * new-related-entity semantics as creation. `created_at` is preserved.
 */
export async function updateItemFromDraft(
  db: RepositoryDb,
  id: number,
  draft: ItemDraftInput,
): Promise<ItemDetail> {
  const validId = validateId(id, 'id');
  const normalized = validateDraftInput(draft);
  let detail: ItemDetail | null = null;
  await runExclusive(db, 'update', async (txn) => {
    await requireItemRow(txn, validId);
    const relations = await resolveDraftRelations(txn, normalized);
    await txn.runAsync(
      'UPDATE items SET name = ?, quantity = ?, location_id = ? WHERE id = ?',
      [normalized.name, normalized.quantity, relations.locationId, validId],
    );
    await replaceCategoryLinks(txn, validId, relations.categoryIds);
    detail = await detailForRow(txn, await requireItemRow(txn, validId));
  });
  if (detail === null) throw new StorageError('item', 'update');
  return detail;
}
