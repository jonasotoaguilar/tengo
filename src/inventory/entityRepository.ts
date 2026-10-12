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
 * map to `EntityConflictError`, never raw SQLite text. No caps are invented.
 * Location deletes rely on the v2
 * `ON DELETE RESTRICT` FK and map its violation to `LocationInUseError`;
 * category deletes cascade to `item_categories` join rows per the schema
 * while items themselves survive.
 */
import type { RepositoryDb } from './database';
import {
  EntityConflictError,
  EntityNotFoundError,
  isForeignKeyViolation,
  isUniqueConstraintViolation,
  LocationInUseError,
  StorageError,
} from './errors';
import type {
  Category,
  Location,
  NewCategoryInput,
  NewLocationInput,
} from './types';
import {
  normalizeNameKey,
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

/** Create a location; rejects `conflict` on an S11 duplicate name. */
export async function createLocation(
  db: RepositoryDb,
  input: NewLocationInput,
): Promise<Location> {
  const normalized = validateLocationInput(input);
  try {
    await assertUniqueLocationName(db, normalized.name);
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
    if (error instanceof EntityConflictError) throw error;
    if (error instanceof StorageError) throw error;
    if (isUniqueConstraintViolation(error)) {
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
    if (error instanceof EntityNotFoundError) throw error;
    throw new StorageError('location', 'fetch', error);
  }
}

/**
 * Update a location; rejects `not-found` when the row is missing and
 * `conflict` when the new name collides with another row's S11 key.
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
    const result = await db.runAsync(
      'UPDATE locations SET name = ?, address = ? WHERE id = ?',
      [normalized.name, normalized.address, validId],
    );
    if (result.changes === 0) {
      throw new EntityNotFoundError('location', validId);
    }
    return await getLocation(db, validId);
  } catch (error) {
    if (error instanceof EntityConflictError) throw error;
    if (error instanceof EntityNotFoundError) throw error;
    if (isUniqueConstraintViolation(error)) {
      throw new EntityConflictError('location', normalized.name);
    }
    throw new StorageError('location', 'update', error);
  }
}

/**
 * Delete a location. A location still referenced by `items.location_id`
 * fails with `LocationInUseError` (v2 `ON DELETE RESTRICT`) — never a
 * cascade. Missing rows reject `not-found`.
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
    if (error instanceof EntityNotFoundError) throw error;
    if (isForeignKeyViolation(error)) {
      throw new LocationInUseError(validId);
    }
    throw new StorageError('location', 'delete', error);
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
    if (error instanceof EntityConflictError) throw error;
    if (error instanceof StorageError) throw error;
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
    if (error instanceof EntityNotFoundError) throw error;
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
    if (error instanceof EntityConflictError) throw error;
    if (error instanceof EntityNotFoundError) throw error;
    if (isUniqueConstraintViolation(error)) {
      throw new EntityConflictError('category', normalized.name);
    }
    throw new StorageError('category', 'update', error);
  }
}

/**
 * Delete a category. `item_categories` join rows cascade per the v2 schema;
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
    if (error instanceof EntityNotFoundError) throw error;
    throw new StorageError('category', 'delete', error);
  }
}
