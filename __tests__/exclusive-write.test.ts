/**
 * T3 write-path: shared exclusive connection (fakes, not device proof).
 *
 * The default `withExclusiveTransactionAsync` opens, FK-enables, verifies,
 * begins, commits/rolls back, and closes an isolated connection PER
 * mutation (pinned by `exclusive-database.test.ts`, untouched here). This
 * file pins the additive shared path instead: many mutations reuse ONE
 * isolated connection, the FK pragma is still set while no transaction is
 * open and verified before every `BEGIN IMMEDIATE`, each mutation still
 * runs in its own exclusive transaction (all-or-nothing), and task errors
 * pass through unwrapped. Deterministic fakes only: no `expo-sqlite`
 * native module, no `.db` file.
 */
import { openManagedDatabase } from '../src/db/exclusive';

// biome-ignore lint/suspicious/noExplicitAny: structural fakes mirror the driver.
type AnyDb = any;
type AnyManaged = any;

function fakeHandle(path: string) {
  const events: string[] = [];
  const state = { fk: 1, failOn: new Set<string>(), throwFkRead: false };
  const db: AnyDb = {
    databasePath: path,
    options: {},
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

async function openPair() {
  const outerHandle = fakeHandle('/data/SQLite/tengo.db');
  const isolatedHandle = fakeHandle('/data/SQLite/tengo.db');
  const openerCalls: { name: string; options?: unknown; directory?: string }[] =
    [];
  let calls = 0;
  const opener = jest.fn(
    async (name: string, options?: unknown, directory?: string) => {
      openerCalls.push({ name, options, directory });
      calls += 1;
      return calls === 1 ? outerHandle.db : isolatedHandle.db;
    },
  );
  const managed: AnyManaged = await openManagedDatabase(
    'tengo.db',
    undefined,
    undefined,
    opener as never,
  );
  return { managed, opener, openerCalls, outerHandle, isolatedHandle };
}

describe('T3 shared exclusive connection', () => {
  test('baseline: the classic path still opens one isolated connection per mutation', async () => {
    const { managed, opener } = await openPair();
    for (let i = 0; i < 3; i += 1) {
      await managed.withExclusiveTransactionAsync(async (txn: AnyDb) => {
        await txn.runAsync('INSERT INTO items (name) VALUES (?)', [
          `item-${i}`,
        ]);
      });
    }
    // 1 outer open + 3 isolated opens: the per-mutation cost T3 removes
    // on the shared path (this behavior is unchanged by design).
    expect(opener).toHaveBeenCalledTimes(4);
  });

  test('three mutations over the shared path open exactly one isolated connection', async () => {
    const { managed, opener, isolatedHandle } = await openPair();
    for (let i = 0; i < 3; i += 1) {
      await managed.withSharedExclusiveTransactionAsync(async (txn: AnyDb) => {
        await txn.runAsync('INSERT INTO items (name) VALUES (?)', [
          `item-${i}`,
        ]);
      });
    }
    // 1 outer open + 1 shared isolated open for all three mutations.
    expect(opener).toHaveBeenCalledTimes(2);
    expect(opener.mock.calls[1][1]).toMatchObject({ useNewConnection: true });
    expect(isolatedHandle.db.runAsync).toHaveBeenCalledTimes(3);
    // The shared handle stays open between mutations: no per-mutation close.
    expect(isolatedHandle.db.closeAsync).not.toHaveBeenCalled();
  });

  test('FK pragma is set once outside any transaction and verified before every BEGIN', async () => {
    const { managed, isolatedHandle } = await openPair();
    const { events } = isolatedHandle;
    for (let i = 0; i < 2; i += 1) {
      await managed.withSharedExclusiveTransactionAsync(async () => {});
    }
    const order = events.join('\n');
    const pragmaOn = order.indexOf('exec:PRAGMA foreign_keys = ON');
    const firstVerify = order.indexOf('get:PRAGMA foreign_keys');
    const firstBegin = order.indexOf('exec:BEGIN IMMEDIATE');
    expect(pragmaOn).toBeGreaterThanOrEqual(0);
    expect(firstVerify).toBeGreaterThan(pragmaOn);
    expect(firstBegin).toBeGreaterThan(firstVerify);
    // One pragma enable for the shared handle, verified ahead of each BEGIN.
    expect(order.match(/exec:PRAGMA foreign_keys = ON/g)).toHaveLength(1);
    expect(order.match(/get:PRAGMA foreign_keys/g)).toHaveLength(2);
    expect(order.match(/exec:BEGIN IMMEDIATE/g)).toHaveLength(2);
    expect(order.match(/exec:COMMIT/g)).toHaveLength(2);
    // The pragma is never set from inside a transaction.
    const beginIdx = order.indexOf('exec:BEGIN IMMEDIATE');
    const commitIdx = order.indexOf('exec:COMMIT');
    const pragmaInside = order
      .slice(beginIdx, commitIdx)
      .includes('PRAGMA foreign_keys = ON');
    expect(pragmaInside).toBe(false);
  });

  test('task failure rolls back, keeps the primary error, and reuses the connection', async () => {
    const { managed, opener, isolatedHandle } = await openPair();
    const { events } = isolatedHandle;
    const primary = new Error('shared-task-boom');
    await expect(
      managed.withSharedExclusiveTransactionAsync(async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(events.join('\n')).toMatch(/exec:ROLLBACK/);
    // A null rejection also rolls back and rejects null (never swallowed).
    const outcome = await managed
      .withSharedExclusiveTransactionAsync(() => Promise.reject(null))
      .then(
        () => ({ settled: 'resolved' as const, value: null as unknown }),
        (reason: unknown) => ({ settled: 'rejected' as const, value: reason }),
      );
    expect(outcome.settled).toBe('rejected');
    expect(outcome.value).toBe(null);
    // The connection survived the rollback: still one isolated open, and
    // the next mutation commits on it.
    await managed.withSharedExclusiveTransactionAsync(async (txn: AnyDb) => {
      await txn.runAsync('INSERT INTO items (name) VALUES (?)', ['after']);
    });
    expect(opener).toHaveBeenCalledTimes(2);
    expect(events.join('\n')).toMatch(/exec:COMMIT/);
    expect(isolatedHandle.db.closeAsync).not.toHaveBeenCalled();
  });

  test('FK verification failure runs no BEGIN and resets the shared handle', async () => {
    const { managed, opener, isolatedHandle } = await openPair();
    const { events, state } = isolatedHandle;
    state.fk = 0;
    await expect(
      managed.withSharedExclusiveTransactionAsync(async () => {}),
    ).rejects.toThrow(/foreign-key/i);
    expect(events.join('\n')).not.toMatch(/BEGIN/);
    expect(isolatedHandle.db.closeAsync).toHaveBeenCalledTimes(1);
    // Recovery: the next mutation opens a fresh shared handle and commits.
    state.fk = 1;
    await managed.withSharedExclusiveTransactionAsync(async (txn: AnyDb) => {
      await txn.runAsync('INSERT INTO items (name) VALUES (?)', ['recovered']);
    });
    expect(opener).toHaveBeenCalledTimes(3);
    expect(events.join('\n')).toMatch(/exec:COMMIT/);
  });

  test('managed closeAsync closes the shared handle; the next use re-opens it', async () => {
    const { managed, opener, isolatedHandle, outerHandle } = await openPair();
    await managed.withSharedExclusiveTransactionAsync(async () => {});
    expect(isolatedHandle.db.closeAsync).not.toHaveBeenCalled();
    await managed.closeAsync();
    expect(isolatedHandle.db.closeAsync).toHaveBeenCalledTimes(1);
    expect(outerHandle.db.closeAsync).toHaveBeenCalledTimes(1);
    await managed.withSharedExclusiveTransactionAsync(async () => {});
    expect(opener).toHaveBeenCalledTimes(3);
  });
});
