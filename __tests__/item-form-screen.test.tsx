/**
 * U2b ItemFormScreen unit (Jest/RNTL only, no device proof).
 *
 * Covers the modal host over the real `useItemFormController` with the
 * repository boundary mocked: create renders without touching the DB, save
 * success notifies `onSaved` then `onDismiss` in order, save failure maps
 * the coded error to localized copy and stays open, edit prefills from the
 * loaded detail, load failure offers retry + close and retry reloads,
 * discard and delete overlays behave (cancel keeps, confirm fires), and
 * the ItemForm delete button reaches the controller's delete request.
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
import type { RepositoryDb } from '../src/inventory/database';
import type { ItemDetail } from '../src/inventory/types';
import type ItemFormScreenType from '../src/screens/ItemFormScreen';
import type { ItemFormRoute } from '../src/screens/useItemFormController';

const ItemFormScreen = require('../src/screens/ItemFormScreen')
  .default as typeof ItemFormScreenType;

const repository = require('../src/inventory/itemRepository') as {
  getItem: jest.Mock;
  createItemFromDraft: jest.Mock;
  updateItemFromDraft: jest.Mock;
  deleteItem: jest.Mock;
};

jest.mock('../src/inventory/itemRepository', () => ({
  getItem: jest.fn(),
  createItemFromDraft: jest.fn(),
  updateItemFromDraft: jest.fn(),
  deleteItem: jest.fn(),
}));

jest.mock('../src/screens/useReducedMotion', () => ({
  __esModule: true,
  default: jest.fn(() => false),
}));

const mockReducedMotion = require('../src/screens/useReducedMotion')
  .default as jest.Mock;

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

const fakeDb = {} as RepositoryDb;

const pantry = { id: 10, name: 'Pantry', address: null, created_at: 'ts-10' };

const riceDetail: ItemDetail = {
  id: 1,
  name: 'Rice',
  quantity: 2,
  locationId: 10,
  location: { ...pantry },
  categoryIds: [],
  categories: [],
  created_at: 'created-1',
};

function defaultMocks(): void {
  repository.getItem.mockResolvedValue({ ...riceDetail });
  repository.createItemFromDraft.mockResolvedValue({ ...riceDetail });
  repository.updateItemFromDraft.mockResolvedValue({ ...riceDetail });
  repository.deleteItem.mockResolvedValue(undefined);
}

async function renderScreen(options: {
  route: ItemFormRoute;
  onSaved?: (detail: ItemDetail) => void;
  onDeleted?: (id: number) => void;
  onDismiss?: () => void;
}) {
  const onSaved = options.onSaved ?? jest.fn();
  const onDeleted = options.onDeleted ?? jest.fn();
  const onDismiss = options.onDismiss ?? jest.fn();
  await render(
    <I18nextProvider i18n={i18n}>
      <ItemFormScreen
        db={fakeDb}
        route={options.route}
        locations={[{ ...pantry }]}
        categories={[]}
        onSaved={onSaved}
        onDeleted={onDeleted}
        onDismiss={onDismiss}
      />
    </I18nextProvider>,
  );
  return { onSaved, onDeleted, onDismiss };
}

/** Fill a valid create form: name + quantity + existing location. */
async function fillValidCreateForm(): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('item-form/name'), 'Rice');
  await fireEvent.changeText(screen.getByTestId('item-form/quantity'), '2');
  await fireEvent.press(screen.getByTestId('item-form/location-10'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReducedMotion.mockReturnValue(false);
  defaultMocks();
});

afterEach(async () => {
  await cleanup();
  await i18n.changeLanguage('en');
});

test('create route renders the form and touches nothing on mount', async () => {
  await renderScreen({ route: { kind: 'create' } });
  expect(await screen.findByTestId('item-form/name')).toBeTruthy();
  expect(screen.getByTestId('item-form/save')).toBeTruthy();
  expect(screen.queryByTestId('item-form/delete')).toBeNull();
  expect(repository.getItem).not.toHaveBeenCalled();
  expect(repository.createItemFromDraft).not.toHaveBeenCalled();
  expect(repository.updateItemFromDraft).not.toHaveBeenCalled();
  expect(repository.deleteItem).not.toHaveBeenCalled();
});

test('save success calls onSaved then onDismiss in order', async () => {
  const onSaved = jest.fn();
  const onDismiss = jest.fn();
  await renderScreen({
    route: { kind: 'create' },
    onSaved,
    onDismiss,
  });
  await screen.findByTestId('item-form/name');
  await fillValidCreateForm();
  await fireEvent.press(screen.getByTestId('item-form/save'));
  expect(repository.createItemFromDraft).toHaveBeenCalledTimes(1);
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onSaved.mock.invocationCallOrder[0]).toBeLessThan(
    onDismiss.mock.invocationCallOrder[0],
  );
});

test('save failure shows the mapped form message and stays open', async () => {
  repository.createItemFromDraft.mockRejectedValueOnce(new Error('boom'));
  const onDismiss = jest.fn();
  await renderScreen({
    route: { kind: 'create' },
    onDismiss,
  });
  await screen.findByTestId('item-form/name');
  await fillValidCreateForm();
  await fireEvent.press(screen.getByTestId('item-form/save'));
  expect(await screen.findByTestId('item-form/error-form')).toBeTruthy();
  expect(
    screen.getByText('Something went wrong. Please try again.'),
  ).toBeTruthy();
  expect(screen.queryByText('boom')).toBeNull();
  expect(onDismiss).not.toHaveBeenCalled();
  // Still open: the form fields remain mounted.
  expect(screen.getByTestId('item-form/name')).toBeTruthy();
});

test('edit route loads and prefills the form', async () => {
  await renderScreen({ route: { kind: 'edit', itemId: 1 } });
  expect(await screen.findByTestId('item-form/name')).toBeTruthy();
  expect(repository.getItem).toHaveBeenCalledTimes(1);
  expect(repository.getItem).toHaveBeenCalledWith(fakeDb, 1);
  expect(screen.getByTestId('item-form/name').props.value).toBe('Rice');
  expect(screen.getByTestId('item-form/quantity').props.value).toBe('2');
  expect(screen.getByTestId('item-form/delete')).toBeTruthy();
});

test('edit-load failure shows retry and retry reloads', async () => {
  repository.getItem.mockRejectedValueOnce(new Error('gone'));
  await renderScreen({ route: { kind: 'edit', itemId: 1 } });
  expect(await screen.findByTestId('item-form-screen/retry')).toBeTruthy();
  expect(screen.getByTestId('item-form-screen/load-error')).toBeTruthy();
  expect(screen.queryByText('gone')).toBeNull();
  expect(screen.queryByTestId('item-form/name')).toBeNull();

  await fireEvent.press(screen.getByTestId('item-form-screen/retry'));
  expect(await screen.findByTestId('item-form/name')).toBeTruthy();
  expect(repository.getItem).toHaveBeenCalledTimes(2);
});

test('discard overlay appears only when dirty; Cancel keeps, Discard dismisses', async () => {
  const onDismiss = jest.fn();
  await renderScreen({
    route: { kind: 'create' },
    onDismiss,
  });
  await screen.findByTestId('item-form/name');

  // Clean form: close dismisses immediately with no overlay.
  await fireEvent.press(screen.getByTestId('item-form/close'));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('item-form-screen/discard-dialog')).toBeNull();
  onDismiss.mockClear();

  // Dirty form: close arms the overlay instead of dismissing.
  await fireEvent.changeText(screen.getByTestId('item-form/name'), 'Quinoa');
  await fireEvent.press(screen.getByTestId('item-form/close'));
  expect(onDismiss).not.toHaveBeenCalled();
  expect(
    await screen.findByTestId('item-form-screen/discard-dialog'),
  ).toBeTruthy();

  // Cancel keeps the form with its input intact.
  await fireEvent.press(screen.getByTestId('item-form-screen/discard-cancel'));
  expect(screen.queryByTestId('item-form-screen/discard-dialog')).toBeNull();
  expect(screen.getByTestId('item-form/name').props.value).toBe('Quinoa');
  expect(onDismiss).not.toHaveBeenCalled();

  // Discard dismisses.
  await fireEvent.press(screen.getByTestId('item-form/close'));
  await fireEvent.press(screen.getByTestId('item-form-screen/discard-confirm'));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test('delete overlay names the item; Cancel closes it, Delete notifies in order', async () => {
  const onDeleted = jest.fn();
  const onDismiss = jest.fn();
  await renderScreen({
    route: { kind: 'edit', itemId: 1 },
    onDeleted,
    onDismiss,
  });
  await screen.findByTestId('item-form/delete');

  await fireEvent.press(screen.getByTestId('item-form/delete'));
  const dialog = await screen.findByTestId('item-form-screen/delete-dialog');
  expect(dialog).toBeTruthy();
  expect(screen.getByTestId('item-form-screen/delete-title')).toHaveTextContent(
    /Rice/,
  );

  await fireEvent.press(screen.getByTestId('item-form-screen/delete-cancel'));
  expect(screen.queryByTestId('item-form-screen/delete-dialog')).toBeNull();
  expect(repository.deleteItem).not.toHaveBeenCalled();
  expect(screen.getByTestId('item-form/name')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('item-form/delete'));
  await screen.findByTestId('item-form-screen/delete-dialog');
  await fireEvent.press(screen.getByTestId('item-form-screen/delete-confirm'));
  expect(repository.deleteItem).toHaveBeenCalledWith(fakeDb, 1);
  expect(onDeleted).toHaveBeenCalledWith(1);
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onDeleted.mock.invocationCallOrder[0]).toBeLessThan(
    onDismiss.mock.invocationCallOrder[0],
  );
});

test('the ItemForm delete button reaches the controller delete request', async () => {
  await renderScreen({ route: { kind: 'edit', itemId: 1 } });
  const deleteButton = await screen.findByTestId('item-form/delete');
  expect(deleteButton.props.accessibilityLabel).toBe('Delete item');
  await fireEvent.press(deleteButton);
  // The controller armed its confirm: the overlay (not a nested Modal) shows.
  expect(
    await screen.findByTestId('item-form-screen/delete-dialog'),
  ).toBeTruthy();
  // The modal trap hides the form from the accessibility tree until the
  // dialog closes; it is still mounted behind the overlay.
  expect(screen.queryByTestId('item-form/name')).toBeNull();
  expect(
    screen.getByTestId('item-form/name', { includeHiddenElements: true }),
  ).toBeTruthy();
});

test('M4: blur on an invalid name shows the inline message without submitting', async () => {
  await renderScreen({ route: { kind: 'create' } });
  await screen.findByTestId('item-form/name');
  await fireEvent.changeText(screen.getByTestId('item-form/name'), '   ');
  await fireEvent(screen.getByTestId('item-form/name'), 'blur');
  expect(await screen.findByTestId('item-form/error-name')).toBeTruthy();
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  expect(repository.createItemFromDraft).not.toHaveBeenCalled();
  expect(repository.updateItemFromDraft).not.toHaveBeenCalled();
});

test('M4-LOAD: edit route shows a loading surface with no editable fields until the load resolves', async () => {
  let resolveLoad!: (detail: ItemDetail) => void;
  repository.getItem.mockImplementationOnce(
    () =>
      new Promise<ItemDetail>((resolve) => {
        resolveLoad = resolve;
      }),
  );
  await renderScreen({ route: { kind: 'edit', itemId: 1 } });
  // Loading surface present; no editable input may be mounted while the
  // blank reset session is showing, or typed input would be discarded.
  expect(await screen.findByTestId('item-form/loading')).toBeTruthy();
  expect(screen.getByText('Loading the item…')).toBeTruthy();
  expect(screen.queryByTestId('item-form/name')).toBeNull();
  expect(screen.queryByTestId('item-form/quantity')).toBeNull();
  expect(screen.getByTestId('item-form/loading-close')).toBeTruthy();
  await act(async () => {
    resolveLoad({ ...riceDetail });
  });
  expect(await screen.findByTestId('item-form/name')).toBeTruthy();
  expect(screen.getByTestId('item-form/name').props.value).toBe('Rice');
  expect(screen.getByTestId('item-form/quantity').props.value).toBe('2');
  expect(screen.queryByTestId('item-form/loading')).toBeNull();
});

test('M4-LOAD: close from the loading surface dismisses without loading the form', async () => {
  const onDismiss = jest.fn();
  repository.getItem.mockImplementationOnce(
    () => new Promise<ItemDetail>(() => {}),
  );
  await renderScreen({ route: { kind: 'edit', itemId: 1 }, onDismiss });
  expect(await screen.findByTestId('item-form/loading')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('item-form/loading-close'));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('item-form/name')).toBeNull();
});

test('M4-LOAD: create route never shows the loading surface', async () => {
  await renderScreen({ route: { kind: 'create' } });
  expect(await screen.findByTestId('item-form/name')).toBeTruthy();
  expect(screen.queryByTestId('item-form/loading')).toBeNull();
});

describe('P5a action states, confirmation hints, dialog roles, reduced motion', () => {
  test('load-error retry and close expose an enabled state', async () => {
    repository.getItem.mockRejectedValueOnce(new Error('gone'));
    await renderScreen({ route: { kind: 'edit', itemId: 1 } });
    expect(await screen.findByTestId('item-form-screen/retry')).toBeTruthy();
    expect(
      screen.getByTestId('item-form-screen/retry').props.accessibilityState,
    ).toMatchObject({ disabled: false });
    expect(
      screen.getByTestId('item-form-screen/load-close').props
        .accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  test('loading close exposes an enabled state while the load is in flight', async () => {
    repository.getItem.mockImplementationOnce(
      () => new Promise<ItemDetail>(() => {}),
    );
    await renderScreen({ route: { kind: 'edit', itemId: 1 } });
    expect(await screen.findByTestId('item-form/loading')).toBeTruthy();
    expect(
      screen.getByTestId('item-form/loading-close').props.accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  test('discard dialog carries an alert role with a name; confirm has state and hint', async () => {
    await renderScreen({ route: { kind: 'create' } });
    await screen.findByTestId('item-form/name');
    await fireEvent.changeText(screen.getByTestId('item-form/name'), 'Quinoa');
    await fireEvent.press(screen.getByTestId('item-form/close'));
    const dialog = await screen.findByTestId('item-form-screen/discard-dialog');
    expect(dialog.props.accessibilityRole).toBe('alert');
    expect(String(dialog.props.accessibilityLabel ?? '')).toMatch(/discard/i);
    expect(
      screen.getByTestId('item-form-screen/discard-cancel').props
        .accessibilityState,
    ).toMatchObject({ disabled: false });
    const confirm = screen.getByTestId('item-form-screen/discard-confirm');
    expect(confirm.props.accessibilityState).toMatchObject({
      disabled: false,
    });
    expect(String(confirm.props.accessibilityHint ?? '')).toMatch(
      /unsaved|lost/i,
    );
  });

  test('delete dialog carries an alert role with a name; confirm has state and hint', async () => {
    await renderScreen({ route: { kind: 'edit', itemId: 1 } });
    await screen.findByTestId('item-form/delete');
    await fireEvent.press(screen.getByTestId('item-form/delete'));
    const dialog = await screen.findByTestId('item-form-screen/delete-dialog');
    expect(dialog.props.accessibilityRole).toBe('alert');
    expect(String(dialog.props.accessibilityLabel ?? '')).toMatch(/Rice/);
    expect(
      screen.getByTestId('item-form-screen/delete-cancel').props
        .accessibilityState,
    ).toMatchObject({ disabled: false });
    const confirm = screen.getByTestId('item-form-screen/delete-confirm');
    expect(confirm.props.accessibilityState).toMatchObject({
      disabled: false,
      busy: false,
    });
    expect(String(confirm.props.accessibilityHint ?? '')).toMatch(/undone/i);
  });

  test('delete confirm reports busy while the delete is in flight', async () => {
    let resolveDelete!: () => void;
    repository.deleteItem.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    await renderScreen({ route: { kind: 'edit', itemId: 1 } });
    await screen.findByTestId('item-form/delete');
    await fireEvent.press(screen.getByTestId('item-form/delete'));
    await screen.findByTestId('item-form-screen/delete-dialog');
    await fireEvent.press(
      screen.getByTestId('item-form-screen/delete-confirm'),
    );
    expect(
      screen.getByTestId('item-form-screen/delete-confirm').props
        .accessibilityState,
    ).toMatchObject({ disabled: true, busy: true });
    await act(async () => {
      resolveDelete();
    });
  });

  test('form modal keeps the slide animation without a reduced-motion request', async () => {
    mockReducedMotion.mockReturnValue(false);
    await renderScreen({ route: { kind: 'create' } });
    await screen.findByTestId('item-form/name');
    expect(screen.getByTestId('item-form-screen').props.animationType).toBe(
      'slide',
    );
  });

  test('form modal appears instantly when reduced motion is requested', async () => {
    mockReducedMotion.mockReturnValue(true);
    await renderScreen({ route: { kind: 'create' } });
    await screen.findByTestId('item-form/name');
    expect(screen.getByTestId('item-form-screen').props.animationType).toBe(
      'none',
    );
  });
});
