/**
 * P3b1 presentational InventoryList unit (Jest/RNTL only, no device proof).
 *
 * Covers loading-vs-empty, safe error + retry, ready rows (qty 0/nonzero,
 * location, zero/many categories, verbatim Unicode names), controlled
 * search/clear, All/single location, category-OR multiselect with dedup and
 * toggle-off, combined controlled rerender, no-results query/reset/prefill,
 * disabled (never no-op) absent callbacks, iOS/Android add variants, and
 * en/es key parity. Small fixtures only; no DB, no App wiring.
 */
import {
  cleanup,
  fireEvent,
  render,
  within,
} from '@testing-library/react-native';
import { I18nextProvider } from 'react-i18next';
import type { ViewProps } from 'react-native';
import { Platform, StyleSheet } from 'react-native';

import type InventoryListType from '../src/components/InventoryList';
import i18n from '../src/i18n';
import { en } from '../src/i18n/resources';
import type {
  Category,
  ItemDetail,
  ItemFilter,
  Location,
} from '../src/inventory/types';

const InventoryList = require('../src/components/InventoryList')
  .default as typeof InventoryListType;

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

const pantry: Location = {
  id: 10,
  name: 'Pantry',
  address: null,
  created_at: 'ts-10',
};
const fridge: Location = {
  id: 11,
  name: 'Fridge',
  address: null,
  created_at: 'ts-11',
};
const bulk: Category = { id: 20, name: 'Bulk', created_at: 'ts-20' };
const cold: Category = { id: 21, name: 'Cold', created_at: 'ts-21' };

function makeItem(
  detail: Partial<ItemDetail> & Pick<ItemDetail, 'id'>,
): ItemDetail {
  const location = detail.location ?? pantry;
  const categories = detail.categories ?? [];
  return {
    name: `Item ${detail.id}`,
    quantity: 1,
    locationId: location.id,
    location,
    categoryIds: categories.map((entry) => entry.id),
    categories,
    created_at: `created-${detail.id}`,
    ...detail,
  };
}

interface ListProps {
  state: 'loading' | 'error' | 'ready';
  items: ItemDetail[];
  totalCount: number;
  locations: Location[];
  categories: Category[];
  filter: ItemFilter;
  onFilterChange: jest.Mock;
  onRetry: jest.Mock;
  onAdd?: (prefilledName?: string) => void;
  onOpenItem?: (id: number) => void;
}

function baseProps(overrides: Partial<ListProps> = {}): ListProps {
  return {
    state: 'ready',
    items: [],
    totalCount: 0,
    locations: [pantry, fridge],
    categories: [bulk, cold],
    filter: {},
    onFilterChange: jest.fn(),
    onRetry: jest.fn(),
    ...overrides,
  };
}

function renderList(props: ListProps) {
  return render(
    <I18nextProvider i18n={i18n}>
      <InventoryList {...props} />
    </I18nextProvider>,
  );
}

afterEach(async () => {
  await cleanup();
});

test('ready rows show verbatim names, quantity, location, and categories', async () => {
  const items = [
    makeItem({
      id: 1,
      name: 'CAFÉ 100%_\\mélange',
      quantity: 0,
      location: fridge,
      categories: [bulk, cold],
      categoryIds: [bulk.id, cold.id],
    }),
    makeItem({ id: 2, name: 'Rice', quantity: 3, categories: [] }),
  ];
  const view = await renderList(
    baseProps({ items, totalCount: 2, onOpenItem: jest.fn() }),
  );
  expect(view.getByTestId('inventory-row-1')).toHaveTextContent(
    /CAFÉ 100%_\\mélange/,
  );
  expect(view.getByTestId('inventory-row-1-quantity')).toHaveTextContent(
    /Quantity 0/,
  );
  expect(view.getByTestId('inventory-row-1-exhausted')).toBeTruthy();
  expect(view.queryByTestId('inventory-row-2-exhausted')).toBeNull();
  expect(view.getByTestId('inventory-row-1-location')).toHaveTextContent(
    'Fridge',
  );
  expect(view.getByTestId('inventory-row-1-categories')).toHaveTextContent(
    'Bulk, Cold',
  );
  expect(view.getByTestId('inventory-row-2-categories')).toHaveTextContent(
    'No categories',
  );
});

test('loading shows a text status with skeleton and never the empty state', async () => {
  const view = await renderList(
    baseProps({ state: 'loading', filter: { query: 'Rice' } }),
  );
  expect(view.getByTestId('inventory-loading')).toBeTruthy();
  expect(view.queryByTestId('inventory-empty-title')).toBeNull();
  expect(view.queryByTestId('inventory-row-1')).toBeNull();
  expect(view.getByTestId('inventory-search').props.value).toBe('Rice');
});

test('error shows a safe message with retry and no raw storage text', async () => {
  const onRetry = jest.fn();
  const view = await renderList(baseProps({ state: 'error', onRetry }));
  const message = view.getByTestId('inventory-error-message');
  const text = String(message.props.children ?? '');
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toMatch(/sqlite|user_version|error \d+/i);
  await fireEvent.press(view.getByTestId('inventory-retry'));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('first-run empty offers one primary add action and no platform add', async () => {
  const onAdd = jest.fn();
  const view = await renderList(baseProps({ totalCount: 0, onAdd }));
  expect(view.getByTestId('inventory-empty-title')).toBeTruthy();
  expect(view.queryByTestId('inventory-add-header')).toBeNull();
  expect(view.queryByTestId('inventory-add-fab')).toBeNull();
  await fireEvent.press(view.getByTestId('inventory-add-empty'));
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd.mock.calls[0]).toHaveLength(0);
});

test('no-results names the query and offers reset plus prefilled add', async () => {
  const onFilterChange = jest.fn();
  const onAdd = jest.fn();
  const view = await renderList(
    baseProps({
      items: [],
      totalCount: 2,
      filter: { query: '  quinoa  ' },
      onFilterChange,
      onAdd,
    }),
  );
  expect(view.getByTestId('inventory-noresults-message')).toHaveTextContent(
    /quinoa/,
  );
  await fireEvent.press(view.getByTestId('inventory-noresults-clear'));
  expect(onFilterChange).toHaveBeenCalledTimes(1);
  expect(onFilterChange).toHaveBeenCalledWith({
    query: '',
    locationId: null,
    categoryIds: [],
  });
  await fireEvent.press(view.getByTestId('inventory-add-noresults'));
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenCalledWith('quinoa');
});

test('row press opens the item exactly once', async () => {
  const onOpenItem = jest.fn();
  const view = await renderList(
    baseProps({ items: [makeItem({ id: 7 })], totalCount: 1, onOpenItem }),
  );
  await fireEvent.press(view.getByTestId('inventory-row-7'));
  expect(onOpenItem).toHaveBeenCalledTimes(1);
  expect(onOpenItem).toHaveBeenCalledWith(7);
});

test('search emits controlled text and the clear action resets the query', async () => {
  const onFilterChange = jest.fn();
  const view = await renderList(
    baseProps({
      items: [makeItem({ id: 1 })],
      totalCount: 1,
      filter: { query: 'Ri', locationId: 11, categoryIds: [20] },
      onFilterChange,
    }),
  );
  await fireEvent.changeText(view.getByTestId('inventory-search'), 'Rice');
  expect(onFilterChange).toHaveBeenCalledWith({
    query: 'Rice',
    locationId: 11,
    categoryIds: [20],
  });
  await fireEvent.press(view.getByTestId('inventory-search-clear'));
  expect(onFilterChange).toHaveBeenCalledWith({
    query: '',
    locationId: 11,
    categoryIds: [20],
  });
});

test('location chips select All and single locations', async () => {
  const onFilterChange = jest.fn();
  const view = await renderList(
    baseProps({ items: [makeItem({ id: 1 })], totalCount: 1, onFilterChange }),
  );
  await fireEvent.press(view.getByTestId('inventory-location-11'));
  expect(onFilterChange).toHaveBeenCalledWith({ locationId: 11 });
  await fireEvent.press(view.getByTestId('inventory-location-all'));
  expect(onFilterChange).toHaveBeenLastCalledWith({ locationId: null });
});

test('category chips multiselect OR, toggle off, and dedupe ids', async () => {
  const onFilterChange = jest.fn();
  const first = await renderList(
    baseProps({
      items: [makeItem({ id: 1 })],
      totalCount: 1,
      filter: { categoryIds: [20, 20] },
      onFilterChange,
    }),
  );
  await fireEvent.press(first.getByTestId('inventory-category-21'));
  expect(onFilterChange).toHaveBeenLastCalledWith({ categoryIds: [20, 21] });
  await first.unmount();
  onFilterChange.mockClear();
  const second = await renderList(
    baseProps({
      items: [makeItem({ id: 1 })],
      totalCount: 1,
      filter: { categoryIds: [20, 21] },
      onFilterChange,
    }),
  );
  await fireEvent.press(second.getByTestId('inventory-category-20'));
  expect(onFilterChange).toHaveBeenCalledWith({ categoryIds: [21] });
});

test('controlled filter props rerender search and chip selection', async () => {
  const props = baseProps({ items: [makeItem({ id: 1 })], totalCount: 1 });
  const view = await renderList(props);
  await view.rerender(
    <I18nextProvider i18n={i18n}>
      <InventoryList
        {...props}
        filter={{ query: 'Rice', locationId: 11, categoryIds: [20] }}
      />
    </I18nextProvider>,
  );
  expect(view.getByTestId('inventory-search').props.value).toBe('Rice');
  expect(
    view.getByTestId('inventory-location-11').props.accessibilityState,
  ).toMatchObject({ selected: true });
  expect(
    view.getByTestId('inventory-category-20').props.accessibilityState,
  ).toMatchObject({ selected: true });
});

test('rows without onOpenItem are not buttons', async () => {
  const view = await renderList(
    baseProps({ items: [makeItem({ id: 3 })], totalCount: 1 }),
  );
  const row = view.getByTestId('inventory-row-3');
  expect(row.props.onPress).toBeUndefined();
  expect(row.props.accessibilityRole).not.toBe('button');
});

test('missing onAdd renders disabled add actions with an honest hint', async () => {
  const view = await renderList(baseProps({ totalCount: 0 }));
  const add = view.getByTestId('inventory-add-empty');
  expect(add.props.accessibilityState).toMatchObject({ disabled: true });
  expect(String(add.props.accessibilityHint ?? '')).toMatch(/not available/i);
});

test('platform add affordance matches the running OS preset', async () => {
  const onAdd = jest.fn();
  const view = await renderList(
    baseProps({ items: [makeItem({ id: 1 })], totalCount: 1, onAdd }),
  );
  if (Platform.OS === 'android') {
    await fireEvent.press(view.getByTestId('inventory-add-fab'));
    expect(view.queryByTestId('inventory-add-header')).toBeNull();
  } else {
    await fireEvent.press(view.getByTestId('inventory-add-header'));
    expect(view.queryByTestId('inventory-add-fab')).toBeNull();
  }
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd.mock.calls[0]).toHaveLength(0);
});

test('every English key has a non-empty Spanish counterpart', async () => {
  const es = (i18n.getResourceBundle('es', 'translation') ?? {}) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(en)) {
    expect(typeof es[key]).toBe('string');
    expect((es[key] as string).length).toBeGreaterThan(0);
  }
});

test('Spanish renders translated search, add, and empty copy', async () => {
  await i18n.changeLanguage('es');
  const view = await renderList(baseProps({ totalCount: 0 }));
  try {
    expect(view.getByTestId('inventory-search').props.placeholder).toBe(
      'Buscar por nombre',
    );
    expect(view.getByTestId('inventory-search').props.accessibilityLabel).toBe(
      'Buscar en el inventario',
    );
    expect(view.getByTestId('inventory-add-empty')).toHaveTextContent(
      'Añade tu primer artículo',
    );
  } finally {
    await view.unmount();
    await i18n.changeLanguage('en');
  }
});

test('groups items by location with verbatim names and filtered counts', async () => {
  const items = [
    makeItem({ id: 1, name: 'Rice', quantity: 2, categories: [bulk] }),
    makeItem({ id: 2, name: 'Rice', quantity: 0, categories: [] }),
    makeItem({
      id: 3,
      name: 'Olive oil',
      quantity: 1,
      location: fridge,
      categories: [bulk, cold],
      categoryIds: [bulk.id, cold.id],
    }),
  ];
  const view = await renderList(baseProps({ items, totalCount: 3 }));
  expect(view.getByTestId('inventory-group-10-name')).toHaveTextContent(
    'Pantry',
  );
  expect(view.getByTestId('inventory-group-10-count')).toHaveTextContent(
    '2 items',
  );
  expect(view.getByTestId('inventory-group-11-name')).toHaveTextContent(
    'Fridge',
  );
  expect(view.getByTestId('inventory-group-11-count')).toHaveTextContent(
    '1 item',
  );
  const order = view
    .getAllByTestId(/^inventory-(group-\d+-(name|count)|row-\d+)$/)
    .map((node) => node.props.testID);
  expect(order).toEqual([
    'inventory-group-10-name',
    'inventory-group-10-count',
    'inventory-row-1',
    'inventory-row-2',
    'inventory-group-11-name',
    'inventory-group-11-count',
    'inventory-row-3',
  ]);
});

test('location-only filter shows a single group with no empty headers', async () => {
  const view = await renderList(
    baseProps({
      items: [makeItem({ id: 3, name: 'Olive oil', location: fridge })],
      totalCount: 3,
      filter: { locationId: 11 },
    }),
  );
  expect(view.getByTestId('inventory-group-11-count')).toHaveTextContent(
    '1 item',
  );
  expect(view.getByTestId('inventory-row-3')).toBeTruthy();
  expect(view.queryByTestId('inventory-group-10-name')).toBeNull();
});

test('location-only no-results names the place, never an empty header', async () => {
  const view = await renderList(
    baseProps({ items: [], totalCount: 3, filter: { locationId: 11 } }),
  );
  expect(view.getByTestId('inventory-noresults-message')).toHaveTextContent(
    'No items match in "Fridge"',
  );
  expect(view.queryAllByTestId(/^inventory-group-/)).toHaveLength(0);
});

test('category-only and unknown-location no-results stay generic', async () => {
  const props = baseProps({
    items: [],
    totalCount: 3,
    filter: { categoryIds: [20] },
  });
  const view = await renderList(props);
  expect(view.getByTestId('inventory-noresults-message')).toHaveTextContent(
    'No items match these filters.',
  );
  await view.rerender(
    <I18nextProvider i18n={i18n}>
      <InventoryList {...props} filter={{ locationId: 999 }} />
    </I18nextProvider>,
  );
  expect(view.getByTestId('inventory-noresults-message')).toHaveTextContent(
    'No items match these filters.',
  );
});

test('disabled add is visually muted while enabled keeps accent', async () => {
  const muted = await renderList(baseProps({ totalCount: 0 }));
  const mutedColor = StyleSheet.flatten(
    within(muted.getByTestId('inventory-add-empty')).getByText(
      'Add your first item',
    ).props.style,
  )?.color;
  await muted.unmount();
  const enabled = await renderList(
    baseProps({ totalCount: 0, onAdd: jest.fn() }),
  );
  const enabledColor = StyleSheet.flatten(
    within(enabled.getByTestId('inventory-add-empty')).getByText(
      'Add your first item',
    ).props.style,
  )?.color;
  expect(mutedColor).toBeDefined();
  expect(enabledColor).toBeDefined();
  expect(mutedColor).not.toBe(enabledColor);
});

test('search placeholder uses the secondary palette color', async () => {
  const view = await renderList(
    baseProps({ items: [makeItem({ id: 1 })], totalCount: 1 }),
  );
  const countColor = StyleSheet.flatten(
    view.getByTestId('inventory-count').props.style,
  )?.color;
  expect(view.getByTestId('inventory-search').props.placeholderTextColor).toBe(
    countColor,
  );
});

test('Spanish renders grouped counts and location zero-match copy', async () => {
  await i18n.changeLanguage('es');
  const view = await renderList(
    baseProps({
      items: [
        makeItem({ id: 1, name: 'Rice' }),
        makeItem({ id: 2, name: 'Oats' }),
        makeItem({ id: 3, name: 'Olive oil', location: fridge }),
      ],
      totalCount: 3,
    }),
  );
  try {
    expect(view.getByTestId('inventory-group-10-count')).toHaveTextContent(
      '2 artículos',
    );
    expect(view.getByTestId('inventory-group-11-count')).toHaveTextContent(
      '1 artículo',
    );
  } finally {
    await view.unmount();
    await i18n.changeLanguage('en');
  }
  await i18n.changeLanguage('es');
  const emptyView = await renderList(
    baseProps({ items: [], totalCount: 3, filter: { locationId: 11 } }),
  );
  try {
    expect(
      emptyView.getByTestId('inventory-noresults-message'),
    ).toHaveTextContent('Ningún artículo coincide en "Fridge"');
  } finally {
    await emptyView.unmount();
    await i18n.changeLanguage('en');
  }
});
