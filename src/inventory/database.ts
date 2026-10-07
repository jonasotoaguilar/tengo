/**
 * Minimal typed subset of `expo-sqlite` needed by the M2 repositories.
 *
 * Mirrors the installed driver (`SQLiteDatabase.d.ts`): `runAsync` for
 * writes, `getFirstAsync`/`getAllAsync` for reads, all with `?`-bound
 * params — never interpolated SQL. The real `SQLiteDatabase` satisfies this
 * structurally, so no adapter is needed. `withTransactionAsync` is optional
 * here and unused by the single-statement location/category CRUD in this
 * unit; it reserves the transactional hook the future item unit needs for
 * atomic item-plus-join writes.
 */

/** Bind values supported by the repositories: no blobs, no objects. */
export type BindValue = string | number | null;

/** Positional bind params for `?` placeholders. */
export type BindParams = BindValue[];

export interface RunResult {
  lastInsertRowId: number;
  changes: number;
}

export interface RepositoryDb {
  runAsync(source: string, params?: BindParams): Promise<RunResult>;
  getFirstAsync<T>(source: string, params?: BindParams): Promise<T | null>;
  getAllAsync<T>(source: string, params?: BindParams): Promise<T[]>;
  withTransactionAsync?(task: () => Promise<void>): Promise<void>;
}
