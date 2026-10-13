/**
 * Entity-management screen unit (R3/R4/R6, D6/S12 adopted).
 *
 * Covers create/rename/delete for both entity kinds through the REAL
 * domain repository functions (no new data layer), the two impact
 * confirmations with honest copy (stock rows removed but items survive;
 * category association removed but items survive), the typed conflict
 * error surfaced as localized inline copy, and the delete paths.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import { I18nextProvider } from 'react-i18next';
import type { ViewProps } from 'react-native';
import type EntityManagerType from '../src/components/EntityManager';
import i18n from '../src/i18n';
import { EntityConflictError } from '../src/inventory/errors';

const EntityManager = require('../src/components/EntityManager')
  .default as typeof EntityManagerType;

const repository = require('../src/inventory/entityRepository') as {
  createLocation: jest.Mock;
  updateLocation: jest.Mock;
  deleteLocation: jest.Mock;
  createCategory: jest.Mock;
  updateCategory: jest.Mock;
  deleteCategory: jest.Mock;
  locationDeleteImpact: jest.Mock;
  categoryDeleteImpact: jest.Mock;
};

jest.mock('../src/inventory/entityRepository', () => ({
  createLocation: jest.fn(),
  updateLocation: jest.fn(),
  deleteLocation: jest.fn(),
  createCategory: jest.fn(),
  updateCategory: jest.fn(),
  deleteCategory: jest.fn(),
  locationDeleteImpact: jest.fn(),
  categoryDeleteImpact: jest.fn(),
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

const pantry = { id: 10, name: 'Pantry', address: null, created_at: 't-10' };
const fridge = { id: 11, name: 'Fridge', address: null, created_at: 't-11' };
const bulk = { id: 20, name: 'Bulk', created_at: 't-20' };

const db = {} as never;

function renderManager(
  overrides: Partial<React.ComponentProps<typeof EntityManager>> = {},
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <EntityManager
        db={db}
        locations={[pantry, fridge]}
        categories={[bulk]}
        onChanged={jest.fn()}
        onClose={jest.fn()}
        {...overrides}
      />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  repository.locationDeleteImpact.mockResolvedValue({
    stockRows: 3,
    unstockedItems: 1,
  });
  repository.categoryDeleteImpact.mockResolvedValue({ items: 2 });
  repository.createLocation.mockImplementation(
    async (_db: unknown, input: { name: string }) => ({
      id: 99,
      name: input.name,
      address: null,
      created_at: 't-99',
    }),
  );
  repository.createCategory.mockImplementation(
    async (_db: unknown, input: { name: string }) => ({
      id: 99,
      name: input.name,
      created_at: 't-99',
    }),
  );
  repository.updateLocation.mockImplementation(
    async (_db: unknown, id: number, input: { name: string }) => ({
      id,
      name: input.name,
      address: null,
      created_at: 't-u',
    }),
  );
  repository.updateCategory.mockImplementation(
    async (_db: unknown, id: number, input: { name: string }) => ({
      id,
      name: input.name,
      created_at: 't-u',
    }),
  );
  repository.deleteLocation.mockResolvedValue(undefined);
  repository.deleteCategory.mockResolvedValue(undefined);
});

afterEach(async () => {
  await cleanup();
});

test('renders both entity lists with accessible controls', async () => {
  await renderManager();
  expect(await screen.findByTestId('entity-manager')).toBeTruthy();
  expect(screen.getByTestId('entity-location-10')).toBeTruthy();
  expect(screen.getByTestId('entity-location-11')).toBeTruthy();
  expect(screen.getByTestId('entity-category-20')).toBeTruthy();
  expect(screen.getByTestId('entity-add-location')).toBeTruthy();
  expect(screen.getByTestId('entity-add-category')).toBeTruthy();
  expect(screen.getByTestId('entity-close')).toBeTruthy();
  expect(
    screen.getByTestId('entity-add-location').props.accessibilityLabel,
  ).toBeTruthy();
  expect(
    screen.getByTestId('entity-close').props.accessibilityLabel,
  ).toBeTruthy();
});

test('creating a location calls createLocation and notifies the owner', async () => {
  const onChanged = jest.fn();
  await renderManager({ onChanged });
  await fireEvent.changeText(
    screen.getByTestId('entity-new-location-name'),
    'Cellar',
  );
  await fireEvent.press(screen.getByTestId('entity-add-location'));
  expect(repository.createLocation).toHaveBeenCalledTimes(1);
  expect(repository.createLocation).toHaveBeenCalledWith(db, {
    name: 'Cellar',
    address: null,
  });
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test('creating a category calls createCategory and notifies the owner', async () => {
  const onChanged = jest.fn();
  await renderManager({ onChanged });
  await fireEvent.changeText(
    screen.getByTestId('entity-new-category-name'),
    'Grains',
  );
  await fireEvent.press(screen.getByTestId('entity-add-category'));
  expect(repository.createCategory).toHaveBeenCalledTimes(1);
  expect(repository.createCategory).toHaveBeenCalledWith(db, {
    name: 'Grains',
  });
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test('renaming a location calls updateLocation and notifies the owner', async () => {
  const onChanged = jest.fn();
  await renderManager({ onChanged });
  await fireEvent.press(screen.getByTestId('entity-location-10-rename'));
  await fireEvent.changeText(
    screen.getByTestId('entity-edit-name'),
    'Pantry New',
  );
  await fireEvent.press(screen.getByTestId('entity-edit-save'));
  expect(repository.updateLocation).toHaveBeenCalledTimes(1);
  expect(repository.updateLocation).toHaveBeenCalledWith(
    db,
    10,
    expect.objectContaining({ name: 'Pantry New' }),
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test('renaming a category calls updateCategory and notifies the owner', async () => {
  const onChanged = jest.fn();
  await renderManager({ onChanged });
  await fireEvent.press(screen.getByTestId('entity-category-20-rename'));
  await fireEvent.changeText(
    screen.getByTestId('entity-edit-name'),
    'Bulk New',
  );
  await fireEvent.press(screen.getByTestId('entity-edit-save'));
  expect(repository.updateCategory).toHaveBeenCalledTimes(1);
  expect(repository.updateCategory).toHaveBeenCalledWith(
    db,
    20,
    expect.objectContaining({ name: 'Bulk New' }),
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test('location delete confirmation states the stock impact and that items survive', async () => {
  await renderManager();
  await fireEvent.press(screen.getByTestId('entity-location-10-delete'));
  expect(repository.locationDeleteImpact).toHaveBeenCalledWith(db, 10);
  const dialog = await screen.findByTestId('entity-delete-dialog');
  expect(dialog).toBeTruthy();
  expect(screen.getByTestId('entity-delete-title')).toHaveTextContent(/Pantry/);
  const message = screen.getByTestId('entity-delete-message');
  expect(message).toHaveTextContent(/3/);
  expect(message).toHaveTextContent(/3 stock entries will be removed/);
  expect(message).toHaveTextContent(/will NOT be deleted/i);
  expect(message).toHaveTextContent(/1 item will be left with no stock/);
  expect(message).toHaveTextContent(/stay visible as out of stock/i);
});

test('location delete confirmation uses singular copy for one stock row and one unstocked item', async () => {
  repository.locationDeleteImpact.mockResolvedValue({
    stockRows: 1,
    unstockedItems: 1,
  });
  await i18n.changeLanguage('en');
  await renderManager();
  await fireEvent.press(screen.getByTestId('entity-location-10-delete'));
  const message = await screen.findByTestId('entity-delete-message');
  expect(message).toHaveTextContent(/1 stock entry will be removed/);
  expect(message).not.toHaveTextContent(/1 stock entries/);
  expect(message).toHaveTextContent(/will NOT be deleted/);
  expect(message).toHaveTextContent(/1 item will be left with no stock/);
  expect(message).not.toHaveTextContent(/1 items will/);
  expect(message).toHaveTextContent(/stay visible as out of stock/);
  await cleanup();
  await i18n.changeLanguage('es');
  await renderManager();
  await fireEvent.press(screen.getByTestId('entity-location-10-delete'));
  const esMessage = await screen.findByTestId('entity-delete-message');
  expect(esMessage).toHaveTextContent(/Se eliminará 1 existencia/);
  expect(esMessage).toHaveTextContent(/NO se eliminarán/);
  expect(esMessage).toHaveTextContent(/1 artículo quedará sin stock/);
  expect(esMessage).toHaveTextContent(/seguirá visible como sin stock/);
  await cleanup();
  await i18n.changeLanguage('en');
});

test('category delete confirmation uses singular copy for one linked item', async () => {
  repository.categoryDeleteImpact.mockResolvedValue({ items: 1 });
  await i18n.changeLanguage('en');
  await renderManager();
  await fireEvent.press(screen.getByTestId('entity-category-20-delete'));
  const message = await screen.findByTestId('entity-delete-message');
  expect(message).toHaveTextContent(/from 1 item\./);
  expect(message).not.toHaveTextContent(/from 1 items/);
  expect(message).toHaveTextContent(/will NOT be deleted/);
  await cleanup();
  await i18n.changeLanguage('es');
  await renderManager();
  await fireEvent.press(screen.getByTestId('entity-category-20-delete'));
  const esMessage = await screen.findByTestId('entity-delete-message');
  expect(esMessage).toHaveTextContent(/de 1 artículo\./);
  expect(esMessage).toHaveTextContent(/NO se eliminarán/);
  await cleanup();
  await i18n.changeLanguage('en');
});

test('confirming a location delete removes it and notifies the owner', async () => {
  const onChanged = jest.fn();
  await renderManager({ onChanged });
  await fireEvent.press(screen.getByTestId('entity-location-10-delete'));
  await screen.findByTestId('entity-delete-dialog');
  await fireEvent.press(screen.getByTestId('entity-delete-confirm'));
  expect(repository.deleteLocation).toHaveBeenCalledTimes(1);
  expect(repository.deleteLocation).toHaveBeenCalledWith(db, 10);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('entity-delete-dialog')).toBeNull();
});

test('category delete confirmation states the association impact and that items survive', async () => {
  await renderManager();
  await fireEvent.press(screen.getByTestId('entity-category-20-delete'));
  expect(repository.categoryDeleteImpact).toHaveBeenCalledWith(db, 20);
  const dialog = await screen.findByTestId('entity-delete-dialog');
  expect(dialog).toBeTruthy();
  expect(screen.getByTestId('entity-delete-title')).toHaveTextContent(/Bulk/);
  const message = screen.getByTestId('entity-delete-message');
  expect(message).toHaveTextContent(/from 2 items\./);
  expect(message).toHaveTextContent(/will NOT be deleted/i);
});

test('confirming a category delete removes it and notifies the owner', async () => {
  const onChanged = jest.fn();
  await renderManager({ onChanged });
  await fireEvent.press(screen.getByTestId('entity-category-20-delete'));
  await screen.findByTestId('entity-delete-dialog');
  await fireEvent.press(screen.getByTestId('entity-delete-confirm'));
  expect(repository.deleteCategory).toHaveBeenCalledTimes(1);
  expect(repository.deleteCategory).toHaveBeenCalledWith(db, 20);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

test('cancelling a delete keeps the entity and closes the dialog', async () => {
  await renderManager();
  await fireEvent.press(screen.getByTestId('entity-location-10-delete'));
  await screen.findByTestId('entity-delete-dialog');
  await fireEvent.press(screen.getByTestId('entity-delete-cancel'));
  expect(repository.deleteLocation).not.toHaveBeenCalled();
  expect(screen.queryByTestId('entity-delete-dialog')).toBeNull();
  expect(screen.getByTestId('entity-location-10')).toBeTruthy();
});

test('a conflicting location name surfaces localized inline copy, never raw storage text', async () => {
  repository.createLocation.mockRejectedValueOnce(
    new EntityConflictError('location', 'Pantry'),
  );
  await renderManager();
  await fireEvent.changeText(
    screen.getByTestId('entity-new-location-name'),
    'Pantry',
  );
  await fireEvent.press(screen.getByTestId('entity-add-location'));
  const error = await screen.findByTestId('entity-location-form-error');
  expect(error).toHaveTextContent(/already exists/i);
  expect(error).not.toHaveTextContent(/sqlite|constraint/i);
});

test('a conflicting category name surfaces localized inline copy', async () => {
  repository.createCategory.mockRejectedValueOnce(
    new EntityConflictError('category', 'Bulk'),
  );
  await renderManager();
  await fireEvent.changeText(
    screen.getByTestId('entity-new-category-name'),
    'Bulk',
  );
  await fireEvent.press(screen.getByTestId('entity-add-category'));
  const error = await screen.findByTestId('entity-category-form-error');
  expect(error).toHaveTextContent(/already exists/i);
});

test('an over-long location name surfaces the localized bound copy', async () => {
  await renderManager();
  await fireEvent.changeText(
    screen.getByTestId('entity-new-location-name'),
    'x'.repeat(81),
  );
  await fireEvent.press(screen.getByTestId('entity-add-location'));
  const error = await screen.findByTestId('entity-location-form-error');
  expect(error).toHaveTextContent(/80 characters/i);
  expect(repository.createLocation).not.toHaveBeenCalled();
});

test('close notifies the owner', async () => {
  const onClose = jest.fn();
  await renderManager({ onClose });
  await fireEvent.press(screen.getByTestId('entity-close'));
  expect(onClose).toHaveBeenCalledTimes(1);
});
