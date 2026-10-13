/**
 * T5 error wrapping: only known driver failures map to `StorageError`.
 *
 * A programming error (e.g. a `TypeError` escaping a fake driver or a
 * mapping helper) must propagate unchanged instead of surfacing as
 * "storage unavailable". Real driver failures (plain `Error`s from the
 * driver) still map to `StorageError` with the same `entity`/`op`/`cause`
 * and a message that never leaks driver text; `ValidationError`,
 * `EntityNotFoundError`, `EntityConflictError` and `StorageError` still
 * pass through untouched, with not-found/conflict precedence unchanged.
 */
import type { RepositoryDb } from '../src/inventory/database';
import {
  createLocation,
  getLocation,
  listLocations,
} from '../src/inventory/entityRepository';
import {
  EntityConflictError,
  EntityNotFoundError,
  StorageError,
} from '../src/inventory/errors';
import { queryItems } from '../src/inventory/itemQuery';
import { getItem, listItems } from '../src/inventory/itemRepository';
import { ValidationError } from '../src/inventory/validation';

function throwingDb(failure: unknown): RepositoryDb {
  return {
    runAsync: jest.fn().mockRejectedValue(failure),
    getFirstAsync: jest.fn().mockRejectedValue(failure),
    getAllAsync: jest.fn().mockRejectedValue(failure),
  };
}

describe('T5 RED: unexpected errors propagate unchanged', () => {
  test('queryItems lets a driver TypeError through as a TypeError', async () => {
    const bug = new TypeError(
      "Cannot read properties of null (reading 'rows')",
    );
    const failure = await queryItems(throwingDb(bug)).catch((e: unknown) => e);
    expect(failure).toBe(bug);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  test('getItem lets a driver TypeError through as a TypeError', async () => {
    const bug = new TypeError(
      "Cannot read properties of undefined (reading 'id')",
    );
    const failure = await getItem(throwingDb(bug), 1).catch((e: unknown) => e);
    expect(failure).toBe(bug);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  test('listItems lets a driver TypeError through as a TypeError', async () => {
    const bug = new TypeError('stock.join is not a function');
    const failure = await listItems(throwingDb(bug)).catch((e: unknown) => e);
    expect(failure).toBe(bug);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  test('getLocation lets a driver TypeError through as a TypeError', async () => {
    const bug = new TypeError(
      "Cannot read properties of null (reading 'name')",
    );
    const failure = await getLocation(throwingDb(bug), 1).catch(
      (e: unknown) => e,
    );
    expect(failure).toBe(bug);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });

  test('listLocations lets a driver TypeError through as a TypeError', async () => {
    const bug = new TypeError('rows.map is not a function');
    const failure = await listLocations(throwingDb(bug)).catch(
      (e: unknown) => e,
    );
    expect(failure).toBe(bug);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(StorageError);
  });
});

describe('T5 PRESERVE: real driver failures still map to StorageError', () => {
  test('queryItems maps a driver failure with entity/op/cause and no leak', async () => {
    const driverFailure = new Error('disk I/O error on sqlite3_step');
    const failure = (await queryItems(throwingDb(driverFailure)).catch(
      (e: unknown) => e,
    )) as StorageError;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({
      code: 'storage',
      entity: 'item',
      operation: 'query',
    });
    expect(failure.message).not.toContain('disk I/O');
    expect(failure.cause).toBe(driverFailure);
  });

  test('listItems maps a driver failure with entity/op/cause and no leak', async () => {
    const driverFailure = new Error('disk I/O error on sqlite3_step');
    const failure = (await listItems(throwingDb(driverFailure)).catch(
      (e: unknown) => e,
    )) as StorageError;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({
      code: 'storage',
      entity: 'item',
      operation: 'list',
    });
    expect(failure.message).not.toContain('disk I/O');
    expect(failure.cause).toBe(driverFailure);
  });

  test('listLocations maps a driver failure with entity/op/cause and no leak', async () => {
    const driverFailure = new Error('SQLITE_FULL: database or disk is full');
    const failure = (await listLocations(throwingDb(driverFailure)).catch(
      (e: unknown) => e,
    )) as StorageError;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({
      code: 'storage',
      entity: 'location',
      operation: 'list',
    });
    expect(failure.message).not.toContain('SQLITE_FULL');
    expect(failure.cause).toBe(driverFailure);
  });
});

describe('T5 PRESERVE: typed errors pass through untouched', () => {
  test('ValidationError still rejects before any driver read', async () => {
    const spy = throwingDb(new Error('must not be reached'));
    await expect(getLocation(spy, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      queryItems(spy, { query: 42 as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(spy.getAllAsync).not.toHaveBeenCalled();
    expect(spy.getFirstAsync).not.toHaveBeenCalled();
  });

  test('not-found keeps precedence over the storage mapping', async () => {
    const empty: RepositoryDb = {
      runAsync: jest.fn(async () => ({ lastInsertRowId: 0, changes: 0 })),
      getFirstAsync: jest.fn(async () => null),
      getAllAsync: jest.fn(async () => []),
    };
    const missing = await getLocation(empty, 99).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(EntityNotFoundError);
    expect(missing).toMatchObject({
      code: 'not-found',
      entity: 'location',
      id: 99,
    });
    const missingItem = await getItem(empty, 99).catch((e: unknown) => e);
    expect(missingItem).toBeInstanceOf(EntityNotFoundError);
    expect(missingItem).toMatchObject({
      code: 'not-found',
      entity: 'item',
      id: 99,
    });
  });

  test('conflict keeps precedence over the storage mapping', async () => {
    const rows = [{ id: 1, name: 'Pantry', created_at: 'ts-1' }];
    const db: RepositoryDb = {
      runAsync: jest.fn(async () => ({ lastInsertRowId: 2, changes: 1 })),
      getFirstAsync: jest.fn(async () => null),
      getAllAsync: jest.fn(async () => rows) as RepositoryDb['getAllAsync'],
    };
    const failure = await createLocation(db, { name: ' pantry ' }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(EntityConflictError);
    expect(failure).toMatchObject({ code: 'conflict', entity: 'location' });
  });

  test('StorageError passes through without double-wrapping', async () => {
    const inner = new StorageError('location', 'list', new Error('root'));
    const failure = await listLocations(throwingDb(inner)).catch(
      (e: unknown) => e,
    );
    expect(failure).toBe(inner);
  });
});
