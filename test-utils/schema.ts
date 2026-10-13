/**
 * Shared schema fixture: bring a real in-memory database to the current schema.
 *
 * Several suites need "a database at the current schema" only as a starting
 * point (seed rows, run the query layer, assert behavior). Hand-building
 * that schema per suite (a `CREATE TABLE` sequence or `db.exec(MIGRATIONS[1])`
 * ... `[2]`, `[3]` plus a copied v4 envelope) is a drift surface: when
 * schema v5 landed, suites whose copy stopped at v4 failed with
 * `no such column` while the query layer had moved on.
 *
 * This helper removes that surface by applying the REAL ladder through the
 * REAL runner (`initializeDatabase` in `src/db/index.ts`): every entry of
 * `MIGRATIONS` in version order, including the v4 FK-off envelope
 * (`PRAGMA foreign_keys=OFF` outside the transaction, rebuild plus
 * `foreign_key_check` plus version bump inside, `PRAGMA foreign_keys=ON`
 * after) and the generic single-transaction path for every other version.
 * A future migration is picked up with no edit here: the runner owns the
 * ladder, this helper only bridges it onto `node:sqlite`.
 *
 * Suites that test the runner or the ladder itself (`db-init.test.ts`,
 * `migrations.test.ts`, the v4->v5 preservation test in
 * `migration-v5.test.ts`) keep stepping by hand: there the stepping is the
 * subject, not an accident.
 *
 * Location note: this file lives outside the `__tests__` directory and its
 * name has no `test` or `spec` infix, so none of the default Jest testMatch
 * patterns collect it as a suite. No Jest config change is needed;
 * `npx jest --listTests` confirms it stays out of the runner.
 */
import { type DatabaseLike, initializeDatabase } from '../src/db';

/** Minimal `node:sqlite` surface the helper needs (mirrors the per-suite casts). */
export interface RealDbHandle {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

/** Bridge a `node:sqlite` handle onto the runner's `DatabaseLike` boundary. */
function wrapRealDb(db: RealDbHandle): DatabaseLike {
  return {
    execAsync: async (source: string) => {
      db.exec(source);
    },
    getFirstAsync: async (source: string) => db.prepare(source).get() ?? null,
    withTransactionAsync: async (task: () => Promise<void>) => {
      db.exec('BEGIN;');
      try {
        await task();
      } catch (error) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Best effort: the rollback of the failed ladder step is what
          // matters, and its failure is reported by rethrowing below.
        }
        throw error;
      }
      db.exec('COMMIT;');
    },
  };
}

/**
 * Run the real migration ladder on `db`, leaving it at the current schema
 * version with foreign keys enforced (the runner enables them first and the
 * v4 envelope restores them). The database must be fresh: like the runner,
 * this refuses a v1 database that still holds rows (`MigrationRequiredError`)
 * and rejects versions newer than known (`UnknownSchemaVersionError`).
 */
export async function bringToCurrentSchema(db: RealDbHandle): Promise<void> {
  await initializeDatabase(wrapRealDb(db));
}
