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
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { ViewProps } from 'react-native';

import type ItemFormType from '../src/components/ItemForm';
import type { ItemFormProps, ItemFormValues } from '../src/components/ItemForm';
import i18n from '../src/i18n';
import type { Category, Location } from '../src/inventory/types';

const ItemForm = require('../src/components/ItemForm')
  .default as typeof ItemFormType;
const { firstErrorField, resolveErrorFocusTarget } =
  require('../src/components/ItemForm') as Pick<typeof ItemFormType, never> & {
    firstErrorField: (errors?: Record<string, string>) => string | null;
    resolveErrorFocusTarget: (
      field: string | null,
      locationKind?: string,
    ) => string | null;
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
  quantityRaw: '',
  location: null,
  categories: [],
  pendingNewCategoryName: '',
  stashedNewLocation: null,
};

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
  expect(view.getByTestId('item-form/quantity')).toBeTruthy();
  expect(view.getByTestId('item-form/decrement')).toBeTruthy();
  expect(view.getByTestId('item-form/increment')).toBeTruthy();
  expect(view.getByTestId('item-form/location-10')).toBeTruthy();
  expect(view.getByTestId('item-form/location-new')).toBeTruthy();
  expect(view.getByTestId('item-form/category-20')).toBeTruthy();
  expect(view.getByTestId('item-form/new-category/name')).toBeTruthy();
  expect(view.getByTestId('item-form/save')).toBeTruthy();
  expect(view.getByTestId('item-form/close')).toBeTruthy();
  expect(view.getByText('New item')).toBeTruthy();
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
  const view = await renderForm(baseProps({ onChange }));
  await fireEvent.changeText(view.getByTestId('item-form/quantity'), 'abc');
  expect(onChange).toHaveBeenCalledWith({ ...emptyValues, quantityRaw: 'abc' });
});

test('renders provided validation errors without inventing copy', async () => {
  const view = await renderForm(
    baseProps({
      errors: { name: 'Enter a name.', quantity: 'Enter a whole number.' },
    }),
  );
  expect(await view.findByTestId('item-form/error-name')).toBeTruthy();
  expect(view.getByTestId('item-form/error-quantity')).toBeTruthy();
  expect(view.getByText('Enter a name.')).toBeTruthy();
});

test('first-error focus order is name, quantity, location, categories', async () => {
  expect(firstErrorField({ quantity: 'q', name: 'n' })).toBe('name');
  expect(firstErrorField({ location: 'l', quantity: 'q' })).toBe('quantity');
  expect(firstErrorField({ categories: 'c', location: 'l' })).toBe('location');
  expect(firstErrorField({})).toBeNull();
  expect(firstErrorField(undefined)).toBeNull();
});

test('quantity zero shows exhausted copy and disables decrement', async () => {
  const view = await renderForm(
    baseProps({ values: { ...emptyValues, quantityRaw: '0' } }),
  );
  expect(await view.findByText('Exhausted')).toBeTruthy();
  expect(
    view.getByTestId('item-form/decrement').props.accessibilityState.disabled,
  ).toBe(true);
});

test('stepper emits controlled updates without touching other fields', async () => {
  const onChange = jest.fn();
  const values: ItemFormValues = {
    name: 'Rice',
    quantityRaw: '2',
    location: { kind: 'existing', locationId: 10 },
    categories: [],
    pendingNewCategoryName: '',
    stashedNewLocation: null,
  };
  const view = await renderForm(baseProps({ values, onChange }));
  await fireEvent.press(view.getByTestId('item-form/increment'));
  expect(onChange).toHaveBeenCalledWith({ ...values, quantityRaw: '3' });
  onChange.mockClear();
  await fireEvent.press(view.getByTestId('item-form/decrement'));
  expect(onChange).toHaveBeenCalledWith({ ...values, quantityRaw: '1' });
});

test.each(['', '   ', 'abc', '1.5', '-3', '9007199254740992'])(
  'null-parse quantity %p disables both steppers and preserves raw',
  async (raw) => {
    const onChange = jest.fn();
    const view = await renderForm(
      baseProps({ values: { ...emptyValues, quantityRaw: raw }, onChange }),
    );
    expect(view.getByTestId('item-form/quantity').props.value).toBe(raw);
    expect(
      view.getByTestId('item-form/increment').props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      view.getByTestId('item-form/decrement').props.accessibilityState.disabled,
    ).toBe(true);
    await fireEvent.press(view.getByTestId('item-form/increment'));
    await fireEvent.press(view.getByTestId('item-form/decrement'));
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
    baseProps({ values: { ...emptyValues, quantityRaw: '999999' }, onChange }),
  );
  expect(
    view.getByTestId('item-form/increment').props.accessibilityState.disabled,
  ).toBe(true);
  expect(
    view.getByTestId('item-form/decrement').props.accessibilityState.disabled,
  ).toBe(false);
  await fireEvent.press(view.getByTestId('item-form/decrement'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    quantityRaw: '999998',
  });
});

test('increment from valid zero reaches one without a default', async () => {
  const onChange = jest.fn();
  const view = await renderForm(
    baseProps({ values: { ...emptyValues, quantityRaw: '0' }, onChange }),
  );
  expect(
    view.getByTestId('item-form/increment').props.accessibilityState.disabled,
  ).toBe(false);
  await fireEvent.press(view.getByTestId('item-form/increment'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    quantityRaw: '1',
  });
});

test('existing location selection emits an existing draft', async () => {
  const onChange = jest.fn();
  const view = await renderForm(baseProps({ onChange }));
  await fireEvent.press(view.getByTestId('item-form/location-11'));
  expect(onChange).toHaveBeenCalledWith({
    ...emptyValues,
    location: { kind: 'existing', locationId: 11 },
  });
});

test('new location draft preserves unsaved names across mode changes', async () => {
  const view = await render(<ControlledHarness />);
  await fireEvent.press(await view.findByTestId('item-form/location-new'));
  await fireEvent.changeText(
    view.getByTestId('item-form/location-new/name'),
    'Bodega',
  );
  await fireEvent.changeText(
    view.getByTestId('item-form/location-new/address'),
    'Calle Luna 3',
  );
  await fireEvent.press(view.getByTestId('item-form/location-10'));
  expect(view.queryByTestId('item-form/location-new/name')).toBeNull();
  await fireEvent.press(view.getByTestId('item-form/location-new'));
  expect(view.getByTestId('item-form/location-new/name').props.value).toBe(
    'Bodega',
  );
  expect(view.getByTestId('item-form/location-new/address').props.value).toBe(
    'Calle Luna 3',
  );
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
    stashedNewLocation: null,
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
  const view = await renderForm(baseProps({ submitting: true }));
  const saveState = view.getByTestId('item-form/save').props.accessibilityState;
  expect(saveState.disabled).toBe(true);
  expect(saveState.busy).toBe(true);
  expect(
    view.getByTestId('item-form/close').props.accessibilityState.disabled,
  ).toBe(true);
  expect(view.getByTestId('item-form/name').props.editable).toBe(false);
  expect(view.getByTestId('item-form/quantity').props.editable).toBe(false);
  expect(
    view.getByTestId('item-form/increment').props.accessibilityState.disabled,
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
  expect(resolveErrorFocusTarget('location', undefined)).toBe(
    'item-form/error-location',
  );
  expect(resolveErrorFocusTarget('location', 'existing')).toBe(
    'item-form/error-location',
  );
  expect(resolveErrorFocusTarget('location', 'new')).toBe(
    'item-form/location-new/name',
  );
  expect(resolveErrorFocusTarget('form', undefined)).toBe(
    'item-form/error-form',
  );
  expect(resolveErrorFocusTarget(null, undefined)).toBeNull();
});

const locationFocusCases: [ItemFormValues['location'], string][] = [
  [null, 'item-form/error-location'],
  [{ kind: 'existing', locationId: 10 }, 'item-form/error-location'],
  [
    { kind: 'new', location: { name: '', address: null } },
    'item-form/location-new/name',
  ],
];
test.each(locationFocusCases)(
  'location error requests focus on mounted target for %p',
  async (location, target) => {
    const onRequestErrorFocus = jest.fn();
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, location },
        errors: { location: 'Choose or create a location.' },
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

test('new-location text survives existing switch plus remount via stash', async () => {
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
    view.getByTestId('item-form/location-new/name'),
    'Bodega',
  );
  await fireEvent.changeText(
    view.getByTestId('item-form/location-new/address'),
    'Calle Luna 3',
  );
  await fireEvent.press(view.getByTestId('item-form/location-10'));
  expect(retained.location).toEqual({
    kind: 'existing',
    locationId: 10,
  });
  expect(retained.stashedNewLocation).toEqual({
    name: 'Bodega',
    address: 'Calle Luna 3',
  });
  // Key change forces a true remount: state re-initializes from props.
  await view.rerender(<RemountHarness key="b" initial={retained} />);
  await fireEvent.press(await view.findByTestId('item-form/location-new'));
  expect(view.getByTestId('item-form/location-new/name').props.value).toBe(
    'Bodega',
  );
  expect(view.getByTestId('item-form/location-new/address').props.value).toBe(
    'Calle Luna 3',
  );
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
    const view = await renderForm(baseProps({ onFieldBlur }));
    await fireEvent(view.getByTestId('item-form/name'), 'blur');
    expect(onFieldBlur).toHaveBeenCalledWith('name');
    await fireEvent(view.getByTestId('item-form/quantity'), 'blur');
    expect(onFieldBlur).toHaveBeenCalledWith('quantity');
    expect(onFieldBlur).toHaveBeenCalledTimes(2);
  });

  test('absent callback stays a true no-op on blur', async () => {
    const view = await renderForm(baseProps({}));
    await expect(
      (async () => {
        await fireEvent(view.getByTestId('item-form/name'), 'blur');
        await fireEvent(view.getByTestId('item-form/quantity'), 'blur');
      })(),
    ).resolves.toBeUndefined();
  });

  test('blur is not fired while submitting', async () => {
    const onFieldBlur = jest.fn();
    const view = await renderForm(baseProps({ onFieldBlur, submitting: true }));
    await fireEvent(view.getByTestId('item-form/name'), 'blur');
    await fireEvent(view.getByTestId('item-form/quantity'), 'blur');
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
          quantityRaw: '2',
          categories: [{ kind: 'new', category: { name: 'Grains' } }],
        },
      }),
    );
    expect(view.getByTestId('item-form/decrement')).toHaveTextContent('−');
    expect(view.getByTestId('item-form/increment')).toHaveTextContent('+');
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
        values: { ...emptyValues, quantityRaw: '1000000' },
        onChange,
      }),
    );
    // Raw text is never coerced or clamped.
    expect(view.getByTestId('item-form/quantity').props.value).toBe('1000000');
    expect(
      view.getByTestId('item-form/increment').props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      view.getByTestId('item-form/decrement').props.accessibilityState.disabled,
    ).toBe(true);
    await fireEvent.press(view.getByTestId('item-form/increment'));
    await fireEvent.press(view.getByTestId('item-form/decrement'));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('RED: stepper caps at 999999 and keeps its 0 floor', async () => {
    const onChange = jest.fn();
    const view = await renderForm(
      baseProps({
        values: { ...emptyValues, quantityRaw: '999999' },
        onChange,
      }),
    );
    expect(
      view.getByTestId('item-form/increment').props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      view.getByTestId('item-form/decrement').props.accessibilityState.disabled,
    ).toBe(false);
    await fireEvent.press(view.getByTestId('item-form/increment'));
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.press(view.getByTestId('item-form/decrement'));
    expect(onChange).toHaveBeenCalledWith({
      ...emptyValues,
      quantityRaw: '999998',
    });
  });
});
