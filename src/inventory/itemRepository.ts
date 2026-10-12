/**
 * Item persistence over catalog + stock: parameterized CRUD plus atomic
 * draft saves.
 *
 * Items are catalog rows (identity: `id, name, created_at`) with zero or
 * more `stock(item_id, location_id, quantity)` rows plus zero-to-many
 * categories via the `item_categories` join. One item may hold stock in
 * many locations; the read model returns it ONCE with its per-location
 * breakdown and total (R2). An item with no stock rows stays visible as
 * "sin stock" with total 0 (R6). All user text (including ids) travels as
 * bound `?` params; SQL sources are fixed strings. Inputs run through the
 * existing M1 domain normalization (`validateItemInput`, draft checks
 * below), so 0-quantity rows are dropped rather than stored, duplicate
 * location ids are rejected, every stock quantity honors the S10 bounds,
 * and verbatim text is preserved.
 *
 * Reads return the `ItemDetail` read model (catalog row plus the stock
 * breakdown with resolved locations plus the category list/ids). Every
 * mutation runs inside the driver's exclusive transaction on its scoped
 * `txn` handle — never on the outer db — so the item row, stock rows,
 * new related rows, and join writes commit or roll back together with no
 * orphan rows and no interleaved unrelated writes. When the exclusive
 * hook is absent the mutation fails closed with a typed `storage` error
 * instead of running non-atomically. Updates never touch `created_at`.
 * Deleting a location cascades only its stock rows (see
 * `./entityRepository`); deleting an item cascades its stock and join
 * rows while locations and categories survive.
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
  ItemStockDraft,
  NewItemInput,
  StockLevel,
} from './types';
import {
  type NormalizedItemStockInput,
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

interface StockJoinRow {
  quantity: number;
  location_id: number;
  location_name: string;
  location_address: string | null;
  location_created_at: string;
}

const ITEM_COLUMNS = 'id, name, created_at';
const LOCATION_COLUMNS = 'id, name, address, created_at';
const CATEGORY_COLUMNS = 'id, name, created_at';
const CATEGORY_JOIN_SELECT = `SELECT c.${CATEGORY_COLUMNS} FROM categories c JOIN item_categories jc ON jc.category_id = c.id WHERE jc.item_id = ? ORDER BY c.id ASC`;
const STOCK_JOIN_SELECT =
  'SELECT s.quantity AS quantity, l.id AS location_id, l.name AS location_name, ' +
  'l.address AS location_address, l.created_at AS location_created_at ' +
  'FROM stock s JOIN locations l ON l.id = s.location_id ' +
  'WHERE s.item_id = ? ORDER BY l.id ASC';

function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, created_at: row.created_at };
}

function toStockLevel(row: StockJoinRow): StockLevel {
  return {
    locationId: row.location_id,
    location: {
      id: row.location_id,
      name: row.location_name,
      address: row.location_address,
      created_at: row.location_created_at,
    },
    quantity: row.quantity,
  };
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
      error instanceof StorageError ||
      error instanceof ValidationError
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

/** Assemble the read model for a known item row (stock + categories). */
async function detailForRow(
  db: RepositoryDb,
  row: ItemRow,
): Promise<ItemDetail> {
  try {
    const stockRows = await db.getAllAsync<StockJoinRow>(STOCK_JOIN_SELECT, [
      row.id,
    ]);
    const stock = stockRows.map(toStockLevel);
    const categoryRows = await db.getAllAsync<CategoryRow>(
      CATEGORY_JOIN_SELECT,
      [row.id],
    );
    const categories = categoryRows.map(toCategory);
    return {
      id: row.id,
      name: row.name,
      stock,
      totalQuantity: stock.reduce((sum, level) => sum + level.quantity, 0),
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

/** Replace an item's stock set: delete-then-insert, zero rows allowed. */
async function replaceStockRows(
  txn: TransactionHandle,
  itemId: number,
  stock: NormalizedItemStockInput[],
): Promise<void> {
  await txn.runAsync('DELETE FROM stock WHERE item_id = ?', [itemId]);
  for (const row of stock) {
    await txn.runAsync(
      'INSERT INTO stock (item_id, location_id, quantity) VALUES (?, ?, ?)',
      [itemId, row.locationId, row.quantity],
    );
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

interface NormalizedStockDraft {
  locationId: number | null;
  newLocation: { name: string; address: string | null } | null;
  quantity: number;
}

interface NormalizedDraft {
  name: string;
  stock: NormalizedStockDraft[];
  categoryIds: number[];
  newCategories: { name: string }[];
}

/** Validate one draft stock row: a location selector plus an S10 quantity. */
function validateStockDraft(entry: ItemStockDraft): NormalizedStockDraft {
  if (entry === null || typeof entry !== 'object') {
    throw new ValidationError(
      'stock',
      'invalid',
      'each stock row must carry a location selector and a quantity.',
    );
  }
  const quantity = normalizeQuantity(entry.quantity);
  const selector = entry.location;
  if (selector === null || typeof selector !== 'object') {
    throw new ValidationError(
      'location',
      'missing',
      'every stock row must reference a valid location.',
    );
  }
  if (selector.kind === 'existing') {
    return {
      locationId: validateId(selector.locationId, 'locationId'),
      newLocation: null,
      quantity,
    };
  }
  if (selector.kind === 'new') {
    return {
      locationId: null,
      newLocation: validateLocationInput(selector.location),
      quantity,
    };
  }
  throw new ValidationError(
    'location',
    'invalid',
    'location must select an existing id or a new name/address.',
  );
}

/**
 * Validate the full add/edit draft before any write or transaction
 * starts: item name via the M1 rules, every stock row (location selector
 * plus quantity), and the zero-to-many category selectors. Duplicate
 * existing location ids across stock rows are rejected like
 * `validateItemInput` rejects them; duplicate existing category ids
 * likewise. Zero-quantity rows are dropped here, so a new location that
 * only a zero row references is never created.
 */
function validateDraftInput(draft: ItemDraftInput): NormalizedDraft {
  if (draft === null || typeof draft !== 'object') {
    throw new ValidationError(
      'item',
      'invalid',
      'item must be an object with a name and stock rows.',
    );
  }
  const name = normalizeName(draft.name, 'name');
  const rawStock = draft.stock === undefined ? [] : draft.stock;
  if (!Array.isArray(rawStock)) {
    throw new ValidationError(
      'stock',
      'invalid',
      'stock must be an array of location/quantity rows.',
    );
  }
  const validatedStock = rawStock.map((entry) => validateStockDraft(entry));
  const existingIds = validatedStock
    .map((row) => row.locationId)
    .filter((id): id is number => id !== null);
  if (new Set(existingIds).size !== existingIds.length) {
    throw new ValidationError(
      'stock',
      'duplicate',
      'stock must not reference the same existing location twice.',
    );
  }
  // Drop zero rows before resolution: "no hay nada acá" stores nothing,
  // and a would-be-new location referenced only by a zero row is never
  // created.
  const stock = validatedStock.filter((row) => row.quantity > 0);
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
  return { name, stock, categoryIds, newCategories };
}

/**
 * Resolve every stock row's location (existing or newly created) plus
 * the category set inside the same exclusive transaction, so an item
 * with three new locations either commits all three or none. New names
 * pass the S11 domain uniqueness check first (against stored rows and,
 * for categories, against each other); the v3 `UNIQUE` index stays the
 * authority for races and its violations map to the same typed
 * `conflict`. Every statement runs on `txn`, so any failure rolls back
 * with no orphan item, location, category, or stock rows.
 */
async function resolveDraftRelations(
  txn: TransactionHandle,
  draft: NormalizedDraft,
): Promise<{
  stock: NormalizedItemStockInput[];
  categoryIds: number[];
}> {
  const stock: NormalizedItemStockInput[] = [];
  const seenNewLocationKeys = new Set<string>();
  for (const row of draft.stock) {
    if (row.locationId !== null) {
      await requireLocation(txn, row.locationId);
      stock.push({ locationId: row.locationId, quantity: row.quantity });
    } else if (row.newLocation !== null) {
      const newLocationName = row.newLocation.name;
      await assertUniqueLocationName(txn, newLocationName);
      const key = normalizeNameKey(newLocationName);
      if (seenNewLocationKeys.has(key)) {
        throw new EntityConflictError('location', newLocationName);
      }
      seenNewLocationKeys.add(key);
      let created: RunResult;
      try {
        created = await txn.runAsync(
          'INSERT INTO locations (name, address) VALUES (?, ?)',
          [row.newLocation.name, row.newLocation.address],
        );
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new EntityConflictError('location', newLocationName);
        }
        throw error;
      }
      await requireLocation(txn, created.lastInsertRowId);
      stock.push({
        locationId: created.lastInsertRowId,
        quantity: row.quantity,
      });
    } else {
      throw new ValidationError(
        'location',
        'missing',
        'every stock row must reference a valid location.',
      );
    }
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
  return { stock, categoryIds };
}

/**
 * Create an item with a per-location stock set and category id set.
 * Runs atomically: missing references reject typed `not-found` with
 * no partial rows. Zero-quantity rows never reach the database (dropped
 * by validation); a stockless payload creates a catalog-only item.
 */
export async function createItem(
  db: RepositoryDb,
  input: NewItemInput,
): Promise<ItemDetail> {
  const normalized = validateItemInput(input);
  let detail: ItemDetail | null = null;
  await runExclusive(db, 'create', async (txn) => {
    for (const row of normalized.stock) {
      await requireLocation(txn, row.locationId);
    }
    for (const categoryId of normalized.categoryIds) {
      await requireCategory(txn, categoryId);
    }
    const created = await txn.runAsync('INSERT INTO items (name) VALUES (?)', [
      normalized.name,
    ]);
    await replaceStockRows(txn, created.lastInsertRowId, normalized.stock);
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

/** Fetch one item with its stock breakdown and categories. */
export async function getItem(
  db: RepositoryDb,
  id: number,
): Promise<ItemDetail> {
  const validId = validateId(id, 'id');
  return detailForRow(db, await requireItemRow(db, validId));
}

/** List items in insertion order with their stock breakdowns and categories. */
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
 * Update an item (full replacement of name, stock set, and category set)
 * without changing `created_at`. Missing rows or references reject typed
 * `not-found`; the stock/category delete+insert is atomic. An empty stock
 * set leaves a catalog-only (sin stock) item.
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
    for (const row of normalized.stock) {
      await requireLocation(txn, row.locationId);
    }
    for (const categoryId of normalized.categoryIds) {
      await requireCategory(txn, categoryId);
    }
    await txn.runAsync('UPDATE items SET name = ? WHERE id = ?', [
      normalized.name,
      validId,
    ]);
    await replaceStockRows(txn, validId, normalized.stock);
    await replaceCategoryLinks(txn, validId, normalized.categoryIds);
    detail = await detailForRow(txn, await requireItemRow(txn, validId));
  });
  if (detail === null) throw new StorageError('item', 'update');
  return detail;
}

/**
 * Delete an item; its stock and join rows cascade per the v4 schema
 * while locations and categories survive. Missing rows reject `not-found`.
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
 * Create an item from an add-form draft, atomically resolving every
 * stock row's location (existing or new) and new categories first. The
 * whole draft is validated before the transaction starts; any
 * invalid/missing reference or write failure rolls back with no orphan
 * item, location, category, or stock rows.
 */
export async function createItemFromDraft(
  db: RepositoryDb,
  draft: ItemDraftInput,
): Promise<ItemDetail> {
  const normalized = validateDraftInput(draft);
  let detail: ItemDetail | null = null;
  await runExclusive(db, 'create', async (txn) => {
    const relations = await resolveDraftRelations(txn, normalized);
    const created = await txn.runAsync('INSERT INTO items (name) VALUES (?)', [
      normalized.name,
    ]);
    await replaceStockRows(txn, created.lastInsertRowId, relations.stock);
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
    await txn.runAsync('UPDATE items SET name = ? WHERE id = ?', [
      normalized.name,
      validId,
    ]);
    await replaceStockRows(txn, validId, relations.stock);
    await replaceCategoryLinks(txn, validId, relations.categoryIds);
    detail = await detailForRow(txn, await requireItemRow(txn, validId));
  });
  if (detail === null) throw new StorageError('item', 'update');
  return detail;
}
