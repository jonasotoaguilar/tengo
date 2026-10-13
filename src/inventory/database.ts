/**
 * Minimal typed subset of `expo-sqlite` needed by the M2 repositories.
 *
 * Mirrors the installed driver (`SQLiteDatabase.d.ts`): `runAsync` for
 * writes, `getFirstAsync`/`getAllAsync` for reads, all with `?`-bound
 * params — never interpolated SQL. The real `SQLiteDatabase` satisfies this
 * structurally, so no adapter is needed. `withTransactionAsync` is optional
 * and unused (its task takes no scoped handle, so concurrent unrelated
 * writes can interleave — see the driver note). Multi-statement item writes
 * use `withExclusiveTransactionAsync` instead, which the installed driver
 * (Android/iOS/macOS/tvOS, not web) provides with a scoped `txn` handle:
 * every query inside the transaction runs on `txn`, never on the outer db,
 * so unrelated writes cannot leak in and a rollback covers exactly the
 * unit's statements. Item mutations fail closed with a typed `storage`
 * error when that exclusive hook is absent instead of running non-atomically.
 */

/** Bind values supported by the repositories: no blobs, no objects. */
export type BindValue = string | number | null;

/** Positional bind params for `?` placeholders. */
export type BindParams = BindValue[];

export interface RunResult {
  lastInsertRowId: number;
  changes: number;
}

/**
 * Scoped handle handed to an exclusive-transaction task. Mirrors the
 * driver's `Transaction` parameter structurally (same query methods), so
 * the real `txn` object satisfies it with no adapter.
 */
export interface TransactionHandle {
  runAsync(source: string, params?: BindParams): Promise<RunResult>;
  getFirstAsync<T>(source: string, params?: BindParams): Promise<T | null>;
  getAllAsync<T>(source: string, params?: BindParams): Promise<T[]>;
}

export interface RepositoryDb {
  runAsync(source: string, params?: BindParams): Promise<RunResult>;
  getFirstAsync<T>(source: string, params?: BindParams): Promise<T | null>;
  getAllAsync<T>(source: string, params?: BindParams): Promise<T[]>;
  withTransactionAsync?(task: () => Promise<void>): Promise<void>;
  /**
   * Exclusive-transaction hook (installed driver, native only). Item
   * mutations require it; absence fails closed, never nonatomic.
   */
  withExclusiveTransactionAsync?(
    task: (txn: TransactionHandle) => Promise<void>,
  ): Promise<void>;
}
