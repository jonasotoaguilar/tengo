/**
 * Global Jest setup: the mocked SQL/native boundary.
 *
 * `expo-sqlite` and `expo-localization` contain native code that cannot run
 * under Jest. They are mocked here so every unit test runs against fakes and
 * NEVER against a real on-device SQLite database.
 *
 * - `expo-localization.getLocales` returns a deterministic US-English locale.
 * - `expo-sqlite.openDatabaseAsync` resolves to an in-memory fake whose
 *   `execAsync`/`getFirstAsync` are `jest.fn()`s. Tests override their
 *   resolved values per case (see `__tests__/db-init.test.ts`).
 * - A `__dbCalls` handle is exposed so tests can introspect executed SQL
 *   without reaching into module internals.
 *
 * Real SQLite persistence requires a native runtime (development build on an
 * emulator or device) and is explicitly out of scope for these unit tests.
 */

const dbCalls: { exec: string[]; openedWith: string[] } = {
  exec: [],
  openedWith: [],
};

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'en-US' }],
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async (name: string) => {
    dbCalls.openedWith.push(name);
    return {
      execAsync: jest.fn(async (source: string) => {
        dbCalls.exec.push(source);
      }),
      getFirstAsync: jest.fn(async () => ({ user_version: 1 })),
    };
  }),
}));

(globalThis as Record<string, unknown>).__tengoDbCalls = dbCalls;
