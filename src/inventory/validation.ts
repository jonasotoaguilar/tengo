/**
 * M1 domain validation and normalization (pure functions, no persistence).
 *
 * Rules (approved contract plus adopted S10 product bounds):
 * - Names are trimmed and must be nonblank. Item names allow 1–120
 *   characters after trim; location and category names allow 1–80 after
 *   trim. Blank is still the existing required error; over the bound is a
 *   new out-of-range (`too-long`) error. No case or accent changes:
 *   `café` stays `café`.
 * - The optional address normalizes every blank form (`undefined`, `null`,
 *   `''`, whitespace-only) consistently to `null`.
 * - Quantity zero is valid (exhausted/sin stock). Anything that is not a
 *   nonnegative safe integer — negatives, fractions, NaN/Infinity,
 *   non-numbers — is rejected with the unchanged `invalid` rule. The
 *   adopted product bound is 0–999999 inclusive: values above it are
 *   rejected with a new `out-of-range` error.
 * - Split: `MAX_QUANTITY` is `Number.MAX_SAFE_INTEGER`, a technical
 *   JavaScript-integer guard (mirrored in the v2/v4 SQL `CHECK`), not the
 *   product bound. The product bound (`PRODUCT_MAX_QUANTITY`) is enforced
 *   here in the domain layer, which is the only writer, so no SQL change
 *   or migration was needed.
 * - Ids must be positive safe integers: valid referential values only.
 *   Existence against the database is enforced by SQLite foreign keys (M2
 *   surfaces those as typed errors); this layer rejects malformed ids.
 * - An item carries zero or more stock rows (location + quantity each).
 *   Every row needs a valid location id and an S10 quantity; a 0-quantity
 *   row is dropped rather than stored; duplicate location ids in one
 *   payload are rejected (the stock composite primary key rejects them
 *   too). Duplicate category ids are likewise rejected.
 * - U2 scanner/reminder base (all optional, absent/blank means unset):
 *   `lowStockThreshold` is null or a safe integer inside the S10 product
 *   bound (same constants and codes as quantity); `barcode` is null or a
 *   plausible code (4–64 chars, letters/numbers/`.-_`, anchored ends);
 *   each stock row carries an optional ISO calendar `expiresOn`. Shape
 *   lives here; barcode uniqueness lives in the v5 UNIQUE index plus the
 *   repository conflict mapping (same split as S11 accents).
 */
import type {
  NewCategoryInput,
  NewItemInput,
  NewItemStockInput,
  NewLocationInput,
} from './types';

/**
 * Technical JavaScript-integer guard for quantities, not the product bound.
 * The v2/v4 SQL `CHECK` mirrors this technical guard; the product bound
 * below is enforced in the domain layer, which is the only writer.
 */
export const MAX_QUANTITY = Number.MAX_SAFE_INTEGER;

/** Adopted product bound (S10): quantities above this are out of range. */
export const PRODUCT_MAX_QUANTITY = 999999;

/** Adopted product bound (S10): item names allow 1–120 chars after trim. */
export const ITEM_NAME_MAX_LENGTH = 120;

/** Adopted product bound (S10): location names allow 1–80 chars after trim. */
export const LOCATION_NAME_MAX_LENGTH = 80;

/** Adopted product bound (S10): category names allow 1–80 chars after trim. */
export const CATEGORY_NAME_MAX_LENGTH = 80;

/**
 * U2 reminder bound: the low-stock threshold reuses the S10 product bound
 * (0–999999), the same range a quantity can hold, so a reminder level can
 * name any reachable total. `null` (absent) means no reminder.
 */
export const LOW_STOCK_THRESHOLD_MAX = PRODUCT_MAX_QUANTITY;

/** U2 barcode shape: 4–64 chars, code characters only. */
export const BARCODE_MIN_LENGTH = 4;
export const BARCODE_MAX_LENGTH = 64;

/**
 * Plausible code shape: starts and ends with a letter or number, code
 * characters (letters, numbers, `.`, `-`, `_`) inside. The anchored
 * length (1 + 2..62 + 1) enforces exactly 4–64 chars in one test.
 */
const BARCODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,62}[A-Za-z0-9]$/;

/** ISO date shape (YYYY-MM-DD); calendar validity is checked separately. */
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * Trim a required name; reject non-strings and blank-after-trim. When
 * `maxLength` is given, names longer than it after trim are rejected with
 * a `too-long` out-of-range error (blank stays the `blank` required error).
 */
export function normalizeName(
  value: unknown,
  field = 'name',
  maxLength?: number,
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field, 'invalid', `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(field, 'blank', `${field} must not be blank.`);
  }
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new ValidationError(
      field,
      'too-long',
      `${field} must be ${maxLength} characters or fewer.`,
    );
  }
  return trimmed;
}

/**
 * Comparison key for S11 name uniqueness: trim, Unicode NFD, strip
 * combining marks, then lowercase. `Café` and `cafe` share a key, and
 * ` Pantry ` shares one with `Pantry`. Comparison-only: stored names
 * keep their verbatim text (`café` stays `café`). The database v3 index
 * enforces the case/whitespace part (`lower(trim(name))`); SQLite cannot
 * fold accents, so the accent part is enforced here in the domain layer,
 * which is the only writer path that can see both spellings.
 */
export function normalizeNameKey(value: string): string {
  return value
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
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

/**
 * Accept zero through the product bound as safe integers; reject everything
 * else. Non-integer, negative, NaN/Infinity, and non-number input keeps the
 * unchanged `invalid` rule; safe integers above the product bound are the
 * new `out-of-range` error. Values above the technical guard stay `invalid`.
 */
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
  if (value > PRODUCT_MAX_QUANTITY) {
    throw new ValidationError(
      'quantity',
      'out-of-range',
      `quantity must be ${PRODUCT_MAX_QUANTITY} or less.`,
    );
  }
  return value;
}

/**
 * Accept an absent threshold as `null` (no reminder), otherwise a safe
 * integer inside the S10 product bound — the same constants and codes
 * `normalizeQuantity` uses, with the `lowStockThreshold` field the
 * localized copy keys off.
 */
export function normalizeLowStockThreshold(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_QUANTITY
  ) {
    throw new ValidationError(
      'lowStockThreshold',
      'invalid',
      'lowStockThreshold must be a nonnegative safe integer or null (null means no reminder).',
    );
  }
  if (value > LOW_STOCK_THRESHOLD_MAX) {
    throw new ValidationError(
      'lowStockThreshold',
      'out-of-range',
      `lowStockThreshold must be ${LOW_STOCK_THRESHOLD_MAX} or less.`,
    );
  }
  return value;
}

/**
 * Accept an absent or blank barcode as `null` (no identity), otherwise a
 * trimmed plausible code: 4–64 chars of letters, numbers, `.`, `-`, `_`,
 * starting and ending with a letter or number. Same blank-to-null
 * convention as `normalizeAddress`; uniqueness itself is the v5 UNIQUE
 * index plus the repository conflict mapping, never this function.
 */
export function normalizeBarcode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError(
      'barcode',
      'invalid',
      'barcode must be a string or null.',
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!BARCODE_SHAPE.test(trimmed)) {
    throw new ValidationError(
      'barcode',
      'invalid',
      `barcode must be ${BARCODE_MIN_LENGTH}-${BARCODE_MAX_LENGTH} characters of letters, numbers, ".", "-", or "_", starting and ending with a letter or number.`,
    );
  }
  return trimmed;
}

/**
 * Accept an absent or blank expiry as `null` (no expiry), otherwise a
 * trimmed ISO calendar date (YYYY-MM-DD with a real month/day; leap
 * years honored). The shape mirrors the v5 SQL GLOB; the calendar check
 * is domain-only, same split as the S11 accent rule.
 */
export function normalizeExpiresOn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError(
      'expiresOn',
      'invalid',
      'expiresOn must be an ISO date (YYYY-MM-DD) or null.',
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!ISO_DATE_SHAPE.test(trimmed)) {
    throw new ValidationError(
      'expiresOn',
      'invalid',
      'expiresOn must be an ISO date (YYYY-MM-DD).',
    );
  }
  const year = Number(trimmed.slice(0, 4));
  const month = Number(trimmed.slice(5, 7));
  const day = Number(trimmed.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ValidationError(
      'expiresOn',
      'invalid',
      'expiresOn must be a real calendar date (YYYY-MM-DD).',
    );
  }
  return trimmed;
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
    name: normalizeName(input.name, 'name', LOCATION_NAME_MAX_LENGTH),
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
  return { name: normalizeName(input.name, 'name', CATEGORY_NAME_MAX_LENGTH) };
}

export interface NormalizedItemStockInput {
  locationId: number;
  quantity: number;
  /** ISO expiry or null (no expiry); validated by `normalizeExpiresOn`. */
  expiresOn: string | null;
}

export interface NormalizedItemInput {
  name: string;
  /** Reminder level or null (no reminder); S10 product bound. */
  lowStockThreshold: number | null;
  /** Scanned identity or null (no barcode); UNIQUE index owns identity. */
  barcode: string | null;
  /** Only rows with quantity > 0: zero rows are dropped, never stored. */
  stock: NormalizedItemStockInput[];
  categoryIds: number[];
}

/**
 * Validate one stock row: a valid location id, an S10 quantity, and an
 * optional ISO expiry. Zero stays valid here (the caller drops it);
 * negatives, fractions, out-of-range values, and bad dates reject.
 */
export function validateStockInput(
  entry: NewItemStockInput,
): NormalizedItemStockInput {
  if (entry === null || typeof entry !== 'object') {
    throw new ValidationError(
      'stock',
      'invalid',
      'each stock row must be an object with a locationId and quantity.',
    );
  }
  const locationId = validateId(entry.locationId, 'locationId');
  const quantity = normalizeQuantity(entry.quantity);
  const expiresOn = normalizeExpiresOn(entry.expiresOn);
  return { locationId, quantity, expiresOn };
}

export function validateItemInput(input: NewItemInput): NormalizedItemInput {
  if (input === null || typeof input !== 'object') {
    throw new ValidationError(
      'item',
      'invalid',
      'item must be an object with a name and stock rows.',
    );
  }
  const name = normalizeName(input.name, 'name', ITEM_NAME_MAX_LENGTH);
  const lowStockThreshold = normalizeLowStockThreshold(input.lowStockThreshold);
  const barcode = normalizeBarcode(input.barcode);
  const rawStock = input.stock === undefined ? [] : input.stock;
  if (!Array.isArray(rawStock)) {
    throw new ValidationError(
      'stock',
      'invalid',
      'stock must be an array of location/quantity rows.',
    );
  }
  const validated = rawStock.map((entry) => validateStockInput(entry));
  // Duplicate location ids reject even when one row is a dropped zero:
  // the payload contradicts itself about that location.
  const locationIds = validated.map((row) => row.locationId);
  if (new Set(locationIds).size !== locationIds.length) {
    throw new ValidationError(
      'stock',
      'duplicate',
      'stock must not contain the same location twice.',
    );
  }
  const stock = validated.filter((row) => row.quantity > 0);
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
  return { name, lowStockThreshold, barcode, stock, categoryIds };
}
