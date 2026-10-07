/**
 * M1 domain validation and normalization (pure functions, no persistence).
 *
 * Rules (approved contract only):
 * - Names are trimmed and must be nonblank. No length caps, no case or
 *   accent changes: those remain proposals, so `café` stays `café`.
 * - The optional address normalizes every blank form (`undefined`, `null`,
 *   `''`, whitespace-only) consistently to `null`.
 * - Quantity zero is valid (exhausted). Anything that is not a nonnegative
 *   safe integer — negatives, fractions, NaN/Infinity, non-numbers — is
 *   rejected. `MAX_QUANTITY` is `Number.MAX_SAFE_INTEGER`, a technical
 *   JavaScript-integer guard (mirrored in the v2 SQL `CHECK`), not a
 *   user-approved product limit.
 * - Ids must be positive safe integers: valid referential values only.
 *   Existence against the database is enforced by SQLite foreign keys (M2
 *   surfaces those as typed errors); this layer rejects malformed ids.
 * - An item must reference a location id; duplicate category ids are
 *   rejected (the join's composite primary key rejects them too).
 */
import type { NewCategoryInput, NewItemInput, NewLocationInput } from './types';

/**
 * Technical JavaScript-integer guard for quantities, not a product limit.
 * Product quantity bounds remain undecided (see PRODUCT.md open decision 1).
 */
export const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;

export class ValidationError extends Error {
  readonly field: string;
  readonly code: string;

  constructor(field: string, code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.code = code;
  }
}

/** Trim a required name; reject non-strings and blank-after-trim. */
export function normalizeName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field, 'invalid', `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(field, 'blank', `${field} must not be blank.`);
  }
  return trimmed;
}

/** Normalize the optional address: any blank form becomes `null`. */
export function normalizeAddress(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ValidationError(
      'address',
      'invalid',
      'address must be a string or null.',
    );
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Accept zero and positive safe integers; reject everything else. */
export function normalizeQuantity(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_QUANTITY
  ) {
    throw new ValidationError(
      'quantity',
      'invalid',
      'quantity must be a nonnegative safe integer (0 means exhausted).',
    );
  }
  return value;
}

/** Accept positive safe integers only (foreign-key references). */
export function validateId(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(
      field,
      'invalid',
      `${field} must be a positive integer referencing an existing row.`,
    );
  }
  return value;
}

export interface NormalizedLocationInput {
  name: string;
  address: string | null;
}

export function validateLocationInput(
  input: NewLocationInput,
): NormalizedLocationInput {
  if (input === null || typeof input !== 'object') {
    throw new ValidationError(
      'location',
      'invalid',
      'location must be an object with a name.',
    );
  }
  return {
    name: normalizeName(input.name, 'name'),
    address: normalizeAddress(input.address),
  };
}

export interface NormalizedCategoryInput {
  name: string;
}

export function validateCategoryInput(
  input: NewCategoryInput,
): NormalizedCategoryInput {
  if (input === null || typeof input !== 'object') {
    throw new ValidationError(
      'category',
      'invalid',
      'category must be an object with a name.',
    );
  }
  return { name: normalizeName(input.name, 'name') };
}

export interface NormalizedItemInput {
  name: string;
  quantity: number;
  locationId: number;
  categoryIds: number[];
}

export function validateItemInput(input: NewItemInput): NormalizedItemInput {
  if (input === null || typeof input !== 'object') {
    throw new ValidationError(
      'item',
      'invalid',
      'item must be an object with a name, quantity, and locationId.',
    );
  }
  const name = normalizeName(input.name, 'name');
  const quantity = normalizeQuantity(input.quantity);
  if (input.locationId === undefined || input.locationId === null) {
    throw new ValidationError(
      'locationId',
      'missing',
      'every item must reference a valid location.',
    );
  }
  const locationId = validateId(input.locationId, 'locationId');
  const rawIds = input.categoryIds ?? [];
  if (!Array.isArray(rawIds)) {
    throw new ValidationError(
      'categoryIds',
      'invalid',
      'categoryIds must be an array of category ids.',
    );
  }
  const categoryIds = rawIds.map((id) => validateId(id, 'categoryIds'));
  if (new Set(categoryIds).size !== categoryIds.length) {
    throw new ValidationError(
      'categoryIds',
      'duplicate',
      'categoryIds must not contain duplicates.',
    );
  }
  return { name, quantity, locationId, categoryIds };
}
