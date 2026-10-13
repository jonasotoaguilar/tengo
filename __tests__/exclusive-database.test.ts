/**
 * Adapter tests for the managed exclusive-connection factory.
 *
 * Deterministic fakes only: no `expo-sqlite` native module, no `.db` file.
 * Nothing here claims device SQLite proof.
 */
import { DATABASE_NAME } from '../src/db';
import { openManagedDatabase } from '../src/db/exclusive';
import { REPOSITORY_FIXTURE_DB } from '../src/dev/nativeRepositoryFixture';

// biome-ignore lint/suspicious/noExplicitAny: structural fakes mirror the driver.
type AnyDb = any;

interface CallLog {
  opener: { name: string; options?: unknown; directory?: string }[];
}

function fakeHandle(path: string, options: Record<string, unknown> = {}) {
  const events: string[] = [];
  const state = { fk: 1, failOn: new Set<string>(), throwFkRead: false };
  const db: AnyDb = {
    databasePath: path,
    options: { ...options },
    execAsync: jest.fn(async (source: string) => {
      events.push(`exec:${source}`);
      if (state.failOn.has(source)) throw new Error(`fake ${source} failure`);
      if (/ROLLBACK/.test(source)) events.push('did-rollback');
    }),
    getFirstAsync: jest.fn(async (source: string) => {
      events.push(`get:${source}`);
      if (/PRAGMA foreign_keys/.test(source)) {
        if (state.throwFkRead) throw new Error('fake read failure');
        return { foreign_keys: state.fk };
      }
      return null;
    }),
    runAsync: jest.fn(async () => ({ lastInsertRowId: 1, changes: 1 })),
    getAllAsync: jest.fn(async () => []),
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
      await task();
    }),
    closeAsync: jest.fn(async () => {
      events.push('close');
    }),
  };
  return { db, events, state };
}

function makeOpener(outer: AnyDb, isolated: AnyDb, log: CallLog) {
  let calls = 0;
  return jest.fn(
    async (name: string, options?: unknown, directory?: string) => {
      log.opener.push({ name, options, directory });
      calls += 1;
      return calls === 1 ? outer : isolated;
    },
  );
}

describe('managed exclusive factory (fakes, not device proof)', () => {
  test('outer open passes filename/options/directory through untouched', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const { db: isolated } = fakeHandle('/data/SQLite/tengo.db', {});
    const log: CallLog = { opener: [] };
    const opener = makeOpener(outer, isolated, log);
    const managed = await openManagedDatabase(
      'tengo.db',
      { enableChangeListener: true },
      '/data/SQLite',
      opener as never,
    );
    expect(log.opener[0]).toEqual({
      name: 'tengo.db',
      options: { enableChangeListener: true },
      directory: '/data/SQLite',
    });
    expect(managed.databasePath).toBe('/data/SQLite/tengo.db');
  });

  test('exclusive opens the SAME file with useNewConnection and FK ON before BEGIN', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const { db: isolated, events } = fakeHandle('/data/SQLite/tengo.db', {});
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer, isolated, log) as never,
    );
    let seen: AnyDb = null;
    await managed.withExclusiveTransactionAsync(async (txn: AnyDb) => {
      seen = txn;
      await txn.runAsync('INSERT INTO items (name) VALUES (?)', ['x']);
    });
    // Same resolved file, new connection, original options preserved.
    expect(log.opener[1].options).toMatchObject({ useNewConnection: true });
    const rebuilt = `${log.opener[1].directory}/${log.opener[1].name}`;
    expect(rebuilt).toBe('/data/SQLite/tengo.db');
    // FK enable + readback precede BEGIN; scoped handle used, outer untouched.
    const order = events.join('\n');
    expect(order.indexOf('PRAGMA foreign_keys = ON')).toBeLessThan(
      order.indexOf('get:PRAGMA foreign_keys'),
    );
    expect(order.indexOf('get:PRAGMA foreign_keys')).toBeLessThan(
      order.indexOf('exec:BEGIN IMMEDIATE'),
    );
    expect(seen).toBe(isolated);
    expect(outer.runAsync).not.toHaveBeenCalled();
    expect(isolated.runAsync).toHaveBeenCalled();
    expect(order).toMatch(/exec:COMMIT/);
    expect(isolated.closeAsync).toHaveBeenCalledTimes(1);
    expect(outer.closeAsync).not.toHaveBeenCalled();
  });

  test('task failure rolls back, closes isolated, keeps the primary error', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const { db: isolated, events } = fakeHandle('/data/SQLite/tengo.db', {});
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer, isolated, log) as never,
    );
    const primary = new Error('task-boom');
    await expect(
      managed.withExclusiveTransactionAsync(async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(events.join('\n')).toMatch(/exec:ROLLBACK/);
    expect(isolated.closeAsync).toHaveBeenCalledTimes(1);
    expect(outer.closeAsync).not.toHaveBeenCalled();
  });

  test('null rejection after BEGIN still rolls back, closes, rejects null', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const { db: isolated, events } = fakeHandle('/data/SQLite/tengo.db', {});
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer, isolated, log) as never,
    );
    const outcome = await managed
      .withExclusiveTransactionAsync(() => Promise.reject(null))
      .then(
        () => ({ settled: 'resolved' as const, value: null as unknown }),
        (reason: unknown) => ({
          settled: 'rejected' as const,
          value: reason,
        }),
      );
    expect(outcome.settled).toBe('rejected');
    expect(outcome.value).toBe(null);
    expect(events.join('\n')).toMatch(/exec:ROLLBACK/);
    expect(isolated.closeAsync).toHaveBeenCalledTimes(1);
    expect(outer.closeAsync).not.toHaveBeenCalled();
  });

  test('close failure never replaces a null primary rejection', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const { db: isolated, events } = fakeHandle('/data/SQLite/tengo.db', {});
    isolated.closeAsync = jest.fn(async () => {
      events.push('close-failed');
      throw new Error('fake close failure');
    });
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer, isolated, log) as never,
    );
    const outcome = await managed
      .withExclusiveTransactionAsync(() => Promise.reject(null))
      .then(
        () => ({ settled: 'resolved' as const, value: null as unknown }),
        (reason: unknown) => ({
          settled: 'rejected' as const,
          value: reason,
        }),
      );
    expect(outcome.settled).toBe('rejected');
    expect(outcome.value).toBe(null);
    expect(events.join('\n')).toMatch(/exec:ROLLBACK/);
    expect(outer.closeAsync).not.toHaveBeenCalled();
  });

  test('FK readback 0 fails BEFORE begin and still closes', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const {
      db: isolated,
      events,
      state,
    } = fakeHandle('/data/SQLite/tengo.db', {});
    state.fk = 0;
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer, isolated, log) as never,
    );
    await expect(
      managed.withExclusiveTransactionAsync(async () => {}),
    ).rejects.toThrow(/foreign-key/i);
    expect(events.join('\n')).not.toMatch(/BEGIN/);
    expect(isolated.closeAsync).toHaveBeenCalledTimes(1);
  });

  test('BEGIN failure performs no rollback but still closes', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const {
      db: isolated,
      events,
      state,
    } = fakeHandle('/data/SQLite/tengo.db', {});
    state.failOn.add('BEGIN IMMEDIATE');
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer, isolated, log) as never,
    );
    await expect(
      managed.withExclusiveTransactionAsync(async () => {}),
    ).rejects.toThrow(/begin/i);
    expect(events.join('\n')).not.toMatch(/did-rollback/);
    expect(isolated.closeAsync).toHaveBeenCalledTimes(1);
  });

  test('COMMIT failure rolls back, closes, and surfaces the commit cause', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const {
      db: isolated,
      events,
      state,
    } = fakeHandle('/data/SQLite/tengo.db', {});
    state.failOn.add('COMMIT');
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer, isolated, log) as never,
    );
    await expect(
      managed.withExclusiveTransactionAsync(async () => {}),
    ).rejects.toThrow(/commit/i);
    expect(events.join('\n')).toMatch(/did-rollback/);
    expect(isolated.closeAsync).toHaveBeenCalledTimes(1);
    expect(outer.closeAsync).not.toHaveBeenCalled();
  });

  test('rollback failure keeps the task error; close failure after success surfaces', async () => {
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const isoFail = fakeHandle('/data/SQLite/tengo.db', {});
    isoFail.db.execAsync = jest.fn(async (source: string) => {
      isoFail.events.push(`exec:${source}`);
      if (/ROLLBACK/.test(source)) throw new Error('fake rollback failure');
    });
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer, isoFail.db, log) as never,
    );
    const primary = new Error('task-kept');
    await expect(
      managed.withExclusiveTransactionAsync(async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);

    const { db: outer2 } = fakeHandle('/data/SQLite/tengo.db', {});
    const isoCloseFail = fakeHandle('/data/SQLite/tengo.db', {});
    isoCloseFail.db.closeAsync = jest.fn(async () => {
      throw new Error('fake close failure');
    });
    const log2: CallLog = { opener: [] };
    const managed2 = await openManagedDatabase(
      'tengo.db',
      undefined,
      undefined,
      makeOpener(outer2, isoCloseFail.db, log2) as never,
    );
    await expect(
      managed2.withExclusiveTransactionAsync(async () => {}),
    ).rejects.toThrow(/close/i);
  });

  test('factory open failure never touches an undefined handle', async () => {
    const opener = jest.fn(async () => {
      throw new Error('fake open failure');
    });
    await expect(
      openManagedDatabase('tengo.db', undefined, undefined, opener as never),
    ).rejects.toThrow(/open/i);
    expect(opener).toHaveBeenCalledTimes(1);
  });

  test('production default and fixture factory share the managed open path', async () => {
    expect(REPOSITORY_FIXTURE_DB).toBe('m1-fixture-repository-fk.db');
    expect(REPOSITORY_FIXTURE_DB).not.toBe(DATABASE_NAME);
    const { db: outer } = fakeHandle('/data/SQLite/tengo.db', {});
    const { db: isolated } = fakeHandle('/data/SQLite/tengo.db', {});
    const log: CallLog = { opener: [] };
    const managed = await openManagedDatabase(
      DATABASE_NAME,
      undefined,
      undefined,
      makeOpener(outer, isolated, log) as never,
    );
    expect(managed.databasePath).toBe('/data/SQLite/tengo.db');
    expect(typeof managed.withExclusiveTransactionAsync).toBe('function');
  });
});
