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
 * live here.
 *
 * Migration 2 never backfills or fabricates locations. The runner (see
 * `src/db/index.ts`) refuses to apply it while v1 `items` holds any rows and
 * raises `MigrationRequiredError` instead, leaving rows and `user_version`
 * untouched.
 */
export const SCHEMA_VERSION = 2;

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
};

/**
 * Notes on what migration 2 deliberately does NOT contain (all proposed,
 * none user-approved): name/address length caps, name/address uniqueness,
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
