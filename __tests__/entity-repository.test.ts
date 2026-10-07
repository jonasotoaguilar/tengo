/**
 * M2 location/category persistence (mocked native boundary).
 *
 * Runs against an in-memory fake `RepositoryDb` — no native module, no
 * `.db` file. Proves parameterized CRUD, domain normalization, typed errors
 * (validation/not-found/in-use/storage), and that raw SQLite text never
 * surfaces. Real driver behavior is P2 native proof (isolated test DBs).
 */

import type { RepositoryDb, RunResult } from '../src/inventory/database';
import {
  createCategory,
  createLocation,
  deleteCategory,
  deleteLocation,
  getCategory,
  getLocation,
  listCategories,
  listLocations,
  updateCategory,
  updateLocation,
} from '../src/inventory/entityRepository';
import {
  EntityNotFoundError,
  LocationInUseError,
  StorageError,
} from '../src/inventory/errors';
import type { Category, Location } from '../src/inventory/types';
import { ValidationError } from '../src/inventory/validation';

interface FakeRow {
  id: number;
  name: string;
  address?: string | null;
  created_at: string;
}

/** In-memory fake: enforces location RESTRICT, category CASCADE. */
function makeFakeDb() {
  const calls: { source: string; params: unknown[] }[] = [];
  const locations = new Map<number, FakeRow>();
  const categories = new Map<number, FakeRow>();
  const itemLocation = new Map<number, number>();
  const joins = new Set<string>();
  let nextId = 1;
  let failNext: unknown = null;

  const tableOf = (source: string) =>
    /locations/i.test(source)
      ? locations
      : /categories/i.test(source)
        ? categories
        : null;

  const maybeFail = (source: string, params: unknown[]) => {
    calls.push({ source, params });
    if (failNext !== null) {
      const error = failNext;
      failNext = null;
      throw error;
    }
  };

  const db: RepositoryDb = {
    runAsync: jest.fn(async (source: string, params: unknown[] = []) => {
      maybeFail(source, params);
      if (/INSERT INTO locations/i.test(source)) {
        const [name, address] = params as [string, string | null];
        const id = nextId++;
        locations.set(id, { id, name, address, created_at: 'now' });
        return { lastInsertRowId: id, changes: 1 } satisfies RunResult;
      }
      if (/INSERT INTO categories/i.test(source)) {
        const [name] = params as [string];
        const id = nextId++;
        categories.set(id, { id, name, created_at: 'now' });
        return { lastInsertRowId: id, changes: 1 } satisfies RunResult;
      }
      if (/UPDATE locations/i.test(source)) {
        const [name, address, id] = params as [string, string | null, number];
        const row = locations.get(id);
        if (!row) return { lastInsertRowId: 0, changes: 0 } satisfies RunResult;
        locations.set(id, { ...row, name, address });
        return { lastInsertRowId: id, changes: 1 } satisfies RunResult;
      }
      if (/UPDATE categories/i.test(source)) {
        const [name, id] = params as [string, number];
        const row = categories.get(id);
        if (!row) return { lastInsertRowId: 0, changes: 0 } satisfies RunResult;
        categories.set(id, { ...row, name });
        return { lastInsertRowId: id, changes: 1 } satisfies RunResult;
      }
      if (/DELETE FROM locations/i.test(source)) {
        const [id] = params as [number];
        for (const locId of itemLocation.values()) {
          if (locId === id) {
            // Shape of the real expo-sqlite native failure (SQLite code 787).
            throw new Error(
              'SQLite error: FOREIGN KEY constraint failed (code 787 SQLITE_CONSTRAINT_FOREIGNKEY)',
            );
          }
        }
        const deleted = locations.delete(id);
        return {
          lastInsertRowId: 0,
          changes: deleted ? 1 : 0,
        } satisfies RunResult;
      }
      if (/DELETE FROM categories/i.test(source)) {
        const [id] = params as [number];
        // Join links cascade with the category; items themselves survive.
        for (const key of [...joins]) {
          if (key.endsWith(`:${id}`)) joins.delete(key);
        }
        const deleted = categories.delete(id);
        return {
          lastInsertRowId: 0,
          changes: deleted ? 1 : 0,
        } satisfies RunResult;
      }
      throw new Error(`fake: unhandled write ${source}`);
    }),
    getFirstAsync: (async <T>(source: string, params: unknown[] = []) => {
      maybeFail(source, params);
      const table = tableOf(source);
      if (table && /WHERE id = \?/i.test(source)) {
        return (table.get(params[0] as number) ?? null) as T | null;
      }
      return null as T | null;
    }) as RepositoryDb['getFirstAsync'],
    getAllAsync: (async <T>(source: string, params: unknown[] = []) => {
      maybeFail(source, params);
      const table = tableOf(source);
      if (table) return [...table.values()] as T[];
      return [] as T[];
    }) as RepositoryDb['getAllAsync'],
  };
  return {
    db,
    calls,
    locations,
    categories,
    itemLocation,
    joins,
    failNextWith: (error: unknown) => {
      failNext = error;
    },
  };
}

describe('location repository', () => {
  test('create/list/fetch round-trip with normalization, unicode intact', async () => {
    const f = makeFakeDb();
    const created = await createLocation(f.db, {
      name: '  café Bogotá — ático ñ  ',
      address: '  Calle 1  ',
    });
    expect(created.name).toBe('café Bogotá — ático ñ');
    expect(created.address).toBe('Calle 1');
    expect(await getLocation(f.db, created.id)).toEqual(created);
    expect(await listLocations(f.db)).toEqual([created]);
    const blank = await createLocation(f.db, { name: 'Base', address: '   ' });
    expect(blank.address).toBeNull();
  });

  test('injection-shaped text is stored verbatim, never interpolated', async () => {
    const f = makeFakeDb();
    const evil = "x'); DROP TABLE locations; --";
    const created = await createLocation(f.db, { name: evil });
    expect(created.name).toBe(evil);
    expect(f.locations.size).toBe(1);
    // User text travels only in bound params, never in the SQL source.
    for (const call of f.calls) {
      expect(call.source).not.toContain(evil);
      expect(call.source).toMatch(/\?/);
    }
    expect(await listLocations(f.db)).toHaveLength(1);
  });

  test('invalid ids throw validation before touching the database', async () => {
    const f = makeFakeDb();
    for (const bad of [0, -1, 1.5, Number.NaN, '1' as unknown as number]) {
      await expect(getLocation(f.db, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(deleteLocation(f.db, bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(f.calls).toEqual([]);
  });

  test('missing rows throw typed not-found; storage failures stay generic', async () => {
    const f = makeFakeDb();
    await expect(getLocation(f.db, 99)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    await expect(
      updateLocation(f.db, 99, { name: 'Gone' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(deleteLocation(f.db, 99)).rejects.toMatchObject({
      code: 'not-found',
    });
    f.failNextWith(new Error('disk I/O error on sqlite3_step'));
    const failure = (await getLocation(f.db, 1).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({ code: 'storage' });
    expect(failure.message).not.toContain('disk I/O');
  });

  test('deleting a referenced location maps the FK failure to in-use', async () => {
    const f = makeFakeDb();
    const loc = await createLocation(f.db, { name: 'Pantry' });
    f.itemLocation.set(7, loc.id);
    const failure = (await deleteLocation(f.db, loc.id).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(LocationInUseError);
    expect(failure).toMatchObject({ code: 'in-use' });
    expect(failure.message).not.toContain('SQLITE_CONSTRAINT');
    // The location survives the blocked delete.
    expect(await getLocation(f.db, loc.id)).toEqual(loc);
  });

  test('alternate FK shapes map to in-use; other constraints stay storage', async () => {
    // Extended-code shape and bare symbolic shape both occur across drivers.
    for (const fkError of [
      Object.assign(new Error('step failed'), { code: 787 }),
      new Error('SQLITE_CONSTRAINT_FOREIGNKEY: abort'),
    ]) {
      const f = makeFakeDb();
      const loc = await createLocation(f.db, { name: 'Pantry' });
      f.itemLocation.set(1, loc.id);
      const deleteSpy = f.db.runAsync as jest.Mock;
      deleteSpy.mockImplementationOnce(async () => {
        throw fkError;
      });
      await expect(deleteLocation(f.db, loc.id)).rejects.toBeInstanceOf(
        LocationInUseError,
      );
    }
    // A non-FK failure (e.g. CHECK) must not masquerade as in-use.
    const f = makeFakeDb();
    const loc = await createLocation(f.db, { name: 'Pantry' });
    f.failNextWith(
      new Error('CHECK constraint failed: length(TRIM(name)) > 0'),
    );
    const failure = (await deleteLocation(f.db, loc.id).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).not.toBeInstanceOf(LocationInUseError);
    expect(failure.message).not.toContain('CHECK constraint');
  });

  test('update normalizes and returns the stored row', async () => {
    const f = makeFakeDb();
    const loc: Location = await createLocation(f.db, { name: 'Old' });
    const updated = await updateLocation(f.db, loc.id, {
      name: '  Nuevo  ',
      address: null,
    });
    expect(updated).toMatchObject({ id: loc.id, name: 'Nuevo', address: null });
  });
});

describe('category repository', () => {
  test('create/list/fetch round-trip preserves unicode names', async () => {
    const f = makeFakeDb();
    const created = await createCategory(f.db, { name: '  lácteos ñ  ' });
    expect(created.name).toBe('lácteos ñ');
    expect(await getCategory(f.db, created.id)).toEqual(created);
    const listed: Category[] = await listCategories(f.db);
    expect(listed).toEqual([created]);
  });

  test('injection-shaped names are bound, not interpolated', async () => {
    const f = makeFakeDb();
    const evil = 'c" OR "1"="1';
    await createCategory(f.db, { name: evil });
    for (const call of f.calls) {
      expect(call.source).not.toContain(evil);
    }
    expect(await listCategories(f.db)).toHaveLength(1);
  });

  test('invalid ids, missing rows, and storage failures are typed', async () => {
    const f = makeFakeDb();
    await expect(getCategory(f.db, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(getCategory(f.db, 42)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(updateCategory(f.db, 42, { name: 'x' })).rejects.toMatchObject(
      { code: 'not-found' },
    );
    await expect(deleteCategory(f.db, 42)).rejects.toMatchObject({
      code: 'not-found',
    });
    f.failNextWith(new Error('SQLITE_FULL: database or disk is full'));
    const failure = (await listCategories(f.db).catch(
      (e: unknown) => e,
    )) as Error;
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure.message).not.toContain('SQLITE_FULL');
  });

  test('deleting a category removes join links but keeps items', async () => {
    const f = makeFakeDb();
    const cat = await createCategory(f.db, { name: 'Bulk' });
    f.joins.add(`3:${cat.id}`);
    f.itemLocation.set(3, 99);
    await deleteCategory(f.db, cat.id);
    expect(f.joins.size).toBe(0);
    expect(f.itemLocation.has(3)).toBe(true);
    await expect(getCategory(f.db, cat.id)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });
});
