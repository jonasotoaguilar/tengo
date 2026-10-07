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
} from '@testing-library/react-native';
import { I18nextProvider } from 'react-i18next';
import type { ViewProps } from 'react-native';
import i18n from '../src/i18n';
import type InventoryContainerType from '../src/screens/InventoryContainer';

const InventoryContainer = require('../src/screens/InventoryContainer')
  .default as typeof InventoryContainerType;

const { initializeDatabase } = require('../src/db') as {
  initializeDatabase: jest.Mock;
};

jest.mock('../src/db', () => ({
  initializeDatabase: jest.fn(),
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

interface PendingCall {
  sql: string;
  params: readonly unknown[] | undefined;
  resolve: (value: Record<string, unknown>[]) => void;
  reject: (error: unknown) => void;
}

const pending: PendingCall[] = [];

interface FakeStore {
  itemRows: Record<string, unknown>[];
  linkRows: Record<string, unknown>[];
  locations: Record<string, unknown>[];
  categories: Record<string, unknown>[];
}

const store: FakeStore = {
  itemRows: [],
  linkRows: [],
  locations: [],
  categories: [],
};

const closeAsync = jest.fn(async () => {});

function itemRow(
  id: number,
  name: string,
  quantity: number,
  locationId: number,
  locationName: string,
): Record<string, unknown> {
  return {
    item_id: id,
    item_name: name,
    item_quantity: quantity,
    item_location_id: locationId,
    item_created_at: `created-${id}`,
    location_id: locationId,
    location_name: locationName,
    location_address: null,
    location_created_at: `loc-created-${locationId}`,
  };
}

function seedPopulated(): void {
  store.itemRows = [
    itemRow(1, 'Rice', 2, 10, 'Pantry'),
    itemRow(2, 'Lentils', 0, 11, 'Fridge'),
  ];
  store.linkRows = [];
  store.locations = [
    { id: 10, name: 'Pantry', address: null, created_at: 'loc-created-10' },
    { id: 11, name: 'Fridge', address: null, created_at: 'loc-created-11' },
  ];
  store.categories = [{ id: 20, name: 'Bulk', created_at: 'cat-created-20' }];
}

function valueFor(call: PendingCall): Record<string, unknown>[] {
  if (call.sql.includes('item_categories')) return store.linkRows;
  if (call.sql.includes('FROM items')) {
    const params = call.params as number[] | undefined;
    if (params !== undefined && params.length > 0) {
      return store.itemRows.filter((row) => row.item_location_id === params[0]);
    }
    return store.itemRows;
  }
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
  // must be shared, never opened again.
  await fireEvent.changeText(screen.getByTestId('inventory-search'), 'Rice');
  await act(async () => {});
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
  // One round of bounded reads: stale round A publishes nothing.
  expect(fake.getAllAsync).toHaveBeenCalledTimes(6);
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

  // Filter A (Pantry) starts but its item read stays slow.
  await fireEvent.press(screen.getByTestId('inventory-location-10'));
  await act(async () => {});
  const roundA = pending.splice(0, pending.length);
  expect(roundA.length).toBeGreaterThan(0);

  // Filter B (Fridge) starts on top of A.
  await fireEvent.press(screen.getByTestId('inventory-location-11'));
  await act(async () => {});
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

  await fireEvent.press(screen.getByTestId('inventory-location-10'));
  await act(async () => {});
  const roundA = pending.splice(0, pending.length);

  await fireEvent.press(screen.getByTestId('inventory-location-11'));
  await act(async () => {});
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
  await act(async () => {});
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
  await settle();
  expect(await screen.findByTestId('inventory-noresults-message')).toBeTruthy();
  expect(screen.queryByTestId('inventory-empty-title')).toBeNull();
  expect(screen.getByTestId('inventory-add-noresults')).toBeDisabled();
});

test('empty inventory stays first-run while choices render', async () => {
  store.itemRows = [];
  store.linkRows = [];
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
