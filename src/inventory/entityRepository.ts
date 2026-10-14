/**
 * M2 location/category persistence: parameterized CRUD over `RepositoryDb`.
 *
 * All user text (including ids) travels as bound `?` params; SQL sources are
 * fixed strings. Inputs run through the existing M1 domain normalization
 * (`validateLocationInput`/`validateCategoryInput`, `validateId`), so names
 * keep verbatim text (`café` stays `café`) and blank addresses become null.
 * S11 uniqueness is enforced: location and category names are unique after
 * trim/accent/case normalization (`normalizeNameKey`), checked in the
 * domain layer before every create/update (self-excluded on update) with
 * the v3 `UNIQUE` index as the backstop authority; `UNIQUE` driver failures
 * map to `EntityConflictError`, never raw SQLite text. U11 extends the
 * same discipline to location addresses (`normalizeAddressKey`, checked
 * before every location create/update with self-exclusion, NULL
 * addresses never colliding) with the v6 partial `UNIQUE` index as the
 * backstop authority and the same typed mapping for a lost race.
 * No caps are invented.
 * Location deletes cascade their `stock` rows per the v4 schema (R3) while
 * catalog items survive; category deletes cascade to `item_categories`
 * join rows per the schema (R4) while items themselves survive. The delete
 * confirmations count the impact first (`locationDeleteImpact`,
 * `categoryDeleteImpact`) so the copy can state it.
 */
import type { RepositoryDb } from './database';
import {
  EntityConflictError,
  EntityNotFoundError,
  isUniqueConstraintViolation,
  StorageError,
} from './errors';
import type {
  Category,
  CategoryDeleteImpact,
  Location,
  LocationDeleteImpact,
  NewCategoryInput,
  NewLocationInput,
} from './types';
import {
  normalizeAddressKey,
  normalizeNameKey,
  ValidationError,
  validateCategoryInput,
  validateId,
  validateLocationInput,
} from './validation';

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

const LOCATION_COLUMNS = 'id, name, address, created_at';
const CATEGORY_COLUMNS = 'id, name, created_at';

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

interface NameRow {
  id: number;
  name: string;
}

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

/**
 * S11 domain uniqueness: no two location (or category) names share a
 * `normalizeNameKey` (trim/accent/case-insensitive). The table name is a
 * fixed literal from our own call sites, never user input. Returns the
 * colliding row, if any, excluding `excludeId` (updates keep their own
 * name). Throws only `EntityConflictError`; driver failures propagate to
 * the caller's typed mapping.
 */
async function findConflictingName(
  db: RepositoryDb,
  table: 'locations' | 'categories',
  candidate: string,
  excludeId?: number,
): Promise<NameRow | null> {
  const rows = await db.getAllAsync<NameRow>(
    `SELECT id, name FROM ${table} ORDER BY id ASC`,
  );
  const key = normalizeNameKey(candidate);
  for (const row of rows) {
    if (excludeId !== undefined && row.id === excludeId) continue;
    if (normalizeNameKey(row.name) === key) return row;
  }
  return null;
}

/**
 * U11 domain uniqueness: no two locations share a `normalizeAddressKey`
 * (trim/accent/case-insensitive). A null address never collides: many
 * address-less locations stay legal. Excludes `excludeId` (updates keep
 * their own address). Throws only `EntityConflictError` with
 * `field: 'address'`; driver failures propagate to the caller's typed
 * mapping.
 */
export async function assertUniqueLocationAddress(
  db: RepositoryDb,
  address: string | null,
  excludeId?: number,
): Promise<void> {
  if (address === null) return;
  const rows = await db.getAllAsync<{ id: number; address: string | null }>(
    'SELECT id, address FROM locations ORDER BY id ASC',
  );
  const key = normalizeAddressKey(address);
  for (const row of rows) {
    if (excludeId !== undefined && row.id === excludeId) continue;
    if (row.address === null) continue;
    if (normalizeAddressKey(row.address) === key) {
      throw new EntityConflictError('location', address, 'address');
    }
  }
}

/** Reject a location name that collides after S11 normalization. */
export async function assertUniqueLocationName(
  db: RepositoryDb,
  name: string,
  excludeId?: number,
): Promise<void> {
  if ((await findConflictingName(db, 'locations', name, excludeId)) !== null) {
    throw new EntityConflictError('location', name);
  }
}

/** Reject a category name that collides after S11 normalization. */
export async function assertUniqueCategoryName(
  db: RepositoryDb,
  name: string,
  excludeId?: number,
): Promise<void> {
  if ((await findConflictingName(db, 'categories', name, excludeId)) !== null) {
    throw new EntityConflictError('category', name);
  }
}

/**
 * T3 batched S11 domain uniqueness: one full-table scan validates every
 * candidate name, throwing `EntityConflictError` for the first candidate
 * (input order) that collides after `normalizeNameKey`, excluding
 * `excludeId`. Same mapping as the singular asserts; an empty batch
 * issues no statement. Within-draft duplicates are the caller's (item
 * draft resolution) check, never this scan's: it only sees stored rows.
 */
export async function assertUniqueLocationNames(
  db: RepositoryDb,
  names: string[],
  excludeId?: number,
): Promise<void> {
  await assertUniqueNames(db, 'locations', 'location', names, excludeId);
}

/** Batched S11 domain uniqueness for category names (same semantics). */
export async function assertUniqueCategoryNames(
  db: RepositoryDb,
  names: string[],
  excludeId?: number,
): Promise<void> {
  await assertUniqueNames(db, 'categories', 'category', names, excludeId);
}

async function assertUniqueNames(
  db: RepositoryDb,
  table: 'locations' | 'categories',
  entity: 'location' | 'category',
  names: string[],
  excludeId?: number,
): Promise<void> {
  if (names.length === 0) return;
  const rows = await db.getAllAsync<NameRow>(
    `SELECT id, name FROM ${table} ORDER BY id ASC`,
  );
  for (const candidate of names) {
    const key = normalizeNameKey(candidate);
    for (const row of rows) {
      if (excludeId !== undefined && row.id === excludeId) continue;
      if (normalizeNameKey(row.name) === key) {
        throw new EntityConflictError(entity, candidate);
      }
    }
  }
}

/**
 * Detect whether a UNIQUE driver failure came from the v6 partial
 * address index (`idx_locations_address_norm`) rather than a name
 * index. Expression-index violations name the index, never the column,
 * so match the index/column token case-insensitively.
 */
function isAddressUniqueViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? ((error as { message: string }).message as string)
      : '';
  return /address/i.test(message);
}

/**
 * Create a location; rejects `conflict` on an S11 duplicate name or a
 * U11 duplicate address (`field: 'address'`).
 */
export async function createLocation(
  db: RepositoryDb,
  input: NewLocationInput,
): Promise<Location> {
  const normalized = validateLocationInput(input);
  try {
    await assertUniqueLocationName(db, normalized.name);
    await assertUniqueLocationAddress(db, normalized.address);
    const result = await db.runAsync(
      'INSERT INTO locations (name, address) VALUES (?, ?)',
      [normalized.name, normalized.address],
    );
    const row = await db.getFirstAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM locations WHERE id = ?`,
      [result.lastInsertRowId],
    );
    if (row === null) {
      throw new StorageError('location', 'create');
    }
    return toLocation(row);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    if (isUniqueConstraintViolation(error)) {
      // A race lost to the v6 address index maps back to the same typed
      // address conflict the domain pre-check throws, never raw SQL text.
      if (normalized.address !== null && isAddressUniqueViolation(error)) {
        throw new EntityConflictError(
          'location',
          normalized.address,
          'address',
        );
      }
      throw new EntityConflictError('location', normalized.name);
    }
    throw new StorageError('location', 'create', error);
  }
}

/** List locations in insertion order (no invented collation). */
export async function listLocations(db: RepositoryDb): Promise<Location[]> {
  try {
    const rows = await db.getAllAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM locations ORDER BY id ASC`,
    );
    return rows.map(toLocation);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('location', 'list', error);
  }
}

/** Fetch one location; rejects `not-found` when the row is missing. */
export async function getLocation(
  db: RepositoryDb,
  id: number,
): Promise<Location> {
  const validId = validateId(id, 'id');
  try {
    const row = await db.getFirstAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM locations WHERE id = ?`,
      [validId],
    );
    if (row === null) throw new EntityNotFoundError('location', validId);
    return toLocation(row);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('location', 'fetch', error);
  }
}

/**
 * Update a location; rejects `not-found` when the row is missing and
 * `conflict` when the new name collides with another row's S11 key or
 * the new address collides with another row's U11 key (keeping the
 * row's own address is not a conflict).
 */
export async function updateLocation(
  db: RepositoryDb,
  id: number,
  input: NewLocationInput,
): Promise<Location> {
  const validId = validateId(id, 'id');
  const normalized = validateLocationInput(input);
  try {
    await assertUniqueLocationName(db, normalized.name, validId);
    await assertUniqueLocationAddress(db, normalized.address, validId);
    const result = await db.runAsync(
      'UPDATE locations SET name = ?, address = ? WHERE id = ?',
      [normalized.name, normalized.address, validId],
    );
    if (result.changes === 0) {
      throw new EntityNotFoundError('location', validId);
    }
    return await getLocation(db, validId);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    if (isUniqueConstraintViolation(error)) {
      // Same race mapping as the create path: an address-index loss
      // surfaces the typed address conflict, never raw SQL text.
      if (normalized.address !== null && isAddressUniqueViolation(error)) {
        throw new EntityConflictError(
          'location',
          normalized.address,
          'address',
        );
      }
      throw new EntityConflictError('location', normalized.name);
    }
    throw new StorageError('location', 'update', error);
  }
}

/**
 * Delete a location. Its `stock` rows cascade per the v4 schema (R3)
 * while catalog items survive (an item left with no stock anywhere stays
 * visible as "sin stock", R6). There is no minimum location count (R8):
 * deleting the last location is allowed. Missing rows reject `not-found`.
 */
export async function deleteLocation(
  db: RepositoryDb,
  id: number,
): Promise<void> {
  const validId = validateId(id, 'id');
  try {
    const result = await db.runAsync('DELETE FROM locations WHERE id = ?', [
      validId,
    ]);
    if (result.changes === 0) {
      throw new EntityNotFoundError('location', validId);
    }
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('location', 'delete', error);
  }
}

/**
 * Impact of deleting a location, for the R3 confirmation copy ("N
 * existencias se borrarán; los ítems NO se borran"). Counts the stock
 * rows the delete removes plus the items left with no stock anywhere
 * afterwards (R6 sin stock). Missing rows reject `not-found`.
 */
export async function locationDeleteImpact(
  db: RepositoryDb,
  id: number,
): Promise<LocationDeleteImpact> {
  const validId = validateId(id, 'id');
  try {
    const location = await db.getFirstAsync<{ id: number }>(
      'SELECT id FROM locations WHERE id = ?',
      [validId],
    );
    if (location === null) {
      throw new EntityNotFoundError('location', validId);
    }
    const stockRows = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM stock WHERE location_id = ?',
      [validId],
    );
    const unstocked = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM (SELECT DISTINCT s1.item_id FROM stock s1 ' +
        'WHERE s1.location_id = ? AND NOT EXISTS ' +
        '(SELECT 1 FROM stock s2 WHERE s2.item_id = s1.item_id AND s2.location_id != ?))',
      [validId, validId],
    );
    return {
      stockRows: stockRows?.count ?? 0,
      unstockedItems: unstocked?.count ?? 0,
    };
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('location', 'fetch', error);
  }
}

/** Create a category; rejects `conflict` on an S11 duplicate name. */
export async function createCategory(
  db: RepositoryDb,
  input: NewCategoryInput,
): Promise<Category> {
  const normalized = validateCategoryInput(input);
  try {
    await assertUniqueCategoryName(db, normalized.name);
    const result = await db.runAsync(
      'INSERT INTO categories (name) VALUES (?)',
      [normalized.name],
    );
    const row = await db.getFirstAsync<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = ?`,
      [result.lastInsertRowId],
    );
    if (row === null) {
      throw new StorageError('category', 'create');
    }
    return toCategory(row);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    if (isUniqueConstraintViolation(error)) {
      throw new EntityConflictError('category', normalized.name);
    }
    throw new StorageError('category', 'create', error);
  }
}

/** List categories in insertion order (no invented collation). */
export async function listCategories(db: RepositoryDb): Promise<Category[]> {
  try {
    const rows = await db.getAllAsync<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM categories ORDER BY id ASC`,
    );
    return rows.map(toCategory);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('category', 'list', error);
  }
}

/** Fetch one category; rejects `not-found` when the row is missing. */
export async function getCategory(
  db: RepositoryDb,
  id: number,
): Promise<Category> {
  const validId = validateId(id, 'id');
  try {
    const row = await db.getFirstAsync<CategoryRow>(
      `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = ?`,
      [validId],
    );
    if (row === null) throw new EntityNotFoundError('category', validId);
    return toCategory(row);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('category', 'fetch', error);
  }
}

/**
 * Update a category; rejects `not-found` when the row is missing and
 * `conflict` when the new name collides with another row's S11 key.
 */
export async function updateCategory(
  db: RepositoryDb,
  id: number,
  input: NewCategoryInput,
): Promise<Category> {
  const validId = validateId(id, 'id');
  const normalized = validateCategoryInput(input);
  try {
    await assertUniqueCategoryName(db, normalized.name, validId);
    const result = await db.runAsync(
      'UPDATE categories SET name = ? WHERE id = ?',
      [normalized.name, validId],
    );
    if (result.changes === 0) {
      throw new EntityNotFoundError('category', validId);
    }
    return await getCategory(db, validId);
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    if (isUniqueConstraintViolation(error)) {
      throw new EntityConflictError('category', normalized.name);
    }
    throw new StorageError('category', 'update', error);
  }
}

/**
 * Impact of deleting a category, for the R4 confirmation copy ("se
 * quitará de N ítems; los ítems NO se borran"). Counts the items that
 * would lose the association. Missing rows reject `not-found`.
 */
export async function categoryDeleteImpact(
  db: RepositoryDb,
  id: number,
): Promise<CategoryDeleteImpact> {
  const validId = validateId(id, 'id');
  try {
    const category = await db.getFirstAsync<{ id: number }>(
      'SELECT id FROM categories WHERE id = ?',
      [validId],
    );
    if (category === null) {
      throw new EntityNotFoundError('category', validId);
    }
    const linked = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM item_categories WHERE category_id = ?',
      [validId],
    );
    return { items: linked?.count ?? 0 };
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('category', 'fetch', error);
  }
}

/**
 * Delete a category. `item_categories` join rows cascade per the schema;
 * items themselves are never deleted by this operation. Missing rows reject
 * `not-found`.
 */
export async function deleteCategory(
  db: RepositoryDb,
  id: number,
): Promise<void> {
  const validId = validateId(id, 'id');
  try {
    const result = await db.runAsync('DELETE FROM categories WHERE id = ?', [
      validId,
    ]);
    if (result.changes === 0) {
      throw new EntityNotFoundError('category', validId);
    }
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof EntityConflictError ||
      error instanceof EntityNotFoundError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    if (isUnexpectedError(error)) throw error;
    throw new StorageError('category', 'delete', error);
  }
}
