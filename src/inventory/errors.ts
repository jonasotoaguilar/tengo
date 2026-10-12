/**
 * Typed M2 repository errors (location/category/item persistence).
 *
 * Codes: `validation` (reuses `ValidationError` from `./validation`),
 * `not-found` (missing row, via `EntityNotFoundError` carrying the
 * `location` | `category` | `item` kind), `in-use` (location still
 * referenced by items), `conflict` (duplicate location/category name
 * after S11 trim/accent/case normalization, via `EntityConflictError`),
 * `storage` (any other SQLite/driver failure).
 * Messages stay generic and never embed raw SQLite/driver text; the
 * original error travels as `cause`.
 */
export { ValidationError } from './validation';

export type EntityKind = 'location' | 'category' | 'item';

/** Thrown when a fetch/update/delete targets a row that does not exist. */
export class EntityNotFoundError extends Error {
  readonly code = 'not-found';
  readonly entity: EntityKind;
  readonly id: number;

  constructor(entity: EntityKind, id: number) {
    super(`No such ${entity} with id ${id}.`);
    this.name = 'EntityNotFoundError';
    this.entity = entity;
    this.id = id;
  }
}

/** Thrown when a location delete is blocked by referencing item rows. */
export class LocationInUseError extends Error {
  readonly code = 'in-use';
  readonly locationId: number;

  constructor(locationId: number) {
    super(
      `Location ${locationId} is still referenced by items and cannot be deleted.`,
    );
    this.name = 'LocationInUseError';
    this.locationId = locationId;
  }
}

/** Thrown when a location/category name collides after S11 normalization. */
export class EntityConflictError extends Error {
  readonly code = 'conflict';
  readonly entity: 'location' | 'category';
  readonly conflictingName: string;

  constructor(entity: 'location' | 'category', conflictingName: string) {
    super(
      `A ${entity} named "${conflictingName}" already exists (names are unique ignoring case, accents, and surrounding whitespace).`,
    );
    this.name = 'EntityConflictError';
    this.entity = entity;
    this.conflictingName = conflictingName;
  }
}

/** Thrown for any SQLite/driver failure that is not a mapped FK block. */
export class StorageError extends Error {
  readonly code = 'storage';
  readonly entity: EntityKind;
  readonly operation: string;

  constructor(entity: EntityKind, operation: string, cause?: unknown) {
    super(`Could not ${operation} ${entity}: storage unavailable.`, { cause });
    this.name = 'StorageError';
    this.entity = entity;
    this.operation = operation;
  }
}

/**
 * Detect the SQLite unique-constraint violation behind an expo-sqlite
 * failure. Native errors surface as `Error` with driver text such as
 * `UNIQUE constraint failed` / `SQLITE_CONSTRAINT_UNIQUE` (extended code
 * 2067), so match all known shapes case-insensitively.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const record = error as { message?: unknown; code?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  const code = typeof record.code === 'number' ? record.code : -1;
  return (
    code === 2067 ||
    /unique constraint failed/i.test(message) ||
    /SQLITE_CONSTRAINT_UNIQUE/i.test(message)
  );
}

/**
 * Detect the SQLite foreign-key violation behind an expo-sqlite failure.
 * Native errors surface as `Error` with driver text such as
 * `FOREIGN KEY constraint failed` / `SQLITE_CONSTRAINT_FOREIGNKEY`
 * (extended code 787), so match all known shapes case-insensitively.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const record = error as { message?: unknown; code?: unknown };
  const message = typeof record.message === 'string' ? record.message : '';
  const code = typeof record.code === 'number' ? record.code : -1;
  return (
    code === 787 ||
    /foreign key constraint failed/i.test(message) ||
    /SQLITE_CONSTRAINT_FOREIGNKEY/i.test(message)
  );
}
