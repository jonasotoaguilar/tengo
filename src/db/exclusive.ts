/**
 * Managed native database opening factory (production + fixture shared path).
 *
 * The installed `expo-sqlite` driver runs `withExclusiveTransactionAsync`
 * item mutations on a NEW native connection (`Transaction.createAsync`:
 * same path, `useNewConnection: true`, only `initAsync()` — no
 * `PRAGMA foreign_keys = ON` anywhere in the driver's `build/*.js`).
 * SQLite enforces foreign keys per connection and defaults to OFF, so every
 * scoped exclusive transaction ran FK-OFF: item deletes could not cascade to
 * `item_categories` and bogus joins would be accepted. `PRAGMA
 * foreign_keys = ON` is a no-op inside a transaction (after `BEGIN`), so the
 * narrow fix enables + verifies FK on the isolated connection BEFORE
 * `BEGIN IMMEDIATE` — a driver/open-path change, never a harness override.
 *
 * Uses ONLY public `expo-sqlite` `openDatabaseAsync` plus
 * `SQLiteDatabase.databasePath`/`options`. No internal `NativeDatabase`
 * imports, private fields, `node_modules` patches, or monkeypatching.
 * The composition root (and future M3) opens through `openManagedDatabase`;
 * `initializeDatabase` without an injected fake uses it for `tengo.db`, and
 * the repository fixture uses the EXACT same factory with its fixture file.
 */

import type { SQLiteDatabase, SQLiteOpenOptions } from 'expo-sqlite';
import * as SQLite from 'expo-sqlite';

/** Public opener shape: exactly `openDatabaseAsync(name, options?, dir?)`. */
export type ManagedOpenFn = typeof SQLite.openDatabaseAsync;

/** Bind values mirrored from the repository layer (no blobs, no objects). */
export type ManagedBindParams = readonly (string | number | null)[];

export interface ManagedRunResult {
  lastInsertRowId: number;
  changes: number;
}

/** Scoped handle handed to an exclusive task: the isolated connection. */
export interface ManagedTransactionHandle {
  runAsync(
    source: string,
    params?: ManagedBindParams,
  ): Promise<ManagedRunResult>;
  getFirstAsync<T>(
    source: string,
    params?: ManagedBindParams,
  ): Promise<T | null>;
  getAllAsync<T>(source: string, params?: ManagedBindParams): Promise<T[]>;
  execAsync(source: string): Promise<void>;
}

/** Managed database: outer handle plus FK-safe exclusive transactions. */
export interface ManagedDatabase {
  readonly databaseName: string;
  readonly directory: string | undefined;
  readonly databasePath: string;
  readonly options: SQLiteOpenOptions;
  execAsync(source: string): Promise<void>;
  runAsync(
    source: string,
    params?: ManagedBindParams,
  ): Promise<ManagedRunResult>;
  getFirstAsync<T>(
    source: string,
    params?: ManagedBindParams,
  ): Promise<T | null>;
  getAllAsync<T>(source: string, params?: ManagedBindParams): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  withExclusiveTransactionAsync(
    task: (txn: ManagedTransactionHandle) => Promise<void>,
  ): Promise<void>;
  closeAsync(): Promise<void>;
}

/** Infrastructure failure with a fixed diagnostic message (never user SQL). */
export class ManagedDatabaseError extends Error {
  readonly code = 'MANAGED_DATABASE_ERROR';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'ManagedDatabaseError';
  }
}

/**
 * Split a resolved native database path into its directory + file name,
 * mirroring the driver's public `createDatabasePath` join
 * (`<dir>/<name>`, single slash, `:memory:` passthrough). No hardcoded
 * database names here.
 */
function splitDatabasePath(path: string): {
  name: string;
  directory: string | undefined;
} {
  if (path === ':memory:') return { name: ':memory:', directory: undefined };
  const slash = path.lastIndexOf('/');
  if (slash < 0) return { name: path, directory: undefined };
  const directory = path.slice(0, slash);
  return {
    name: path.slice(slash + 1),
    directory: directory === '' ? undefined : directory,
  };
}

/** Read `PRAGMA foreign_keys` across driver row shapes (number vs row). */
async function readForeignKeysFlag(db: {
  getFirstAsync<T>(source: string): Promise<T | null>;
}): Promise<number> {
  const raw = await db.getFirstAsync<unknown>('PRAGMA foreign_keys');
  if (typeof raw === 'number') return raw;
  const value = (raw as { foreign_keys?: unknown } | null)?.foreign_keys;
  return typeof value === 'number' ? value : -1;
}

/**
 * Open a managed database: the outer handle stays open for reads/schema
 * work, while `withExclusiveTransactionAsync` opens an isolated connection
 * on the SAME resolved file (`useNewConnection: true`), enables + verifies
 * FK BEFORE `BEGIN IMMEDIATE`, runs the task on the isolated handle only,
 * commits, rolls back only when `BEGIN` succeeded, and always closes the
 * isolated handle. The outer handle is never closed per mutation. Task
 * errors pass through unwrapped; infrastructure failures throw
 * `ManagedDatabaseError` with the driver error as `cause`.
 */
export async function openManagedDatabase(
  databaseName: string,
  options?: SQLiteOpenOptions,
  directory?: string,
  opener: ManagedOpenFn = SQLite.openDatabaseAsync,
): Promise<ManagedDatabase> {
  let outer: SQLiteDatabase;
  try {
    // Preserve the historical single-argument open shape for the default
    // path so existing init tests keep passing; extra args stay undefined.
    if (options === undefined && directory === undefined) {
      outer = await opener(databaseName);
    } else if (directory === undefined) {
      outer = await opener(databaseName, options);
    } else {
      outer = await opener(databaseName, options, directory);
    }
  } catch (error) {
    throw new ManagedDatabaseError(
      'managed database: failed to open database',
      { cause: error },
    );
  }
  const rawPath = (outer as { databasePath?: unknown }).databasePath;
  const databasePath =
    typeof rawPath === 'string' && rawPath.length > 0 ? rawPath : databaseName;
  const rawOptions = (outer as { options?: unknown }).options;
  const snapshotOptions: SQLiteOpenOptions =
    rawOptions !== null && typeof rawOptions === 'object'
      ? { ...(rawOptions as SQLiteOpenOptions) }
      : { ...(options ?? {}) };

  async function withExclusiveTransactionAsync(
    task: (txn: ManagedTransactionHandle) => Promise<void>,
  ): Promise<void> {
    const target = splitDatabasePath(databasePath);
    const isolatedOptions: SQLiteOpenOptions = {
      ...snapshotOptions,
      useNewConnection: true,
    };
    let isolated: SQLiteDatabase;
    try {
      isolated = await opener(target.name, isolatedOptions, target.directory);
    } catch (error) {
      throw new ManagedDatabaseError(
        'managed database: failed to open isolated exclusive connection',
        { cause: error },
      );
    }
    let begun = false;
    // Explicit failure flag: the task may reject with ANY value (null,
    // undefined, or other falsy values), so null itself is never a valid
    // "no failure" sentinel.
    let failed = false;
    let failure: unknown;
    try {
      try {
        await isolated.execAsync('PRAGMA foreign_keys = ON');
      } catch (error) {
        throw new ManagedDatabaseError(
          'managed database: failed to enable foreign-key enforcement',
          { cause: error },
        );
      }
      let flag = -1;
      try {
        flag = await readForeignKeysFlag(isolated);
      } catch (error) {
        throw new ManagedDatabaseError(
          'managed database: failed to verify foreign-key enforcement',
          { cause: error },
        );
      }
      if (flag !== 1) {
        throw new ManagedDatabaseError(
          `managed database: exclusive connection rejected foreign-key enforcement (PRAGMA foreign_keys=${flag})`,
        );
      }
      try {
        await isolated.execAsync('BEGIN IMMEDIATE');
      } catch (error) {
        throw new ManagedDatabaseError(
          'managed database: failed to begin exclusive transaction',
          { cause: error },
        );
      }
      begun = true;
      await task(isolated as unknown as ManagedTransactionHandle);
      try {
        await isolated.execAsync('COMMIT');
      } catch (error) {
        throw new ManagedDatabaseError(
          'managed database: failed to commit exclusive transaction',
          { cause: error },
        );
      }
    } catch (error) {
      failed = true;
      failure = error;
      if (begun) {
        try {
          await isolated.execAsync('ROLLBACK');
        } catch {
          // Retain the primary failure; rollback noise must not replace it.
        }
      }
    }
    try {
      await isolated.closeAsync();
    } catch (error) {
      if (failed) throw failure;
      throw new ManagedDatabaseError(
        'managed database: failed to close exclusive connection',
        { cause: error },
      );
    }
    if (failed) throw failure;
  }

  type LooseOuter = {
    withTransactionAsync?: (task: () => Promise<void>) => Promise<void>;
    runAsync?: (source: string, params?: never) => Promise<ManagedRunResult>;
    getAllAsync?: <T>(source: string, params?: never) => Promise<T[]>;
    closeAsync?: () => Promise<void>;
  };
  const loose = outer as unknown as LooseOuter;
  return {
    databaseName,
    directory,
    databasePath,
    options: snapshotOptions,
    execAsync: (source: string) => outer.execAsync(source),
    runAsync: (source: string, params?: ManagedBindParams) => {
      if (typeof loose.runAsync !== 'function') {
        throw new ManagedDatabaseError(
          'managed database: runAsync unavailable on this connection',
        );
      }
      return loose.runAsync(source, params as never);
    },
    getFirstAsync: <T>(source: string, params?: ManagedBindParams) =>
      outer.getFirstAsync(source, params as never) as Promise<T | null>,
    getAllAsync: <T>(source: string, params?: ManagedBindParams) => {
      if (typeof loose.getAllAsync !== 'function') {
        throw new ManagedDatabaseError(
          'managed database: getAllAsync unavailable on this connection',
        );
      }
      return loose.getAllAsync<T>(source, params as never);
    },
    // Preserve the historical `DatabaseLike` fallback: fakes without
    // `withTransactionAsync` run the task directly.
    withTransactionAsync: (task: () => Promise<void>) => {
      if (typeof loose.withTransactionAsync !== 'function') return task();
      return loose.withTransactionAsync(task);
    },
    withExclusiveTransactionAsync,
    closeAsync: () => {
      if (typeof loose.closeAsync !== 'function') return Promise.resolve();
      return loose.closeAsync();
    },
  };
}
