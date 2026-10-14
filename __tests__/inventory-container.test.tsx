/**
 * P3b2 App-wired inventory container unit (Jest/RNTL only, no device proof).
 *
 * Covers bootstrap/read error retry, out-of-order filter completion (B wins,
 * stale errors ignored), rapid retry races, filtered-zero vs first-run
 * total semantics, entity-choice forwarding, no post-unmount publish or
 * handle close, single bootstrap reuse, and genuinely-disabled Add/Open
 * (P4 owns the real routes). The native boundary stays mocked: reads run
 * the REAL `queryItems`/`listLocations`/`listCategories` against a fake
 * `getAllAsync` whose promises the tests resolve by hand.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { I18nextProvider } from 'react-i18next';
import type { ViewProps } from 'react-native';
import i18n from '../src/i18n';
import type { RepositoryDb } from '../src/inventory/database';
import type InventoryContainerType from '../src/screens/InventoryContainer';

const InventoryContainer = require('../src/screens/InventoryContainer')
  .default as typeof InventoryContainerType;

const { initializeDatabase } = require('../src/db') as {
  initializeDatabase: jest.Mock;
};

jest.mock('../src/db', () => ({
  initializeDatabase: jest.fn(),
}));

jest.mock('../src/inventory/itemRepository', () => ({
  getItem: jest.fn(),
  createItemFromDraft: jest.fn(),
  updateItemFromDraft: jest.fn(),
  deleteItem: jest.fn(),
  // U3 scanner lookup (null = unknown code; the real default resolves
  // per test below, never in the suites above).
  findItemByBarcode: jest.fn(),
}));

// U3 scanner camera boundary (virtual: these suites never touch a real
// camera; `ScanScreen` mounts only when a test below opens it).
jest.mock(
  'expo-camera',
  () => {
    const React = require('react');
    const { View } = require('react-native');
    return {
      CameraView: ({
        onBarcodeScanned,
        onMountError,
        testID,
      }: {
        onBarcodeScanned?: (event: { data: string }) => void;
        onMountError?: (event: { message: string }) => void;
        testID?: string;
      }) =>
        React.createElement(View, {
          testID: testID ?? 'scan-camera',
          // Tests read the handlers back off props; no real camera.
          onBarcodeScanned,
          onMountError,
        }),
      useCameraPermissions: jest.fn(() => [null, jest.fn()]),
    };
  },
  { virtual: true },
);

// U4 local reminders: the `expo-notifications` native boundary. Bare
// `jest.fn()`s (no implementation) resolve `undefined`, which the hook
// reads as "no grant yet" and stays silent on — so every suite above
// keeps proving its existing behavior with zero reminder traffic. The U4
// suite below arms per-test permission stubs on these same fns.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    SafeAreaView: ({ children, ...props }: ViewProps) => (
      <View {...props}>{children}</View>
    ),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// U4 date-picker native boundary (same stub as the item-form suite): the
// real picker renders nothing under Jest, so this View carries the picker
// props. Proves the form wiring around the picker; proves nothing about
// the OS dialog itself.
jest.mock('@react-native-community/datetimepicker', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({
      testID,
      value,
      onChange,
    }: {
      testID?: string;
      value?: Date;
      onChange?: (event: { type: string }, date?: Date) => void;
    }) => React.createElement(View, { testID, value, onChange }),
  };
});

interface PendingCall {
  sql: string;
  params: readonly unknown[] | undefined;
  resolve: (value: Record<string, unknown>[]) => void;
  reject: (error: unknown) => void;
}

const pending: PendingCall[] = [];

interface FakeStore {
  items: Record<string, unknown>[];
  links: Record<string, unknown>[];
  stock: Record<string, unknown>[];
  locations: Record<string, unknown>[];
  categories: Record<string, unknown>[];
}

const store: FakeStore = {
  items: [],
  links: [],
  stock: [],
  locations: [],
  categories: [],
};

const closeAsync = jest.fn(async () => {});

function itemRow(
  id: number,
  name: string,
  lowStockThreshold: number | null = null,
): Record<string, unknown> {
  return {
    item_id: id,
    item_name: name,
    // U4: additive v5 reminder level; null keeps every earlier seed
    // (and every earlier assertion) exactly as before.
    low_stock_threshold: lowStockThreshold,
    item_created_at: `created-${id}`,
  };
}

function stockRow(
  itemId: number,
  quantity: number,
  locationId: number,
  locationName: string,
  expiresOn: string | null = null,
): Record<string, unknown> {
  return {
    stock_item_id: itemId,
    quantity,
    location_id: locationId,
    location_name: locationName,
    location_address: null,
    location_created_at: `loc-created-${locationId}`,
    // U4: additive v5 expiry; null keeps every earlier seed exactly as
    // before.
    expires_on: expiresOn,
  };
}

function seedPopulated(): void {
  store.items = [itemRow(1, 'Rice'), itemRow(2, 'Lentils')];
  store.links = [];
  // Rice lives in the Pantry; Lentils is catalog-only (sin stock, R6).
  store.stock = [stockRow(1, 2, 10, 'Pantry')];
  store.locations = [
    { id: 10, name: 'Pantry', address: null, created_at: 'loc-created-10' },
    { id: 11, name: 'Fridge', address: null, created_at: 'loc-created-11' },
  ];
  store.categories = [{ id: 20, name: 'Bulk', created_at: 'cat-created-20' }];
}

function valueFor(call: PendingCall): Record<string, unknown>[] {
  if (call.sql.includes('item_categories')) return store.links;
  if (call.sql.includes('FROM stock')) return store.stock;
  if (call.sql.includes('FROM items')) return store.items;
  if (call.sql.includes('FROM locations')) return store.locations;
  if (call.sql.includes('FROM categories')) return store.categories;
  throw new Error(`unexpected SQL: ${call.sql}`);
}

function makeFakeDb() {
  return {
    getAllAsync: jest.fn(
      (sql: string, params?: readonly unknown[]) =>
        new Promise<Record<string, unknown>[]>((resolve, reject) => {
          pending.push({
            sql,
            params,
            resolve: resolve as (value: Record<string, unknown>[]) => void,
            reject,
          });
        }),
    ),
    // U1 last-used read: the newest stocked item's location among
    // locations that still exist (JOIN-equivalent filter), smallest
    // location on ties, null when no stock row qualifies.
    getFirstAsync: jest.fn(async (sql: string) => {
      if (!sql.includes('FROM stock'))
        throw new Error(`unexpected SQL: ${sql}`);
      const live = new Set(store.locations.map((l) => l.id));
      let best: { itemId: number; locationId: number } | null = null;
      for (const row of store.stock) {
        const itemId = row.stock_item_id as number;
        const locationId = row.location_id as number;
        if (!live.has(locationId)) continue;
        if (
          best === null ||
          itemId > best.itemId ||
          (itemId === best.itemId && locationId < best.locationId)
        ) {
          best = { itemId, locationId };
        }
      }
      return best === null ? null : { location_id: best.locationId };
    }),
    closeAsync,
  };
}

/** Resolve every queued read (plus follow-up link reads) until quiet. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    const batch = pending.splice(0, pending.length);
    if (batch.length === 0) {
      await act(async () => {});
      if (pending.length === 0) return;
    } else {
      await act(async () => {
        for (const call of batch) call.resolve(valueFor(call));
      });
    }
  }
  throw new Error('settle: reads still pending after 10 rounds');
}

async function renderContainer() {
  return render(
    <I18nextProvider i18n={i18n}>
      <InventoryContainer />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  pending.length = 0;
  closeAsync.mockClear();
  initializeDatabase.mockReset();
  seedPopulated();
});

afterEach(async () => {
  await cleanup();
});

test('loads the wired list with entity choices and an honest count', async () => {
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  expect(screen.getByTestId('inventory-loading')).toBeTruthy();
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '2 of 2',
  );
  expect(screen.getByTestId('inventory-row-1')).toBeTruthy();
  expect(screen.getByTestId('inventory-row-2')).toBeTruthy();
  expect(screen.getByTestId('inventory-location-10')).toBeTruthy();
  expect(screen.getByTestId('inventory-category-20')).toBeTruthy();
  expect(initializeDatabase).toHaveBeenCalledTimes(1);
});

test('filter change during pending bootstrap opens only once and reads the current filter', async () => {
  let resolveBootstrap!: (db: unknown) => void;
  initializeDatabase.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveBootstrap = resolve as (db: unknown) => void;
      }),
  );
  await renderContainer();
  await act(async () => {});
  expect(initializeDatabase).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('inventory-loading')).toBeTruthy();

  // Filter while the first open is still in flight: the pending bootstrap
  // must be shared, never opened again. T1: the keystroke settles past
  // the debounce window first, so the single shared round already
  // carries the current filter (the stale mount round publishes nothing).
  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Rice');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  expect(initializeDatabase).toHaveBeenCalledTimes(1);

  const fake = makeFakeDb();
  await act(async () => {
    resolveBootstrap(fake);
  });
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '1 of 2',
  );
  expect(screen.getByTestId('inventory-row-1')).toBeTruthy();
  expect(screen.queryByTestId('inventory-row-2')).toBeNull();
  // One shared full round carrying the settled filter (filtered + total
  // item pages plus the choice lists): stale round A publishes nothing.
  expect(fake.getAllAsync).toHaveBeenCalledTimes(8);
  expect(initializeDatabase).toHaveBeenCalledTimes(1);
});

test('pending bootstrap rejection after a filter change errors once, retry recovers fresh', async () => {
  let rejectBootstrap!: (error: unknown) => void;
  initializeDatabase.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectBootstrap = reject;
      }),
  );
  await renderContainer();
  await act(async () => {});
  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Rice');
  // T1: let the keystroke settle past the debounce window so the
  // pending-bootstrap round already carries the current filter.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  await act(async () => {});
  expect(initializeDatabase).toHaveBeenCalledTimes(1);

  await act(async () => {
    rejectBootstrap(new Error('boot down'));
  });
  expect(await screen.findByTestId('inventory-error-message')).toBeTruthy();
  expect(screen.queryByText('boot down')).toBeNull();

  initializeDatabase.mockImplementationOnce(async () => makeFakeDb());
  await fireEvent.press(screen.getByTestId('inventory-retry'));
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '1 of 2',
  );
  expect(initializeDatabase).toHaveBeenCalledTimes(2);
});

test('bootstrap resolving after unmount issues no reads and closes nothing', async () => {
  let resolveBootstrap!: (db: unknown) => void;
  initializeDatabase.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveBootstrap = resolve as (db: unknown) => void;
      }),
  );
  const fake = makeFakeDb();
  const view = await renderContainer();
  await view.unmount();
  await act(async () => {
    resolveBootstrap(fake);
  });
  await act(async () => {});
  expect(fake.getAllAsync).not.toHaveBeenCalled();
  expect(closeAsync).not.toHaveBeenCalled();
});

test('bootstrap failure recovers through retry into ready', async () => {
  initializeDatabase.mockRejectedValueOnce(new Error('no native module'));
  await renderContainer();
  await act(async () => {});
  expect(await screen.findByTestId('inventory-error-message')).toBeTruthy();
  expect(screen.queryByTestId('inventory-count')).toBeNull();

  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await fireEvent.press(screen.getByTestId('inventory-retry'));
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '2 of 2',
  );
  expect(initializeDatabase).toHaveBeenCalledTimes(2);
});

test('read failure recovers through retry reusing the same handle', async () => {
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  await act(async () => {
    for (const call of pending.splice(0, pending.length)) {
      call.reject(new Error('FOREIGN KEY constraint failed'));
    }
  });
  expect(await screen.findByTestId('inventory-error-message')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('inventory-retry'));
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '2 of 2',
  );
  // One bootstrap for the whole lifetime: retry re-reads, never re-opens.
  expect(initializeDatabase).toHaveBeenCalledTimes(1);
});

test('out-of-order filter completion lets the latest filter win', async () => {
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '2 of 2',
  );

  // Filter A (Rice) starts but its item read stays slow. T1: each
  // keystroke settles past the debounce window so A and B are two
  // separate rounds (rapid typing without the wait would coalesce).
  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Rice');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  const roundA = pending.splice(0, pending.length);
  expect(roundA.length).toBeGreaterThan(0);

  // Filter B (Lentils) starts on top of A.
  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Lentils');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  const roundB = pending.splice(0, pending.length);
  expect(roundB.length).toBeGreaterThan(0);

  // B resolves fully while A is still in flight: B must render.
  await act(async () => {
    for (const call of roundB) call.resolve(valueFor(call));
  });
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '1 of 2',
  );
  expect(screen.getByTestId('inventory-row-2')).toBeTruthy();
  expect(screen.queryByTestId('inventory-row-1')).toBeNull();

  // A's stale completion (and a stale error) must not clobber B.
  await act(async () => {
    for (const call of roundA) call.resolve(valueFor(call));
  });
  await settle();
  expect(screen.getByTestId('inventory-row-2')).toBeTruthy();
  expect(screen.queryByTestId('inventory-error-message')).toBeNull();
  expect(initializeDatabase).toHaveBeenCalledTimes(1);
});

test('a stale read error never replaces a newer ready list', async () => {
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  await settle();

  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Rice');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  const roundA = pending.splice(0, pending.length);

  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Lentils');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  const roundB = pending.splice(0, pending.length);

  await act(async () => {
    for (const call of roundB) call.resolve(valueFor(call));
  });
  await settle();
  expect(await screen.findByTestId('inventory-row-2')).toBeTruthy();

  await act(async () => {
    for (const call of roundA) call.reject(new Error('stale read blew up'));
  });
  await settle();
  expect(screen.getByTestId('inventory-row-2')).toBeTruthy();
  expect(screen.queryByTestId('inventory-error-message')).toBeNull();
});

test('rapid rounds race safely: only the newest round renders', async () => {
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  await act(async () => {
    for (const call of pending.splice(0, pending.length)) {
      call.reject(new Error('first read failed'));
    }
  });
  expect(await screen.findByTestId('inventory-error-message')).toBeTruthy();

  // Retry starts a slow round; a search keystroke supersedes it while the
  // header controls stay interactive (loading shows skeleton, not a lock).
  await fireEvent.press(screen.getByTestId('inventory-retry'));
  await act(async () => {});
  const retried = pending.splice(0, pending.length);
  expect(retried.length).toBeGreaterThan(0);
  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Rice');
  // T1: the keystroke settles past the debounce window before its round
  // is captured as the superseding one.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  const superseding = pending.splice(0, pending.length);
  expect(superseding.length).toBeGreaterThan(0);

  await act(async () => {
    for (const call of retried) call.reject(new Error('superseded round'));
  });
  await act(async () => {
    for (const call of superseding) call.resolve(valueFor(call));
  });
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '1 of 2',
  );
  expect(screen.getByTestId('inventory-row-1')).toBeTruthy();
  expect(screen.queryByTestId('inventory-error-message')).toBeNull();
  expect(initializeDatabase).toHaveBeenCalledTimes(1);
});

test('filtered zero with a nonzero total is no-results, not first-run', async () => {
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '2 of 2',
  );

  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'quinoa');
  // T1: the keystroke settles past the debounce window before settling.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  await settle();
  expect(await screen.findByTestId('inventory-noresults-message')).toBeTruthy();
  expect(screen.queryByTestId('inventory-empty-title')).toBeNull();
  expect(screen.getByTestId('inventory-add-noresults')).toBeDisabled();
});

test('selecting a location shows its quantity with sin-stock breakdowns', async () => {
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '2 of 2',
  );

  // Fridge holds no Rice and no Lentils stock: both rows stay visible
  // (L9a), marked sin stock with the breakdown where stock exists.
  await fireEvent.press(screen.getByTestId('inventory-location-11'));
  await settle();
  expect(screen.getByTestId('inventory-row-1-quantity')).toHaveTextContent(
    /Quantity 0/,
  );
  expect(screen.getByTestId('inventory-row-1-exhausted')).toBeTruthy();
  expect(screen.getByTestId('inventory-row-1-breakdown')).toHaveTextContent(
    'Pantry 2',
  );
  expect(screen.getByTestId('inventory-row-2-exhausted')).toBeTruthy();
  expect(screen.queryByTestId('inventory-noresults-message')).toBeNull();
});

test('empty inventory stays first-run while choices render', async () => {
  store.items = [];
  store.links = [];
  store.stock = [];
  store.locations = [];
  store.categories = [];
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  await settle();
  expect(await screen.findByTestId('inventory-empty-title')).toBeTruthy();
  expect(screen.queryByTestId('inventory-noresults-message')).toBeNull();
  expect(screen.getByTestId('inventory-add-empty')).toBeDisabled();
});

test('unmount publishes nothing and never closes the app-lifetime handle', async () => {
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  const view = await renderContainer();
  await view.unmount();
  await act(async () => {
    for (const call of pending.splice(0, pending.length)) {
      call.resolve(valueFor(call));
    }
  });
  await act(async () => {});
  expect(closeAsync).not.toHaveBeenCalled();
});

test('add and open stay genuinely disabled until P4', async () => {
  // NOTE: jest-expo inlines `process.env.EXPO_OS` to the ios platform at
  // transform time, so Jest always exercises the header Add variant; the
  // Android FAB shares the same `addDisabled` flag in source and needs the
  // pending native pass (see outstanding checks). Either branch proves the
  // container passes `onAdd`/`onOpenItem` as undefined.
  initializeDatabase.mockResolvedValueOnce(makeFakeDb());
  await renderContainer();
  await settle();
  expect(await screen.findByTestId('inventory-add-header')).toBeDisabled();
  expect(screen.getByTestId('inventory-row-1')).toBeTruthy();
});

test('injected isolated bootstrap serves reads without opening production', async () => {
  const isolated = makeFakeDb();
  const bootstrap = jest.fn(
    async (): Promise<RepositoryDb> => isolated as unknown as RepositoryDb,
  );
  await render(
    <I18nextProvider i18n={i18n}>
      <InventoryContainer bootstrap={bootstrap} />
    </I18nextProvider>,
  );
  await settle();
  expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
    '2 of 2',
  );
  expect(bootstrap).toHaveBeenCalledTimes(1);
  // The default production open stays untouched when isolated.
  expect(initializeDatabase).not.toHaveBeenCalled();
  expect(isolated.getAllAsync).toHaveBeenCalled();
});

describe('U2b opt-in mutations (enableMutations)', () => {
  const repository = require('../src/inventory/itemRepository') as {
    getItem: jest.Mock;
    createItemFromDraft: jest.Mock;
    updateItemFromDraft: jest.Mock;
    deleteItem: jest.Mock;
  };

  const riceDetail = {
    id: 1,
    name: 'Rice',
    stock: [
      {
        locationId: 10,
        location: {
          id: 10,
          name: 'Pantry',
          address: null,
          created_at: 'loc-created-10',
        },
        quantity: 2,
      },
    ],
    totalQuantity: 2,
    categoryIds: [],
    categories: [],
    created_at: 'created-1',
  };

  beforeEach(() => {
    repository.getItem.mockReset();
    repository.createItemFromDraft.mockReset();
    repository.updateItemFromDraft.mockReset();
    repository.deleteItem.mockReset();
    repository.getItem.mockResolvedValue({ ...riceDetail });
    repository.createItemFromDraft.mockResolvedValue({
      ...riceDetail,
      id: 3,
      name: 'Quinoa',
    });
    repository.updateItemFromDraft.mockResolvedValue({ ...riceDetail });
    repository.deleteItem.mockResolvedValue(undefined);
  });

  async function renderMutations() {
    return render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations />
      </I18nextProvider>,
    );
  }

  async function openCreate(): Promise<void> {
    await fireEvent.press(screen.getByTestId('inventory-add-header'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
  }

  async function fillValidCreateForm(): Promise<void> {
    await fireEvent.changeText(screen.getByTestId('item-form/name'), 'Quinoa');
    // U1: the form opens prefilled with the last-used location (Pantry
    // in this seed), so its chip is already consumed — append it only
    // when it is still offered. End state is unchanged either way.
    if (screen.queryByTestId('item-form/location-10') !== null) {
      await fireEvent.press(screen.getByTestId('item-form/location-10'));
    }
    await fireEvent.changeText(
      screen.getByTestId('item-form/stock-0/quantity'),
      '1',
    );
  }

  test('Add opens the create route once the handle is ready', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();
    expect(screen.getByTestId('inventory-add-header')).not.toBeDisabled();

    await openCreate();
    expect(screen.getByText('New item')).toBeTruthy();
    expect(repository.getItem).not.toHaveBeenCalled();
    await cleanup();
  });

  test('a row open opens the edit route prefilled', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-row-1'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    expect(screen.getByTestId('item-form/name').props.value).toBe('Rice');
    expect(repository.getItem).toHaveBeenCalledWith(expect.anything(), 1);
    await cleanup();
  });

  test('after a save the list re-queries and the screen closes', async () => {
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderMutations();
    await settle();

    await openCreate();
    await fillValidCreateForm();
    const readsBefore = fake.getAllAsync.mock.calls.length;
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
    await settle();
    expect(fake.getAllAsync.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '2 of 2',
    );
    await cleanup();
  });

  test('after a delete the list re-queries and the screen closes', async () => {
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-row-1'));
    await screen.findByTestId('item-form/delete');
    const readsBefore = fake.getAllAsync.mock.calls.length;
    await fireEvent.press(screen.getByTestId('item-form/delete'));
    await screen.findByTestId('item-form-screen/delete-dialog');
    await fireEvent.press(
      screen.getByTestId('item-form-screen/delete-confirm'),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    expect(repository.deleteItem).toHaveBeenCalledWith(expect.anything(), 1);
    await settle();
    expect(fake.getAllAsync.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();
    await cleanup();
  });

  test('post-write refresh keeps the ready list visible without loading', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '2 of 2',
    );

    await openCreate();
    await fillValidCreateForm();
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    // The refresh re-read is still in flight: no full-screen loading, and
    // the previous page stays visible until the new one arrives.
    expect(screen.queryByTestId('inventory-loading')).toBeNull();
    expect(screen.getByTestId('inventory-count')).toHaveTextContent('2 of 2');
    expect(screen.getByTestId('inventory-row-1')).toBeTruthy();
    await settle();
    expect(screen.queryByTestId('inventory-loading')).toBeNull();
    expect(screen.getByTestId('inventory-count')).toHaveTextContent('2 of 2');
    await cleanup();
  });

  test('a filter change still renders loading as before', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Rice');
    // T1: loading appears once the keystroke settles past the debounce
    // window and the debounced round starts; the old page stays visible
    // through the window itself.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.getByTestId('inventory-loading')).toBeTruthy();
    await settle();
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '1 of 2',
    );
    await cleanup();
  });
});

describe('M4 transient feedback (Gap A)', () => {
  const repository = require('../src/inventory/itemRepository') as {
    getItem: jest.Mock;
    createItemFromDraft: jest.Mock;
    updateItemFromDraft: jest.Mock;
    deleteItem: jest.Mock;
  };

  const riceDetail = {
    id: 1,
    name: 'Rice',
    stock: [
      {
        locationId: 10,
        location: {
          id: 10,
          name: 'Pantry',
          address: null,
          created_at: 'loc-created-10',
        },
        quantity: 2,
      },
    ],
    totalQuantity: 2,
    categoryIds: [],
    categories: [],
    created_at: 'created-1',
  };

  beforeEach(() => {
    repository.getItem.mockReset();
    repository.createItemFromDraft.mockReset();
    repository.updateItemFromDraft.mockReset();
    repository.deleteItem.mockReset();
    repository.getItem.mockResolvedValue({ ...riceDetail });
    repository.createItemFromDraft.mockResolvedValue({
      ...riceDetail,
      id: 3,
      name: 'Quinoa',
    });
    repository.updateItemFromDraft.mockResolvedValue({ ...riceDetail });
    repository.deleteItem.mockResolvedValue(undefined);
  });

  // The jest-expo `AccessibilityInfo` mock does not survive `spyOn`
  // with stable call counts, so the announce tests below swap the
  // function by direct assignment and restore it here.
  let realAnnounce: ((message: string) => void) | null = null;

  function stubAnnounce(): jest.Mock {
    const { AccessibilityInfo } = require('react-native') as {
      AccessibilityInfo: { announceForAccessibility: (m: string) => void };
    };
    if (realAnnounce === null) {
      realAnnounce =
        AccessibilityInfo.announceForAccessibility.bind(AccessibilityInfo);
    }
    const announce = jest.fn();
    AccessibilityInfo.announceForAccessibility = announce;
    return announce;
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (realAnnounce !== null) {
      const { AccessibilityInfo } = require('react-native') as {
        AccessibilityInfo: { announceForAccessibility: (m: string) => void };
      };
      AccessibilityInfo.announceForAccessibility = realAnnounce;
      realAnnounce = null;
    }
  });

  async function renderMutations() {
    return render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations />
      </I18nextProvider>,
    );
  }

  async function openCreate(): Promise<void> {
    await fireEvent.press(screen.getByTestId('inventory-add-header'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
  }

  async function fillValidCreateForm(): Promise<void> {
    await fireEvent.changeText(screen.getByTestId('item-form/name'), 'Quinoa');
    // U1: the form opens prefilled with the last-used location (Pantry
    // in this seed), so its chip is already consumed — append it only
    // when it is still offered. End state is unchanged either way.
    if (screen.queryByTestId('item-form/location-10') !== null) {
      await fireEvent.press(screen.getByTestId('item-form/location-10'));
    }
    await fireEvent.changeText(
      screen.getByTestId('item-form/stock-0/quantity'),
      '1',
    );
  }

  test('no notice surface renders before anything happens', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();
    expect(screen.queryByTestId('inventory-notice')).toBeNull();
    await cleanup();
  });

  test('a successful save shows the saved message, announces it once, and clears after the timer', async () => {
    jest.useFakeTimers();
    const announce = stubAnnounce();
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await openCreate();
    await fillValidCreateForm();
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    const notice = await screen.findByTestId('inventory-notice');
    expect(notice).toBeTruthy();
    expect(notice.props.accessibilityRole).toBe('alert');
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item saved.',
    );
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Item saved.');

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.queryByTestId('inventory-notice')).toBeNull();
    await cleanup();
  });

  test('a successful delete shows the deleted message', async () => {
    jest.useFakeTimers();
    const announce = stubAnnounce();
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-row-1'));
    await screen.findByTestId('item-form/delete');
    await fireEvent.press(screen.getByTestId('item-form/delete'));
    await screen.findByTestId('item-form-screen/delete-dialog');
    await fireEvent.press(
      screen.getByTestId('item-form-screen/delete-confirm'),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    expect(await screen.findByTestId('inventory-notice')).toBeTruthy();
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item deleted.',
    );
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Item deleted.');
    await cleanup();
  });

  test('a second message replaces the first and restarts the timer', async () => {
    jest.useFakeTimers();
    const announce = stubAnnounce();
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await openCreate();
    await fillValidCreateForm();
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item saved.',
    );

    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.queryByTestId('inventory-notice')).toBeTruthy();

    await openCreate();
    await fillValidCreateForm();
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item saved.',
    );
    expect(announce).toHaveBeenCalledTimes(2);

    // The first timer would have fired 500ms from now; the restart keeps
    // the second message visible.
    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(screen.queryByTestId('inventory-notice')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('inventory-notice')).toBeNull();
    await cleanup();
  });

  test('the notice renders in both color schemes with a scheme-matched palette', async () => {
    // `useColorScheme` is a plain jest mock returning 'light'; drive it
    // per iteration instead of going through `Appearance`.
    const { StyleSheet, useColorScheme } = require('react-native') as {
      StyleSheet: { flatten: (style: unknown) => { backgroundColor?: string } };
      useColorScheme: jest.Mock;
    };
    const backgrounds: (string | undefined)[] = [];
    try {
      for (const colorScheme of ['light', 'dark'] as const) {
        jest.useFakeTimers();
        const announce = stubAnnounce();
        useColorScheme.mockReturnValue(colorScheme);
        initializeDatabase.mockResolvedValueOnce(makeFakeDb());
        await renderMutations();
        await settle();

        await openCreate();
        await fillValidCreateForm();
        await fireEvent.press(screen.getByTestId('item-form/save'));
        await waitFor(() =>
          expect(screen.queryByTestId('item-form/name')).toBeNull(),
        );
        const notice = await screen.findByTestId('inventory-notice');
        expect(notice.props.accessibilityRole).toBe('alert');
        expect(notice.props.pointerEvents).toBe('none');
        backgrounds.push(
          StyleSheet.flatten(notice.props.style).backgroundColor,
        );
        expect(announce).toHaveBeenCalledTimes(1);
        await cleanup();
        jest.useRealTimers();
      }
    } finally {
      useColorScheme.mockReturnValue('light');
    }
    // Both schemes resolve a concrete inverse-surface background, and
    // the two differ so the toast stays distinct from the list in each.
    expect(backgrounds).toHaveLength(2);
    expect(backgrounds[0]).toBeTruthy();
    expect(backgrounds[1]).toBeTruthy();
    expect(backgrounds[0]).not.toBe(backgrounds[1]);
  });
});

describe('Entity-management entry point (D6/S12 adopted)', () => {
  async function renderMutations() {
    return render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations />
      </I18nextProvider>,
    );
  }

  test('the manage entry point opens the entity screen once the handle is ready', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();
    expect(await screen.findByTestId('inventory-manage-entities')).toBeTruthy();
    expect(screen.getByTestId('inventory-manage-entities')).not.toBeDisabled();

    await fireEvent.press(screen.getByTestId('inventory-manage-entities'));
    expect(await screen.findByTestId('entity-manager')).toBeTruthy();
    expect(screen.getByTestId('entity-location-10')).toBeTruthy();
    expect(screen.getByTestId('entity-category-20')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('entity-close'));
    await waitFor(() =>
      expect(screen.queryByTestId('entity-manager')).toBeNull(),
    );
    await cleanup();
  });

  test('an entity write refreshes the list without blanking it', async () => {
    const fake = makeFakeDb();
    Object.assign(fake, {
      runAsync: jest.fn(async () => ({ lastInsertRowId: 99, changes: 1 })),
      getFirstAsync: jest.fn(async () => ({
        id: 99,
        name: 'Grains',
        created_at: 'cat-created-99',
      })),
    });
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderMutations();
    await settle();
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '2 of 2',
    );

    await fireEvent.press(screen.getByTestId('inventory-manage-entities'));
    await screen.findByTestId('entity-manager');
    const readsBefore = fake.getAllAsync.mock.calls.length;
    await fireEvent.changeText(
      screen.getByTestId('entity-new-category-name'),
      'Grains',
    );
    await fireEvent.press(screen.getByTestId('entity-add-category'));
    await waitFor(() =>
      expect(fake.getAllAsync.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    // The ready list stays visible through the background refresh.
    expect(screen.queryByTestId('inventory-loading')).toBeNull();
    expect(screen.getByTestId('inventory-count')).toBeTruthy();
    await settle();
    await cleanup();
  });

  test('the manage entry point stays disabled without opt-in mutations', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderContainer();
    await settle();
    const manage = await screen.findByTestId('inventory-manage-entities');
    expect(manage).toBeDisabled();
    expect(String(manage.props.accessibilityHint ?? '')).toMatch(
      /not available/i,
    );
    await cleanup();
  });
});

describe('T1 search-cost optimization (S2.1)', () => {
  function classifyCalls(
    calls: readonly unknown[][],
    fromIndex: number,
  ): { catalog: number; locations: number; categories: number } {
    let catalog = 0;
    let locations = 0;
    let categories = 0;
    for (let i = fromIndex; i < calls.length; i += 1) {
      const sql = String((calls[i] as readonly unknown[])[0] ?? '');
      if (sql.includes('FROM locations')) locations += 1;
      else if (
        sql.includes('FROM categories') &&
        !sql.includes('item_categories')
      )
        categories += 1;
      else if (sql.includes('FROM items')) catalog += 1;
    }
    return { catalog, locations, categories };
  }

  test('rapid keystrokes share one debounced filtered read without re-reading total or choices', async () => {
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderContainer();
    await settle();
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '2 of 2',
    );
    const callsBefore = fake.getAllAsync.mock.calls.length;

    // Three rapid keystrokes: q -> qui -> quinoa. Only the settled value
    // may pay for a filtered item query; the unfiltered total
    // (queryItems(db, {})) and the near-static choice lists
    // (listLocations/listCategories) must not re-fire per keystroke.
    await fireEvent.changeText(screen.getByTestId('inventory-search'), 'q');
    await fireEvent.changeText(screen.getByTestId('inventory-search'), 'qui');
    await fireEvent.changeText(
      screen.getByTestId('inventory-search'),
      'quinoa',
    );
    // Account for the debounce window before settling the reads.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await settle();

    const extra = classifyCalls(fake.getAllAsync.mock.calls, callsBefore);
    // One debounced filtered item query (a single catalog read); zero
    // total re-reads beyond it and zero choice-list re-reads.
    expect(extra.catalog).toBeLessThanOrEqual(1);
    expect(extra.locations).toBe(0);
    expect(extra.categories).toBe(0);
    // The settled query still filters: nothing matches 'quinoa'.
    expect(
      await screen.findByTestId('inventory-noresults-message'),
    ).toBeTruthy();
    await cleanup();
  });

  test('location selection stays view-only and costs zero reads', async () => {
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderContainer();
    await settle();
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '2 of 2',
    );
    const callsBefore = fake.getAllAsync.mock.calls.length;

    // Fridge holds no stock: both rows stay visible (L9a), marked sin
    // stock — with no query issued, since the location is a view only.
    await fireEvent.press(screen.getByTestId('inventory-location-11'));
    await settle();
    expect(screen.getByTestId('inventory-row-1-quantity')).toHaveTextContent(
      /Quantity 0/,
    );
    expect(screen.getByTestId('inventory-row-1-exhausted')).toBeTruthy();
    expect(screen.getByTestId('inventory-row-1-breakdown')).toHaveTextContent(
      'Pantry 2',
    );
    expect(screen.getByTestId('inventory-row-2-exhausted')).toBeTruthy();
    expect(fake.getAllAsync.mock.calls.length).toBe(callsBefore);
    await cleanup();
  });

  test('category selection still filters through the query without reloading choices', async () => {
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderContainer();
    await settle();
    const callsBefore = fake.getAllAsync.mock.calls.length;

    // No seeded links carry Bulk, so selecting it filters everything out
    // through the category OR while the total stays honest.
    await fireEvent.press(screen.getByTestId('inventory-category-20'));
    await settle();
    expect(
      await screen.findByTestId('inventory-noresults-message'),
    ).toBeTruthy();
    expect(screen.getByTestId('inventory-count')).toHaveTextContent('0 of 2');
    const extra = classifyCalls(fake.getAllAsync.mock.calls, callsBefore);
    expect(extra.locations).toBe(0);
    expect(extra.categories).toBe(0);
    await cleanup();
  });

  test('clearing the search reuses the cached unfiltered page with zero reads', async () => {
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderContainer();
    await settle();

    await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Rice');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await settle();
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '1 of 2',
    );
    const callsBefore = fake.getAllAsync.mock.calls.length;

    await fireEvent.changeText(screen.getByTestId('inventory-search'), '');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await settle();
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '2 of 2',
    );
    expect(screen.getByTestId('inventory-row-1')).toBeTruthy();
    expect(screen.getByTestId('inventory-row-2')).toBeTruthy();
    expect(fake.getAllAsync.mock.calls.length).toBe(callsBefore);
    await cleanup();
  });

  test('post-write refresh reloads the total and the choice lists', async () => {
    const repository = require('../src/inventory/itemRepository') as {
      getItem: jest.Mock;
      createItemFromDraft: jest.Mock;
      updateItemFromDraft: jest.Mock;
      deleteItem: jest.Mock;
    };
    repository.getItem.mockReset();
    repository.createItemFromDraft.mockReset();
    repository.updateItemFromDraft.mockReset();
    repository.deleteItem.mockReset();
    repository.createItemFromDraft.mockResolvedValue({
      id: 3,
      name: 'Quinoa',
      stock: [],
      totalQuantity: 0,
      categoryIds: [],
      categories: [],
      created_at: 'created-3',
    });
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations />
      </I18nextProvider>,
    );
    await settle();
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '2 of 2',
    );

    // The write adds a row, a location, and a category behind the
    // container: the background refresh must pick all three up.
    await fireEvent.press(screen.getByTestId('inventory-add-header'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('item-form/name'), 'Quinoa');
    // U1: the form opens prefilled with the last-used location (Pantry
    // in this seed), so its chip is already consumed — append it only
    // when it is still offered. End state is unchanged either way.
    if (screen.queryByTestId('item-form/location-10') !== null) {
      await fireEvent.press(screen.getByTestId('item-form/location-10'));
    }
    await fireEvent.changeText(
      screen.getByTestId('item-form/stock-0/quantity'),
      '1',
    );
    store.items = [...store.items, itemRow(3, 'Quinoa')];
    store.locations = [
      ...store.locations,
      {
        id: 12,
        name: 'Cellar',
        address: null,
        created_at: 'loc-created-12',
      },
    ];
    store.categories = [
      ...store.categories,
      { id: 21, name: 'Grains', created_at: 'cat-created-21' },
    ];
    const callsBefore = fake.getAllAsync.mock.calls.length;
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    await settle();
    const extra = classifyCalls(fake.getAllAsync.mock.calls, callsBefore);
    // The refresh re-read the total and both choice lists.
    expect(extra.catalog).toBeGreaterThan(0);
    expect(extra.locations).toBeGreaterThan(0);
    expect(extra.categories).toBeGreaterThan(0);
    expect(await screen.findByTestId('inventory-count')).toHaveTextContent(
      '3 of 3',
    );
    expect(screen.getByTestId('inventory-location-12')).toBeTruthy();
    expect(screen.getByTestId('inventory-category-21')).toBeTruthy();
    await cleanup();
  });
});

describe('U1 quick capture (last-used location prefill)', () => {
  const repository = require('../src/inventory/itemRepository') as {
    getItem: jest.Mock;
    createItemFromDraft: jest.Mock;
    updateItemFromDraft: jest.Mock;
    deleteItem: jest.Mock;
  };

  const riceDetail = {
    id: 1,
    name: 'Rice',
    stock: [
      {
        locationId: 10,
        location: {
          id: 10,
          name: 'Pantry',
          address: null,
          created_at: 'loc-created-10',
        },
        quantity: 2,
      },
    ],
    totalQuantity: 2,
    categoryIds: [],
    categories: [],
    created_at: 'created-1',
  };

  beforeEach(() => {
    repository.getItem.mockReset();
    repository.createItemFromDraft.mockReset();
    repository.updateItemFromDraft.mockReset();
    repository.deleteItem.mockReset();
    repository.getItem.mockResolvedValue({ ...riceDetail });
  });

  async function renderMutations() {
    return render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations />
      </I18nextProvider>,
    );
  }

  test('Add opens with the newest stocked location prefilled and an empty quantity', async () => {
    // Lentils (item 2) is newer than Rice (item 1): its Fridge stock is
    // the last-used location even though Rice also has stock.
    store.stock = [stockRow(1, 2, 10, 'Pantry'), stockRow(2, 1, 11, 'Fridge')];
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-add-header'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    expect(screen.getByTestId('item-form/stock-0/name')).toHaveTextContent(
      'Fridge',
    );
    expect(screen.getByTestId('item-form/stock-0/quantity').props.value).toBe(
      '',
    );
    // Exactly one prefilled row, never a second guess.
    expect(screen.queryByTestId('item-form/stock-1/name')).toBeNull();
    await cleanup();
  });

  test('a fresh database with no stock opens the blank form', async () => {
    store.stock = [];
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-add-header'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    expect(screen.queryByTestId('item-form/stock-0/name')).toBeNull();
    await cleanup();
  });

  test('a deleted location falls back to the blank form, never a stale row', async () => {
    // The only stock lived in the Pantry, which no longer exists: the
    // derived id must not render as a stale row (not even as `#10`).
    store.locations = store.locations.filter((l) => l.id !== 10);
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-add-header'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    expect(screen.queryByTestId('item-form/stock-0/name')).toBeNull();
    expect(screen.queryByText(/#10/)).toBeNull();
    await cleanup();
  });

  test('a last-used read failure still opens the blank form', async () => {
    const fake = makeFakeDb();
    (fake.getFirstAsync as jest.Mock).mockRejectedValueOnce(
      new Error('last-used read blew up'),
    );
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-add-header'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    expect(screen.queryByTestId('item-form/stock-0/name')).toBeNull();
    expect(screen.queryByText(/blew up/)).toBeNull();
    await cleanup();
  });

  test('U1 PRESERVE: edit opens the stored rows with no prefilled row', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-row-1'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    expect(screen.getByTestId('item-form/name').props.value).toBe('Rice');
    // Exactly the stored breakdown: one Pantry row at quantity 2.
    expect(screen.getByTestId('item-form/stock-0/name')).toHaveTextContent(
      'Pantry',
    );
    expect(screen.getByTestId('item-form/stock-0/quantity').props.value).toBe(
      '2',
    );
    expect(screen.queryByTestId('item-form/stock-1/name')).toBeNull();
    await cleanup();
  });
});

describe('U3 barcode scan entry (scan to find or create)', () => {
  const cameraMocks = require('expo-camera') as {
    useCameraPermissions: jest.Mock;
  };
  const repository = require('../src/inventory/itemRepository') as {
    getItem: jest.Mock;
    findItemByBarcode: jest.Mock;
  };

  const riceDetail = {
    id: 1,
    name: 'Rice',
    stock: [
      {
        locationId: 10,
        location: {
          id: 10,
          name: 'Pantry',
          address: null,
          created_at: 'loc-created-10',
        },
        quantity: 2,
      },
    ],
    totalQuantity: 2,
    categoryIds: [],
    categories: [],
    created_at: 'created-1',
  };

  beforeEach(() => {
    repository.getItem.mockReset();
    repository.findItemByBarcode.mockReset();
    repository.getItem.mockResolvedValue({ ...riceDetail });
    repository.findItemByBarcode.mockResolvedValue(null);
    cameraMocks.useCameraPermissions.mockReturnValue([
      { granted: true, canAskAgain: true },
      jest.fn(async () => ({ granted: true })),
    ]);
  });

  async function renderMutations() {
    return render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations />
      </I18nextProvider>,
    );
  }

  async function emitContainerScan(data: string): Promise<void> {
    const camera = await screen.findByTestId('scan-camera');
    await act(async () => {
      await (
        camera.props as {
          onBarcodeScanned: (event: { data: string }) => void;
        }
      ).onBarcodeScanned({ data });
    });
  }

  test('the scan entry stays disabled without opt-in mutations', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderContainer();
    await settle();
    const scan = await screen.findByTestId('inventory-scan-open');
    expect(scan).toBeDisabled();
    expect(String(scan.props.accessibilityHint ?? '')).toMatch(
      /not available/i,
    );
    await cleanup();
  });

  test('the scan entry opens the scanner once the handle is ready', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();
    expect(screen.getByTestId('inventory-scan-open')).not.toBeDisabled();

    await fireEvent.press(screen.getByTestId('inventory-scan-open'));
    expect(await screen.findByTestId('scan-screen')).toBeTruthy();
    expect(screen.getByTestId('scan-camera')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('scan-close'));
    await waitFor(() => expect(screen.queryByTestId('scan-screen')).toBeNull());
    await cleanup();
  });

  test('a known scan opens that item for edit', async () => {
    repository.findItemByBarcode.mockResolvedValueOnce({ ...riceDetail });
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-scan-open'));
    await emitContainerScan('ABC-1234');
    expect(repository.findItemByBarcode).toHaveBeenCalledTimes(1);
    // The scanner closes and the edit route opens prefilled.
    await waitFor(() => expect(screen.queryByTestId('scan-screen')).toBeNull());
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    expect(screen.getByTestId('item-form/name').props.value).toBe('Rice');
    expect(repository.getItem).toHaveBeenCalledWith(expect.anything(), 1);
    await cleanup();
  });

  test('an unknown scan opens the create route', async () => {
    repository.findItemByBarcode.mockResolvedValueOnce(null);
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-scan-open'));
    await emitContainerScan('ZZZ-9999');
    await waitFor(() => expect(screen.queryByTestId('scan-screen')).toBeNull());
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    expect(screen.getByText('New item')).toBeTruthy();
    await cleanup();
  });

  test('U3 RED: an unknown scan carries the code into the created item', async () => {
    const mutations = require('../src/inventory/itemRepository') as {
      createItemFromDraft: jest.Mock;
    };
    mutations.createItemFromDraft.mockReset();
    mutations.createItemFromDraft.mockResolvedValue({
      id: 3,
      name: 'Scanned beans',
      stock: [],
      totalQuantity: 0,
      categoryIds: [],
      categories: [],
      created_at: 'created-3',
      barcode: 'ZZZ-9999',
    });
    repository.findItemByBarcode.mockResolvedValueOnce(null);
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settle();

    await fireEvent.press(screen.getByTestId('inventory-scan-open'));
    await emitContainerScan('ZZZ-9999');
    await waitFor(() => expect(screen.queryByTestId('scan-screen')).toBeNull());
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('item-form/name'),
      'Scanned beans',
    );
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(mutations.createItemFromDraft).toHaveBeenCalledTimes(1),
    );
    const draft = mutations.createItemFromDraft.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(draft.barcode).toBe('ZZZ-9999');
    await cleanup();
  });
});

describe('U4 local reminders (S4: entirely on device)', () => {
  const repository = require('../src/inventory/itemRepository') as {
    getItem: jest.Mock;
    createItemFromDraft: jest.Mock;
    updateItemFromDraft: jest.Mock;
    deleteItem: jest.Mock;
  };
  const Notifications = require('expo-notifications') as {
    getPermissionsAsync: jest.Mock;
    requestPermissionsAsync: jest.Mock;
    scheduleNotificationAsync: jest.Mock;
    cancelScheduledNotificationAsync: jest.Mock;
  };
  const { expiryNotificationKey } =
    require('../src/notifications/reminders') as {
      expiryNotificationKey: (itemId: number, locationId: number) => string;
    };

  const pantry = {
    id: 10,
    name: 'Pantry',
    address: null,
    created_at: 'loc-created-10',
  };

  function riceDetailWith(quantity: number, expiresOn: string | null) {
    return {
      id: 1,
      name: 'Rice',
      lowStockThreshold: 2,
      barcode: null,
      stock: [
        {
          locationId: 10,
          location: { ...pantry },
          quantity,
          expiresOn,
        },
      ],
      totalQuantity: quantity,
      categoryIds: [],
      categories: [],
      created_at: 'created-1',
    };
  }

  function grantNotifications(): void {
    Notifications.getPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });
    Notifications.requestPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });
  }

  function denyNotifications(): void {
    Notifications.getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });
    Notifications.requestPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });
  }

  function clearNotificationCalls(): void {
    Notifications.scheduleNotificationAsync.mockClear();
    Notifications.cancelScheduledNotificationAsync.mockClear();
  }

  function immediateCalls(): unknown[][] {
    return Notifications.scheduleNotificationAsync.mock.calls.filter(
      ([request]) => (request as { trigger: unknown }).trigger === null,
    );
  }

  async function renderMutations() {
    return render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations />
      </I18nextProvider>,
    );
  }

  // The reminder hook reads permission asynchronously after the handle
  // arms: settle the list, then drain the permission effect before any
  // save/delete, so `afterSave`/`afterDelete` observe the stubbed grant
  // instead of racing it.
  async function settleWithPermission(): Promise<void> {
    await settle();
    await waitFor(() =>
      expect(Notifications.getPermissionsAsync).toHaveBeenCalled(),
    );
    await act(async () => {});
    await act(async () => {});
  }

  async function openRiceForEdit(): Promise<void> {
    await fireEvent.press(screen.getByTestId('inventory-row-1'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
  }

  beforeEach(() => {
    repository.getItem.mockReset();
    repository.createItemFromDraft.mockReset();
    repository.updateItemFromDraft.mockReset();
    repository.deleteItem.mockReset();
    repository.deleteItem.mockResolvedValue(undefined);
    Notifications.getPermissionsAsync.mockReset();
    Notifications.requestPermissionsAsync.mockReset();
    Notifications.scheduleNotificationAsync.mockReset();
    Notifications.cancelScheduledNotificationAsync.mockReset();
    Notifications.scheduleNotificationAsync.mockResolvedValue('scheduled-id');
    Notifications.cancelScheduledNotificationAsync.mockResolvedValue(undefined);
  });

  test('a crossing save pings once, reschedules expiry, and still refreshes with notice', async () => {
    // List state: Rice above its threshold (5 > 2) with a dated row.
    store.items = [itemRow(1, 'Rice', 2)];
    store.stock = [stockRow(1, 5, 10, 'Pantry', '2030-04-15')];
    grantNotifications();
    repository.getItem.mockResolvedValue(riceDetailWith(5, '2030-04-15'));
    // NOTE: the persisted detail is the repository's answer for the
    // save, stood in by the mock; the container notifies on exactly
    // what persistence reports (see the U2-form risk in the report).
    repository.updateItemFromDraft.mockResolvedValue(
      riceDetailWith(1, '2030-06-01'),
    );
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settleWithPermission();
    clearNotificationCalls();

    await openRiceForEdit();
    await fireEvent.changeText(
      screen.getByTestId('item-form/stock-0/quantity'),
      '1',
    );
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );

    // The 5 -> 1 crossing fires exactly one immediate ping naming Rice.
    await waitFor(() => expect(immediateCalls()).toHaveLength(1));
    expect(
      (immediateCalls()[0][0] as { content: { body: string } }).content.body,
    ).toMatch(/Rice/);
    // Expiry reschedules under the deterministic row key: the old date
    // cancels (no orphan) and the new date schedules.
    await waitFor(() =>
      expect(
        Notifications.cancelScheduledNotificationAsync,
      ).toHaveBeenCalledWith(expiryNotificationKey(1, 10)),
    );
    const dated = Notifications.scheduleNotificationAsync.mock.calls.filter(
      ([request]) => (request as { trigger: unknown }).trigger !== null,
    );
    expect(dated).toHaveLength(1);
    expect((dated[0][0] as { identifier: string }).identifier).toBe(
      expiryNotificationKey(1, 10),
    );
    // The ordinary post-write behavior is unchanged: refresh plus saved
    // notice, exactly as the U2b/M4 suites prove.
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item saved.',
    );
    await cleanup();
  });

  test('re-saving an already-low item schedules no immediate ping', async () => {
    store.items = [itemRow(1, 'Rice', 2)];
    store.stock = [stockRow(1, 1, 10, 'Pantry')];
    grantNotifications();
    repository.getItem.mockResolvedValue(riceDetailWith(1, null));
    repository.updateItemFromDraft.mockResolvedValue(riceDetailWith(1, null));
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settleWithPermission();
    clearNotificationCalls();

    await openRiceForEdit();
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    await settle();
    expect(immediateCalls()).toHaveLength(0);
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item saved.',
    );
    await cleanup();
  });

  test('deleting cancels the item rows and schedules nothing', async () => {
    store.items = [itemRow(1, 'Rice', 2)];
    store.stock = [stockRow(1, 5, 10, 'Pantry', '2030-04-15')];
    grantNotifications();
    repository.getItem.mockResolvedValue(riceDetailWith(5, '2030-04-15'));
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settleWithPermission();
    clearNotificationCalls();

    await openRiceForEdit();
    await fireEvent.press(screen.getByTestId('item-form/delete'));
    await screen.findByTestId('item-form-screen/delete-dialog');
    await fireEvent.press(
      screen.getByTestId('item-form-screen/delete-confirm'),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );

    await waitFor(() =>
      expect(
        Notifications.cancelScheduledNotificationAsync,
      ).toHaveBeenCalledWith(expiryNotificationKey(1, 10)),
    );
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    await settle();
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item deleted.',
    );
    await cleanup();
  });

  test('denied permission: saves and deletes keep working with zero scheduling traffic', async () => {
    store.items = [itemRow(1, 'Rice', 2)];
    store.stock = [stockRow(1, 5, 10, 'Pantry', '2030-04-15')];
    denyNotifications();
    repository.getItem.mockResolvedValue(riceDetailWith(5, '2030-04-15'));
    repository.updateItemFromDraft.mockResolvedValue(
      riceDetailWith(1, '2030-06-01'),
    );
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settleWithPermission();
    clearNotificationCalls();

    // A crossing save under denial: no ping, no schedule, no cancel —
    // but the refresh and the saved notice behave exactly as ever.
    await openRiceForEdit();
    await fireEvent.changeText(
      screen.getByTestId('item-form/stock-0/quantity'),
      '1',
    );
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    await settle();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(
      Notifications.cancelScheduledNotificationAsync,
    ).not.toHaveBeenCalled();
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item saved.',
    );

    // And the delete path is equally unaffected.
    await openRiceForEdit();
    await fireEvent.press(screen.getByTestId('item-form/delete'));
    await screen.findByTestId('item-form-screen/delete-dialog');
    await fireEvent.press(
      screen.getByTestId('item-form-screen/delete-confirm'),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );
    await settle();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(
      Notifications.cancelScheduledNotificationAsync,
    ).not.toHaveBeenCalled();
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Item deleted.',
    );
    await cleanup();
  });
});

describe('U4 form side (edit carries threshold and expiry into the draft)', () => {
  const repository = require('../src/inventory/itemRepository') as {
    getItem: jest.Mock;
    createItemFromDraft: jest.Mock;
    updateItemFromDraft: jest.Mock;
    deleteItem: jest.Mock;
  };
  const Notifications = require('expo-notifications') as {
    getPermissionsAsync: jest.Mock;
    requestPermissionsAsync: jest.Mock;
    scheduleNotificationAsync: jest.Mock;
    cancelScheduledNotificationAsync: jest.Mock;
  };

  const pantry = {
    id: 10,
    name: 'Pantry',
    address: null,
    created_at: 'loc-created-10',
  };

  function riceDetailWithReminders(quantity: number, expiresOn: string | null) {
    return {
      id: 1,
      name: 'Rice',
      lowStockThreshold: 2,
      barcode: null,
      stock: [
        {
          locationId: 10,
          location: { ...pantry },
          quantity,
          expiresOn,
        },
      ],
      totalQuantity: quantity,
      categoryIds: [],
      categories: [],
      created_at: 'created-1',
    };
  }

  async function renderMutations() {
    return render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations />
      </I18nextProvider>,
    );
  }

  async function settleWithPermission(): Promise<void> {
    await settle();
    await waitFor(() =>
      expect(Notifications.getPermissionsAsync).toHaveBeenCalled(),
    );
    await act(async () => {});
    await act(async () => {});
  }

  beforeEach(() => {
    repository.getItem.mockReset();
    repository.createItemFromDraft.mockReset();
    repository.updateItemFromDraft.mockReset();
    repository.deleteItem.mockReset();
    repository.deleteItem.mockResolvedValue(undefined);
    Notifications.getPermissionsAsync.mockReset();
    Notifications.requestPermissionsAsync.mockReset();
    Notifications.scheduleNotificationAsync.mockReset();
    Notifications.cancelScheduledNotificationAsync.mockReset();
    Notifications.scheduleNotificationAsync.mockResolvedValue('scheduled-id');
    Notifications.cancelScheduledNotificationAsync.mockResolvedValue(undefined);
  });

  test('REGRESSION U4b: an untouched edit preserves the threshold and expiry in the update draft', async () => {
    // The reported data-loss bug at the integrated level: the form used
    // to write its draft verbatim without either reminder value, so an
    // edit silently wiped both. The mock stands in for persistence and
    // answers the saved detail; the assertion is on the draft the real
    // controller built, which is what the repository would have stored.
    store.items = [itemRow(1, 'Rice', 2)];
    store.stock = [stockRow(1, 5, 10, 'Pantry', '2030-04-15')];
    Notifications.getPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });
    Notifications.requestPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    });
    repository.getItem.mockResolvedValue(
      riceDetailWithReminders(5, '2030-04-15'),
    );
    repository.updateItemFromDraft.mockResolvedValue(
      riceDetailWithReminders(5, '2030-04-15'),
    );
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderMutations();
    await settleWithPermission();

    await fireEvent.press(screen.getByTestId('inventory-row-1'));
    expect(await screen.findByTestId('item-form/name')).toBeTruthy();
    // The carried values are visible in the form before the save.
    expect(screen.getByTestId('item-form/threshold').props.value).toBe('2');
    expect(screen.getByText('2030-04-15')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('item-form/save'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-form/name')).toBeNull(),
    );

    expect(repository.updateItemFromDraft).toHaveBeenCalledTimes(1);
    const draft = repository.updateItemFromDraft.mock.calls[0][2] as Record<
      string,
      unknown
    >;
    expect(draft.lowStockThreshold).toBe(2);
    expect((draft.stock as { expiresOn?: string | null }[])[0]?.expiresOn).toBe(
      '2030-04-15',
    );
    await cleanup();
  });
});

describe('U6 export/import entry points (transfer)', () => {
  const transferDoc = JSON.stringify({
    format: 'tengo-inventory',
    version: 1,
    exportedAt: '2026-10-14T00:00:00.000Z',
    locations: [{ name: 'Pantry', address: null }],
    categories: [{ name: 'Bulk' }],
    items: [
      {
        name: 'Rice',
        barcode: null,
        lowStockThreshold: null,
        categories: ['Bulk'],
        stock: [{ location: 'Pantry', quantity: 2, expiresOn: null }],
      },
    ],
  });

  interface TransferTestDeps {
    writeExportFile: jest.Mock;
    shareExportFile: jest.Mock;
    pickImportFile: jest.Mock;
    buildDocument: jest.Mock;
    applyDocument: jest.Mock;
    listDetails: jest.Mock;
  }

  const TransferNotifications = require('expo-notifications') as {
    getPermissionsAsync: jest.Mock;
    requestPermissionsAsync: jest.Mock;
    scheduleNotificationAsync: jest.Mock;
    cancelScheduledNotificationAsync: jest.Mock;
  };

  function transferDeps(
    overrides: Partial<TransferTestDeps> = {},
  ): TransferTestDeps {
    return {
      writeExportFile: jest.fn(async () => 'file:///export.json'),
      shareExportFile: jest.fn(async () => {}),
      pickImportFile: jest.fn(async () => transferDoc),
      buildDocument: jest.fn(async () => JSON.parse(transferDoc)),
      applyDocument: jest.fn(async () => ({
        locations: 1,
        categories: 1,
        items: 1,
        stockRows: 1,
      })),
      listDetails: jest.fn(async () => []),
      ...overrides,
    };
  }

  // Reminder-native stubs are hermetic per test: the wiring test arms a
  // grant, and this reset returns every transfer test to the bare
  // (permission-undetermined, silent) boundary afterwards.
  beforeEach(() => {
    TransferNotifications.getPermissionsAsync.mockReset();
    TransferNotifications.requestPermissionsAsync.mockReset();
    TransferNotifications.scheduleNotificationAsync.mockReset();
    TransferNotifications.cancelScheduledNotificationAsync.mockReset();
    TransferNotifications.scheduleNotificationAsync.mockResolvedValue(
      'scheduled-id',
    );
    TransferNotifications.cancelScheduledNotificationAsync.mockResolvedValue(
      undefined,
    );
  });

  async function renderTransfer(deps: TransferTestDeps) {
    return render(
      <I18nextProvider i18n={i18n}>
        <InventoryContainer enableMutations transferDeps={deps} />
      </I18nextProvider>,
    );
  }

  test('export and import entries render enabled once the handle is ready', async () => {
    const deps = transferDeps();
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderTransfer(deps);
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();
    const exportButton = screen.getByTestId('inventory-export');
    const importButton = screen.getByTestId('inventory-import');
    expect(exportButton).not.toBeDisabled();
    expect(importButton).not.toBeDisabled();
    expect(exportButton.props.accessibilityRole).toBe('button');
    expect(importButton.props.accessibilityRole).toBe('button');
    expect(String(exportButton.props.accessibilityLabel ?? '')).toMatch(
      /export/i,
    );
    expect(String(importButton.props.accessibilityLabel ?? '')).toMatch(
      /import/i,
    );
    await cleanup();
  });

  test('export writes the versioned file, shares it, and shows the exported notice', async () => {
    const deps = transferDeps();
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderTransfer(deps);
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('inventory-export'));
    await waitFor(() => expect(deps.buildDocument).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(deps.shareExportFile).toHaveBeenCalledTimes(1));
    // The shared file is the versioned JSON document.
    const written = String(deps.writeExportFile.mock.calls[0][1] ?? '');
    expect(JSON.parse(written)).toMatchObject({
      format: 'tengo-inventory',
      version: 1,
    });
    expect(deps.shareExportFile.mock.calls[0][0]).toBe('file:///export.json');
    expect(await screen.findByTestId('inventory-notice')).toBeTruthy();
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Inventory exported.',
    );
    await cleanup();
  });

  test('import applies the picked file, refreshes the list, and shows the imported notice', async () => {
    const deps = transferDeps();
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderTransfer(deps);
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();
    const readsBefore = fake.getAllAsync.mock.calls.length;

    await fireEvent.press(screen.getByTestId('inventory-import'));
    await waitFor(() => expect(deps.pickImportFile).toHaveBeenCalledTimes(1));
    // U6 destructive-action gate: the staged file applies only on confirm.
    await screen.findByTestId('inventory-import-confirm-dialog');
    await fireEvent.press(
      screen.getByTestId('inventory-import-confirm-confirm'),
    );
    await waitFor(() => expect(deps.applyDocument).toHaveBeenCalledTimes(1));
    expect(deps.applyDocument.mock.calls[0][1]).toMatchObject({
      format: 'tengo-inventory',
      version: 1,
    });
    // The post-import refresh re-reads through the same handle.
    await waitFor(() =>
      expect(fake.getAllAsync.mock.calls.length).toBeGreaterThan(readsBefore),
    );
    expect(await screen.findByTestId('inventory-notice')).toBeTruthy();
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'Inventory imported.',
    );
    await cleanup();
  });

  test('a refused import shows the typed reason and leaves the list alone', async () => {
    const deps = transferDeps({
      pickImportFile: jest.fn(async () => '{"format":"tengo-inventory"}'),
    });
    const fake = makeFakeDb();
    initializeDatabase.mockResolvedValueOnce(fake);
    await renderTransfer(deps);
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('inventory-import'));
    await waitFor(() => expect(deps.pickImportFile).toHaveBeenCalledTimes(1));
    expect(deps.applyDocument).not.toHaveBeenCalled();
    expect(await screen.findByTestId('inventory-notice')).toBeTruthy();
    expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
      'This file is not a valid inventory export.',
    );
    // The ready list stays visible: no loading, no error.
    expect(screen.queryByTestId('inventory-loading')).toBeNull();
    expect(screen.getByTestId('inventory-count')).toBeTruthy();
    await cleanup();
  });

  test('a cancelled pick is silent: no notice, no apply', async () => {
    const deps = transferDeps({
      pickImportFile: jest.fn(async () => null),
    });
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderTransfer(deps);
    await settle();
    expect(await screen.findByTestId('inventory-count')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('inventory-import'));
    await waitFor(() => expect(deps.pickImportFile).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(deps.applyDocument).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inventory-notice')).toBeNull();
    await cleanup();
  });

  test('the transfer entries stay disabled without opt-in mutations', async () => {
    initializeDatabase.mockResolvedValueOnce(makeFakeDb());
    await renderContainer();
    await settle();
    const exportButton = await screen.findByTestId('inventory-export');
    const importButton = screen.getByTestId('inventory-import');
    expect(exportButton).toBeDisabled();
    expect(importButton).toBeDisabled();
    expect(String(exportButton.props.accessibilityHint ?? '')).toMatch(
      /not available/i,
    );
    await cleanup();
  });

  describe('import confirmation (destructive-action gate)', () => {
    test('a confirmed import cancels stale reminder keys and schedules the imported ones', async () => {
      // Import replaces every id: the pre-import row key must cancel
      // and the imported rows must schedule under their new ids.
      const prevDetail = {
        id: 1,
        name: 'Rice',
        lowStockThreshold: 2,
        barcode: null,
        stock: [
          {
            locationId: 10,
            location: {
              id: 10,
              name: 'Pantry',
              address: null,
              created_at: 'loc-created-10',
            },
            quantity: 5,
            expiresOn: '2030-04-15',
          },
        ],
        totalQuantity: 5,
        categoryIds: [],
        categories: [],
        created_at: 'created-1',
      };
      const nextDetail = {
        id: 7,
        name: 'Rice',
        lowStockThreshold: 2,
        barcode: null,
        stock: [
          {
            locationId: 20,
            location: {
              id: 20,
              name: 'Cellar',
              address: null,
              created_at: 'loc-created-20',
            },
            quantity: 1,
            expiresOn: '2031-06-01',
          },
        ],
        totalQuantity: 1,
        categoryIds: [],
        categories: [],
        created_at: 'created-7',
      };
      const deps = transferDeps({
        listDetails: jest
          .fn()
          .mockResolvedValueOnce([prevDetail])
          .mockResolvedValueOnce([nextDetail]),
      });
      TransferNotifications.getPermissionsAsync.mockResolvedValue({
        granted: true,
        canAskAgain: true,
      });
      TransferNotifications.requestPermissionsAsync.mockResolvedValue({
        granted: true,
        canAskAgain: true,
      });
      initializeDatabase.mockResolvedValueOnce(makeFakeDb());
      await renderTransfer(deps);
      await settle();
      await waitFor(() =>
        expect(TransferNotifications.getPermissionsAsync).toHaveBeenCalled(),
      );
      await act(async () => {});
      await act(async () => {});
      TransferNotifications.scheduleNotificationAsync.mockClear();
      TransferNotifications.cancelScheduledNotificationAsync.mockClear();
      expect(await screen.findByTestId('inventory-count')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('inventory-import'));
      await screen.findByTestId('inventory-import-confirm-dialog');
      await fireEvent.press(
        screen.getByTestId('inventory-import-confirm-confirm'),
      );
      await waitFor(() => expect(deps.applyDocument).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(
          TransferNotifications.cancelScheduledNotificationAsync,
        ).toHaveBeenCalledWith('tengo-expiry-1-10'),
      );
      const scheduled =
        TransferNotifications.scheduleNotificationAsync.mock.calls;
      expect(
        scheduled.some(
          ([request]) => (request as { trigger: unknown }).trigger === null,
        ),
      ).toBe(true);
      expect(
        scheduled.some(
          ([request]) =>
            (request as { identifier?: string }).identifier ===
            'tengo-expiry-7-20',
        ),
      ).toBe(true);
      await cleanup();
    });

    test('a picker failure surfaces the import-failed notice while cancel stays silent', async () => {
      const deps = transferDeps({
        pickImportFile: jest.fn(async () => {
          throw new Error('document picker blew up');
        }),
      });
      initializeDatabase.mockResolvedValueOnce(makeFakeDb());
      await renderTransfer(deps);
      await settle();
      expect(await screen.findByTestId('inventory-count')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('inventory-import'));
      await waitFor(() => expect(deps.pickImportFile).toHaveBeenCalledTimes(1));
      // A throwing picker is a failure (localized notice), never
      // silence and never raw text; nothing is staged or applied.
      expect(await screen.findByTestId('inventory-notice')).toBeTruthy();
      expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
        'Could not import the inventory. Please try again.',
      );
      expect(
        screen.queryByTestId('inventory-import-confirm-dialog'),
      ).toBeNull();
      expect(deps.applyDocument).not.toHaveBeenCalled();
      await cleanup();
    });

    test('a staged import asks for confirmation naming the impact before applying', async () => {
      const deps = transferDeps();
      initializeDatabase.mockResolvedValueOnce(makeFakeDb());
      await renderTransfer(deps);
      await settle();
      expect(await screen.findByTestId('inventory-count')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('inventory-import'));
      await waitFor(() => expect(deps.pickImportFile).toHaveBeenCalledTimes(1));
      // The file is staged, not applied: no write, no notice yet.
      const dialog = await screen.findByTestId(
        'inventory-import-confirm-dialog',
      );
      expect(dialog).toBeTruthy();
      expect(dialog.props.accessibilityRole).toBe('alert');
      expect(
        screen.getByTestId('inventory-import-confirm-title'),
      ).toHaveTextContent('Replace your inventory?');
      expect(
        screen.getByTestId('inventory-import-confirm-message'),
      ).toHaveTextContent(/cannot be undone/);
      // Singular counts read correctly (the app's One/Other pattern).
      expect(
        screen.getByTestId('inventory-import-confirm-message'),
      ).toHaveTextContent(/1 location,/);
      expect(
        screen.getByTestId('inventory-import-confirm-message'),
      ).toHaveTextContent(/1 category,/);
      expect(
        screen.getByTestId('inventory-import-confirm-message'),
      ).toHaveTextContent(/1 item\./);
      expect(deps.applyDocument).not.toHaveBeenCalled();
      expect(screen.queryByTestId('inventory-notice')).toBeNull();
      await cleanup();
    });

    test('plural counts read correctly for many', async () => {
      const pluralDoc = JSON.stringify({
        format: 'tengo-inventory',
        version: 1,
        exportedAt: '2026-10-14T00:00:00.000Z',
        locations: [
          { name: 'Pantry', address: null },
          { name: 'Cellar', address: null },
        ],
        categories: [{ name: 'Bulk' }, { name: 'Grains' }],
        items: [
          {
            name: 'Rice',
            barcode: null,
            lowStockThreshold: null,
            categories: ['Bulk'],
            stock: [{ location: 'Pantry', quantity: 2, expiresOn: null }],
          },
          {
            name: 'Beans',
            barcode: null,
            lowStockThreshold: null,
            categories: ['Grains'],
            stock: [{ location: 'Cellar', quantity: 1, expiresOn: null }],
          },
          {
            name: 'Lentils',
            barcode: null,
            lowStockThreshold: null,
            categories: [],
            stock: [],
          },
        ],
      });
      const deps = transferDeps({
        pickImportFile: jest.fn(async () => pluralDoc),
      });
      initializeDatabase.mockResolvedValueOnce(makeFakeDb());
      await renderTransfer(deps);
      await settle();
      expect(await screen.findByTestId('inventory-count')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('inventory-import'));
      await screen.findByTestId('inventory-import-confirm-dialog');
      expect(
        screen.getByTestId('inventory-import-confirm-message'),
      ).toHaveTextContent(/2 locations,/);
      expect(
        screen.getByTestId('inventory-import-confirm-message'),
      ).toHaveTextContent(/2 categories,/);
      expect(
        screen.getByTestId('inventory-import-confirm-message'),
      ).toHaveTextContent(/3 items\./);
      expect(deps.applyDocument).not.toHaveBeenCalled();
      await cleanup();
    });

    test('confirming the dialog applies the whole staged file', async () => {
      const deps = transferDeps();
      const fake = makeFakeDb();
      initializeDatabase.mockResolvedValueOnce(fake);
      await renderTransfer(deps);
      await settle();
      expect(await screen.findByTestId('inventory-count')).toBeTruthy();
      const readsBefore = fake.getAllAsync.mock.calls.length;

      await fireEvent.press(screen.getByTestId('inventory-import'));
      await screen.findByTestId('inventory-import-confirm-dialog');
      expect(deps.applyDocument).not.toHaveBeenCalled();

      await fireEvent.press(
        screen.getByTestId('inventory-import-confirm-confirm'),
      );
      await waitFor(() => expect(deps.applyDocument).toHaveBeenCalledTimes(1));
      expect(deps.applyDocument.mock.calls[0][1]).toMatchObject({
        format: 'tengo-inventory',
        version: 1,
      });
      // The post-import refresh re-reads through the same handle.
      await waitFor(() =>
        expect(fake.getAllAsync.mock.calls.length).toBeGreaterThan(readsBefore),
      );
      expect(await screen.findByTestId('inventory-notice')).toBeTruthy();
      expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
        'Inventory imported.',
      );
      expect(
        screen.queryByTestId('inventory-import-confirm-dialog'),
      ).toBeNull();
      await cleanup();
    });

    test('cancelling the dialog applies nothing and leaves every count unchanged', async () => {
      const deps = transferDeps();
      const fake = makeFakeDb();
      initializeDatabase.mockResolvedValueOnce(fake);
      await renderTransfer(deps);
      await settle();
      expect(await screen.findByTestId('inventory-count')).toBeTruthy();
      const storedBefore = JSON.stringify(store);
      const readsBefore = fake.getAllAsync.mock.calls.length;

      await fireEvent.press(screen.getByTestId('inventory-import'));
      await screen.findByTestId('inventory-import-confirm-dialog');
      expect(deps.applyDocument).not.toHaveBeenCalled();

      await fireEvent.press(
        screen.getByTestId('inventory-import-confirm-cancel'),
      );
      await waitFor(() =>
        expect(
          screen.queryByTestId('inventory-import-confirm-dialog'),
        ).toBeNull(),
      );
      // Refused confirmation: no apply, no notice, no refresh, no writes —
      // locations, categories, items and stock rows all untouched.
      expect(deps.applyDocument).not.toHaveBeenCalled();
      expect(screen.queryByTestId('inventory-notice')).toBeNull();
      expect(fake.getAllAsync.mock.calls.length).toBe(readsBefore);
      expect(JSON.stringify(store)).toBe(storedBefore);
      expect(screen.getByTestId('inventory-count')).toBeTruthy();
      await cleanup();
    });

    test('an unparseable file refuses before any confirmation', async () => {
      const deps = transferDeps({
        pickImportFile: jest.fn(async () => '{"format":"tengo-inventory"}'),
      });
      initializeDatabase.mockResolvedValueOnce(makeFakeDb());
      await renderTransfer(deps);
      await settle();
      expect(await screen.findByTestId('inventory-count')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('inventory-import'));
      await waitFor(() => expect(deps.pickImportFile).toHaveBeenCalledTimes(1));
      expect(await screen.findByTestId('inventory-notice')).toBeTruthy();
      expect(screen.getByTestId('inventory-notice-text')).toHaveTextContent(
        'This file is not a valid inventory export.',
      );
      expect(
        screen.queryByTestId('inventory-import-confirm-dialog'),
      ).toBeNull();
      expect(deps.applyDocument).not.toHaveBeenCalled();
      await cleanup();
    });
  });
});
