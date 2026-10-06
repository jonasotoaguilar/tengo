/**
 * Versioned SQLite migrations (no ORM).
 *
 * Each key is a schema version; the value is the SQL applied exactly once when
 * upgrading to that version. `user_version` in the database tracks what is
 * already applied. Migration 1 is the minimal useful foundation for a
 * household inventory app: a single `items` table. Domain CRUD arrives later.
 */
export const SCHEMA_VERSION = 1;

export const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`.trim(),
};

/** Sorted list of migration versions still pending for `currentVersion`. */
export function getPendingMigrations(currentVersion: number): number[] {
  return Object.keys(MIGRATIONS)
    .map(Number)
    .filter((version) => version > currentVersion)
    .sort((a, b) => a - b);
}
