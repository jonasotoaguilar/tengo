/**
 * U6 export/import: a versioned, self-describing file the user owns.
 *
 * The transfer document carries the whole inventory — locations,
 * categories, items and their per-location stock rows including the
 * schema-v5 fields (barcode, low-stock threshold, per-row expiry) — as
 * plain JSON with an explicit `format` tag and `version`, so a future
 * schema can reject what it cannot read. Identity travels by NAME, never
 * by row id: ids are database-local, so an import into another database
 * resolves locations/categories by name and refuses unknown references
 * instead of fabricating rows.
 *
 * Layering: `buildTransferDocument` reads through the existing
 * repository functions; `parseTransferDocument` checks the envelope
 * (readable file of a readable version); `applyTransferDocument`
 * validates every entry through the existing domain validators
 * (`validateLocationInput`, `validateCategoryInput`, `validateItemInput`
 * with name-resolved stand-in ids, `normalizeNameKey` duplicate checks)
 * BEFORE opening any transaction, then wipes and recreates the inventory
 * inside ONE exclusive transaction on the scoped handle. A refused
 * import never opens a write; a mid-write driver failure rolls back, so
 * counts are unchanged either way. Item writes use direct SQL because
 * the item repository functions each open their OWN exclusive
 * transaction and fail closed without the hook — nesting them inside
 * ours is impossible — but the statements mirror the repository SQL and
 * the same validators gate every value, so domain validation, S10
 * bounds and name uniqueness stay enforced. Zero-quantity stock rows
 * are REFUSED (a stored row means `quantity > 0` per the schema CHECK):
 * the exporter never emits them, and a hand-edited file carrying one is
 * rejected rather than silently dropped.
 *
 * Errors are typed `TransferError`s (`version-mismatch` | `malformed` |
 * `validation` | `conflict` | `storage`) with generic messages that
 * never embed raw driver text; the original travels as `cause`.
 * Unexpected programming errors (`TypeError` and siblings, non-`Error`
 * throws) propagate unchanged per the T5 convention instead of
 * surfacing as "storage unavailable".
 */
import type { RepositoryDb, TransactionHandle } from './database';
import { listCategories, listLocations } from './entityRepository';
import { listItems } from './itemRepository';
import {
  normalizeExpiresOn,
  normalizeNameKey,
  ValidationError,
  validateCategoryInput,
  validateItemInput,
  validateLocationInput,
} from './validation';

/** Envelope tag: every transfer file names its own format. */
export const TRANSFER_FORMAT = 'tengo-inventory';

/** Current file version: a future schema bumps this and old readers refuse. */
export const TRANSFER_FORMAT_VERSION = 1;

export interface TransferLocation {
  name: string;
  address: string | null;
}

export interface TransferCategory {
  name: string;
}

export interface TransferStockRow {
  /** Location NAME (ids are database-local, never portable). */
  location: string;
  quantity: number;
  expiresOn: string | null;
}

export interface TransferItem {
  name: string;
  barcode: string | null;
  lowStockThreshold: number | null;
  /** Category NAMES (same portability rule as locations). */
  categories: string[];
  stock: TransferStockRow[];
}

export interface TransferDocument {
  format: typeof TRANSFER_FORMAT;
  version: typeof TRANSFER_FORMAT_VERSION;
  exportedAt: string;
  locations: TransferLocation[];
  categories: TransferCategory[];
  items: TransferItem[];
}

/** Counts recreated by one applied import, for the confirmation copy. */
export interface TransferSummary {
  locations: number;
  categories: number;
  items: number;
  stockRows: number;
}

export type TransferErrorCode =
  | 'version-mismatch'
  | 'malformed'
  | 'validation'
  | 'conflict'
  | 'storage';

/** Typed transfer failure; `cause` carries the wrapped original. */
export class TransferError extends Error {
  readonly code: TransferErrorCode;

  constructor(code: TransferErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TransferError';
    this.code = code;
  }
}

/**
 * T5: only driver/storage failures map to `storage`. Programming errors
 * and non-`Error` throws propagate unchanged.
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

/** Detect the SQLite unique-constraint shape behind a driver failure. */
function isUniqueViolation(error: unknown): boolean {
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

/** Read the whole inventory through the existing repository functions. */
export async function buildTransferDocument(
  db: RepositoryDb,
): Promise<TransferDocument> {
  try {
    const [locations, categories, items] = await Promise.all([
      listLocations(db),
      listCategories(db),
      listItems(db),
    ]);
    return {
      format: TRANSFER_FORMAT,
      version: TRANSFER_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      locations: locations.map((location) => ({
        name: location.name,
        address: location.address,
      })),
      categories: categories.map((category) => ({ name: category.name })),
      items: items.map((item) => ({
        name: item.name,
        barcode: item.barcode ?? null,
        lowStockThreshold: item.lowStockThreshold ?? null,
        categories: item.categories.map((category) => category.name),
        stock: item.stock.map((level) => ({
          location: level.location.name,
          quantity: level.quantity,
          expiresOn: level.expiresOn ?? null,
        })),
      })),
    };
  } catch (error) {
    if (error instanceof TransferError) throw error;
    if (isUnexpectedError(error)) throw error;
    throw new TransferError(
      'storage',
      'Could not read the inventory: storage unavailable.',
      error,
    );
  }
}

/** Serialize the document to the file bytes the user owns. */
export function serializeTransferDocument(doc: TransferDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Parse pasted/file text into a document: JSON shape plus the envelope
 * (format tag, supported version, top-level arrays). Entry-level domain
 * checks belong to `applyTransferDocument`, so a shape-valid file with
 * un-storable data parses but refuses at apply time.
 */
export function parseTransferDocument(text: unknown): TransferDocument {
  if (typeof text !== 'string') {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
      error,
    );
  }
  assertEnvelope(parsed);
  return parsed;
}

/** Envelope gate shared by parse and apply (direct-object callers). */
function assertEnvelope(doc: unknown): asserts doc is TransferDocument {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  const record = doc as Record<string, unknown>;
  if (record.format !== TRANSFER_FORMAT) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  if (typeof record.version !== 'number') {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  if (record.version !== TRANSFER_FORMAT_VERSION) {
    throw new TransferError(
      'version-mismatch',
      'This inventory file uses an unsupported format version.',
    );
  }
  if (
    typeof record.exportedAt !== 'string' ||
    !Array.isArray(record.locations) ||
    !Array.isArray(record.categories) ||
    !Array.isArray(record.items)
  ) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
}

interface ValidatedLocation {
  name: string;
  address: string | null;
}

interface ValidatedCategory {
  name: string;
}

interface ValidatedStockRow {
  locationIndex: number;
  quantity: number;
  expiresOn: string | null;
}

interface ValidatedItem {
  name: string;
  barcode: string | null;
  lowStockThreshold: number | null;
  stock: ValidatedStockRow[];
  categoryIndexes: number[];
}

interface ValidatedPlan {
  locations: ValidatedLocation[];
  categories: ValidatedCategory[];
  items: ValidatedItem[];
}

/**
 * Full entry validation: entry shapes (`malformed` for wrong types),
 * then domain rules through the existing validators (`validation` for
 * rejected values, `conflict` for within-file duplicates). Runs BEFORE
 * any transaction opens, so a refusal writes nothing. Location and
 * category references resolve by name to stand-in ids for the shared
 * `validateItemInput` check (positive ints, order-preserving); unknown
 * names reject instead of fabricating rows.
 */
function validateTransferPlan(doc: TransferDocument): ValidatedPlan {
  const locations: ValidatedLocation[] = doc.locations.map((entry) =>
    validateTransferLocation(entry),
  );
  const locationKeys = new Set<string>();
  for (const location of locations) {
    const key = normalizeNameKey(location.name);
    if (locationKeys.has(key)) {
      throw new TransferError(
        'conflict',
        'This inventory file lists the same location twice.',
      );
    }
    locationKeys.add(key);
  }
  const categories: ValidatedCategory[] = doc.categories.map((entry) =>
    validateTransferCategory(entry),
  );
  const categoryKeys = new Set<string>();
  for (const category of categories) {
    const key = normalizeNameKey(category.name);
    if (categoryKeys.has(key)) {
      throw new TransferError(
        'conflict',
        'This inventory file lists the same category twice.',
      );
    }
    categoryKeys.add(key);
  }
  const locationIndexByKey = new Map<string, number>();
  locations.forEach((location, index) => {
    locationIndexByKey.set(normalizeNameKey(location.name), index);
  });
  const categoryIndexByKey = new Map<string, number>();
  categories.forEach((category, index) => {
    categoryIndexByKey.set(normalizeNameKey(category.name), index);
  });

  const seenBarcodes = new Set<string>();
  const items: ValidatedItem[] = doc.items.map((entry) =>
    validateTransferItem(entry, locationIndexByKey, categoryIndexByKey),
  );
  for (const item of items) {
    if (item.barcode !== null) {
      if (seenBarcodes.has(item.barcode)) {
        throw new TransferError(
          'conflict',
          'This inventory file assigns the same barcode twice.',
        );
      }
      seenBarcodes.add(item.barcode);
    }
  }
  return { locations, categories, items };
}

function validateTransferLocation(entry: unknown): ValidatedLocation {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  const record = entry as Record<string, unknown>;
  if (
    typeof record.name !== 'string' ||
    (record.address !== undefined &&
      record.address !== null &&
      typeof record.address !== 'string')
  ) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  try {
    return validateLocationInput({
      name: record.name,
      address: (record.address ?? null) as string | null,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new TransferError(
        'validation',
        'This inventory file contains a location that cannot be imported.',
        error,
      );
    }
    throw error;
  }
}

function validateTransferCategory(entry: unknown): ValidatedCategory {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.name !== 'string') {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  try {
    return validateCategoryInput({ name: record.name });
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new TransferError(
        'validation',
        'This inventory file contains a category that cannot be imported.',
        error,
      );
    }
    throw error;
  }
}

function validateTransferItem(
  entry: unknown,
  locationIndexByKey: Map<string, number>,
  categoryIndexByKey: Map<string, number>,
): ValidatedItem {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  const record = entry as Record<string, unknown>;
  if (
    typeof record.name !== 'string' ||
    (record.barcode !== undefined &&
      record.barcode !== null &&
      typeof record.barcode !== 'string') ||
    (record.lowStockThreshold !== undefined &&
      record.lowStockThreshold !== null &&
      typeof record.lowStockThreshold !== 'number') ||
    !Array.isArray(record.categories) ||
    !Array.isArray(record.stock)
  ) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  const stock = (record.stock as unknown[]).map((row) =>
    validateTransferStockRow(row, locationIndexByKey),
  );
  const categoryIndexes = (record.categories as unknown[]).map((name) => {
    if (typeof name !== 'string') {
      throw new TransferError(
        'malformed',
        'This file is not a valid inventory export.',
      );
    }
    const index = categoryIndexByKey.get(normalizeNameKey(name));
    if (index === undefined) {
      throw new TransferError(
        'validation',
        'This inventory file references a category it does not contain.',
      );
    }
    return index;
  });
  try {
    // Shared domain check: S10 bounds, barcode shape, expiry shape,
    // duplicate locations — identical to every other item writer.
    // Stand-in ids (index + 1) stand for the rows the plan inserts in
    // order; only their distinctness matters here.
    validateItemInput({
      name: record.name,
      barcode: (record.barcode ?? null) as string | null,
      lowStockThreshold: (record.lowStockThreshold ?? null) as number | null,
      stock: stock.map((row) => ({
        locationId: row.locationIndex + 1,
        quantity: row.quantity,
        expiresOn: row.expiresOn,
      })),
      categoryIds: categoryIndexes.map((index) => index + 1),
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new TransferError(
        'validation',
        'This inventory file contains an item that cannot be imported.',
        error,
      );
    }
    throw error;
  }
  return {
    name: (record.name as string).trim(),
    barcode:
      typeof record.barcode === 'string' && record.barcode.trim() !== ''
        ? record.barcode.trim()
        : null,
    lowStockThreshold:
      typeof record.lowStockThreshold === 'number'
        ? record.lowStockThreshold
        : null,
    stock,
    categoryIndexes,
  };
}

function validateTransferStockRow(
  entry: unknown,
  locationIndexByKey: Map<string, number>,
): ValidatedStockRow {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  const record = entry as Record<string, unknown>;
  if (
    typeof record.location !== 'string' ||
    typeof record.quantity !== 'number' ||
    (record.expiresOn !== undefined &&
      record.expiresOn !== null &&
      typeof record.expiresOn !== 'string')
  ) {
    throw new TransferError(
      'malformed',
      'This file is not a valid inventory export.',
    );
  }
  const locationIndex = locationIndexByKey.get(
    normalizeNameKey(record.location),
  );
  if (locationIndex === undefined) {
    throw new TransferError(
      'validation',
      'This inventory file references a location it does not contain.',
    );
  }
  // A stored row means `quantity > 0` (schema CHECK): refuse a zero row
  // instead of silently dropping what the file contains.
  if (!Number.isInteger(record.quantity) || record.quantity <= 0) {
    throw new TransferError(
      'validation',
      'This inventory file contains a stock row that cannot be imported.',
    );
  }
  // Normalize the expiry through the shared domain normalizer BEFORE
  // anything can reach SQL: blank becomes null, padding is trimmed, and
  // a value it rejects refuses here as typed `validation` instead of
  // dying later on the v5 `GLOB` CHECK as a `storage` failure.
  let expiresOn: string | null;
  try {
    expiresOn = normalizeExpiresOn(record.expiresOn);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new TransferError(
        'validation',
        'This inventory file contains a stock row that cannot be imported.',
        error,
      );
    }
    throw error;
  }
  return {
    locationIndex,
    quantity: record.quantity,
    expiresOn,
  };
}

/**
 * Optional shared-connection hook (see `src/db/exclusive.ts`): same
 * preference order as the item repository.
 */
interface SharedExclusiveDb extends RepositoryDb {
  withSharedExclusiveTransactionAsync?: (
    task: (txn: TransactionHandle) => Promise<void>,
  ) => Promise<void>;
}

/**
 * Apply a transfer document atomically: the validated plan wipes and
 * recreates the inventory inside ONE exclusive transaction on the scoped
 * handle. Any failure rolls back with no partial rows.
 */
export async function applyTransferDocument(
  db: RepositoryDb,
  doc: TransferDocument,
): Promise<TransferSummary> {
  assertEnvelope(doc);
  const plan = validateTransferPlan(doc);
  const shared = (db as SharedExclusiveDb).withSharedExclusiveTransactionAsync;
  const hook =
    typeof shared === 'function' ? shared : db.withExclusiveTransactionAsync;
  if (typeof hook !== 'function') {
    throw new TransferError(
      'storage',
      'Could not apply the inventory file: storage unavailable.',
      new Error('exclusive transaction unavailable'),
    );
  }
  try {
    await hook.call(db, async (txn: TransactionHandle) => {
      await txn.runAsync('DELETE FROM item_categories');
      await txn.runAsync('DELETE FROM stock');
      await txn.runAsync('DELETE FROM items');
      await txn.runAsync('DELETE FROM locations');
      await txn.runAsync('DELETE FROM categories');
      const locationIds: number[] = [];
      for (const location of plan.locations) {
        locationIds.push(
          await insertLocationRow(txn, location.name, location.address),
        );
      }
      const categoryIds: number[] = [];
      for (const category of plan.categories) {
        categoryIds.push(await insertCategoryRow(txn, category.name));
      }
      for (const item of plan.items) {
        const itemId = await insertItemRow(
          txn,
          item.name,
          item.lowStockThreshold,
          item.barcode,
        );
        for (const row of item.stock) {
          await txn.runAsync(
            'INSERT INTO stock (item_id, location_id, quantity, expires_on) VALUES (?, ?, ?, ?)',
            [
              itemId,
              locationIds[row.locationIndex],
              row.quantity,
              row.expiresOn,
            ],
          );
        }
        for (const categoryIndex of item.categoryIndexes) {
          await txn.runAsync(
            'INSERT INTO item_categories (item_id, category_id) VALUES (?, ?)',
            [itemId, categoryIds[categoryIndex]],
          );
        }
      }
    });
  } catch (error) {
    if (error instanceof TransferError) throw error;
    if (isUnexpectedError(error)) throw error;
    if (isUniqueViolation(error)) {
      throw new TransferError(
        'conflict',
        'This inventory file conflicts with stored data.',
        error,
      );
    }
    throw new TransferError(
      'storage',
      'Could not apply the inventory file: storage unavailable.',
      error,
    );
  }
  return {
    locations: plan.locations.length,
    categories: plan.categories.length,
    items: plan.items.length,
    stockRows: plan.items.reduce((sum, item) => sum + item.stock.length, 0),
  };
}

async function insertLocationRow(
  txn: TransactionHandle,
  name: string,
  address: string | null,
): Promise<number> {
  try {
    const created = await txn.runAsync(
      'INSERT INTO locations (name, address) VALUES (?, ?)',
      [name, address],
    );
    return created.lastInsertRowId;
  } catch (error) {
    if (isUnexpectedError(error)) throw error;
    if (isUniqueViolation(error)) {
      throw new TransferError(
        'conflict',
        'This inventory file conflicts with stored data.',
        error,
      );
    }
    throw error;
  }
}

async function insertCategoryRow(
  txn: TransactionHandle,
  name: string,
): Promise<number> {
  try {
    const created = await txn.runAsync(
      'INSERT INTO categories (name) VALUES (?)',
      [name],
    );
    return created.lastInsertRowId;
  } catch (error) {
    if (isUnexpectedError(error)) throw error;
    if (isUniqueViolation(error)) {
      throw new TransferError(
        'conflict',
        'This inventory file conflicts with stored data.',
        error,
      );
    }
    throw error;
  }
}

async function insertItemRow(
  txn: TransactionHandle,
  name: string,
  lowStockThreshold: number | null,
  barcode: string | null,
): Promise<number> {
  try {
    const created = await txn.runAsync(
      'INSERT INTO items (name, low_stock_threshold, barcode) VALUES (?, ?, ?)',
      [name, lowStockThreshold, barcode],
    );
    return created.lastInsertRowId;
  } catch (error) {
    if (isUnexpectedError(error)) throw error;
    if (isUniqueViolation(error)) {
      throw new TransferError(
        'conflict',
        'This inventory file conflicts with stored data.',
        error,
      );
    }
    throw error;
  }
}
