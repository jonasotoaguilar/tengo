import { openManagedDatabase } from './exclusive';
import {
  getPendingMigrations,
  MIGRATIONS,
  MigrationIntegrityError,
  MigrationRequiredError,
  SCHEMA_VERSION,
  UnknownSchemaVersionError,
} from './migrations';

export type { ManagedDatabase } from './exclusive';
export { openManagedDatabase } from './exclusive';
export {
  MigrationIntegrityError,
  MigrationRequiredError,
  UnknownSchemaVersionError,
};

export const DATABASE_NAME = 'tengo.db';

/** Minimal structural subset of `expo-sqlite` used by the foundation.
 *
 * Tests inject a fake implementing this interface, so unit tests exercise
 * the migration logic without native code or a real `.db` file.
 * `withTransactionAsync` is optional only so older fakes keep working; the
 * real `expo-sqlite` database always provides it (installed
 * `SQLiteDatabase.d.ts`/`SQLiteDatabase.js`: `BEGIN` -> task -> `COMMIT`,
 * `ROLLBACK` plus rethrow on failure).
 */
export interface DatabaseLike {
  execAsync(source: string): Promise<void>;
  getFirstAsync(source: string): Promise<unknown>;
  withTransactionAsync?(task: () => Promise<void>): Promise<void>;
}

export async function getUserVersion(db: DatabaseLike): Promise<number> {
  const row = (await db.getFirstAsync('PRAGMA user_version')) as {
    user_version: number;
  } | null;
  return row?.user_version ?? 0;
}

export async function setUserVersion(
  db: DatabaseLike,
  version: number,
): Promise<void> {
  // `version` always comes from our own MIGRATIONS keys (a number), never
  // from user input, so interpolating it is safe.
  await db.execAsync(`PRAGMA user_version = ${version}`);
}

/**
 * Enable foreign-key enforcement for this connection.
 *
 * SQLite enforces foreign keys per connection and defaults to off, so this
 * must run explicitly on every open, outside any transaction. Without it the
 * v2 `REFERENCES` clauses would parse but never reject dangling rows.
 */
export async function enableForeignKeys(db: DatabaseLike): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON');
}

/**
 * Run `task` atomically: on the real database this is `withTransactionAsync`
 * (`COMMIT` on success, `ROLLBACK` on failure). Fakes without transaction
 * support run the task directly; transactionality of the real path is proven
 * by host SQLite runs, not by those fakes.
 */
async function runInTransaction(
  db: DatabaseLike,
  task: () => Promise<void>,
): Promise<void> {
  if (typeof db.withTransactionAsync === 'function') {
    await db.withTransactionAsync(task);
    return;
  }
  await task();
}

async function countV1Items(db: DatabaseLike): Promise<number> {
  const row = (await db.getFirstAsync(
    'SELECT COUNT(*) AS count FROM items',
  )) as { count: number } | null;
  return row?.count ?? 0;
}

/**
 * Apply one migration with its version bump in a single transaction, so a
 * failing migration statement rolls the version update back with it.
 * Migration 2 additionally refuses to run while v1 `items` holds any rows
 * (see `MigrationRequiredError`): the check happens before the transaction,
 * so the block itself writes nothing. Migration 4 additionally runs under
 * the FK-off envelope: `PRAGMA foreign_keys=OFF` OUTSIDE the transaction
 * (inside it the pragma is a no-op — with keys ON the `DROP TABLE items`
 * would cascade-delete every `item_categories` link), then the rebuild
 * plus a `foreign_key_check` plus the version bump in one transaction,
 * then commit, then `PRAGMA foreign_keys=ON`. A non-empty check or the
 * in-SQL preserve-and-stop guard surfaces as `MigrationIntegrityError`
 * with rows and version untouched. Migrations 2, 3, 5, and 6 run the generic path exactly as before:
 * FK ON inside one transaction (5 and 6 are purely additive, so neither needs the v4 envelope).
 */
async function applyMigration(
  db: DatabaseLike,
  version: number,
): Promise<void> {
  if (version === 2) {
    const rowCount = await countV1Items(db);
    if (rowCount > 0) {
      throw new MigrationRequiredError(rowCount);
    }
  }
  if (version === 4) {
    await db.execAsync('PRAGMA foreign_keys = OFF');
    try {
      await runInTransaction(db, async () => {
        await db.execAsync(MIGRATIONS[version]);
        const check = (await db.getFirstAsync(
          'SELECT COUNT(*) AS count FROM pragma_foreign_key_check',
        )) as { count: number } | null;
        if ((check?.count ?? 0) > 0) {
          throw new MigrationIntegrityError(
            'Migration to schema version 4 blocked: ' +
              `foreign_key_check reported ${check?.count} violation(s) after the rebuild. ` +
              'Rows and schema version are preserved; no data was modified.',
          );
        }
        await setUserVersion(db, version);
      });
    } catch (error) {
      if (error instanceof MigrationIntegrityError) throw error;
      if (
        error instanceof Error &&
        /Migration to schema version 4 blocked/.test(error.message)
      ) {
        throw new MigrationIntegrityError(error.message, error);
      }
      throw error;
    } finally {
      await db.execAsync('PRAGMA foreign_keys = ON');
    }
    return;
  }
  await runInTransaction(db, async () => {
    await db.execAsync(MIGRATIONS[version]);
    await setUserVersion(db, version);
  });
}

/**
 * Open the database and apply pending migrations in version order.
 *
 * An injected `externalDb` keeps the historical fake-friendly semantics for
 * schema unit tests. The default production open uses the shared managed
 * factory (`openManagedDatabase`), so item mutations run on FK-enforced
 * isolated exclusive connections. Only the default open uses the factory.
 */
export async function initializeDatabase(
  externalDb?: DatabaseLike,
): Promise<DatabaseLike> {
  const db: DatabaseLike =
    externalDb ?? (await openManagedDatabase(DATABASE_NAME));
  // Foreign keys on first: per-connection, and never inside a migration
  // transaction (a pragma, not transactional schema work).
  await enableForeignKeys(db);
  const currentVersion = await getUserVersion(db);
  if (currentVersion > SCHEMA_VERSION) {
    throw new UnknownSchemaVersionError(currentVersion, SCHEMA_VERSION);
  }
  for (const version of getPendingMigrations(currentVersion)) {
    await applyMigration(db, version);
  }
  return db;
}
