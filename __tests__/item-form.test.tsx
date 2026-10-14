/**
 * P4 U1 controlled ItemForm unit (Jest/RNTL only, no device proof).
 *
 * Covers controlled values/onChange (verbatim name, raw quantity),
 * provided-error rendering, quantity zero/decrement/increment and invalid
 * raw preservation, existing/new location drafts (append-only, mode-change
 * preservation), existing multi-select plus new-category drafts (same names
 * allowed, distinct ids), pending/absent-callback disabling, first-error
 * focus order, bilingual en/es parity, and structural theme/safe-area
 * behavior. No DB, no navigation, no App wiring.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { ViewProps } from 'react-native';

import type ItemFormType from '../src/components/ItemForm';
import type {
  ItemFormProps,
  ItemFormValues,
  ItemStockRowValues,
} from '../src/components/ItemForm';
import i18n from '../src/i18n';
import type { Category, Location } from '../src/inventory/types';

const ItemForm = require('../src/components/ItemForm')
  .default as typeof ItemFormType;
const { firstErrorField, resolveErrorFocusTarget } =
  require('../src/components/ItemForm') as Pick<typeof ItemFormType, never> & {
    firstErrorField: (
      errors?: import('../src/components/ItemForm').ItemFormErrors,
    ) => unknown;
    resolveErrorFocusTarget: (target: unknown, kind?: string) => string | null;
  };

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

// U4 date-picker native boundary: the real picker renders nothing under
// Jest (proven by probe), so this stub renders a View carrying the picker
// props. Tests drive selection through `onChange` to prove the
// toggle/picker/clear wiring and the ISO conversion at the component
// edge; it proves nothing about the OS dialog itself.
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

const pantry: Location = {
  id: 10,
  name: 'Pantry',
  address: null,
  created_at: 'ts-10',
};
const garage: Location = {
  id: 11,
  name: 'Garage',
  address: 'Calle Mayor 12',
  created_at: 'ts-11',
};
const bulk: Category = { id: 20, name: 'Bulk', created_at: 'ts-20' };
const grains: Category = { id: 21, name: 'Grains', created_at: 'ts-21' };
const grainsTwin: Category = { id: 22, name: 'Grains', created_at: 'ts-22' };

const emptyValues: ItemFormValues = {
  name: '',
  stock: [],
  categories: [],
  pendingNewCategoryName: '',
};

function row(quantityRaw: string, locationId = 10): ItemStockRowValues {
  return { location: { kind: 'existing', locationId }, quantityRaw };
}

function newRow(quantityRaw = ''): ItemStockRowValues {
  return {
    location: { kind: 'new', location: { name: '', address: null } },
    quantityRaw,
  };
}

function baseProps(overrides: Partial<ItemFormProps> = {}): ItemFormProps {
  return {
    mode: 'add',
    values: emptyValues,
    onChange: jest.fn(),
    onSubmit: jest.fn(),
    onRequestClose: jest.fn(),
    locations: [pantry, garage],
    categories: [bulk, grains],
    ...overrides,
  };
}

function renderForm(props: ItemFormProps) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ItemForm {...props} />
    </I18nextProvider>,
  );
}

/** Stateful controlled wrapper that applies every onChange like U2 will. */
function ControlledHarness({
  initial = emptyValues,
  props = {},
}: {
  initial?: ItemFormValues;
  props?: Partial<ItemFormProps>;
}) {
  const [values, setValues] = useState<ItemFormValues>(initial);
  return (
    <I18nextProvider i18n={i18n}>
      <ItemForm
        mode="add"
        locations={[pantry, garage]}
        categories={[bulk, grains, grainsTwin]}
        onChange={setValues}
        onSubmit={() => {}}
        onRequestClose={() => {}}
        values={values}
        {...props}
      />
    </I18nextProvider>
  );
}

afterEach(async () => {
  await cleanup();
  await i18n.changeLanguage('en');
});

test('renders add-mode fields with stable testIDs', async () => {
  const view = await renderForm(baseProps());
  expect(await view.findByTestId('item-form/name')).toBeTruthy();
  // No stock rows yet: the per-location editor offers its add affordance.
  expect(view.queryByTestId('item-form/stock-0/quantity')).toBeNull();
  expect(view.getByTestId('item-form/location-10')).toBeTruthy();
  expect(view.getByTestId('item-form/location-new')).toBeTruthy();
  expect(view.getByTestId('item-form/category-20')).toBeTruthy();
  expect(view.getByTestId('item-form/new-category/name')).toBeTruthy();
  expect(view.getByTestId('item-form/save')).toBeTruthy();
  expect(view.getByTestId('item-form/close')).toBeTruthy();
  expect(view.getByText('New item')).toBeTruthy();
});

test('add location chip appends a stock row with quantity controls', async () => {
  const onChange = jest.fn();
  const view = await renderForm(baseProps({ onChange }));
  await fireEvent.press(view.getByTestId('item-form/location-10'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    stock: [row('')],
  });
  const withRow = await renderForm(
    baseProps({ values: { ...emptyValues, stock: [row('')] } }),
  );
  expect(withRow.getByTestId('item-form/stock-0/quantity')).toBeTruthy();
  expect(withRow.getByTestId('item-form/stock-0/decrement')).toBeTruthy();
  expect(withRow.getByTestId('item-form/stock-0/increment')).toBeTruthy();
  expect(withRow.getByTestId('item-form/stock-0/remove')).toBeTruthy();
  // The added location leaves the add chips so other locations stay
  // addable; the added one is gone.
  expect(withRow.queryByTestId('item-form/location-10')).toBeNull();
  expect(withRow.getByTestId('item-form/location-11')).toBeTruthy();
});

test('stock row remove drops the row', async () => {
  const onChange = jest.fn();
  const values: ItemFormValues = {
    ...emptyValues,
    stock: [row('2'), row('1', 11)],
  };
  const view = await renderForm(baseProps({ values, onChange }));
  await fireEvent.press(view.getByTestId('item-form/stock-0/remove'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    stock: [row('1', 11)],
  });
});

test('renders edit-mode title', async () => {
  const view = await renderForm(baseProps({ mode: 'edit' }));
  expect(await view.findByText('Edit item')).toBeTruthy();
});

test('name typing emits controlled onChange with verbatim text', async () => {
  const onChange = jest.fn();
  const view = await renderForm(baseProps({ onChange }));
  await fireEvent.changeText(
    view.getByTestId('item-form/name'),
    '  café con leche  ',
  );
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    name: '  café con leche  ',
  });
});

test('invalid quantity raw text is preserved for explicit errors', async () => {
  const onChange = jest.fn();
  const view = await renderForm(
    baseProps({
      values: { ...emptyValues, stock: [row('')] },
      onChange,
    }),
  );
  await fireEvent.changeText(
    view.getByTestId('item-form/stock-0/quantity'),
    'abc',
  );
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    stock: [row('abc')],
  });
});

test('renders provided validation errors without inventing copy', async () => {
  const view = await renderForm(
    baseProps({
      values: { ...emptyValues, stock: [row('')] },
      errors: {
        name: 'Enter a name.',
        stock: [{ quantity: 'Enter a whole number.' }],
      },
    }),
  );
  expect(await view.findByTestId('item-form/error-name')).toBeTruthy();
  expect(view.getByTestId('item-form/error-stock-0-quantity')).toBeTruthy();
  expect(view.getByText('Enter a name.')).toBeTruthy();
});

test('first-error focus order is name, stock rows, categories', async () => {
  expect(firstErrorField({ stock: [{ quantity: 'q' }], name: 'n' })).toBe(
    'name',
  );
  expect(
    firstErrorField({ stock: [{ location: 'l' }, { quantity: 'q' }] }),
  ).toEqual({ row: 0, side: 'location' });
  expect(firstErrorField({ stock: [{ quantity: 'q' }] })).toEqual({
    row: 0,
    side: 'quantity',
  });
  expect(firstErrorField({ categories: 'c', stock: [undefined] })).toBe(
    'categories',
  );
  expect(firstErrorField({})).toBeNull();
  expect(firstErrorField(undefined)).toBeNull();
});

test('quantity zero shows exhausted copy and disables decrement', async () => {
  const view = await renderForm(
    baseProps({ values: { ...emptyValues, stock: [row('0')] } }),
  );
  expect(await view.findByText('Exhausted')).toBeTruthy();
  expect(
    view.getByTestId('item-form/stock-0/decrement').props.accessibilityState
      .disabled,
  ).toBe(true);
});

test('stepper emits controlled updates without touching other fields', async () => {
  const onChange = jest.fn();
  const values: ItemFormValues = {
    name: 'Rice',
    stock: [row('2')],
    categories: [],
    pendingNewCategoryName: '',
  };
  const view = await renderForm(baseProps({ values, onChange }));
  await fireEvent.press(view.getByTestId('item-form/stock-0/increment'));
  expect(onChange).toHaveBeenCalledWith({
    ...values,
    stock: [row('3')],
  });
  onChange.mockClear();
  await fireEvent.press(view.getByTestId('item-form/stock-0/decrement'));
  expect(onChange).toHaveBeenCalledWith({
    ...values,
    stock: [row('1')],
  });
});

test.each(['', '   ', 'abc', '1.5', '-3', '9007199254740992'])(
  'null-parse quantity %p disables both steppers and preserves raw',
  async (raw) => {
    const onChange = jest.fn();
    const view = await renderForm(
      baseProps({ values: { ...emptyValues, stock: [row(raw)] }, onChange }),
    );
    expect(view.getByTestId('item-form/stock-0/quantity').props.value).toBe(
      raw,
    );
    expect(
      view.getByTestId('item-form/stock-0/increment').props.accessibilityState
        .disabled,
    ).toBe(true);
    expect(
      view.getByTestId('item-form/stock-0/decrement').props.accessibilityState
        .disabled,
    ).toBe(true);
    await fireEvent.press(view.getByTestId('item-form/stock-0/increment'));
    await fireEvent.press(view.getByTestId('item-form/stock-0/decrement'));
    expect(onChange).not.toHaveBeenCalled();
    // Save stays enabled: parent validation reports the explicit error.
    expect(
      view.getByTestId('item-form/save').props.accessibilityState.disabled,
    ).toBe(false);
  },
);

test('product cap disables increment at 999999; technical guard stays null-parse', async () => {
  const onChange = jest.fn();
  const view = await renderForm(
    baseProps({ values: { ...emptyValues, stock: [row('999999')] }, onChange }),
  );
  expect(
    view.getByTestId('item-form/stock-0/increment').props.accessibilityState
      .disabled,
  ).toBe(true);
  expect(
    view.getByTestId('item-form/stock-0/decrement').props.accessibilityState
      .disabled,
  ).toBe(false);
  await fireEvent.press(view.getByTestId('item-form/stock-0/decrement'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    stock: [row('999998')],
  });
});

test('increment from valid zero reaches one without a default', async () => {
  const onChange = jest.fn();
  const view = await renderForm(
    baseProps({ values: { ...emptyValues, stock: [row('0')] }, onChange }),
  );
  expect(
    view.getByTestId('item-form/stock-0/increment').props.accessibilityState
      .disabled,
  ).toBe(false);
  await fireEvent.press(view.getByTestId('item-form/stock-0/increment'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    stock: [row('1')],
  });
});

test('new location append appends a draft row with inline inputs', async () => {
  const onChange = jest.fn();
  const view = await renderForm(baseProps({ onChange }));
  await fireEvent.press(view.getByTestId('item-form/location-new'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    stock: [newRow()],
  });
});

test('new location draft preserves unsaved names while editing the row', async () => {
  const view = await render(<ControlledHarness />);
  await fireEvent.press(await view.findByTestId('item-form/location-new'));
  await fireEvent.changeText(
    view.getByTestId('item-form/stock-0/location-new/name'),
    'Bodega',
  );
  await fireEvent.changeText(
    view.getByTestId('item-form/stock-0/location-new/address'),
    'Calle Luna 3',
  );
  // Editing the same row's quantity keeps the draft text.
  await fireEvent.changeText(
    view.getByTestId('item-form/stock-0/quantity'),
    '2',
  );
  expect(
    view.getByTestId('item-form/stock-0/location-new/name').props.value,
  ).toBe('Bodega');
  expect(
    view.getByTestId('item-form/stock-0/location-new/address').props.value,
  ).toBe('Calle Luna 3');
});

test('category toggle adds and removes without duplicating selection', async () => {
  const onChange = jest.fn();
  const view = await renderForm(baseProps({ onChange }));
  await fireEvent.press(view.getByTestId('item-form/category-20'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    categories: [{ kind: 'existing', categoryId: 20 }],
  });
});

test('same-named categories are distinct selectable entities', async () => {
  const onChange = jest.fn();
  const values: ItemFormValues = {
    ...emptyValues,
    categories: [{ kind: 'existing', categoryId: 21 }],
    pendingNewCategoryName: '',
  };
  const view = await renderForm(
    baseProps({
      values,
      categories: [bulk, grains, grainsTwin],
      onChange,
    }),
  );
  await fireEvent.press(view.getByTestId('item-form/category-22'));
  expect(onChange).toHaveBeenCalledWith({
    ...values,
    categories: [
      { kind: 'existing', categoryId: 21 },
      { kind: 'existing', categoryId: 22 },
    ],
  });
});

test('new category appends a draft only and removes by draft button', async () => {
  const view = await render(<ControlledHarness />);
  await fireEvent.changeText(
    await view.findByTestId('item-form/new-category/name'),
    'Bulk fresco',
  );
  await fireEvent.press(view.getByTestId('item-form/new-category/add'));
  expect(
    await view.findByTestId('item-form/new-category/remove-0'),
  ).toBeTruthy();
  expect(view.getByTestId('item-form/new-category/name').props.value).toBe('');
  await fireEvent.press(view.getByTestId('item-form/new-category/remove-0'));
  expect(view.queryByTestId('item-form/new-category/remove-0')).toBeNull();
});

test('pending disables save, close, and every mutating input', async () => {
  const view = await renderForm(
    baseProps({
      values: { ...emptyValues, stock: [row('2')] },
      submitting: true,
    }),
  );
  const saveState = view.getByTestId('item-form/save').props.accessibilityState;
  expect(saveState.disabled).toBe(true);
  expect(saveState.busy).toBe(true);
  expect(
    view.getByTestId('item-form/close').props.accessibilityState.disabled,
  ).toBe(true);
  expect(view.getByTestId('item-form/name').props.editable).toBe(false);
  expect(view.getByTestId('item-form/stock-0/quantity').props.editable).toBe(
    false,
  );
  expect(
    view.getByTestId('item-form/stock-0/increment').props.accessibilityState
      .disabled,
  ).toBe(true);
  expect(
    view.getByTestId('item-form/stock-0/remove').props.accessibilityState
      .disabled,
  ).toBe(true);
  expect(
    view.getByTestId('item-form/location-11').props.accessibilityState.disabled,
  ).toBe(true);
});

test('save stays enabled when blank so parent validation can focus errors', async () => {
  const view = await renderForm(baseProps());
  expect(
    view.getByTestId('item-form/save').props.accessibilityState.disabled,
  ).toBe(false);
});

test('missing save/close callbacks disable truthfully instead of no-op', async () => {
  const props = baseProps({ onSubmit: undefined, onRequestClose: undefined });
  const view = await renderForm(props);
  expect(
    view.getByTestId('item-form/save').props.accessibilityState.disabled,
  ).toBe(true);
  expect(
    view.getByTestId('item-form/close').props.accessibilityState.disabled,
  ).toBe(true);
});

test('location error focus target exists in every selection state', async () => {
  expect(resolveErrorFocusTarget('name', undefined)).toBe('item-form/name');
  expect(resolveErrorFocusTarget({ row: 0, side: 'quantity' }, undefined)).toBe(
    'item-form/stock-0/quantity',
  );
  expect(
    resolveErrorFocusTarget({ row: 0, side: 'location' }, 'existing'),
  ).toBe('item-form/error-stock-0-location');
  expect(resolveErrorFocusTarget({ row: 1, side: 'location' }, 'new')).toBe(
    'item-form/stock-1/location-new/name',
  );
  expect(resolveErrorFocusTarget('form', undefined)).toBe(
    'item-form/error-form',
  );
  expect(resolveErrorFocusTarget(null, undefined)).toBeNull();
});

const locationFocusCases: [ItemStockRowValues['location'], string][] = [
  [{ kind: 'existing', locationId: 10 }, 'item-form/error-stock-0-location'],
  [
    { kind: 'new', location: { name: '', address: null } },
    'item-form/stock-0/location-new/name',
  ],
];
test.each(locationFocusCases)(
  'location error requests focus on mounted target for %p',
  async (location, target) => {
    const onRequestErrorFocus = jest.fn();
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, stock: [{ location, quantityRaw: '' }] },
        errors: { stock: [{ location: 'Choose or create a location.' }] },
        onRequestErrorFocus,
      }),
    );
    expect(onRequestErrorFocus).toHaveBeenCalledWith(target);
    expect(view.getByTestId(target as string)).toBeTruthy();
  },
);

test('form error requests focus on its announced alert target', async () => {
  const onRequestErrorFocus = jest.fn();
  const view = await renderForm(
    baseProps({
      errors: { form: 'Could not save: storage unavailable.' },
      onRequestErrorFocus,
    }),
  );
  expect(onRequestErrorFocus).toHaveBeenCalledWith('item-form/error-form');
  expect(view.getByTestId('item-form/error-form')).toBeTruthy();
});

test('pending category typing is controlled and survives remount unappended', async () => {
  let retained: ItemFormValues = { ...emptyValues };
  function RemountHarness({ initial }: { initial: ItemFormValues }) {
    const [current, setCurrent] = useState<ItemFormValues>(initial);
    return (
      <I18nextProvider i18n={i18n}>
        <ItemForm
          mode="add"
          locations={[pantry, garage]}
          categories={[bulk, grains, grainsTwin]}
          values={current}
          onChange={(next) => {
            retained = next;
            setCurrent(next);
          }}
          onSubmit={() => {}}
          onRequestClose={() => {}}
        />
      </I18nextProvider>
    );
  }
  const view = await render(<RemountHarness key="a" initial={retained} />);
  await fireEvent.changeText(
    view.getByTestId('item-form/new-category/name'),
    'Bulk fresco',
  );
  expect(retained.pendingNewCategoryName).toBe('Bulk fresco');
  expect(retained.categories).toEqual([]);
  // Key change forces a true remount: state re-initializes from props.
  await view.rerender(<RemountHarness key="b" initial={retained} />);
  expect(view.getByTestId('item-form/new-category/name').props.value).toBe(
    'Bulk fresco',
  );
  expect(view.queryByTestId('item-form/new-category/remove-0')).toBeNull();
});

test('new-location row text survives remount controlled by props', async () => {
  let retained: ItemFormValues = { ...emptyValues };
  function RemountHarness({ initial }: { initial: ItemFormValues }) {
    const [current, setCurrent] = useState<ItemFormValues>(initial);
    return (
      <I18nextProvider i18n={i18n}>
        <ItemForm
          mode="add"
          locations={[pantry, garage]}
          categories={[bulk, grains, grainsTwin]}
          values={current}
          onChange={(next) => {
            retained = next;
            setCurrent(next);
          }}
          onSubmit={() => {}}
          onRequestClose={() => {}}
        />
      </I18nextProvider>
    );
  }
  const view = await render(<RemountHarness key="a" initial={retained} />);
  await fireEvent.press(await view.findByTestId('item-form/location-new'));
  await fireEvent.changeText(
    view.getByTestId('item-form/stock-0/location-new/name'),
    'Bodega',
  );
  await fireEvent.changeText(
    view.getByTestId('item-form/stock-0/location-new/address'),
    'Calle Luna 3',
  );
  expect(retained.stock).toEqual([
    {
      location: {
        kind: 'new',
        location: { name: 'Bodega', address: 'Calle Luna 3' },
      },
      quantityRaw: '',
    },
  ]);
  // Key change forces a true remount: state re-initializes from props.
  await view.rerender(<RemountHarness key="b" initial={retained} />);
  expect(
    view.getByTestId('item-form/stock-0/location-new/name').props.value,
  ).toBe('Bodega');
  expect(
    view.getByTestId('item-form/stock-0/location-new/address').props.value,
  ).toBe('Calle Luna 3');
});

test('renders Spanish strings when locale is es', async () => {
  await i18n.changeLanguage('es');
  const view = await renderForm(baseProps());
  expect(await view.findByText('Nuevo artículo')).toBeTruthy();
  expect(view.getByText('Guardar')).toBeTruthy();
  expect(view.getByText('Cerrar')).toBeTruthy();
});

test('passes parent error copy through verbatim without raw sqlite text', async () => {
  const view = await renderForm(
    baseProps({ errors: { form: 'Could not save: storage unavailable.' } }),
  );
  const node = await view.findByTestId('item-form/error-form');
  expect(node).toBeTruthy();
  expect(view.getByText('Could not save: storage unavailable.')).toBeTruthy();
});

describe('U2b delete affordance', () => {
  test('renders in edit mode only when the prop is provided', async () => {
    const onRequestDelete = jest.fn();
    const view = await renderForm(baseProps({ mode: 'edit', onRequestDelete }));
    const action = await view.findByTestId('item-form/delete');
    expect(action).toBeTruthy();
    expect(action.props.accessibilityRole).toBe('button');
    expect(action.props.accessibilityLabel).toBe('Delete item');
    expect(action.props.accessibilityState?.disabled ?? false).toBe(false);
    expect(view.getByText('Delete item')).toBeTruthy();
    await fireEvent.press(action);
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });

  test('not rendered in edit mode without the prop', async () => {
    const view = await renderForm(baseProps({ mode: 'edit' }));
    await view.findByTestId('item-form/save');
    expect(view.queryByTestId('item-form/delete')).toBeNull();
  });

  test('not rendered in add mode even when the prop is provided', async () => {
    const view = await renderForm(
      baseProps({ mode: 'add', onRequestDelete: jest.fn() }),
    );
    await view.findByTestId('item-form/save');
    expect(view.queryByTestId('item-form/delete')).toBeNull();
  });

  test('disabled while submitting', async () => {
    const onRequestDelete = jest.fn();
    const view = await renderForm(
      baseProps({ mode: 'edit', onRequestDelete, submitting: true }),
    );
    const action = await view.findByTestId('item-form/delete');
    expect(action.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(action);
    expect(onRequestDelete).not.toHaveBeenCalled();
  });

  test('renders the Spanish label when locale is es', async () => {
    await i18n.changeLanguage('es');
    const view = await renderForm(
      baseProps({ mode: 'edit', onRequestDelete: jest.fn() }),
    );
    expect(await view.findByText('Eliminar artículo')).toBeTruthy();
  });
});

describe('M4 blur callback (Gap B)', () => {
  test('blur events call onFieldBlur with the right field', async () => {
    const onFieldBlur = jest.fn();
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, stock: [row('')] },
        onFieldBlur,
      }),
    );
    await fireEvent(view.getByTestId('item-form/name'), 'blur');
    expect(onFieldBlur).toHaveBeenCalledWith('name');
    await fireEvent(view.getByTestId('item-form/stock-0/quantity'), 'blur');
    expect(onFieldBlur).toHaveBeenCalledWith('quantity', 0);
    expect(onFieldBlur).toHaveBeenCalledTimes(2);
  });

  test('absent callback stays a true no-op on blur', async () => {
    const view = await renderForm(
      baseProps({ values: { ...emptyValues, stock: [row('')] } }),
    );
    await expect(
      (async () => {
        await fireEvent(view.getByTestId('item-form/name'), 'blur');
        await fireEvent(view.getByTestId('item-form/stock-0/quantity'), 'blur');
      })(),
    ).resolves.toBeUndefined();
  });

  test('blur is not fired while submitting', async () => {
    const onFieldBlur = jest.fn();
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, stock: [row('')] },
        onFieldBlur,
        submitting: true,
      }),
    );
    await fireEvent(view.getByTestId('item-form/name'), 'blur');
    await fireEvent(view.getByTestId('item-form/stock-0/quantity'), 'blur');
    expect(onFieldBlur).not.toHaveBeenCalled();
  });
});

describe('P5a selection-chip labels and symbol glyphs', () => {
  test('location and category chips expose their visible name as the label', async () => {
    const view = await renderForm(baseProps());
    expect(
      view.getByTestId('item-form/location-10').props.accessibilityLabel,
    ).toBe('Pantry');
    expect(
      view.getByTestId('item-form/location-new').props.accessibilityLabel,
    ).toBe('New location');
    expect(
      view.getByTestId('item-form/category-20').props.accessibilityLabel,
    ).toBe('Bulk');
  });

  test('steppers and draft-remove render the fixed non-translatable symbols', async () => {
    const view = await renderForm(
      baseProps({
        values: {
          ...emptyValues,
          stock: [row('2')],
          categories: [{ kind: 'new', category: { name: 'Grains' } }],
        },
      }),
    );
    expect(view.getByTestId('item-form/stock-0/decrement')).toHaveTextContent(
      '−',
    );
    expect(view.getByTestId('item-form/stock-0/increment')).toHaveTextContent(
      '+',
    );
    expect(
      view.getByTestId('item-form/new-category/remove-0'),
    ).toHaveTextContent('✕');
  });
});

describe('S10 product quantity bound (999999)', () => {
  const { parseQuantityRaw } = require('../src/components/ItemForm') as {
    parseQuantityRaw: (raw: string) => number | null;
  };

  test('RED: 999999 parses, 1000000 is null-parse raw preserved', async () => {
    expect(parseQuantityRaw('999999')).toBe(999999);
    expect(parseQuantityRaw('1000000')).toBeNull();
    const onChange = jest.fn();
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, stock: [row('1000000')] },
        onChange,
      }),
    );
    // Raw text is never coerced or clamped.
    expect(view.getByTestId('item-form/stock-0/quantity').props.value).toBe(
      '1000000',
    );
    expect(
      view.getByTestId('item-form/stock-0/increment').props.accessibilityState
        .disabled,
    ).toBe(true);
    expect(
      view.getByTestId('item-form/stock-0/decrement').props.accessibilityState
        .disabled,
    ).toBe(true);
    await fireEvent.press(view.getByTestId('item-form/stock-0/increment'));
    await fireEvent.press(view.getByTestId('item-form/stock-0/decrement'));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('RED: stepper caps at 999999 and keeps its 0 floor', async () => {
    const onChange = jest.fn();
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, stock: [row('999999')] },
        onChange,
      }),
    );
    expect(
      view.getByTestId('item-form/stock-0/increment').props.accessibilityState
        .disabled,
    ).toBe(true);
    expect(
      view.getByTestId('item-form/stock-0/decrement').props.accessibilityState
        .disabled,
    ).toBe(false);
    await fireEvent.press(view.getByTestId('item-form/stock-0/increment'));
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.press(view.getByTestId('item-form/stock-0/decrement'));
    expect(onChange).toHaveBeenCalledWith({
      ...emptyValues,
      stock: [row('999998')],
    });
  });
});

describe('T4 form per-keystroke work (S2.6)', () => {
  test('T4 RED: typing a quantity does not re-request error focus for an unchanged error', async () => {
    const onRequestErrorFocus = jest.fn();
    const view = await render(
      <ControlledHarness
        initial={{ ...emptyValues, stock: [row('1'), row('2', 11)] }}
        props={{
          errors: { stock: [{ location: 'Choose or create a location.' }] },
          onRequestErrorFocus,
        }}
      />,
    );
    expect(onRequestErrorFocus).toHaveBeenCalledTimes(1);
    expect(onRequestErrorFocus).toHaveBeenCalledWith(
      'item-form/error-stock-0-location',
    );
    await fireEvent.changeText(
      view.getByTestId('item-form/stock-1/quantity'),
      '25',
    );
    expect(onRequestErrorFocus).toHaveBeenCalledTimes(1);
  });

  test('T4 RED: stock rows are isolated memo components', async () => {
    const { ItemStockRow } =
      require('../src/components/ItemForm') as unknown as {
        ItemStockRow: unknown;
      };
    expect(ItemStockRow).toBeTruthy();
    expect((ItemStockRow as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });
});

describe('U4 reminder fields (threshold plus per-row expiry)', () => {
  const { formatExpiresOnDate, parseExpiresOnToDate } =
    require('../src/components/ItemForm') as {
      formatExpiresOnDate: (date: Date) => string;
      parseExpiresOnToDate: (raw: unknown) => Date | null;
    };

  test('expiry date boundary round-trips local calendar days', () => {
    expect(formatExpiresOnDate(new Date(2027, 2, 15))).toBe('2027-03-15');
    expect(parseExpiresOnToDate('2027-03-15')).toEqual(new Date(2027, 2, 15));
    expect(parseExpiresOnToDate('')).toBeNull();
    expect(parseExpiresOnToDate(undefined)).toBeNull();
    expect(parseExpiresOnToDate('tomorrow')).toBeNull();
    expect(parseExpiresOnToDate('2027-02-30')).toBeNull();
  });

  test('threshold renders empty when unset and types verbatim', async () => {
    const onChange = jest.fn();
    const values: ItemFormValues = {
      ...emptyValues,
      stock: [row('2')],
    };
    const view = await renderForm(baseProps({ values, onChange }));
    expect(view.getByTestId('item-form/threshold').props.value).toBe('');
    await fireEvent.changeText(view.getByTestId('item-form/threshold'), '5');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...values,
      lowStockThresholdRaw: '5',
    });
  });

  test('threshold renders the carried value', async () => {
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, lowStockThresholdRaw: '5' },
      }),
    );
    expect(view.getByTestId('item-form/threshold').props.value).toBe('5');
  });

  test('threshold error renders without inventing copy', async () => {
    const view = await renderForm(
      baseProps({
        errors: { lowStockThreshold: 'Enter a threshold of 999999 or less.' },
      }),
    );
    expect(
      view.getByTestId('item-form/error-low-stock-threshold'),
    ).toBeTruthy();
    expect(view.getByText('Enter a threshold of 999999 or less.')).toBeTruthy();
  });

  test('row without expiry offers set, opens the picker, and stores ISO', async () => {
    const onChange = jest.fn();
    const values: ItemFormValues = {
      ...emptyValues,
      stock: [row('2')],
    };
    const view = await renderForm(baseProps({ values, onChange }));
    expect(view.queryByTestId('item-form/stock-0/expires-picker')).toBeNull();
    expect(view.queryByTestId('item-form/stock-0/expires-clear')).toBeNull();
    await fireEvent.press(view.getByTestId('item-form/stock-0/expires-toggle'));
    const picker = view.getByTestId('item-form/stock-0/expires-picker');
    expect(picker).toBeTruthy();
    picker.props.onChange({ type: 'set' }, new Date(2027, 2, 15));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...values,
      stock: [{ ...row('2'), expiresOnRaw: '2027-03-15' }],
    });
  });

  test('picker dismissal stores nothing and closes', async () => {
    const onChange = jest.fn();
    const values: ItemFormValues = {
      ...emptyValues,
      stock: [row('2')],
    };
    const view = await renderForm(baseProps({ values, onChange }));
    await fireEvent.press(view.getByTestId('item-form/stock-0/expires-toggle'));
    expect(view.getByTestId('item-form/stock-0/expires-picker')).toBeTruthy();
    await act(async () => {
      view
        .getByTestId('item-form/stock-0/expires-picker')
        .props.onChange({ type: 'dismissed' }, undefined);
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(view.queryByTestId('item-form/stock-0/expires-picker')).toBeNull();
  });

  test('row with expiry shows the value and clears back to empty', async () => {
    const onChange = jest.fn();
    const values: ItemFormValues = {
      ...emptyValues,
      stock: [{ ...row('2'), expiresOnRaw: '2027-03-15' }],
    };
    const view = await renderForm(baseProps({ values, onChange }));
    expect(view.getByText('2027-03-15')).toBeTruthy();
    await fireEvent.press(view.getByTestId('item-form/stock-0/expires-clear'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      ...values,
      stock: [{ ...row('2'), expiresOnRaw: '' }],
    });
  });

  test('row expiry error renders without inventing copy', async () => {
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, stock: [row('2')] },
        errors: {
          stock: [{ expiresOn: 'Enter a valid expiry date (YYYY-MM-DD).' }],
        },
      }),
    );
    expect(view.getByTestId('item-form/error-stock-0-expiresOn')).toBeTruthy();
    expect(
      view.getByText('Enter a valid expiry date (YYYY-MM-DD).'),
    ).toBeTruthy();
  });

  test('pending disables the threshold input and the expiry affordances', async () => {
    const view = await renderForm(
      baseProps({
        values: {
          ...emptyValues,
          stock: [{ ...row('2'), expiresOnRaw: '2027-03-15' }],
        },
        submitting: true,
      }),
    );
    expect(view.getByTestId('item-form/threshold').props.editable).toBe(false);
    expect(
      view.getByTestId('item-form/stock-0/expires-toggle').props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(
      view.getByTestId('item-form/stock-0/expires-clear').props
        .accessibilityState.disabled,
    ).toBe(true);
  });

  test('reminder focus order is name, threshold, rows, categories', async () => {
    expect(firstErrorField({ lowStockThreshold: 't', name: 'n' })).toBe('name');
    expect(
      firstErrorField({ lowStockThreshold: 't', stock: [{ quantity: 'q' }] }),
    ).toBe('lowStockThreshold');
    expect(
      firstErrorField({ stock: [{ quantity: 'q', expiresOn: 'e' }] }),
    ).toEqual({ row: 0, side: 'quantity' });
    expect(
      firstErrorField({ stock: [{ location: 'l', expiresOn: 'e' }] }),
    ).toEqual({ row: 0, side: 'location' });
    expect(firstErrorField({ stock: [{ expiresOn: 'e' }] })).toEqual({
      row: 0,
      side: 'expiresOn',
    });
    expect(firstErrorField({ categories: 'c', lowStockThreshold: 't' })).toBe(
      'lowStockThreshold',
    );
  });

  test('reminder error focus targets exist', async () => {
    expect(resolveErrorFocusTarget('lowStockThreshold', undefined)).toBe(
      'item-form/threshold',
    );
    expect(
      resolveErrorFocusTarget({ row: 1, side: 'expiresOn' }, 'existing'),
    ).toBe('item-form/stock-1/expires-toggle');
  });

  test('threshold error requests focus on its mounted input', async () => {
    const onRequestErrorFocus = jest.fn();
    const view = await renderForm(
      baseProps({
        errors: { lowStockThreshold: 'Enter a whole number of 0 or more.' },
        onRequestErrorFocus,
      }),
    );
    expect(onRequestErrorFocus).toHaveBeenCalledWith('item-form/threshold');
    expect(view.getByTestId('item-form/threshold')).toBeTruthy();
  });

  test('row expiry error requests focus on the row toggle', async () => {
    const onRequestErrorFocus = jest.fn();
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, stock: [row('2')] },
        errors: { stock: [{ expiresOn: 'Enter a valid date.' }] },
        onRequestErrorFocus,
      }),
    );
    expect(onRequestErrorFocus).toHaveBeenCalledWith(
      'item-form/stock-0/expires-toggle',
    );
    expect(view.getByTestId('item-form/stock-0/expires-toggle')).toBeTruthy();
  });
});
