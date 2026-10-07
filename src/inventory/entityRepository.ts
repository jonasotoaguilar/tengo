/**
 * M2 location/category persistence: parameterized CRUD over `RepositoryDb`.
 *
 * All user text (including ids) travels as bound `?` params; SQL sources are
 * fixed strings. Inputs run through the existing M1 domain normalization
 * (`validateLocationInput`/`validateCategoryInput`, `validateId`), so names
 * keep verbatim text (`café` stays `café`) and blank addresses become null.
 * No uniqueness or caps are invented. Location deletes rely on the v2
 * `ON DELETE RESTRICT` FK and map its violation to `LocationInUseError`;
 * category deletes cascade to `item_categories` join rows per the schema
 * while items themselves survive.
 */
import type { RepositoryDb } from './database';
import {
  EntityNotFoundError,
  isForeignKeyViolation,
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

/** Create a location; returns the stored row (trimmed name, nulled blank). */
export async function createLocation(
  db: RepositoryDb,
  input: NewLocationInput,
): Promise<Location> {
  const normalized = validateLocationInput(input);
  try {
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
    if (error instanceof StorageError) throw error;
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

/** Update a location; rejects `not-found` when the row is missing. */
export async function updateLocation(
  db: RepositoryDb,
  id: number,
  input: NewLocationInput,
): Promise<Location> {
  const validId = validateId(id, 'id');
  const normalized = validateLocationInput(input);
  try {
    const result = await db.runAsync(
      'UPDATE locations SET name = ?, address = ? WHERE id = ?',
      [normalized.name, normalized.address, validId],
    );
    if (result.changes === 0) {
      throw new EntityNotFoundError('location', validId);
    }
    return await getLocation(db, validId);
  } catch (error) {
    if (error instanceof EntityNotFoundError) throw error;
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

/** Create a category; returns the stored row (trimmed, verbatim text). */
export async function createCategory(
  db: RepositoryDb,
  input: NewCategoryInput,
): Promise<Category> {
  const normalized = validateCategoryInput(input);
  try {
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
    if (error instanceof StorageError) throw error;
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

/** Update a category; rejects `not-found` when the row is missing. */
export async function updateCategory(
  db: RepositoryDb,
  id: number,
  input: NewCategoryInput,
): Promise<Category> {
  const validId = validateId(id, 'id');
  const normalized = validateCategoryInput(input);
  try {
    const result = await db.runAsync(
      'UPDATE categories SET name = ? WHERE id = ?',
      [normalized.name, validId],
    );
    if (result.changes === 0) {
      throw new EntityNotFoundError('category', validId);
    }
    return await getCategory(db, validId);
  } catch (error) {
    if (error instanceof EntityNotFoundError) throw error;
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
