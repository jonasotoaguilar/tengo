/**
 * Versioned SQLite migrations (no ORM).
 *
 * Each key is a schema version; the value is the SQL applied exactly once when
 * upgrading to that version. `user_version` in the database tracks what is
 * already applied. Migration 1 is the minimal useful foundation for a
 * household inventory app: a single `items` table. Migration 2 normalizes the
 * approved M1 model: `locations` and `categories` entities, `items` with a
 * required `location_id` foreign key plus `quantity`, and an
 * `item_categories` join. Domain CRUD arrives later (M2); no query helpers
 * live here. Migration 3 (adopted S11) adds one `UNIQUE` expression index
 * per entity table over the normalized name (`lower(trim(name))`, an
 * SQLite expression index): the database enforces the case/whitespace part
 * of name uniqueness. SQLite cannot fold accents, so the accent part is
 * enforced in the domain layer (`normalizeNameKey`), which runs before
 * every write; the index stays the backstop authority for races.
 *
 * Migration 2 never backfills or fabricates locations. The runner (see
 * `src/db/index.ts`) refuses to apply it while v1 `items` holds any rows and
 * raises `MigrationRequiredError` instead, leaving rows and `user_version`
 * untouched.
 *
 * Migration 3 never rewrites or fabricates names. Its guard aborts with a
 * clear `Migration to schema version 3 blocked` message while duplicate
 * names exist (checked first, inside the same runner transaction), leaving
 * rows and `user_version` untouched: no silent rewrite, no row loss, no
 * invented data.
 *
 * Migration 4 (multi-location stock) splits identity from storage: `items`
 * is rebuilt as the identity-only catalog (`id`, `name`, `created_at`)
 * and per-location quantities move to `stock(item_id, location_id,
 * quantity)`. SQLite cannot drop a column used by an index or a foreign
 * key, so the table is rebuilt following the SQLite procedure. The
 * rebuild MUST run with `PRAGMA foreign_keys=OFF` OUTSIDE the transaction
 * (inside it the pragma is a no-op): `item_categories.item_id REFERENCES
 * items(id) ON DELETE CASCADE` means a plain `DROP TABLE items` with
 * foreign keys ON silently cascade-deletes every category link. The
 * runner (see `src/db/index.ts`) owns that envelope; this SQL only holds
 * the rebuild plus its preserve-and-stop guard.
 *
 * Migration 5 (scanner + reminders base, U2) is purely ADDITIVE: two
 * `ALTER TABLE items ADD COLUMN` (`low_stock_threshold`, `barcode`), one
 * `CREATE UNIQUE INDEX` (`idx_items_barcode`), and one `ALTER TABLE stock
 * ADD COLUMN` (`expires_on`). No table is rebuilt, so no preserve-and-stop
 * guard is needed: existing rows keep every value and the new columns
 * default to NULL. The runner applies it on the generic path (FK ON,
 * one transaction with the version bump) — only v4 owns the FK-off
 * envelope. `low_stock_threshold` mirrors the S10 product bound
 * (0-999999, integer storage) in SQL; the barcode SHAPE is domain-only
 * (same split as S11 accents: SQLite cannot express the code regex, so
 * `normalizeBarcode` owns it and the UNIQUE index owns identity); the
 * `expires_on` CHECK enforces the ISO YYYY-MM-DD shape while calendar
 * validity (month/day, leap years) stays domain-only in
 * `normalizeExpiresOn`.
 *
 * Migration 6 (U11 address uniqueness, adopted now) is purely ADDITIVE:
 * one `CREATE UNIQUE INDEX` (partial: `WHERE address IS NOT NULL`, so
 * many address-less locations stay legal) over the normalized address
 * (`lower(trim(address))`, the same case/whitespace expression discipline
 * migration 3 uses for names). SQLite cannot fold accents, so the accent
 * part is enforced in the domain layer (`normalizeAddressKey`), which
 * runs before every write; the index stays the backstop authority for
 * races. No table rebuild, no DROP, no column change; a database that
 * already holds duplicate addresses fails loudly with a clear `Migration
 * to schema version 6 blocked` message and leaves rows and
 * `user_version` untouched, exactly like the v3 guard (TEMP scratch
 * table plus a single-firing TEMP trigger, inside the runner's
 * transaction). Never rewritten, never nulled out, never fabricated.
 *
 * The guard aborts with a clear `Migration to schema version 4 blocked`
 * message (via a single-firing TEMP trigger, same pattern as v3) when the
 * copied catalog count differs from the old item count or the stock sum
 * differs from the old quantity sum, leaving rows and `user_version`
 * untouched: one stock row per old item WITH `quantity > 0` (an old item
 * at quantity 0 becomes a catalog item with no stock = "sin stock"),
 * never rewritten, never an invented location, never backfilled. `PRAGMA
 * foreign_key_check` must come back empty before the version bump.
 */
export const SCHEMA_VERSION = 6;

export const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`.trim(),
  // Guard (enforced in code before this SQL runs): v1 `items` must be empty.
  // Applied only to an empty v1 table (or a fresh database that just applied
  // migration 1, which is empty by construction), so dropping the legacy
  // table discards zero rows. A nonempty v1 database stops with
  // `MigrationRequiredError` and this SQL never runs.
  2: `
DROP TABLE IF EXISTS items;
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(TRIM(name)) > 0),
  address TEXT CHECK (address IS NULL OR length(TRIM(address)) > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(TRIM(name)) > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(TRIM(name)) > 0),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (typeof(quantity) = 'integer' AND quantity >= 0 AND quantity <= 9007199254740991),
  location_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS item_categories (
  item_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (item_id, category_id),
  FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_items_location_id ON items (location_id);
CREATE INDEX IF NOT EXISTS idx_item_categories_category_id ON item_categories (category_id);
`.trim(),
  // Guard (enforced by this SQL before the indexes are built): the v2
  // tables must hold no duplicate names after trim/case normalization.
  // `RAISE` only runs inside a trigger, so the guard is a TEMP scratch
  // table plus a single-firing TEMP trigger (TEMP objects vanish when the
  // connection closes, so only the trigger is dropped explicitly). The
  // runner applies this whole script in one transaction with the version
  // bump, so a blocked migration rolls back to untouched rows and
  // `user_version`. A nonempty v2 database with duplicates stops with a
  // clear `Migration to schema version 3 blocked` message instead of being
  // rewritten; an empty v2 database migrates cleanly.
  3: `
CREATE TEMP TABLE _migration_v3_guard (id INTEGER);
CREATE TEMP TRIGGER _migration_v3_guard_check BEFORE INSERT ON _migration_v3_guard
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM (SELECT lower(trim(name)) AS k FROM locations GROUP BY k HAVING COUNT(*) > 1)) > 0
    THEN RAISE(ABORT, 'Migration to schema version 3 blocked: locations holds duplicate names after trim/case normalization. Rows and schema version are preserved; rename the duplicates before retrying. No data was modified.')
    WHEN (SELECT COUNT(*) FROM (SELECT lower(trim(name)) AS k FROM categories GROUP BY k HAVING COUNT(*) > 1)) > 0
    THEN RAISE(ABORT, 'Migration to schema version 3 blocked: categories holds duplicate names after trim/case normalization. Rows and schema version are preserved; rename the duplicates before retrying. No data was modified.')
  END;
END;
INSERT INTO _migration_v3_guard (id) VALUES (1);
DROP TRIGGER IF EXISTS temp._migration_v3_guard_check;
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_name_norm ON locations (lower(trim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_norm ON categories (lower(trim(name)));
`.trim(),
  // Rebuild (runs under the runner's FK-off envelope, see `src/db/index.ts`):
  // the new catalog keeps `id, name, created_at` byte-identical; `stock`
  // carries one row per old item WITH `quantity > 0`; the TEMP guard
  // aborts before the DROP when either comparison differs; the
  // `sqlite_sequence` fix-up keeps AUTOINCREMENT past the preserved max id
  // after the rename (DROP removes the old row, RENAME does not move the
  // new one). `stock.location_id ON DELETE CASCADE` is the R3 inversion:
  // deleting a location removes stock, never items.
  4: `
CREATE TABLE items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(TRIM(name)) > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO items_new (id, name, created_at) SELECT id, name, created_at FROM items;
CREATE TABLE stock (
  item_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0 AND quantity <= 9007199254740991),
  PRIMARY KEY (item_id, location_id),
  FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
);
INSERT INTO stock (item_id, location_id, quantity) SELECT id, location_id, quantity FROM items WHERE quantity > 0;
CREATE TEMP TABLE _migration_v4_guard (id INTEGER);
CREATE TEMP TRIGGER _migration_v4_guard_check BEFORE INSERT ON _migration_v4_guard
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM items_new) != (SELECT COUNT(*) FROM items)
    THEN RAISE(ABORT, 'Migration to schema version 4 blocked: catalog copy holds a different row count than the old items table. Rows and schema version are preserved; no data was modified.')
    WHEN (SELECT COALESCE(SUM(quantity), 0) FROM stock) != (SELECT COALESCE(SUM(quantity), 0) FROM items)
    THEN RAISE(ABORT, 'Migration to schema version 4 blocked: stock quantity sum differs from the old items quantity sum. Rows and schema version are preserved; no data was modified.')
  END;
END;
INSERT INTO _migration_v4_guard (id) VALUES (1);
DROP TRIGGER IF EXISTS temp._migration_v4_guard_check;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
UPDATE sqlite_sequence SET name = 'items' WHERE name = 'items_new';
CREATE INDEX IF NOT EXISTS idx_stock_location_id ON stock (location_id);
`.trim(),
  // Additive (U2 scanner + reminders base): two nullable item columns,
  // the UNIQUE barcode identity index, and one nullable stock column.
  // Existing rows are untouched (new columns default to NULL) and NULL
  // barcodes never collide, so many codeless items stay legal. Runs on
  // the generic runner path: FK ON, one transaction with the version
  // bump, no envelope, no guard.
  5: `
ALTER TABLE items ADD COLUMN low_stock_threshold INTEGER CHECK (low_stock_threshold IS NULL OR (typeof(low_stock_threshold) = 'integer' AND low_stock_threshold >= 0 AND low_stock_threshold <= 999999));
ALTER TABLE items ADD COLUMN barcode TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode ON items (barcode);
ALTER TABLE stock ADD COLUMN expires_on TEXT CHECK (expires_on IS NULL OR (expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));
`.trim(),
  // Guard (enforced by this SQL before the index is built): the v5
  // locations table must hold no duplicate addresses after trim/case
  // normalization (NULL addresses excluded: many address-less locations
  // stay legal). `RAISE` only runs inside a trigger, so the guard is a
  // TEMP scratch table plus a single-firing TEMP trigger (TEMP objects
  // vanish when the connection closes, so only the trigger is dropped
  // explicitly). The runner applies this whole script in one transaction
  // with the version bump, so a blocked migration rolls back to
  // untouched rows and `user_version`. A v5 database with duplicates
  // stops with a clear `Migration to schema version 6 blocked` message
  // instead of being rewritten; an empty v5 database migrates cleanly.
  6: `
CREATE TEMP TABLE _migration_v6_guard (id INTEGER);
CREATE TEMP TRIGGER _migration_v6_guard_check BEFORE INSERT ON _migration_v6_guard
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM (SELECT lower(trim(address)) AS k FROM locations WHERE address IS NOT NULL GROUP BY k HAVING COUNT(*) > 1)) > 0
    THEN RAISE(ABORT, 'Migration to schema version 6 blocked: locations holds duplicate addresses after trim/case normalization. Rows and schema version are preserved; give each address to at most one location before retrying. No data was modified.')
  END;
END;
INSERT INTO _migration_v6_guard (id) VALUES (1);
DROP TRIGGER IF EXISTS temp._migration_v6_guard_check;
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_address_norm ON locations (lower(trim(address))) WHERE address IS NOT NULL;
`.trim(),
};

/**
 * Notes on what migration 2 deliberately does NOT contain (all proposed,
 * none user-approved at the time): name/address length caps, product
 * quantity caps, accent folding, and any synthetic-location backfill.
 * Name uniqueness arrived later as adopted S11 and lives in migration 3
 * (case/whitespace `UNIQUE` index) plus the domain layer (accent folding),
 * so migration 2 still carries no `UNIQUE` clause.
 * product quantity caps, accent folding, and any synthetic-location backfill.
 * The `9007199254740991` bound is `Number.MAX_SAFE_INTEGER`, a technical
 * JavaScript-integer guard (documented in `src/inventory/validation.ts`), not
 * a product quantity limit. `typeof(quantity) = 'integer'` enforces integer
 * storage in SQLite itself (rejecting fractional REAL values such as 1.5),
 * matching the domain `normalizeQuantity` rule; it adds no product cap. `ON DELETE RESTRICT` on `items.location_id`
 * means deleting a location that still has items fails instead of orphaning
 * or cascade-deleting those items; join rows clean up with their parent item
 * or category via `ON DELETE CASCADE`.
 */

/** Sorted list of migration versions still pending for `currentVersion`. */
export function getPendingMigrations(currentVersion: number): number[] {
  return Object.keys(MIGRATIONS)
    .map(Number)
    .filter((version) => version > currentVersion)
    .sort((a, b) => a - b);
}

/**
 * Raised when migration to schema v2 is blocked because v1 `items` still
 * holds rows that predate the required location entity. The runner raises
 * this before executing any migration SQL, so v1 rows and `user_version` are
 * preserved. No synthetic location is created and no data is modified.
 */
export class MigrationRequiredError extends Error {
  readonly code = 'MIGRATION_REQUIRED';
  readonly rowCount: number;

  constructor(rowCount: number) {
    super(
      `Migration to schema version 2 blocked: ${rowCount} v1 item row(s) ` +
        'predate the required location entity. Rows and schema version are ' +
        'preserved; assign a valid location to each row before retrying. ' +
        'No synthetic location was created and no data was modified.',
    );
    this.name = 'MigrationRequiredError';
    this.rowCount = rowCount;
  }
}

/**
 * Raised when the v4 preserve-and-stop guard fires (catalog count or stock
 * sum differs) or the post-rebuild `foreign_key_check` is non-empty. The
 * runner raises this inside the migration transaction, so rows and
 * `user_version` are preserved. Never rewritten, never an invented
 * location, never backfilled.
 */
export class MigrationIntegrityError extends Error {
  readonly code = 'MIGRATION_INTEGRITY';

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MigrationIntegrityError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Raised when the database reports a schema version newer than
 * `SCHEMA_VERSION`. Downgrade and forward migration are out of scope, so the
 * runner refuses to open the database instead of guessing.
 */
export class UnknownSchemaVersionError extends Error {
  readonly code = 'UNKNOWN_SCHEMA_VERSION';
  readonly foundVersion: number;
  readonly knownVersion: number;

  constructor(foundVersion: number, knownVersion: number = SCHEMA_VERSION) {
    super(
      `Unsupported database schema version ${foundVersion} ` +
        `(latest known: ${knownVersion}). Refusing to open: downgrade and ` +
        'forward migration are out of scope.',
    );
    this.name = 'UnknownSchemaVersionError';
    this.foundVersion = foundVersion;
    this.knownVersion = knownVersion;
  }
}
