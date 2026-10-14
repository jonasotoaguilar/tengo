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
 * and verbatim text is preserved. The U2 scanner/reminder base rides the
 * same paths: an optional `low_stock_threshold` and `barcode` per catalog
 * row (one code maps to one item via the v5 UNIQUE index; NULLs never
 * collide) plus an optional `expires_on` per stock row, all validated by
 * the U2 normalizers. `findItemByBarcode` is the scanner lookup (null
 * when the code is unknown).
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
import type { BindParams, RepositoryDb, TransactionHandle } from './database';
import {
  assertUniqueCategoryNames,
  assertUniqueLocationNames,
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
  normalizeBarcode,
  normalizeExpiresOn,
  normalizeLowStockThreshold,
  normalizeName,
  normalizeNameKey,
  normalizeQuantity,
  ValidationError,
  validateCategoryInput,
  validateId,
  validateItemInput,
  validateLocationInput,
} from './validation';

/**
 * T5: only driver/storage failures map to `StorageError`. Programming
 * errors (`TypeError` and siblings) and non-`Error` throws are unexpected,
 * so they propagate unchanged instead of surfacing as "storage unavailable".
 */
function isUnexpectedError(error: unknown): boolean {
  if (
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof URIError ||
    error instanceof EvalError
  ) {
    return true;
  }
  return !(error instanceof Error);
}

interface ItemRow {
  id: number;
  name: string;
  low_stock_threshold: number | null;
  barcode: string | null;
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
  expires_on: string | null;
}

const ITEM_COLUMNS = 'id, name, low_stock_threshold, barcode, created_at';
const LOCATION_COLUMNS = 'id, name, address, created_at';
const CATEGORY_COLUMNS = 'id, name, created_at';
const CATEGORY_JOIN_SELECT = `SELECT c.${CATEGORY_COLUMNS} FROM categories c JOIN item_categories jc ON jc.category_id = c.id WHERE jc.item_id = ? ORDER BY c.id ASC`;
const STOCK_JOIN_SELECT =
  'SELECT s.quantity AS quantity, l.id AS location_id, l.name AS location_name, ' +
  'l.address AS location_address, l.created_at AS location_created_at, ' +
  's.expires_on AS expires_on ' +
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
    // Pre-v5 rows (and host fakes shaped before v5) carry no alias:
    // the additive column reads as null, never as a hole.
    expiresOn: row.expires_on ?? null,
  };
}

/**
 * Optional shared-connection hook (see `src/db/exclusive.ts`): when the
 * database reuses one FK-enforced isolated connection across mutations,
 * item writes take it; otherwise they use the classic per-mutation hook.
 * Both paths give one exclusive transaction per mutation with identical
 * atomicity and error mapping.
 */
interface SharedExclusiveDb extends RepositoryDb {
  withSharedExclusiveTransactionAsync?: (
    task: (txn: TransactionHandle) => Promise<void>,
  ) => Promise<void>;
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
  const shared = (db as SharedExclusiveDb).withSharedExclusiveTransactionAsync;
  const hook =
    typeof shared === 'function' ? shared : db.withExclusiveTransactionAsync;
  if (typeof hook !== 'function') {
    throw new StorageError(
      'item',
      operation,
      new Error('exclusive transaction unavailable'),
    );
  }
  try {
    await hook.call(db, task);
  } catch (error) {
    if (
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError ||
      error instanceof ValidationError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('item', operation, error);
  }
}

/**
 * T3 write-path batching: SQLite historically caps bound variables per
 * statement (999), so multi-row statements and `IN` lists are chunked
 * well below it. Draft payloads are small; the chunks only matter for
 * unbounded programmatic writes, which must not break on old drivers.
 */
const INSERT_ROWS_PER_STATEMENT = 200;
const EXISTENCE_IDS_PER_SELECT = 500;

/** Split rows into statement-sized groups; an empty input yields no groups. */
function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    groups.push(values.slice(i, i + size));
  }
  return groups;
}

/**
 * Fetch every location id with ONE `IN` select per chunk (T3 batching).
 * Missing ids reject `not-found` in input order, exactly like the
 * sequential per-row checks did. An empty input issues no statement.
 */
async function requireLocations(
  txn: TransactionHandle,
  locationIds: number[],
): Promise<Map<number, LocationRow>> {
  const unique = [...new Set(locationIds)];
  const found = new Map<number, LocationRow>();
  for (const group of chunk(unique, EXISTENCE_IDS_PER_SELECT)) {
    const placeholders = group.map(() => '?').join(', ');
    let rows: LocationRow[];
    try {
      rows = await txn.getAllAsync<LocationRow>(
        `SELECT ${LOCATION_COLUMNS} FROM locations WHERE id IN (${placeholders})`,
        [...group],
      );
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof EntityNotFoundError ||
        error instanceof EntityConflictError ||
        error instanceof StorageError
      ) {
        throw error;
      }
      if (isUnexpectedError(error)) throw error;
      throw new StorageError('item', 'fetch', error);
    }
    for (const row of rows) found.set(row.id, row);
  }
  for (const id of unique) {
    if (!found.has(id)) throw new EntityNotFoundError('location', id);
  }
  return found;
}

/**
 * Fetch every category id with ONE `IN` select per chunk (T3 batching).
 * Missing ids reject `not-found` in input order. Empty input: no statement.
 */
async function requireCategories(
  txn: TransactionHandle,
  categoryIds: number[],
): Promise<Map<number, CategoryRow>> {
  const unique = [...new Set(categoryIds)];
  const found = new Map<number, CategoryRow>();
  for (const group of chunk(unique, EXISTENCE_IDS_PER_SELECT)) {
    const placeholders = group.map(() => '?').join(', ');
    let rows: CategoryRow[];
    try {
      rows = await txn.getAllAsync<CategoryRow>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id IN (${placeholders})`,
        [...group],
      );
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof EntityNotFoundError ||
        error instanceof EntityConflictError ||
        error instanceof StorageError
      ) {
        throw error;
      }
      if (isUnexpectedError(error)) throw error;
      throw new StorageError('item', 'fetch', error);
    }
    for (const row of rows) found.set(row.id, row);
  }
  for (const id of unique) {
    if (!found.has(id)) throw new EntityNotFoundError('category', id);
  }
  return found;
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
      // Additive v5 columns read as null when absent (pre-v5 rows,
      // legacy fakes, or an item that simply has no reminder/code).
      lowStockThreshold: row.low_stock_threshold ?? null,
      barcode: row.barcode ?? null,
      stock,
      totalQuantity: stock.reduce((sum, level) => sum + level.quantity, 0),
      categoryIds: categories.map((category) => category.id),
      categories,
      created_at: row.created_at,
    };
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityNotFoundError ||
      error instanceof EntityConflictError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
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
    if (
      error instanceof ValidationError ||
      error instanceof EntityNotFoundError ||
      error instanceof EntityConflictError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('item', 'fetch', error);
  }
}

/**
 * Replace an item's stock set: one DELETE plus one multi-row INSERT per
 * chunk (T3 batching); zero rows allowed. The single INSERT keeps the
 * UNIQUE backstop on `(item_id, location_id)` exactly as before; v5
 * appends the optional expiry to each row group.
 */
async function replaceStockRows(
  txn: TransactionHandle,
  itemId: number,
  stock: NormalizedItemStockInput[],
): Promise<void> {
  await txn.runAsync('DELETE FROM stock WHERE item_id = ?', [itemId]);
  for (const group of chunk(stock, INSERT_ROWS_PER_STATEMENT)) {
    const placeholders = group.map(() => '(?, ?, ?, ?)').join(', ');
    const params: (string | number | null)[] = [];
    for (const row of group) {
      params.push(itemId, row.locationId, row.quantity, row.expiresOn);
    }
    await txn.runAsync(
      `INSERT INTO stock (item_id, location_id, quantity, expires_on) VALUES ${placeholders}`,
      params,
    );
  }
}

/**
 * U2 barcode identity: one code maps to one item (v5 UNIQUE index).
 * The table name is a fixed literal, the code a bound param. Throws
 * `EntityConflictError('item', ...)` for another row's code; `excludeId`
 * keeps an update's own barcode (same pattern as the S11 asserts).
 */
async function assertUniqueItemBarcode(
  db: RepositoryDb | TransactionHandle,
  barcode: string,
  excludeId?: number,
): Promise<void> {
  const row = await db.getFirstAsync<{ id: number }>(
    'SELECT id FROM items WHERE barcode = ?',
    [barcode],
  );
  if (row !== null && row.id !== excludeId) {
    throw new EntityConflictError('item', barcode);
  }
}

/**
 * Insert one catalog row with its U2 fields. A stored collision the
 * domain pre-check cannot see (a race) maps from the driver's UNIQUE
 * failure to the same typed `conflict`, never raw SQLite text.
 */
async function insertCatalogRow(
  txn: TransactionHandle,
  name: string,
  lowStockThreshold: number | null,
  barcode: string | null,
): Promise<number> {
  if (barcode !== null) await assertUniqueItemBarcode(txn, barcode);
  const params: BindParams = [name, lowStockThreshold, barcode];
  try {
    const created = await txn.runAsync(
      'INSERT INTO items (name, low_stock_threshold, barcode) VALUES (?, ?, ?)',
      params,
    );
    return created.lastInsertRowId;
  } catch (error) {
    if (barcode !== null && isUniqueConstraintViolation(error)) {
      throw new EntityConflictError('item', barcode);
    }
    throw error;
  }
}

/**
 * Update one catalog row's name and U2 fields (`created_at` preserved).
 * Same conflict mapping as the insert; keeping the row's own barcode is
 * not a conflict.
 */
async function updateCatalogRow(
  txn: TransactionHandle,
  id: number,
  name: string,
  lowStockThreshold: number | null,
  barcode: string | null,
): Promise<void> {
  if (barcode !== null) await assertUniqueItemBarcode(txn, barcode, id);
  const params: BindParams = [name, lowStockThreshold, barcode, id];
  try {
    await txn.runAsync(
      'UPDATE items SET name = ?, low_stock_threshold = ?, barcode = ? WHERE id = ?',
      params,
    );
  } catch (error) {
    if (barcode !== null && isUniqueConstraintViolation(error)) {
      throw new EntityConflictError('item', barcode);
    }
    throw error;
  }
}

/**
 * Replace an item's category set: one DELETE plus one multi-row INSERT
 * per chunk (T3 batching); zero links allowed.
 */
async function replaceCategoryLinks(
  txn: TransactionHandle,
  itemId: number,
  categoryIds: number[],
): Promise<void> {
  await txn.runAsync('DELETE FROM item_categories WHERE item_id = ?', [itemId]);
  for (const group of chunk(categoryIds, INSERT_ROWS_PER_STATEMENT)) {
    const placeholders = group.map(() => '(?, ?)').join(', ');
    const params: (string | number | null)[] = [];
    for (const categoryId of group) {
      params.push(itemId, categoryId);
    }
    await txn.runAsync(
      `INSERT INTO item_categories (item_id, category_id) VALUES ${placeholders}`,
      params,
    );
  }
}

interface NormalizedStockDraft {
  locationId: number | null;
  newLocation: { name: string; address: string | null } | null;
  quantity: number;
  expiresOn: string | null;
}

interface NormalizedDraft {
  name: string;
  lowStockThreshold: number | null;
  barcode: string | null;
  stock: NormalizedStockDraft[];
  categoryIds: number[];
  newCategories: { name: string }[];
}

/**
 * Validate one draft stock row: a location selector, an S10 quantity,
 * and an optional ISO expiry.
 */
function validateStockDraft(entry: ItemStockDraft): NormalizedStockDraft {
  if (entry === null || typeof entry !== 'object') {
    throw new ValidationError(
      'stock',
      'invalid',
      'each stock row must carry a location selector and a quantity.',
    );
  }
  const quantity = normalizeQuantity(entry.quantity);
  const expiresOn = normalizeExpiresOn(entry.expiresOn);
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
      expiresOn,
    };
  }
  if (selector.kind === 'new') {
    return {
      locationId: null,
      newLocation: validateLocationInput(selector.location),
      quantity,
      expiresOn,
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
  const lowStockThreshold = normalizeLowStockThreshold(draft.lowStockThreshold);
  const barcode = normalizeBarcode(draft.barcode);
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
  return {
    name,
    lowStockThreshold,
    barcode,
    stock,
    categoryIds,
    newCategories,
  };
}

/**
 * Create every new draft location with ONE domain uniqueness scan, ONE
 * multi-row INSERT per chunk, and ONE id resolve per chunk (T3). Stored
 * collisions and within-draft duplicates map to the same typed
 * `conflict` as the sequential path; the v3 `UNIQUE` index stays the
 * race authority with identical mapping (first candidate name carried).
 * Returns the fresh ids in input order.
 */
async function createLocations(
  txn: TransactionHandle,
  locations: { name: string; address: string | null }[],
): Promise<number[]> {
  if (locations.length === 0) return [];
  const seenKeys = new Set<string>();
  for (const location of locations) {
    const key = normalizeNameKey(location.name);
    if (seenKeys.has(key)) {
      throw new EntityConflictError('location', location.name);
    }
    seenKeys.add(key);
  }
  await assertUniqueLocationNames(
    txn,
    locations.map((location) => location.name),
  );
  for (const group of chunk(locations, INSERT_ROWS_PER_STATEMENT)) {
    const placeholders = group.map(() => '(?, ?)').join(', ');
    const params: (string | number | null)[] = [];
    for (const location of group) {
      params.push(location.name, location.address);
    }
    try {
      await txn.runAsync(
        `INSERT INTO locations (name, address) VALUES ${placeholders}`,
        params,
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new EntityConflictError('location', group[0].name);
      }
      throw error;
    }
  }
  return resolveEntityIds(
    txn,
    'locations',
    locations.map((location) => location.name),
  );
}

/**
 * Create every new draft category with ONE domain uniqueness scan, ONE
 * multi-row INSERT per chunk, and ONE id resolve per chunk (T3). Same
 * conflict mapping as the sequential path. Returns ids in input order.
 */
async function createCategories(
  txn: TransactionHandle,
  names: string[],
): Promise<number[]> {
  if (names.length === 0) return [];
  const seenKeys = new Set<string>();
  for (const name of names) {
    const key = normalizeNameKey(name);
    if (seenKeys.has(key)) {
      throw new EntityConflictError('category', name);
    }
    seenKeys.add(key);
  }
  await assertUniqueCategoryNames(txn, [...names]);
  for (const group of chunk(names, INSERT_ROWS_PER_STATEMENT)) {
    const placeholders = group.map(() => '(?)').join(', ');
    try {
      await txn.runAsync(
        `INSERT INTO categories (name) VALUES ${placeholders}`,
        [...group],
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new EntityConflictError('category', group[0]);
      }
      throw error;
    }
  }
  return resolveEntityIds(txn, 'categories', [...names]);
}

/**
 * Resolve fresh ids by exact name after a batched create: the
 * uniqueness checks above guarantee each candidate matches exactly one
 * stored row. One `IN` select per chunk; results return in input order.
 */
async function resolveEntityIds(
  txn: TransactionHandle,
  table: 'locations' | 'categories',
  names: string[],
): Promise<number[]> {
  const idsByKey = new Map<string, number>();
  for (const group of chunk(names, EXISTENCE_IDS_PER_SELECT)) {
    const placeholders = group.map(() => '?').join(', ');
    let rows: { id: number; name: string }[];
    try {
      rows = await txn.getAllAsync<{ id: number; name: string }>(
        `SELECT id, name FROM ${table} WHERE name IN (${placeholders})`,
        [...group],
      );
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof EntityNotFoundError ||
        error instanceof EntityConflictError ||
        error instanceof StorageError
      ) {
        throw error;
      }
      if (isUnexpectedError(error)) throw error;
      throw new StorageError('item', 'fetch', error);
    }
    for (const row of rows) idsByKey.set(normalizeNameKey(row.name), row.id);
  }
  return names.map((name) => {
    const id = idsByKey.get(normalizeNameKey(name));
    // Unreachable: the rows were just inserted in this transaction.
    if (id === undefined) throw new StorageError('item', 'create');
    return id;
  });
}

/**
 * Resolve every stock row's location (existing or newly created) plus
 * the category set inside the same exclusive transaction, so an item
 * with three new locations either commits all three or none. Existence
 * checks run as ONE `IN` select per entity, new names pass ONE batched
 * S11 domain uniqueness check per entity (against stored rows; the
 * within-draft duplicate check stays here), and every table takes ONE
 * multi-row INSERT per chunk; the v3 `UNIQUE` indexes stay the
 * authority for races and their violations map to the same typed
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
  const existingLocationIds: number[] = [];
  const newLocations: { name: string; address: string | null }[] = [];
  for (const row of draft.stock) {
    if (row.locationId !== null) {
      existingLocationIds.push(row.locationId);
    } else if (row.newLocation !== null) {
      newLocations.push(row.newLocation);
    } else {
      throw new ValidationError(
        'location',
        'missing',
        'every stock row must reference a valid location.',
      );
    }
  }
  await requireLocations(txn, existingLocationIds);
  const createdLocationIds = await createLocations(txn, newLocations);
  const stock: NormalizedItemStockInput[] = [];
  let newLocationIndex = 0;
  for (const row of draft.stock) {
    if (row.locationId !== null) {
      stock.push({
        locationId: row.locationId,
        quantity: row.quantity,
        expiresOn: row.expiresOn,
      });
    } else {
      stock.push({
        locationId: createdLocationIds[newLocationIndex],
        quantity: row.quantity,
        expiresOn: row.expiresOn,
      });
      newLocationIndex += 1;
    }
  }
  await requireCategories(txn, draft.categoryIds);
  const createdCategoryIds = await createCategories(
    txn,
    draft.newCategories.map((category) => category.name),
  );
  return {
    stock,
    categoryIds: [...draft.categoryIds, ...createdCategoryIds],
  };
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
    await requireLocations(
      txn,
      normalized.stock.map((row) => row.locationId),
    );
    await requireCategories(txn, normalized.categoryIds);
    const itemId = await insertCatalogRow(
      txn,
      normalized.name,
      normalized.lowStockThreshold,
      normalized.barcode,
    );
    await replaceStockRows(txn, itemId, normalized.stock);
    await replaceCategoryLinks(txn, itemId, normalized.categoryIds);
    detail = await detailForRow(txn, await requireItemRow(txn, itemId));
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

/**
 * Scanner lookup: find one item by its barcode. The input is trimmed
 * and shape-checked before any SQL (blank/misshapen codes reject with
 * `ValidationError`, never a driver round trip); the read itself is a
 * fixed SELECT with the code as a bound param, so scanned text is never
 * interpolated. Returns `null` when no item carries the code — an
 * unknown scan is an empty result, not an error. Driver failures map to
 * generic `StorageError('item', 'fetch')` with `cause`, never raw text.
 */
export async function findItemByBarcode(
  db: RepositoryDb,
  barcode: string,
): Promise<ItemDetail | null> {
  const normalized = normalizeBarcode(barcode);
  if (normalized === null) {
    throw new ValidationError('barcode', 'blank', 'barcode must not be blank.');
  }
  try {
    const row = await db.getFirstAsync<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE barcode = ?`,
      [normalized],
    );
    if (row === null) return null;
    return detailForRow(db, row);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityNotFoundError ||
      error instanceof EntityConflictError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('item', 'fetch', error);
  }
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
    if (
      error instanceof ValidationError ||
      error instanceof EntityNotFoundError ||
      error instanceof EntityConflictError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
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
    await requireLocations(
      txn,
      normalized.stock.map((row) => row.locationId),
    );
    await requireCategories(txn, normalized.categoryIds);
    await updateCatalogRow(
      txn,
      validId,
      normalized.name,
      normalized.lowStockThreshold,
      normalized.barcode,
    );
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
    const itemId = await insertCatalogRow(
      txn,
      normalized.name,
      normalized.lowStockThreshold,
      normalized.barcode,
    );
    await replaceStockRows(txn, itemId, relations.stock);
    await replaceCategoryLinks(txn, itemId, relations.categoryIds);
    detail = await detailForRow(txn, await requireItemRow(txn, itemId));
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
    await updateCatalogRow(
      txn,
      validId,
      normalized.name,
      normalized.lowStockThreshold,
      normalized.barcode,
    );
    await replaceStockRows(txn, validId, relations.stock);
    await replaceCategoryLinks(txn, validId, relations.categoryIds);
    detail = await detailForRow(txn, await requireItemRow(txn, validId));
  });
  if (detail === null) throw new StorageError('item', 'update');
  return detail;
}
