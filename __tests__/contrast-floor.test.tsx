/**
 * P5d contrast-floor guard (decision approved 2026-10-12).
 *
 * `DESIGN.md` section 5 requires interactive control boundaries to reach
 * 3:1 against adjacent colors, and `src/theme/tokens.ts` carries that as
 * the `controlBorder` role. This test renders the real production
 * components in both schemes, reads the boundary color each control
 * actually paints, and computes the WCAG contrast ratio against both the
 * `background` and the `surface` literals of the same scheme. A token edit
 * that lowers the value, or a control that quietly keeps an older role,
 * fails here with real numbers instead of a copied constant.
 *
 * Decorative dividers are exempt by WCAG 1.4.11 and are intentionally not
 * asserted: item row separators (`inventory-row-*`) and the static
 * draft-tag outline keep the lighter `separator` role.
 */
import { cleanup, render } from '@testing-library/react-native';
import { I18nextProvider } from 'react-i18next';
import { StyleSheet } from 'react-native';
import type InventoryListType from '../src/components/InventoryList';
import type ItemFormType from '../src/components/ItemForm';
import type { ItemFormProps, ItemFormValues } from '../src/components/ItemForm';
import i18n from '../src/i18n';
import type { Category, ItemDetail, Location } from '../src/inventory/types';
import { DARK, LIGHT, type PaletteBase } from '../src/theme/tokens';

const ItemForm = require('../src/components/ItemForm')
  .default as typeof ItemFormType;
const InventoryList = require('../src/components/InventoryList')
  .default as typeof InventoryListType;

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) => (
      <View {...props}>{children}</View>
    ),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

/** WCAG 2.x floor for the extent cue of an interactive control. */
const CONTROL_FLOOR = 3;

/** Documented control inventory; the walk must keep finding these. */
const EXPECTED_CONTROLS = [
  'item-form/name',
  'item-form/stock-0/quantity',
  'item-form/stock-0/decrement',
  'item-form/stock-0/increment',
  'item-form/location-10',
  'item-form/location-new',
  'item-form/stock-0/location-new/name',
  'item-form/stock-0/location-new/address',
  'item-form/category-20',
  'item-form/new-category/name',
  'inventory-search',
  'inventory-location-all',
  'inventory-category-20',
];

/** A row separator is decoration, not the boundary of a control. */
const DECORATIVE_TEST_ID = /^inventory-row-\d+$/;

interface JsonNode {
  type: string;
  props: Record<string, unknown>;
  children: (JsonNode | string)[] | null;
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const hex = color.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`not an opaque hex color: ${color}`);
  }
  const [r, g, b] = [0, 2, 4].map((offset) =>
    channelLuminance(Number.parseInt(hex.slice(offset, offset + 2), 16)),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

function isControl(node: JsonNode): boolean {
  if (node.type === 'TextInput') return true;
  return typeof node.props.accessibilityRole === 'string';
}

function borders(node: JsonNode): {
  borderColor?: string;
  width: number;
} {
  const style = StyleSheet.flatten(node.props.style) as {
    borderColor?: string;
    borderWidth?: number;
  } | null;
  return {
    borderColor: style?.borderColor,
    width: style?.borderWidth ?? 0,
  };
}

/** Every bordered interactive control in the rendered tree, by testID. */
function collectControls(root: JsonNode): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (node: JsonNode): void => {
    const testID = node.props.testID;
    const { borderColor, width } = borders(node);
    if (
      typeof testID === 'string' &&
      width > 0 &&
      typeof borderColor === 'string' &&
      !DECORATIVE_TEST_ID.test(testID) &&
      isControl(node)
    ) {
      found[testID] = borderColor;
    }
    for (const child of node.children ?? []) {
      if (typeof child !== 'object' || child === null) continue;
      visit(child);
    }
  };
  visit(root);
  return found;
}

const pantry: Location = {
  id: 10,
  name: 'Pantry',
  address: null,
  created_at: 'ts-10',
};
const bulk: Category = { id: 20, name: 'Bulk', created_at: 'ts-20' };
const item: ItemDetail = {
  id: 1,
  name: 'Rice',
  stock: [{ locationId: pantry.id, location: pantry, quantity: 2 }],
  totalQuantity: 2,
  categoryIds: [bulk.id],
  categories: [bulk],
  created_at: 'created-1',
};

function formProps(): ItemFormProps {
  const values: ItemFormValues = {
    name: '',
    stock: [
      {
        location: { kind: 'new', location: { name: '', address: null } },
        quantityRaw: '',
      },
    ],
    categories: [],
    pendingNewCategoryName: '',
  };
  return {
    mode: 'add',
    values,
    onChange: jest.fn(),
    onSubmit: jest.fn(),
    onRequestClose: jest.fn(),
    locations: [pantry],
    categories: [bulk],
  };
}

function listProps() {
  return {
    state: 'ready' as const,
    items: [item],
    totalCount: 1,
    locations: [pantry],
    categories: [bulk],
    filter: {},
    onFilterChange: jest.fn(),
    onRetry: jest.fn(),
    onAdd: jest.fn(),
    onOpenItem: jest.fn(),
  };
}

async function renderControls(scheme: 'light' | 'dark') {
  const { useColorScheme } = require('react-native') as {
    useColorScheme: jest.Mock;
  };
  useColorScheme.mockReturnValue(scheme);
  const form = await render(
    <I18nextProvider i18n={i18n}>
      <ItemForm {...formProps()} />
    </I18nextProvider>,
  );
  const list = await render(
    <I18nextProvider i18n={i18n}>
      <InventoryList {...listProps()} />
    </I18nextProvider>,
  );
  const controls = {
    ...collectControls(form.toJSON() as unknown as JsonNode),
    ...collectControls(list.toJSON() as unknown as JsonNode),
  };
  await cleanup();
  return controls;
}

function assertFloor(
  controls: Record<string, string>,
  palette: PaletteBase,
  label: string,
): void {
  const failures: string[] = [];
  for (const [testID, borderColor] of Object.entries(controls)) {
    if (borderColor !== palette.controlBorder) {
      failures.push(
        `${testID}: paints ${borderColor}, expected the controlBoundary role ${palette.controlBorder}`,
      );
      continue;
    }
    for (const [role, adjacent] of [
      ['background', palette.background],
      ['surface', palette.surface],
    ] as const) {
      const ratio = contrastRatio(borderColor, adjacent);
      if (ratio < CONTROL_FLOOR) {
        failures.push(
          `${testID}: ${ratio.toFixed(2)}:1 against ${role} (${adjacent}), floor ${CONTROL_FLOOR}:1`,
        );
      }
    }
  }
  expect({ scheme: label, failures }).toEqual({ scheme: label, failures: [] });
}

afterEach(async () => {
  await cleanup();
  const { useColorScheme } = require('react-native') as {
    useColorScheme: jest.Mock;
  };
  useColorScheme.mockReturnValue('light');
});

test('the light control boundary meets the 3:1 floor on background and surface', async () => {
  const controls = await renderControls('light');
  expect(Object.keys(controls)).toEqual(
    expect.arrayContaining(EXPECTED_CONTROLS),
  );
  assertFloor(controls, LIGHT, 'light');
});

test('the dark control boundary meets the 3:1 floor on background and surface', async () => {
  const controls = await renderControls('dark');
  expect(Object.keys(controls)).toEqual(
    expect.arrayContaining(EXPECTED_CONTROLS),
  );
  assertFloor(controls, DARK, 'dark');
});
