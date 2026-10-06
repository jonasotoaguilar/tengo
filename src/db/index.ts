import * as SQLite from 'expo-sqlite';

import { getPendingMigrations, MIGRATIONS } from './migrations';

export const DATABASE_NAME = 'tengo.db';

/** Minimal structural subset of `expo-sqlite` used by the foundation.
 *
 * Tests inject a fake implementing this interface, so unit tests exercise
 * the migration logic without native code or a real `.db` file.
 */
export interface DatabaseLike {
  execAsync(source: string): Promise<void>;
  getFirstAsync(source: string): Promise<unknown>;
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

/** Open the database and apply pending migrations in version order. */
export async function initializeDatabase(
  externalDb?: DatabaseLike,
): Promise<DatabaseLike> {
  const db: DatabaseLike =
    externalDb ?? (await SQLite.openDatabaseAsync(DATABASE_NAME));
  const currentVersion = await getUserVersion(db);
  for (const version of getPendingMigrations(currentVersion)) {
    await db.execAsync(MIGRATIONS[version]);
    await setUserVersion(db, version);
  }
  return db;
}
