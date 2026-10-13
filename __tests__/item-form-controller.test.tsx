/**
 * U2a item-form controller hook unit (Jest/RNTL renderHook only, no DB).
 *
 * Covers blank create (no default quantity), prefilled names, client
 * validation (no writes, localized field errors), zero-quantity create,
 * edit latest-load population, explicit draft conversion excluding UI-only
 * fields, immediate single-flight save/delete, failure preservation of all
 * raw/pending/stash text with coded (never SQL) errors, dirty discard
 * confirm/cancel, clean dismiss, pending-blocked close, confirmed-only
 * delete, stale-load races, and unmount races. Fake repository callbacks
 * only — no native persistence proof (existing domain atomic proof stands).
 */
import {
  act,
  cleanup,
  render,
  renderHook,
} from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';
import type { RepositoryDb } from '../src/inventory/database';
import { EntityConflictError } from '../src/inventory/errors';
import type { ItemDetail } from '../src/inventory/types';
import type {
  ItemFormControllerOptions,
  SaveOutcome,
} from '../src/screens/useItemFormController';
import '../src/i18n';

const { default: useItemFormController, blankItemFormValues } =
  require('../src/screens/useItemFormController') as {
    default: (options: ItemFormControllerOptions) => {
      values: Record<string, unknown>;
      errors: Record<string, string>;
      [key: string]: unknown;
    };
    blankItemFormValues: (prefilledName?: string) => Record<string, unknown>;
  };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeStorageError extends Error {
  readonly code = 'storage';
  constructor() {
    super('Could not create item: storage unavailable.');
    this.name = 'StorageError';
  }
}

const pantry = {
  id: 10,
  name: 'Pantry',
  address: null,
  created_at: 'loc-10',
};
const bulk = { id: 20, name: 'Bulk', created_at: 'cat-20' };

function makeDetail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  const stock = overrides.stock ?? [
    { locationId: pantry.id, location: { ...pantry }, quantity: 2 },
  ];
  const categories = overrides.categories ?? [{ ...bulk }];
  return {
    id: 7,
    name: 'Rice',
    created_at: 'item-7',
    ...overrides,
    stock,
    totalQuantity: stock.reduce((sum, level) => sum + level.quantity, 0),
    categoryIds: categories.map((entry) => entry.id),
    categories,
  };
}

function rowQuantityError(result: { current: { errors: unknown } }): unknown {
  return (
    result.current.errors as { stock?: { quantity?: string }[] } | undefined
  )?.stock?.[0]?.quantity;
}

function existingRow(locationId: number, quantityRaw: string) {
  return { location: { kind: 'existing', locationId }, quantityRaw };
}

const db = {} as RepositoryDb;

function makeRepository() {
  return {
    getItem: jest.fn(async (_db: RepositoryDb, _id: number) => makeDetail()),
    createItemFromDraft: jest.fn(async (_db: RepositoryDb, _draft: unknown) =>
      makeDetail(),
    ),
    updateItemFromDraft: jest.fn(
      async (_db: RepositoryDb, _id: number, _draft: unknown) => makeDetail(),
    ),
    deleteItem: jest.fn(async (_db: RepositoryDb, _id: number) => {}),
  };
}

function baseOptions(
  overrides: Partial<ItemFormControllerOptions> = {},
): ItemFormControllerOptions {
  return {
    db,
    route: { kind: 'create' },
    repository: makeRepository(),
    onSaved: jest.fn(),
    onDeleted: jest.fn(),
    onDismissed: jest.fn(),
    ...overrides,
  };
}

async function renderController(options: ItemFormControllerOptions) {
  return renderHook(
    (props: ItemFormControllerOptions) => {
      const hook = useItemFormController(props);
      return hook as unknown as {
        values: Record<string, unknown>;
        errors: Record<string, string>;
        onChange: (next: Record<string, unknown>) => void;
        onSave: () => Promise<SaveOutcome>;
        onRequestClose: () => void;
        onConfirmDiscard: () => void;
        onCancelDiscard: () => void;
        onRequestDelete: () => void;
        onConfirmDelete: () => Promise<{ deleted: boolean }>;
        onCancelDelete: () => void;
        onRetry: () => void;
        [key: string]: unknown;
      };
    },
    { initialProps: options },
  );
}

afterEach(async () => {
  await cleanup();
  latestProbedController = null;
});

type ProbeController = {
  onConfirmDelete: () => Promise<{ deleted: boolean }>;
  onSave: () => Promise<SaveOutcome>;
  onRequestDelete: () => void;
  onRequestClose: () => void;
  onConfirmDiscard: () => void;
  onChange: (next: Record<string, unknown>) => void;
  [key: string]: unknown;
};

let latestProbedController: ProbeController | null = null;

/**
 * Commit-window probe: its layout effect is registered BEFORE the hook
 * call below, so it fires before the hook's own layout reset and observes
 * the raw commit window (new route in callbacks, stale session state).
 */
function WindowProbe({
  options,
  onWindow,
}: {
  options: ItemFormControllerOptions;
  onWindow: ((controller: ProbeController) => void) | null;
}) {
  const windowRef = React.useRef(onWindow);
  windowRef.current = onWindow;
  React.useLayoutEffect(() => {
    if (latestProbedController) windowRef.current?.(latestProbedController);
  });
  const controller = useItemFormController(
    options,
  ) as unknown as ProbeController;
  latestProbedController = controller;
  return <Text testID="window-probe">probe</Text>;
}

function WindowChild({ options }: { options: ItemFormControllerOptions }) {
  const controller = useItemFormController(
    options,
  ) as unknown as ProbeController;
  latestProbedController = controller;
  return <Text testID="window-child">child</Text>;
}

function WindowParent({
  options,
  onWindow,
}: {
  options: ItemFormControllerOptions;
  onWindow: ((controller: ProbeController) => void) | null;
}) {
  const windowRef = React.useRef(onWindow);
  windowRef.current = onWindow;
  // Parent layout effects fire after every child layout effect, so this
  // observes the window after the hook's own layout reset has run.
  React.useLayoutEffect(() => {
    if (latestProbedController) windowRef.current?.(latestProbedController);
  });
  return <WindowChild options={options} />;
}

test('create starts blank with no rows and no default quantity', async () => {
  const { result } = await renderController(baseOptions());
  expect(result.current.values).toEqual({
    name: '',
    stock: [],
    categories: [],
    pendingNewCategoryName: '',
  });
  expect(result.current.mode).toBe('add');
  expect(result.current.loadState).toBe('ready');
});

test('blankItemFormValues carries an optional prefilled name verbatim', async () => {
  expect(blankItemFormValues()).toMatchObject({ name: '', stock: [] });
  expect(blankItemFormValues('quinoa')).toMatchObject({ name: 'quinoa' });
  const options = baseOptions({
    route: { kind: 'create', prefilledName: 'quinoa' },
  });
  const { result } = await renderController(options);
  expect(result.current.values.name).toBe('quinoa');
  expect(result.current.values.stock).toEqual([]);
});

test.each([
  ['blank name', { name: '  ' }, 'name'],
  [
    'invalid row quantity text',
    { name: 'Rice', stock: [existingRow(10, 'abc')] },
    'stock',
  ],
  [
    'fraction row quantity',
    { name: 'Rice', stock: [existingRow(10, '1.5')] },
    'stock',
  ],
  [
    'new location with blank name',
    {
      name: 'Rice',
      stock: [
        {
          location: { kind: 'new', location: { name: '  ', address: null } },
          quantityRaw: '2',
        },
      ],
    },
    'stock',
  ],
])(
  'invalid create %p writes nothing and reports localized errors',
  async (_label, patch, field) => {
    const repository = makeRepository();
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        ...patch,
      });
    });
    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(false);
    expect(repository.createItemFromDraft).not.toHaveBeenCalled();
    const fieldError = result.current.errors[field] as unknown;
    expect(fieldError).toBeTruthy();
    if (field === 'stock') {
      // Per-row errors: the first row reports a side message.
      const rows = fieldError as { location?: string; quantity?: string }[];
      expect(
        rows[0]?.location !== undefined || rows[0]?.quantity !== undefined,
      ).toBe(true);
    } else {
      expect(typeof fieldError).toBe('string');
    }
  },
);

test('field errors use existing localized strings', async () => {
  const { result } = await renderController(baseOptions());
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: '   ',
      stock: [existingRow(10, 'abc')],
    });
  });
  await act(async () => {
    await result.current.onSave();
  });
  expect(result.current.errors.name).toBe('Enter a name.');
  const stock = result.current.errors.stock as unknown as
    | { quantity?: string }[]
    | undefined;
  expect(stock?.[0]?.quantity).toBe('Enter a whole number of 0 or more.');
});

test('blank name with no rows still requires only the name', async () => {
  const repository = makeRepository();
  const { result } = await renderController(baseOptions({ repository }));
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: '   ',
    });
  });
  let outcome!: SaveOutcome;
  await act(async () => {
    outcome = await result.current.onSave();
  });
  expect(outcome.persisted).toBe(false);
  expect(repository.createItemFromDraft).not.toHaveBeenCalled();
  expect(result.current.errors.name).toBe('Enter a name.');
  // Stockless is valid (sin stock): no row errors without rows.
  expect(result.current.errors.stock).toBeUndefined();
});

test('zero and blank quantities are dropped, leaving catalog-only stock', async () => {
  const repository = makeRepository();
  const { result } = await renderController(baseOptions({ repository }));
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '0'), existingRow(11, '  ')],
    });
  });
  await act(async () => {
    await result.current.onSave();
  });
  expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
  const draft = repository.createItemFromDraft.mock.calls[0][1] as Record<
    string,
    unknown
  >;
  expect(draft.stock).toEqual([]);
});

test('edit loads the latest detail and populates raw values', async () => {
  const detail = makeDetail({ name: 'Olive oil', stock: [] });
  const gate = deferred<ItemDetail>();
  const repository = makeRepository();
  repository.getItem.mockReturnValueOnce(gate.promise);
  const { result } = await renderController(
    baseOptions({ repository, route: { kind: 'edit', itemId: 7 } }),
  );
  expect(result.current.mode).toBe('edit');
  expect(result.current.loadState).toBe('loading');
  expect(repository.getItem).toHaveBeenCalledWith(db, 7);
  await act(async () => {
    gate.resolve(detail);
  });
  expect(result.current.loadState).toBe('ready');
  expect(result.current.values).toEqual({
    name: 'Olive oil',
    stock: [],
    categories: [{ kind: 'existing', categoryId: 20 }],
    pendingNewCategoryName: '',
  });
});

test('edit loads stock rows into the per-location editor', async () => {
  const detail = makeDetail({ name: 'Leche' });
  const repository = makeRepository();
  repository.getItem.mockResolvedValueOnce({
    ...detail,
    stock: [
      { locationId: 10, location: { ...pantry }, quantity: 1 },
      {
        locationId: 11,
        location: { id: 11, name: 'Fridge', address: null, created_at: 'l11' },
        quantity: 2,
      },
    ],
    totalQuantity: 3,
  });
  const { result } = await renderController(
    baseOptions({ repository, route: { kind: 'edit', itemId: 7 } }),
  );
  await act(async () => {});
  expect(result.current.loadState).toBe('ready');
  expect(result.current.values).toEqual({
    name: 'Leche',
    stock: [existingRow(10, '1'), existingRow(11, '2')],
    categories: [{ kind: 'existing', categoryId: 20 }],
    pendingNewCategoryName: '',
  });
});

test('conversion is explicit and excludes UI-only fields', async () => {
  const repository = makeRepository();
  const { result } = await renderController(baseOptions({ repository }));
  await act(async () => {
    result.current.onChange({
      name: 'Rice',
      stock: [
        existingRow(10, '2'),
        {
          location: {
            kind: 'new',
            location: { name: 'Bodega', address: null },
          },
          quantityRaw: '1',
        },
      ],
      categories: [
        { kind: 'existing', categoryId: 20 },
        { kind: 'new', category: { name: 'Fresh' } },
      ],
      pendingNewCategoryName: 'Not yet added',
    });
  });
  await act(async () => {
    await result.current.onSave();
  });
  const draft = repository.createItemFromDraft.mock.calls[0][1] as Record<
    string,
    unknown
  >;
  expect(Object.keys(draft).sort()).toEqual(
    ['categories', 'name', 'stock'].sort(),
  );
  expect(draft).toEqual({
    name: 'Rice',
    stock: [
      {
        location: { kind: 'existing', locationId: 10 },
        quantity: 2,
      },
      {
        location: { kind: 'new', location: { name: 'Bodega', address: null } },
        quantity: 1,
      },
    ],
    categories: [
      { kind: 'existing', categoryId: 20 },
      { kind: 'new', category: { name: 'Fresh' } },
    ],
  });
});

test('duplicate existing locations in one payload write nothing', async () => {
  const repository = makeRepository();
  const { result } = await renderController(baseOptions({ repository }));
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '1'), existingRow(10, '2')],
    });
  });
  let outcome!: SaveOutcome;
  await act(async () => {
    outcome = await result.current.onSave();
  });
  expect(outcome.persisted).toBe(false);
  expect(repository.createItemFromDraft).not.toHaveBeenCalled();
  const stock = result.current.errors.stock as unknown as
    | { location?: string }[]
    | undefined;
  expect(stock?.[1]?.location).toBe('This location is already added.');
});

test('immediate double save writes once; second outcome reports no persist', async () => {
  const gate = deferred<ItemDetail>();
  const repository = makeRepository();
  repository.createItemFromDraft.mockReturnValueOnce(gate.promise);
  const onSaved = jest.fn();
  const { result } = await renderController(
    baseOptions({ repository, onSaved }),
  );
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '1')],
    });
  });
  let first!: Promise<SaveOutcome>;
  let second!: Promise<SaveOutcome>;
  await act(async () => {
    first = result.current.onSave();
    second = result.current.onSave();
  });
  expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
  expect(result.current.submitting).toBe(true);
  const detail = makeDetail();
  await act(async () => {
    gate.resolve(detail);
  });
  expect(await first).toEqual({ persisted: true, detail });
  expect(await second).toEqual({ persisted: false });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(detail);
});

test('save failure preserves all raw text and codes the error', async () => {
  const repository = makeRepository();
  repository.createItemFromDraft.mockRejectedValueOnce(new FakeStorageError());
  const before = {
    name: 'Rice ',
    stock: [
      {
        location: { kind: 'new', location: { name: 'Bodega', address: 'C 3' } },
        quantityRaw: '2',
      },
    ],
    categories: [{ kind: 'new', category: { name: 'Fresh' } }],
    pendingNewCategoryName: 'Later',
  };
  const { result } = await renderController(baseOptions({ repository }));
  await act(async () => {
    result.current.onChange(before);
  });
  let outcome!: SaveOutcome;
  await act(async () => {
    outcome = await result.current.onSave();
  });
  expect(outcome.persisted).toBe(false);
  expect(result.current.values).toEqual(before);
  expect(result.current.submitting).toBe(false);
  expect(result.current.errors.form).toBe('storage');
  expect(result.current.formErrorCode).toBe('storage');
  expect(JSON.stringify(result.current.errors)).not.toMatch(/SELECT|sqlite/i);
});

test('dirty close asks to confirm; cancel preserves, confirm dismisses', async () => {
  const onDismissed = jest.fn();
  const { result } = await renderController(baseOptions({ onDismissed }));
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      pendingNewCategoryName: 'typing',
    });
  });
  expect(result.current.dirty).toBe(true);
  await act(async () => {
    result.current.onRequestClose();
  });
  expect(result.current.confirmDiscard).toBe(true);
  expect(onDismissed).not.toHaveBeenCalled();
  await act(async () => {
    result.current.onCancelDiscard();
  });
  expect(result.current.confirmDiscard).toBe(false);
  expect(result.current.values.pendingNewCategoryName).toBe('typing');
  await act(async () => {
    result.current.onRequestClose();
  });
  await act(async () => {
    result.current.onConfirmDiscard();
  });
  expect(onDismissed).toHaveBeenCalledTimes(1);
});

test('clean close dismisses without confirmation', async () => {
  const onDismissed = jest.fn();
  const { result } = await renderController(baseOptions({ onDismissed }));
  expect(result.current.dirty).toBe(false);
  await act(async () => {
    result.current.onRequestClose();
  });
  expect(result.current.confirmDiscard).toBe(false);
  expect(onDismissed).toHaveBeenCalledTimes(1);
});

test('close during a pending write is blocked truthfully', async () => {
  const gate = deferred<ItemDetail>();
  const repository = makeRepository();
  repository.createItemFromDraft.mockReturnValueOnce(gate.promise);
  const onDismissed = jest.fn();
  const { result } = await renderController(
    baseOptions({ repository, onDismissed }),
  );
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '1')],
    });
  });
  await act(async () => {
    void result.current.onSave();
  });
  await act(async () => {
    result.current.onRequestClose();
  });
  expect(result.current.confirmDiscard).toBe(false);
  expect(onDismissed).not.toHaveBeenCalled();
  await act(async () => {
    gate.resolve(makeDetail());
  });
});

test('delete requires confirmation and only then deletes once', async () => {
  const repository = makeRepository();
  const onDeleted = jest.fn();
  const onDismissed = jest.fn();
  const { result } = await renderController(
    baseOptions({
      repository,
      onDeleted,
      onDismissed,
      route: { kind: 'edit', itemId: 7 },
    }),
  );
  await act(async () => {});
  await act(async () => {
    result.current.onRequestDelete();
  });
  expect(result.current.confirmDelete).toBe(true);
  expect(repository.deleteItem).not.toHaveBeenCalled();
  await act(async () => {
    result.current.onCancelDelete();
  });
  expect(result.current.confirmDelete).toBe(false);
  expect(repository.deleteItem).not.toHaveBeenCalled();
  const gate = deferred<void>();
  repository.deleteItem.mockReturnValueOnce(gate.promise);
  await act(async () => {
    result.current.onRequestDelete();
  });
  let first!: Promise<{ deleted: boolean }>;
  let second!: Promise<{ deleted: boolean }>;
  await act(async () => {
    first = result.current.onConfirmDelete();
    second = result.current.onConfirmDelete();
  });
  expect(repository.deleteItem).toHaveBeenCalledTimes(1);
  expect(repository.deleteItem).toHaveBeenCalledWith(db, 7);
  await act(async () => {
    gate.resolve();
  });
  expect(await first).toEqual({ deleted: true });
  expect(await second).toEqual({ deleted: false });
  expect(onDeleted).toHaveBeenCalledWith(7);
  expect(onDismissed).toHaveBeenCalledTimes(1);
});

test('delete failure preserves detail and codes the error', async () => {
  const repository = makeRepository();
  repository.deleteItem.mockRejectedValueOnce(new FakeStorageError());
  const { result } = await renderController(
    baseOptions({ repository, route: { kind: 'edit', itemId: 7 } }),
  );
  await act(async () => {});
  const before = { ...(result.current.values as object) };
  await act(async () => {
    result.current.onRequestDelete();
  });
  let outcome!: { deleted: boolean };
  await act(async () => {
    outcome = await result.current.onConfirmDelete();
  });
  expect(outcome.deleted).toBe(false);
  expect(result.current.values).toEqual(before);
  expect(result.current.errors.form).toBe('storage');
  expect(result.current.confirmDelete).toBe(false);
});

test('stale edit load resolves obsolete and keeps the latest', async () => {
  const first = deferred<ItemDetail>();
  const repository = makeRepository();
  repository.getItem.mockImplementation((_db: RepositoryDb, id: number) =>
    id === 1 ? first.promise : Promise.resolve(makeDetail({ name: 'Second' })),
  );
  const options = baseOptions({
    repository,
    route: { kind: 'edit', itemId: 1 },
  });
  const view = await renderController(options);
  await act(async () => {});
  await view.rerender({ ...options, route: { kind: 'edit', itemId: 2 } });
  await act(async () => {});
  expect(view.result.current.values.name).toBe('Second');
  await act(async () => {
    first.resolve(makeDetail({ name: 'Stale' }));
  });
  expect(view.result.current.values.name).toBe('Second');
  expect(view.result.current.loadState).toBe('ready');
});

test('unmount during save suppresses callbacks but resolves the outcome', async () => {
  const gate = deferred<ItemDetail>();
  const repository = makeRepository();
  repository.createItemFromDraft.mockReturnValueOnce(gate.promise);
  const onSaved = jest.fn();
  const onDismissed = jest.fn();
  const view = await renderController(
    baseOptions({ repository, onSaved, onDismissed }),
  );
  await act(async () => {
    view.result.current.onChange({
      ...(view.result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '1')],
    });
  });
  let outcome!: Promise<SaveOutcome>;
  await act(async () => {
    outcome = view.result.current.onSave();
  });
  await view.unmount();
  gate.resolve(makeDetail());
  expect(await outcome).toEqual({ persisted: true, detail: expect.anything() });
  expect(onSaved).not.toHaveBeenCalled();
  expect(onDismissed).not.toHaveBeenCalled();
});

test('REGRESSION D1: stale-route persisted save releases submitting and still refreshes', async () => {
  const gate = deferred<ItemDetail>();
  const repository = makeRepository();
  repository.createItemFromDraft.mockReturnValueOnce(gate.promise);
  repository.getItem.mockImplementation(async () =>
    makeDetail({ name: 'Second' }),
  );
  const onSaved = jest.fn();
  const options = baseOptions({ repository, onSaved });
  const view = await renderController(options);
  await act(async () => {
    view.result.current.onChange({
      ...(view.result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '1')],
    });
  });
  let outcome!: Promise<SaveOutcome>;
  await act(async () => {
    outcome = view.result.current.onSave();
  });
  // Route changes while the write is in flight.
  await view.rerender({ ...options, route: { kind: 'edit', itemId: 2 } });
  await act(async () => {});
  const persistedDetail = makeDetail({ name: 'Rice' });
  await act(async () => {
    gate.resolve(persistedDetail);
  });
  const resolved = await outcome;
  expect(resolved).toEqual({ persisted: true, detail: persistedDetail });
  // Refresh must not be dropped even though the route moved on.
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(persistedDetail);
  // Single-flight guard + saving flag must be released.
  expect(view.result.current.submitting).toBe(false);
  // Newer route form-local state must not be clobbered.
  expect(view.result.current.values.name).toBe('Second');
  // Guard release proof: a follow-up save writes again.
  await act(async () => {
    view.result.current.onChange({
      ...(view.result.current.values as object),
      name: 'Second',
      stock: [existingRow(10, '2')],
    });
  });
  await act(async () => {
    await view.result.current.onSave();
  });
  expect(repository.updateItemFromDraft).toHaveBeenCalledTimes(1);
});

test('REGRESSION D4: stale save completion never clears a newer save\u2019s guard or spinner', async () => {
  const gateA = deferred<ItemDetail>();
  const gateB = deferred<ItemDetail>();
  const repository = makeRepository();
  repository.createItemFromDraft.mockReturnValueOnce(gateA.promise);
  repository.updateItemFromDraft.mockReturnValueOnce(gateB.promise);
  repository.getItem.mockImplementation(async () =>
    makeDetail({ name: 'Second' }),
  );
  const onSaved = jest.fn();
  const onDismissed = jest.fn();
  const options = baseOptions({ repository, onSaved, onDismissed });
  const view = await renderController(options);
  // Save A starts on the create route and stays in flight.
  await act(async () => {
    view.result.current.onChange({
      ...(view.result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '1')],
    });
  });
  let outcomeA!: Promise<SaveOutcome>;
  await act(async () => {
    outcomeA = view.result.current.onSave();
  });
  expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
  // Route B (edit item 2): the newer save takes over the guard.
  await view.rerender({ ...options, route: { kind: 'edit', itemId: 2 } });
  await act(async () => {});
  expect(view.result.current.values.name).toBe('Second');
  let outcomeB!: Promise<SaveOutcome>;
  await act(async () => {
    outcomeB = view.result.current.onSave();
  });
  expect(repository.updateItemFromDraft).toHaveBeenCalledTimes(1);
  expect(view.result.current.submitting).toBe(true);
  // A resolves stale: persisted + refresh, but B keeps guard and spinner.
  const detailA = makeDetail({ name: 'Rice' });
  await act(async () => {
    gateA.resolve(detailA);
  });
  expect(await outcomeA).toEqual({ persisted: true, detail: detailA });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledWith(detailA);
  expect(onDismissed).not.toHaveBeenCalled();
  expect(view.result.current.submitting).toBe(true);
  expect(view.result.current.values.name).toBe('Second');
  // A third same-ticket write is still rejected while B is in flight.
  let outcomeC!: SaveOutcome;
  await act(async () => {
    outcomeC = await view.result.current.onSave();
  });
  expect(outcomeC).toEqual({ persisted: false });
  expect(repository.updateItemFromDraft).toHaveBeenCalledTimes(1);
  // B resolves current: full success and normal release.
  const detailB = makeDetail({ name: 'Second' });
  await act(async () => {
    gateB.resolve(detailB);
  });
  expect(await outcomeB).toEqual({ persisted: true, detail: detailB });
  expect(onSaved).toHaveBeenCalledTimes(2);
  expect(onSaved).toHaveBeenNthCalledWith(2, detailB);
  expect(onDismissed).toHaveBeenCalledTimes(1);
  expect(view.result.current.submitting).toBe(false);
});

test('REGRESSION B0a: create route settles with an inline repository recreated every render', async () => {
  let renders = 0;
  const view = await renderHook(
    (props: ItemFormControllerOptions) => {
      renders += 1;
      const hook = useItemFormController({
        ...props,
        // Fresh object identity every render, like repository={makeRepo()}.
        repository: makeRepository(),
      });
      return hook as unknown as {
        values: Record<string, unknown>;
        errors: Record<string, string>;
        [key: string]: unknown;
      };
    },
    { initialProps: baseOptions() },
  );
  await act(async () => {});
  expect(view.result.current.values).toEqual({
    name: '',
    stock: [],
    categories: [],
    pendingNewCategoryName: '',
  });
  expect(view.result.current.loadState).toBe('ready');
  expect(renders).toBeLessThanOrEqual(4);
  const snapshot = view.result.current.values;
  await view.rerender(baseOptions());
  await act(async () => {});
  expect(view.result.current.values).toEqual(snapshot);
});

test('REGRESSION B0b: edit route loads exactly once with an inline repository recreated every render', async () => {
  const getItem = jest.fn(async (_db: RepositoryDb, _id: number) =>
    makeDetail({ name: 'Loaded' }),
  );
  const view = await renderHook(
    (props: ItemFormControllerOptions) => {
      const hook = useItemFormController({
        ...props,
        // Fresh object identity every render; the shared getItem counts loads.
        repository: { ...makeRepository(), getItem },
      });
      return hook as unknown as {
        values: Record<string, unknown>;
        [key: string]: unknown;
      };
    },
    { initialProps: baseOptions({ route: { kind: 'edit', itemId: 7 } }) },
  );
  await act(async () => {});
  expect(getItem).toHaveBeenCalledTimes(1);
  expect(getItem).toHaveBeenCalledWith(db, 7);
  expect(view.result.current.loadState).toBe('ready');
  expect(view.result.current.values.name).toBe('Loaded');
  // Settling rerenders with another fresh repository must not reload.
  await view.rerender(baseOptions({ route: { kind: 'edit', itemId: 7 } }));
  await act(async () => {});
  expect(getItem).toHaveBeenCalledTimes(1);
});

test('REGRESSION RA1: throwing onSaved still runs onDismissed', async () => {
  const repository = makeRepository();
  const detail = makeDetail();
  repository.createItemFromDraft.mockResolvedValueOnce(detail);
  const onSaved = jest.fn(() => {
    throw new Error('refresh boom');
  });
  const onDismissed = jest.fn();
  const { result } = await renderController(
    baseOptions({ repository, onSaved, onDismissed }),
  );
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '1')],
    });
  });
  let outcome!: SaveOutcome;
  await act(async () => {
    outcome = await result.current.onSave();
  });
  expect(outcome).toEqual({ persisted: true, detail });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onDismissed).toHaveBeenCalledTimes(1);
  expect(result.current.errors.form).toBeUndefined();
  expect(result.current.formErrorCode).toBeNull();
  expect(result.current.submitting).toBe(false);
});

test('REGRESSION RA2: throwing onDeleted still runs onDismissed', async () => {
  const repository = makeRepository();
  const onDeleted = jest.fn(() => {
    throw new Error('refresh boom');
  });
  const onDismissed = jest.fn();
  const { result } = await renderController(
    baseOptions({
      repository,
      onDeleted,
      onDismissed,
      route: { kind: 'edit', itemId: 7 },
    }),
  );
  await act(async () => {});
  await act(async () => {
    result.current.onRequestDelete();
  });
  let outcome!: { deleted: boolean };
  await act(async () => {
    outcome = await result.current.onConfirmDelete();
  });
  expect(outcome).toEqual({ deleted: true });
  expect(onDeleted).toHaveBeenCalledWith(7);
  expect(onDismissed).toHaveBeenCalledTimes(1);
  expect(result.current.errors.form).toBeUndefined();
  expect(result.current.submitting).toBe(false);
});

test('REGRESSION RB1: onSave yields while a delete owns the screen', async () => {
  const deleteGate = deferred<void>();
  const repository = makeRepository();
  repository.deleteItem.mockReturnValueOnce(deleteGate.promise);
  const { result } = await renderController(
    baseOptions({ repository, route: { kind: 'edit', itemId: 7 } }),
  );
  await act(async () => {});
  await act(async () => {
    result.current.onRequestDelete();
  });
  let firstDelete!: Promise<{ deleted: boolean }>;
  await act(async () => {
    firstDelete = result.current.onConfirmDelete();
  });
  expect(repository.deleteItem).toHaveBeenCalledTimes(1);
  // A save attempted while the delete owns the screen is rejected.
  let saveOutcome!: SaveOutcome;
  await act(async () => {
    saveOutcome = await result.current.onSave();
  });
  expect(saveOutcome).toEqual({ persisted: false });
  expect(repository.updateItemFromDraft).not.toHaveBeenCalled();
  expect(result.current.submitting).toBe(true);
  // Close stays blocked while either write is in flight.
  await act(async () => {
    result.current.onRequestClose();
  });
  expect(result.current.confirmDiscard).toBe(false);
  // After the delete completes, saving proceeds normally.
  await act(async () => {
    deleteGate.resolve();
  });
  expect(await firstDelete).toEqual({ deleted: true });
  expect(result.current.submitting).toBe(false);
  let secondOutcome!: SaveOutcome;
  await act(async () => {
    secondOutcome = await result.current.onSave();
  });
  expect(secondOutcome.persisted).toBe(true);
  expect(repository.updateItemFromDraft).toHaveBeenCalledTimes(1);
});

test('REGRESSION RB2: onConfirmDelete yields while a save owns the screen', async () => {
  const saveGate = deferred<ItemDetail>();
  const repository = makeRepository();
  repository.updateItemFromDraft.mockReturnValueOnce(saveGate.promise);
  const { result } = await renderController(
    baseOptions({ repository, route: { kind: 'edit', itemId: 7 } }),
  );
  await act(async () => {});
  let saveOutcome!: Promise<SaveOutcome>;
  await act(async () => {
    saveOutcome = result.current.onSave();
  });
  expect(repository.updateItemFromDraft).toHaveBeenCalledTimes(1);
  // A delete confirmed while the save owns the screen is rejected.
  await act(async () => {
    result.current.onRequestDelete();
  });
  let firstDelete!: { deleted: boolean };
  await act(async () => {
    firstDelete = await result.current.onConfirmDelete();
  });
  expect(firstDelete).toEqual({ deleted: false });
  expect(repository.deleteItem).not.toHaveBeenCalled();
  // After the save completes, deleting proceeds normally.
  await act(async () => {
    saveGate.resolve(makeDetail());
  });
  expect((await saveOutcome).persisted).toBe(true);
  expect(result.current.submitting).toBe(false);
  const deleteGate = deferred<void>();
  repository.deleteItem.mockReturnValueOnce(deleteGate.promise);
  let secondDelete!: Promise<{ deleted: boolean }>;
  await act(async () => {
    secondDelete = result.current.onConfirmDelete();
  });
  expect(repository.deleteItem).toHaveBeenCalledTimes(1);
  await act(async () => {
    deleteGate.resolve();
  });
  expect(await secondDelete).toEqual({ deleted: true });
});

test('REGRESSION W1: same-component layout-phase confirm after route change deletes nothing', async () => {
  const repository = makeRepository();
  const optionsFor = (itemId: number) =>
    baseOptions({ repository, route: { kind: 'edit', itemId } });
  let fire = false;
  const calls: Promise<{ deleted: boolean }>[] = [];
  const onWindow = (controller: ProbeController) => {
    if (fire) {
      fire = false;
      calls.push(controller.onConfirmDelete());
    }
  };
  const view = await render(
    <WindowProbe options={optionsFor(7)} onWindow={onWindow} />,
  );
  await act(async () => {});
  await act(async () => {
    latestProbedController?.onRequestDelete();
  });
  // Route changes; the layout-phase call below fires before any passive
  // effect, and before the hook's own layout reset (probe registered first).
  fire = true;
  await view.rerender(
    <WindowProbe options={optionsFor(8)} onWindow={onWindow} />,
  );
  await act(async () => {});
  expect(calls).toHaveLength(1);
  expect(await calls[0]).toEqual({ deleted: false });
  expect(repository.deleteItem).not.toHaveBeenCalled();
  await view.unmount();
});

test('REGRESSION W2: parent layout-phase confirm after route change deletes nothing', async () => {
  const repository = makeRepository();
  const optionsFor = (itemId: number) =>
    baseOptions({ repository, route: { kind: 'edit', itemId } });
  let fire = false;
  const calls: Promise<{ deleted: boolean }>[] = [];
  const onWindow = (controller: ProbeController) => {
    if (fire) {
      fire = false;
      calls.push(controller.onConfirmDelete());
    }
  };
  const view = await render(
    <WindowParent options={optionsFor(7)} onWindow={onWindow} />,
  );
  await act(async () => {});
  await act(async () => {
    latestProbedController?.onRequestDelete();
  });
  fire = true;
  await view.rerender(
    <WindowParent options={optionsFor(8)} onWindow={onWindow} />,
  );
  await act(async () => {});
  expect(calls).toHaveLength(1);
  expect(await calls[0]).toEqual({ deleted: false });
  expect(repository.deleteItem).not.toHaveBeenCalled();
  await view.unmount();
});

test('REGRESSION W3: layout-phase save after route change writes nothing', async () => {
  const repository = makeRepository();
  const optionsFor = (itemId: number) =>
    baseOptions({ repository, route: { kind: 'edit', itemId } });
  let fire = false;
  const calls: Promise<SaveOutcome>[] = [];
  const onWindow = (controller: ProbeController) => {
    if (fire) {
      fire = false;
      calls.push(controller.onSave());
    }
  };
  const view = await render(
    <WindowProbe options={optionsFor(7)} onWindow={onWindow} />,
  );
  await act(async () => {});
  await act(async () => {
    latestProbedController?.onChange({
      ...(latestProbedController?.values as object),
      name: 'Hijack',
    });
  });
  fire = true;
  await view.rerender(
    <WindowProbe options={optionsFor(9)} onWindow={onWindow} />,
  );
  await act(async () => {});
  expect(calls).toHaveLength(1);
  expect(await calls[0]).toEqual({ persisted: false });
  expect(repository.updateItemFromDraft).not.toHaveBeenCalled();
  expect(repository.createItemFromDraft).not.toHaveBeenCalled();
  await view.unmount();
});

test('REGRESSION W4: layout-phase calls with no route change still work', async () => {
  const repository = makeRepository();
  const optionsFor = (itemId: number) =>
    baseOptions({ repository, route: { kind: 'edit', itemId } });
  let mode: 'save' | 'confirm' | null = null;
  const saves: Promise<SaveOutcome>[] = [];
  const deletes: Promise<{ deleted: boolean }>[] = [];
  const onWindow = (controller: ProbeController) => {
    if (mode === 'save') {
      mode = null;
      saves.push(controller.onSave());
    } else if (mode === 'confirm') {
      mode = null;
      deletes.push(controller.onConfirmDelete());
    }
  };
  const view = await render(
    <WindowProbe options={optionsFor(7)} onWindow={onWindow} />,
  );
  await act(async () => {});
  // Same-route layout-phase save writes the current item.
  mode = 'save';
  await view.rerender(
    <WindowProbe options={optionsFor(7)} onWindow={onWindow} />,
  );
  await act(async () => {});
  expect(saves).toHaveLength(1);
  expect(await saves[0]).toEqual({
    persisted: true,
    detail: expect.anything(),
  });
  expect(repository.updateItemFromDraft).toHaveBeenCalledTimes(1);
  expect(repository.updateItemFromDraft).toHaveBeenCalledWith(
    db,
    7,
    expect.anything(),
  );
  // Same-route armed layout-phase confirm deletes the current item.
  await act(async () => {
    latestProbedController?.onRequestDelete();
  });
  mode = 'confirm';
  await view.rerender(
    <WindowProbe options={optionsFor(7)} onWindow={onWindow} />,
  );
  await act(async () => {});
  expect(deletes).toHaveLength(1);
  expect(await deletes[0]).toEqual({ deleted: true });
  expect(repository.deleteItem).toHaveBeenCalledTimes(1);
  expect(repository.deleteItem).toHaveBeenCalledWith(db, 7);
  await view.unmount();
});

test('REGRESSION H1: dirty create to edit change, layout-phase close dismisses nothing', async () => {
  const repository = makeRepository();
  repository.getItem.mockImplementation(async () =>
    makeDetail({ name: 'Eight' }),
  );
  const onDismissed = jest.fn();
  const optionsFor = (route: ItemFormControllerOptions['route']) =>
    baseOptions({ repository, onDismissed, route });
  let fire = false;
  const onWindow = (controller: ProbeController) => {
    if (fire) {
      fire = false;
      controller.onRequestClose();
    }
  };
  const view = await render(
    <WindowProbe
      options={optionsFor({ kind: 'create' })}
      onWindow={onWindow}
    />,
  );
  await act(async () => {});
  // Dirty the create form (baseline stays blank).
  await act(async () => {
    latestProbedController?.onChange({
      ...(latestProbedController?.values as object),
      name: 'Dirty typing',
    });
  });
  // Route change; the probe fires before the hook's own layout reset, so
  // the mixed epoch must refuse the close.
  fire = true;
  await view.rerender(
    <WindowProbe
      options={optionsFor({ kind: 'edit', itemId: 8 })}
      onWindow={onWindow}
    />,
  );
  await act(async () => {});
  expect(onDismissed).not.toHaveBeenCalled();
  await view.unmount();
});

test('REGRESSION H2: edit 7 to 8, layout-phase close with a stale closure arms nothing', async () => {
  const repository = makeRepository();
  const onDismissed = jest.fn();
  const optionsFor = (itemId: number) =>
    baseOptions({ repository, onDismissed, route: { kind: 'edit', itemId } });
  // The caller holds the pre-change controller (stale baseline closure)
  // and invokes it from a parent layout effect after the route change,
  // while the new item is still loading.
  let stale: ProbeController | null = null;
  let fire = false;
  const onWindow = () => {
    if (fire) {
      fire = false;
      stale?.onRequestClose();
    }
  };
  const view = await render(
    <WindowParent options={optionsFor(7)} onWindow={onWindow} />,
  );
  await act(async () => {});
  // Item 7 loaded: the captured closure's baseline is item 7's values.
  stale = latestProbedController;
  const loadGate = deferred<ItemDetail>();
  repository.getItem.mockReturnValueOnce(loadGate.promise);
  fire = true;
  await view.rerender(
    <WindowParent options={optionsFor(8)} onWindow={onWindow} />,
  );
  await act(async () => {});
  // Post-fix the blank session compares clean against the live baseline:
  // dismiss once, no arming (pre-fix the stale item-7 baseline armed a
  // confirm on a clean form).
  expect(onDismissed).toHaveBeenCalledTimes(1);
  expect(latestProbedController?.confirmDiscard).toBe(false);
  await act(async () => {
    loadGate.resolve(makeDetail({ name: 'Item-8' }));
  });
  expect(latestProbedController?.dirty).toBe(false);
  await view.unmount();
});

test('REGRESSION H3: armed discard plus route change, layout-phase confirm dismisses nothing', async () => {
  const repository = makeRepository();
  repository.getItem.mockImplementation(async () =>
    makeDetail({ name: 'Eight' }),
  );
  const onDismissed = jest.fn();
  const optionsFor = (route: ItemFormControllerOptions['route']) =>
    baseOptions({ repository, onDismissed, route });
  let fire = false;
  const calls: number[] = [];
  const onWindow = (controller: ProbeController) => {
    if (fire) {
      fire = false;
      calls.push(1);
      controller.onConfirmDiscard();
    }
  };
  const view = await render(
    <WindowProbe
      options={optionsFor({ kind: 'create' })}
      onWindow={onWindow}
    />,
  );
  await act(async () => {});
  // Arm the discard on the create route.
  await act(async () => {
    latestProbedController?.onChange({
      ...(latestProbedController?.values as object),
      name: 'Dirty typing',
    });
    latestProbedController?.onRequestClose();
  });
  // Route change; the probe fires before the hook's own layout reset.
  fire = true;
  await view.rerender(
    <WindowProbe
      options={optionsFor({ kind: 'edit', itemId: 8 })}
      onWindow={onWindow}
    />,
  );
  await act(async () => {});
  expect(calls).toHaveLength(1);
  expect(onDismissed).not.toHaveBeenCalled();
  expect(repository.deleteItem).not.toHaveBeenCalled();
  await view.unmount();
});

test('REGRESSION H4: settled-route close and discard control still works', async () => {
  const onDismissed = jest.fn();
  const { result } = await renderController(baseOptions({ onDismissed }));
  // Clean values dismiss once.
  await act(async () => {
    result.current.onRequestClose();
  });
  expect(onDismissed).toHaveBeenCalledTimes(1);
  // Dirty values arm the discard.
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: 'Dirty typing',
    });
  });
  await act(async () => {
    result.current.onRequestClose();
  });
  expect(result.current.confirmDiscard).toBe(true);
  expect(onDismissed).toHaveBeenCalledTimes(1);
  // Confirm after a real user request dismisses once.
  await act(async () => {
    result.current.onConfirmDiscard();
  });
  expect(onDismissed).toHaveBeenCalledTimes(2);
  expect(result.current.confirmDiscard).toBe(false);
});

test('REGRESSION H5: clean first-mount dismiss works from an earlier layout effect', async () => {
  const onDismissed = jest.fn();
  let fire = false;
  const onWindow = (controller: ProbeController) => {
    if (fire) {
      fire = false;
      controller.onRequestClose();
    }
  };
  // Fire on the very first commit: the probe is registered before the
  // hook, so this runs before the hook's own layout reset.
  fire = true;
  const view = await render(
    <WindowProbe
      options={baseOptions({ onDismissed, route: { kind: 'create' } })}
      onWindow={onWindow}
    />,
  );
  await act(async () => {});
  expect(onDismissed).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('REGRESSION S1: armed delete confirm does not survive an itemId change', async () => {
  const repository = makeRepository();
  const options = baseOptions({
    repository,
    route: { kind: 'edit', itemId: 7 },
  });
  const view = await renderController(options);
  await act(async () => {});
  await act(async () => {
    view.result.current.onRequestDelete();
  });
  expect(view.result.current.confirmDelete).toBe(true);
  await view.rerender({ ...options, route: { kind: 'edit', itemId: 8 } });
  await act(async () => {});
  // A confirm armed on item 7 must never delete item 8.
  expect(view.result.current.confirmDelete).toBe(false);
  let outcome!: { deleted: boolean };
  await act(async () => {
    outcome = await view.result.current.onConfirmDelete();
  });
  expect(outcome).toEqual({ deleted: false });
  expect(repository.deleteItem).not.toHaveBeenCalled();
  // A subsequent explicit request on the new route deletes item 8, once.
  await act(async () => {
    view.result.current.onRequestDelete();
  });
  expect(view.result.current.confirmDelete).toBe(true);
  await act(async () => {
    outcome = await view.result.current.onConfirmDelete();
  });
  expect(outcome).toEqual({ deleted: true });
  expect(repository.deleteItem).toHaveBeenCalledTimes(1);
  expect(repository.deleteItem).toHaveBeenCalledWith(db, 8);
});

test('REGRESSION S2: armed discard confirm does not survive a route change', async () => {
  const repository = makeRepository();
  repository.getItem.mockImplementation(async () =>
    makeDetail({ name: 'Eight' }),
  );
  const options = baseOptions({ repository });
  const view = await renderController(options);
  await act(async () => {
    view.result.current.onChange({
      ...(view.result.current.values as object),
      name: 'Dirty typing',
    });
  });
  await act(async () => {
    view.result.current.onRequestClose();
  });
  expect(view.result.current.confirmDiscard).toBe(true);
  await view.rerender({ ...options, route: { kind: 'edit', itemId: 8 } });
  await act(async () => {});
  expect(view.result.current.confirmDiscard).toBe(false);
});

test('REGRESSION S3: baseline resets on edit entry so dirty is false while loading and after failure', async () => {
  const repository = makeRepository();
  const options = baseOptions({
    repository,
    route: { kind: 'edit', itemId: 7 },
  });
  const view = await renderController(options);
  await act(async () => {});
  expect(view.result.current.loadState).toBe('ready');
  expect(view.result.current.dirty).toBe(false);
  const failGate = deferred<ItemDetail>();
  repository.getItem.mockReturnValueOnce(failGate.promise);
  await view.rerender({ ...options, route: { kind: 'edit', itemId: 8 } });
  await act(async () => {});
  // While item 8 loads, blank values sit on a blank baseline: clean.
  expect(view.result.current.dirty).toBe(false);
  await act(async () => {
    failGate.reject(new FakeStorageError());
  });
  expect(view.result.current.loadState).toBe('error');
  expect(view.result.current.dirty).toBe(false);
});

test('REGRESSION S4: edit entry resets session state then loads fresh data clean', async () => {
  const repository = makeRepository();
  const options = baseOptions({
    repository,
    route: { kind: 'edit', itemId: 7 },
  });
  const view = await renderController(options);
  await act(async () => {});
  // Arm both confirms on item 7 (dirty values + delete request).
  await act(async () => {
    view.result.current.onChange({
      ...(view.result.current.values as object),
      pendingNewCategoryName: 'typing',
    });
  });
  await act(async () => {
    view.result.current.onRequestClose();
  });
  await act(async () => {
    view.result.current.onRequestDelete();
  });
  expect(view.result.current.confirmDiscard).toBe(true);
  expect(view.result.current.confirmDelete).toBe(true);
  repository.getItem.mockImplementation(async () =>
    makeDetail({ name: 'Eight' }),
  );
  await view.rerender({ ...options, route: { kind: 'edit', itemId: 8 } });
  await act(async () => {});
  expect(view.result.current.confirmDiscard).toBe(false);
  expect(view.result.current.confirmDelete).toBe(false);
  expect(view.result.current.loadState).toBe('ready');
  expect(view.result.current.values.name).toBe('Eight');
  expect(view.result.current.dirty).toBe(false);
  expect(view.result.current.errors).toEqual({});
});

test('REGRESSION D2a: throwing onSaved still reports persisted without a storage error', async () => {
  const repository = makeRepository();
  const detail = makeDetail();
  repository.createItemFromDraft.mockResolvedValueOnce(detail);
  const onSaved = jest.fn(() => {
    throw new Error('refresh boom');
  });
  const { result } = await renderController(
    baseOptions({ repository, onSaved }),
  );
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: 'Rice',
      stock: [existingRow(10, '1')],
    });
  });
  let outcome!: SaveOutcome;
  await act(async () => {
    outcome = await result.current.onSave();
  });
  expect(outcome).toEqual({ persisted: true, detail });
  expect(result.current.errors.form).toBeUndefined();
  expect(result.current.formErrorCode).toBeNull();
  expect(result.current.submitting).toBe(false);
  // Guard must not re-latch: a follow-up save writes again.
  await act(async () => {
    await result.current.onSave();
  });
  expect(repository.createItemFromDraft).toHaveBeenCalledTimes(2);
});

test('REGRESSION D2b: throwing onDeleted still reports deleted without a storage error', async () => {
  const repository = makeRepository();
  const onDeleted = jest.fn(() => {
    throw new Error('refresh boom');
  });
  const { result } = await renderController(
    baseOptions({ repository, onDeleted, route: { kind: 'edit', itemId: 7 } }),
  );
  await act(async () => {});
  await act(async () => {
    result.current.onRequestDelete();
  });
  let outcome!: { deleted: boolean };
  await act(async () => {
    outcome = await result.current.onConfirmDelete();
  });
  expect(outcome).toEqual({ deleted: true });
  expect(result.current.errors.form).toBeUndefined();
  expect(result.current.formErrorCode).toBeNull();
  expect(result.current.submitting).toBe(false);
});

test('REGRESSION D3: StrictMode remount recovers instead of short-circuiting guards', async () => {
  const React = require('react') as typeof import('react');
  const { Text } = require('react-native') as typeof import('react-native');
  const { render } =
    require('@testing-library/react-native') as typeof import('@testing-library/react-native');
  const hook = useItemFormController as unknown as (
    o: ItemFormControllerOptions,
  ) => {
    loadState: string;
    values: { name: string };
  };
  function Probe({ options }: { options: ItemFormControllerOptions }) {
    const controller = hook(options);
    return React.createElement(
      Text,
      { testID: 'probe' },
      `${controller.loadState}:${controller.values.name}`,
    );
  }
  const repository = makeRepository();
  const gate = deferred<ItemDetail>();
  // Every mount-effect load attempt waits on the same gate so the
  // StrictMode double-mount (mount, cleanup, remount with live refs)
  // leaves exactly one current ticket to publish.
  repository.getItem.mockReturnValue(gate.promise);
  const options = baseOptions({
    repository,
    route: { kind: 'edit', itemId: 7 },
  });
  const view = await render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(Probe, { options }),
    ),
  );
  await act(async () => {
    gate.resolve(makeDetail({ name: 'Strict' }));
  });
  const probe = await view.findByTestId('probe');
  expect(probe.props.children).toBe('ready:Strict');
  await view.unmount();
});

test('failed edit load codes the error and retry reloads latest', async () => {
  const repository = makeRepository();
  const gate = deferred<ItemDetail>();
  repository.getItem.mockReturnValueOnce(gate.promise);
  const { result } = await renderController(
    baseOptions({ repository, route: { kind: 'edit', itemId: 7 } }),
  );
  expect(result.current.loadState).toBe('loading');
  await act(async () => {
    gate.reject(new FakeStorageError());
  });
  expect(result.current.loadState).toBe('error');
  expect(result.current.errors.form).toBe('storage');
  const retryGate = deferred<ItemDetail>();
  repository.getItem.mockReturnValueOnce(retryGate.promise);
  await act(async () => {
    result.current.onRetry();
  });
  expect(result.current.loadState).toBe('loading');
  await act(async () => {
    retryGate.resolve(makeDetail({ name: 'Retry' }));
  });
  expect(result.current.loadState).toBe('ready');
  expect(result.current.values.name).toBe('Retry');
  expect(result.current.errors.form).toBeUndefined();
});

describe('M4 blur validation (Gap B)', () => {
  test('blur on an empty name sets only the name error', async () => {
    const { result } = await renderController(baseOptions());
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: '   ',
        stock: [existingRow(10, '2')],
      });
    });
    await act(async () => {
      await (
        result.current as unknown as {
          onFieldBlur: (f: 'name' | 'quantity', index?: number) => void;
        }
      ).onFieldBlur('name');
    });
    expect(result.current.errors.name).toBe('Enter a name.');
    expect(result.current.errors.stock).toBeUndefined();
  });

  test('blur on a valid name clears a previous name error and leaves a quantity error intact', async () => {
    const { result } = await renderController(baseOptions());
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: '   ',
        stock: [existingRow(10, 'abc')],
      });
    });
    const blur = (
      result.current as unknown as {
        onFieldBlur: (f: 'name' | 'quantity', index?: number) => void;
      }
    ).onFieldBlur;
    await act(async () => {
      await blur('quantity', 0);
    });
    expect(rowQuantityError(result)).toBe('Enter a whole number of 0 or more.');
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
      });
    });
    // Seed a stale name error as a prior submit would have left it.
    await act(async () => {
      await result.current.onSave();
    });
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        stock: [existingRow(10, 'abc')],
      });
    });
    await act(async () => {
      await (
        result.current as unknown as {
          onFieldBlur: (f: 'name' | 'quantity', index?: number) => void;
        }
      ).onFieldBlur('name');
    });
    expect(result.current.errors.name).toBeUndefined();
    expect(rowQuantityError(result)).toBe('Enter a whole number of 0 or more.');
  });

  test('blur on an invalid quantity sets only the quantity error', async () => {
    const { result } = await renderController(baseOptions());
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        stock: [existingRow(10, 'abc')],
      });
    });
    await act(async () => {
      await (
        result.current as unknown as {
          onFieldBlur: (f: 'name' | 'quantity', index?: number) => void;
        }
      ).onFieldBlur('quantity', 0);
    });
    expect(rowQuantityError(result)).toBe('Enter a whole number of 0 or more.');
    expect(result.current.errors.name).toBeUndefined();
  });

  test('blur on a valid quantity clears a previous quantity error', async () => {
    const { result } = await renderController(baseOptions());
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        stock: [existingRow(10, 'abc')],
      });
    });
    await act(async () => {
      await (
        result.current as unknown as {
          onFieldBlur: (f: 'name' | 'quantity', index?: number) => void;
        }
      ).onFieldBlur('quantity', 0);
    });
    expect(rowQuantityError(result)).toBeTruthy();
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        stock: [existingRow(10, '3')],
      });
    });
    await act(async () => {
      await (
        result.current as unknown as {
          onFieldBlur: (f: 'name' | 'quantity', index?: number) => void;
        }
      ).onFieldBlur('quantity', 0);
    });
    expect(result.current.errors.stock?.[0]).toBeUndefined();
  });

  test('blur while submitting does nothing', async () => {
    const gate = deferred<ItemDetail>();
    const repository = makeRepository();
    repository.createItemFromDraft.mockReturnValueOnce(gate.promise);
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        quantityRaw: '1',
        location: { kind: 'existing', locationId: 10 },
      });
    });
    await act(async () => {
      void result.current.onSave();
    });
    expect(result.current.submitting).toBe(true);
    // Invalidate the name mid-flight, then blur: the pending write owns
    // the screen, so no error may publish.
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: '   ',
      });
    });
    await act(async () => {
      await (
        result.current as unknown as {
          onFieldBlur: (f: 'name' | 'quantity', index?: number) => void;
        }
      ).onFieldBlur('name');
    });
    expect(result.current.errors.name).toBeUndefined();
    await act(async () => {
      gate.resolve(makeDetail());
    });
  });

  test('blur in the commit window after a route change publishes no stale error', async () => {
    const repository = makeRepository();
    repository.getItem.mockImplementation(async () =>
      makeDetail({ name: 'Eight' }),
    );
    const optionsFor = (itemId: number) =>
      baseOptions({ repository, route: { kind: 'edit', itemId } });
    let fire = false;
    const onWindow = (controller: ProbeController) => {
      if (fire) {
        fire = false;
        (
          controller as unknown as {
            onFieldBlur: (f: 'name' | 'quantity', index?: number) => void;
          }
        ).onFieldBlur('name');
      }
    };
    const view = await render(
      <WindowProbe options={optionsFor(7)} onWindow={onWindow} />,
    );
    await act(async () => {});
    await act(async () => {
      latestProbedController?.onChange({
        ...(latestProbedController?.values as object),
        name: '   ',
        stock: [existingRow(10, '2')],
      });
    });
    fire = true;
    await view.rerender(
      <WindowProbe options={optionsFor(8)} onWindow={onWindow} />,
    );
    await act(async () => {});
    expect(latestProbedController?.errors).toEqual({});
    await view.unmount();
  });
});

describe('S10 out-of-range inline errors (current language)', () => {
  test('RED: over-120 name rejected with too-long copy, no write', async () => {
    const repository = makeRepository();
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'a'.repeat(121),
        stock: [existingRow(10, '2')],
      });
    });
    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(false);
    expect(repository.createItemFromDraft).not.toHaveBeenCalled();
    expect(result.current.errors.name).toBe(
      'Enter a name of 120 characters or fewer.',
    );
  });

  test('RED: quantity 1000000 rejected with too-large copy; 999999 writes', async () => {
    const repository = makeRepository();
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        stock: [existingRow(10, '1000000')],
      });
    });
    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(false);
    expect(repository.createItemFromDraft).not.toHaveBeenCalled();
    expect(rowQuantityError(result)).toBe(
      'Enter a quantity of 999999 or less.',
    );
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        stock: [existingRow(10, '999999')],
      });
    });
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(true);
    const draft = repository.createItemFromDraft.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(draft.stock).toEqual([
      { location: { kind: 'existing', locationId: 10 }, quantity: 999999 },
    ]);
  });

  test('RED: new location name over 80 rejected with location copy, no write', async () => {
    const repository = makeRepository();
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        stock: [
          {
            location: {
              kind: 'new',
              location: { name: 'b'.repeat(81), address: null },
            },
            quantityRaw: '2',
          },
        ],
      });
    });
    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(false);
    expect(repository.createItemFromDraft).not.toHaveBeenCalled();
    const longNameError = (
      result.current.errors.stock as unknown as
        | { location?: string }[]
        | undefined
    )?.[0];
    expect(longNameError?.location).toBe(
      'Enter a location name of 80 characters or fewer.',
    );
  });

  test('RED: new category name over 80 rejected with category copy, no write', async () => {
    const repository = makeRepository();
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        stock: [existingRow(10, '2')],
        categories: [{ kind: 'new', category: { name: 'c'.repeat(81) } }],
      });
    });
    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(false);
    expect(repository.createItemFromDraft).not.toHaveBeenCalled();
    expect(result.current.errors.categories).toBe(
      'Enter a category name of 80 characters or fewer.',
    );
  });
});

describe('S11 duplicate-name conflict inline errors (current language)', () => {
  test('RED: conflicting new location shows the location conflict copy', async () => {
    const repository = makeRepository();
    repository.createItemFromDraft.mockRejectedValueOnce(
      new EntityConflictError('location', 'Pantry'),
    );
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        stock: [
          {
            location: {
              kind: 'new',
              location: { name: 'pantry', address: null },
            },
            quantityRaw: '2',
          },
        ],
      });
    });
    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(false);
    const conflict = (
      result.current.errors.stock as unknown as
        | { location?: string }[]
        | undefined
    )?.[0];
    expect(conflict?.location).toBe(
      'A location with this name already exists.',
    );
    expect(result.current.errors.form).toBeUndefined();
  });

  test('RED: conflicting new category shows the category conflict copy', async () => {
    const repository = makeRepository();
    repository.createItemFromDraft.mockRejectedValueOnce(
      new EntityConflictError('category', 'Bulk'),
    );
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
        stock: [existingRow(10, '2')],
        categories: [{ kind: 'new', category: { name: 'bulk' } }],
      });
    });
    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(false);
    expect(result.current.errors.categories).toBe(
      'A category with this name already exists.',
    );
    expect(result.current.errors.form).toBeUndefined();
  });
});

describe('T4 form per-keystroke work (S2.6)', () => {
  test('T4 RED: a quantity keystroke performs no JSON serialization for the dirty check', async () => {
    const stringifySpy = jest.spyOn(JSON, 'stringify');
    try {
      const { result } = await renderController(baseOptions());
      await act(async () => {
        result.current.onChange({
          ...(result.current.values as object),
          name: 'Rice',
          stock: [existingRow(10, '1'), existingRow(11, '2')],
        });
      });
      stringifySpy.mockClear();
      await act(async () => {
        const current = result.current.values as unknown as {
          name: string;
          stock: { location: unknown; quantityRaw: string }[];
        };
        result.current.onChange({
          ...(result.current.values as object),
          stock: [{ ...current.stock[0], quantityRaw: '12' }, current.stock[1]],
        });
      });
      const serializedFormValues = stringifySpy.mock.calls.filter(
        ([arg]) =>
          typeof arg === 'object' &&
          arg !== null &&
          'pendingNewCategoryName' in (arg as object),
      );
      expect(serializedFormValues).toHaveLength(0);
    } finally {
      stringifySpy.mockRestore();
    }
  });
});

test('U1: create with a last-used location starts with exactly one empty-quantity row', async () => {
  const { result } = await renderController(
    baseOptions({ route: { kind: 'create', prefilledLocationId: 10 } }),
  );
  expect(result.current.mode).toBe('add');
  expect(result.current.loadState).toBe('ready');
  expect(result.current.values).toEqual({
    name: '',
    stock: [existingRow(10, '')],
    categories: [],
    pendingNewCategoryName: '',
  });
  // A prefill is a starting point, not a user edit: clean, no confirm.
  expect(result.current.dirty).toBe(false);
});

test('U1: an invalid prefilled location falls back to the blank form', async () => {
  const { result } = await renderController(
    baseOptions({
      route: { kind: 'create', prefilledLocationId: 0 },
    }),
  );
  expect(result.current.values.stock).toEqual([]);
});

test('U1: an untouched prefill saves catalog-only (blank-and-droppable unchanged)', async () => {
  const repository = makeRepository();
  const { result } = await renderController(
    baseOptions({
      repository,
      route: { kind: 'create', prefilledLocationId: 10 },
    }),
  );
  await act(async () => {
    result.current.onChange({
      ...(result.current.values as object),
      name: 'Rice',
    });
  });
  await act(async () => {
    await result.current.onSave();
  });
  expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
  const draft = repository.createItemFromDraft.mock.calls[0][1] as Record<
    string,
    unknown
  >;
  expect(draft.stock).toEqual([]);
});

test('U1 PRESERVE: edit loads only the detail rows and never gains a prefilled row', async () => {
  const repository = makeRepository();
  const { result } = await renderController(
    baseOptions({ repository, route: { kind: 'edit', itemId: 7 } }),
  );
  await act(async () => {});
  expect(result.current.mode).toBe('edit');
  expect(result.current.loadState).toBe('ready');
  expect(result.current.values.stock).toEqual([existingRow(10, '2')]);
});

describe('U3 scanned barcode plumbing (closed loop)', () => {
  const { decideScanRoute } =
    require('../src/screens/useBarcodeScanController') as typeof import('../src/screens/useBarcodeScanController');

  test('RED: a scanned create carries the code into the draft', async () => {
    const repository = makeRepository();
    const { result } = await renderController(
      baseOptions({
        repository,
        route: { kind: 'create', prefilledBarcode: 'ZZZ-9999' },
      }),
    );
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Beans',
      });
    });
    await act(async () => {
      await result.current.onSave();
    });
    expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
    const draft = repository.createItemFromDraft.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(draft.barcode).toBe('ZZZ-9999');
  });

  test('a manual (unscanned) create stores no barcode', async () => {
    const repository = makeRepository();
    const { result } = await renderController(baseOptions({ repository }));
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice',
      });
    });
    await act(async () => {
      await result.current.onSave();
    });
    expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
    const draft = repository.createItemFromDraft.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(draft.barcode ?? null).toBeNull();
  });

  test('an existing item edited from a scan keeps its own code untouched', async () => {
    const repository = makeRepository();
    repository.getItem.mockResolvedValueOnce(
      makeDetail({ name: 'Rice', barcode: 'AAA-1111' }),
    );
    const { result } = await renderController(
      baseOptions({ repository, route: { kind: 'edit', itemId: 7 } }),
    );
    await act(async () => {});
    expect(result.current.loadState).toBe('ready');
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Rice edited',
      });
    });
    await act(async () => {
      await result.current.onSave();
    });
    expect(repository.updateItemFromDraft).toHaveBeenCalledTimes(1);
    const draft = repository.updateItemFromDraft.mock.calls[0][2] as Record<
      string,
      unknown
    >;
    expect(draft.barcode).toBe('AAA-1111');
  });

  test('an invalid code never reaches the draft', async () => {
    for (const bad of ['ab', '   ', '!!!nope!!!']) {
      const repository = makeRepository();
      const { result } = await renderController(
        baseOptions({
          repository,
          route: { kind: 'create', prefilledBarcode: bad },
        }),
      );
      await act(async () => {
        result.current.onChange({
          ...(result.current.values as object),
          name: 'Rice',
        });
      });
      await act(async () => {
        await result.current.onSave();
      });
      expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
      const draft = repository.createItemFromDraft.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(draft.barcode ?? null).toBeNull();
    }
  });

  test('closed loop: unknown scan creates with the code and the same code finds it', async () => {
    // In-memory fake database: barcode -> stored detail.
    const store = new Map<string, ItemDetail>();
    const fakeDb = {} as RepositoryDb;
    const lookup = jest.fn(async (_db: RepositoryDb, code: string) => {
      const found = store.get(code);
      return found !== undefined ? { ...found } : null;
    });
    const repository = makeRepository();
    let nextId = 100;
    repository.createItemFromDraft.mockImplementation(
      async (_db: RepositoryDb, draft: unknown) => {
        const input = draft as { name: string; barcode?: string | null };
        const detail = makeDetail({
          id: nextId++,
          name: input.name,
          barcode: input.barcode ?? null,
        });
        if (typeof input.barcode === 'string' && input.barcode !== '') {
          store.set(input.barcode, detail);
        }
        return detail;
      },
    );
    // Scan an unknown code: create carrying the normalized code.
    const first = await decideScanRoute(fakeDb, 'ZZZ-9999', lookup);
    expect(first).toEqual({ kind: 'create', barcode: 'ZZZ-9999' });
    if (first.kind !== 'create') throw new Error('expected create route');
    // The create form opens prefilled with that code and saves.
    const { result } = await renderController(
      baseOptions({
        repository,
        route: { kind: 'create', prefilledBarcode: first.barcode },
      }),
    );
    await act(async () => {
      result.current.onChange({
        ...(result.current.values as object),
        name: 'Scanned beans',
      });
    });
    let outcome!: SaveOutcome;
    await act(async () => {
      outcome = await result.current.onSave();
    });
    expect(outcome.persisted).toBe(true);
    // The stored item carries that code.
    const draft = repository.createItemFromDraft.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(draft.barcode).toBe('ZZZ-9999');
    expect(outcome.detail?.barcode).toBe('ZZZ-9999');
    // A re-scan of the same code reaches that item.
    const second = await decideScanRoute(fakeDb, 'ZZZ-9999', lookup);
    expect(second).toEqual({ kind: 'edit', itemId: outcome.detail?.id });
    expect(lookup).toHaveBeenCalledWith(fakeDb, 'ZZZ-9999');
  });
});
