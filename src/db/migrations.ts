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
 */
export const SCHEMA_VERSION = 3;

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
