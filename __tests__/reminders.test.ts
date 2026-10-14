/**
 * U4 local reminders (S4: entirely on device, no network, no push).
 *
 * Pure decision logic lives in `src/notifications/reminders.ts` (no
 * scheduling calls); the `useReminders` hook wraps `expo-notifications`
 * and is exercised here with a mocked native boundary. The mocks prove
 * the app's decisions (when to fire, what to schedule/cancel, and that a
 * denied permission silences everything without breaking anything else).
 * They do NOT prove real delivery, the OS permission dialog, or actual
 * scheduled firing on a device — those need a native run.
 */
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

import { renderHook, waitFor } from '@testing-library/react-native';
import * as React from 'react';
import { I18nextProvider } from 'react-i18next';

import i18n from '../src/i18n';
import type { ItemDetail } from '../src/inventory/types';
import {
  expiryDateForNotification,
  expiryKeysForDetail,
  expiryNotificationKey,
  shouldNotifyLowStock,
} from '../src/notifications/reminders';
import { useReminders } from '../src/notifications/useReminders';

const Notifications = require('expo-notifications') as {
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
  scheduleNotificationAsync: jest.Mock;
  cancelScheduledNotificationAsync: jest.Mock;
  setNotificationChannelAsync: jest.Mock;
};

function detailWith(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id: 1,
    name: 'Rice',
    lowStockThreshold: 2,
    barcode: null,
    stock: [],
    totalQuantity: 0,
    categoryIds: [],
    categories: [],
    created_at: 'created-1',
    ...overrides,
  };
}

function stockRow(locationId: number, quantity: number, expiresOn?: string) {
  return {
    locationId,
    location: {
      id: locationId,
      name: `Place ${locationId}`,
      address: null,
      created_at: `loc-created-${locationId}`,
    },
    quantity,
    ...(expiresOn === undefined ? {} : { expiresOn }),
  };
}

function grantPermission(): void {
  Notifications.getPermissionsAsync.mockResolvedValue({
    granted: true,
    canAskAgain: true,
  });
}

function denyPermission(): void {
  Notifications.getPermissionsAsync.mockResolvedValue({
    granted: false,
    canAskAgain: false,
  });
  Notifications.requestPermissionsAsync.mockResolvedValue({
    granted: false,
    canAskAgain: false,
  });
}

async function renderReminders(enabled = true) {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(I18nextProvider, { i18n }, children);
  return renderHook(() => useReminders({ enabled }), { wrapper });
}

beforeEach(() => {
  jest.clearAllMocks();
  grantPermission();
  Notifications.requestPermissionsAsync.mockResolvedValue({
    granted: true,
    canAskAgain: true,
  });
  Notifications.scheduleNotificationAsync.mockResolvedValue('scheduled-id');
  Notifications.cancelScheduledNotificationAsync.mockResolvedValue(undefined);
});

describe('low-stock crossing rule (pure)', () => {
  test('crossing from above to at-or-below the threshold fires', () => {
    expect(
      shouldNotifyLowStock({ previousTotal: 5, nextTotal: 2, threshold: 2 }),
    ).toBe(true);
    // Exactly at the threshold counts as crossing (at or below).
    expect(
      shouldNotifyLowStock({ previousTotal: 3, nextTotal: 3, threshold: 3 }),
    ).toBe(false);
    expect(
      shouldNotifyLowStock({ previousTotal: 4, nextTotal: 3, threshold: 3 }),
    ).toBe(true);
  });

  test('staying below the threshold does not fire again', () => {
    expect(
      shouldNotifyLowStock({ previousTotal: 2, nextTotal: 1, threshold: 2 }),
    ).toBe(false);
    expect(
      shouldNotifyLowStock({ previousTotal: 1, nextTotal: 1, threshold: 2 }),
    ).toBe(false);
    // Restocking above the threshold is not a low-stock event either.
    expect(
      shouldNotifyLowStock({ previousTotal: 1, nextTotal: 9, threshold: 2 }),
    ).toBe(false);
  });

  test('an item without a threshold never fires', () => {
    expect(
      shouldNotifyLowStock({ previousTotal: 9, nextTotal: 0, threshold: null }),
    ).toBe(false);
    expect(
      shouldNotifyLowStock({
        previousTotal: 9,
        nextTotal: 0,
        threshold: undefined,
      }),
    ).toBe(false);
  });

  test('a first sighting at or below the threshold fires, above does not', () => {
    expect(
      shouldNotifyLowStock({
        previousTotal: undefined,
        nextTotal: 1,
        threshold: 2,
      }),
    ).toBe(true);
    expect(
      shouldNotifyLowStock({
        previousTotal: undefined,
        nextTotal: 5,
        threshold: 2,
      }),
    ).toBe(false);
  });
});

describe('expiry scheduling helpers (pure)', () => {
  test('a valid ISO date maps to a 09:00 local trigger on that day', () => {
    const date = expiryDateForNotification('2030-04-15');
    expect(date).not.toBeNull();
    expect(date?.getFullYear()).toBe(2030);
    expect(date?.getMonth()).toBe(3);
    expect(date?.getDate()).toBe(15);
    expect(date?.getHours()).toBe(9);
    expect(date?.getMinutes()).toBe(0);
  });

  test('absent or misshapen expiry never schedules', () => {
    expect(expiryDateForNotification(null)).toBeNull();
    expect(expiryDateForNotification(undefined)).toBeNull();
    expect(expiryDateForNotification('')).toBeNull();
    expect(expiryDateForNotification('15/04/2030')).toBeNull();
    expect(expiryDateForNotification('2030-13-40')).toBeNull();
    expect(expiryDateForNotification('not-a-date')).toBeNull();
  });

  test('notification keys are deterministic per row', () => {
    expect(expiryNotificationKey(1, 10)).toBe(expiryNotificationKey(1, 10));
    expect(expiryNotificationKey(1, 10)).not.toBe(expiryNotificationKey(1, 11));
    expect(expiryNotificationKey(1, 10)).not.toBe(expiryNotificationKey(2, 10));
  });

  test('keys cover every stock row of the detail', () => {
    const detail = detailWith({
      stock: [stockRow(10, 2, '2030-04-15'), stockRow(11, 1)],
    });
    expect(expiryKeysForDetail(detail)).toEqual([
      expiryNotificationKey(1, 10),
      expiryNotificationKey(1, 11),
    ]);
    expect(expiryKeysForDetail(detailWith({ stock: [] }))).toEqual([]);
  });
});

describe('useReminders with a granted permission', () => {
  test('a threshold crossing schedules one immediate notification', async () => {
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    Notifications.scheduleNotificationAsync.mockClear();

    await result.current.afterSave(
      detailWith({ totalQuantity: 5 }),
      detailWith({ totalQuantity: 2 }),
    );
    const immediates =
      Notifications.scheduleNotificationAsync.mock.calls.filter(
        ([request]) => (request as { trigger: unknown }).trigger === null,
      );
    expect(immediates).toHaveLength(1);
    expect(
      (immediates[0][0] as { content: { body: string } }).content.body,
    ).toMatch(/Rice/);
  });

  test('re-saving an already-low item schedules nothing immediate', async () => {
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    Notifications.scheduleNotificationAsync.mockClear();

    await result.current.afterSave(
      detailWith({ totalQuantity: 2 }),
      detailWith({ totalQuantity: 1 }),
    );
    const immediates =
      Notifications.scheduleNotificationAsync.mock.calls.filter(
        ([request]) => (request as { trigger: unknown }).trigger === null,
      );
    expect(immediates).toHaveLength(0);
  });

  test('an item without a threshold never schedules an immediate notification', async () => {
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    Notifications.scheduleNotificationAsync.mockClear();

    await result.current.afterSave(
      detailWith({ totalQuantity: 9, lowStockThreshold: null }),
      detailWith({ totalQuantity: 0, lowStockThreshold: null }),
    );
    const immediates =
      Notifications.scheduleNotificationAsync.mock.calls.filter(
        ([request]) => (request as { trigger: unknown }).trigger === null,
      );
    expect(immediates).toHaveLength(0);
  });

  test('saving schedules expiry per dated row', async () => {
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    Notifications.scheduleNotificationAsync.mockClear();

    await result.current.afterSave(
      null,
      detailWith({
        totalQuantity: 9,
        lowStockThreshold: null,
        stock: [stockRow(10, 2, '2030-04-15'), stockRow(11, 1)],
      }),
    );
    const dated = Notifications.scheduleNotificationAsync.mock.calls.filter(
      ([request]) => (request as { trigger: unknown }).trigger !== null,
    );
    // Exactly the dated row, under its deterministic identifier.
    expect(dated).toHaveLength(1);
    expect((dated[0][0] as { identifier: string }).identifier).toBe(
      expiryNotificationKey(1, 10),
    );
  });

  test('re-saving cancels before re-scheduling, so no orphan survives', async () => {
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    const prev = detailWith({
      totalQuantity: 9,
      lowStockThreshold: null,
      stock: [stockRow(10, 2, '2030-04-15'), stockRow(11, 1, '2030-05-01')],
    });
    // The Fridge row lost its date; the Pantry row is gone entirely.
    const next = detailWith({
      totalQuantity: 9,
      lowStockThreshold: null,
      stock: [stockRow(11, 1)],
    });
    Notifications.cancelScheduledNotificationAsync.mockClear();
    Notifications.scheduleNotificationAsync.mockClear();

    await result.current.afterSave(prev, next);
    const cancelled: string[] =
      Notifications.cancelScheduledNotificationAsync.mock.calls.map(
        ([identifier]) => identifier as string,
      );
    // Both previous rows are cancelled, including the removed one.
    expect(cancelled).toEqual(
      expect.arrayContaining([
        expiryNotificationKey(1, 10),
        expiryNotificationKey(1, 11),
      ]),
    );
    // Nothing is scheduled for the removed row or the dateless row.
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  test('deleting cancels every row of the last-known detail and schedules nothing', async () => {
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    Notifications.cancelScheduledNotificationAsync.mockClear();
    Notifications.scheduleNotificationAsync.mockClear();

    await result.current.afterDelete(
      detailWith({
        stock: [stockRow(10, 2, '2030-04-15'), stockRow(11, 1, '2030-05-01')],
      }),
    );
    const cancelled: string[] =
      Notifications.cancelScheduledNotificationAsync.mock.calls.map(
        ([identifier]) => identifier as string,
      );
    expect(cancelled).toEqual(
      expect.arrayContaining([
        expiryNotificationKey(1, 10),
        expiryNotificationKey(1, 11),
      ]),
    );
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('useReminders with a denied permission', () => {
  test('denied permission touches nothing and resolves, leaving the app working', async () => {
    denyPermission();
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('denied'));
    Notifications.scheduleNotificationAsync.mockClear();
    Notifications.cancelScheduledNotificationAsync.mockClear();

    // A crossing save and a delete both resolve without a single
    // scheduling call: every other feature keeps working, and the app
    // says nothing it cannot deliver.
    await expect(
      result.current.afterSave(
        detailWith({ totalQuantity: 5 }),
        detailWith({
          totalQuantity: 1,
          stock: [stockRow(10, 1, '2030-04-15')],
        }),
      ),
    ).resolves.toBe('skipped');
    await expect(
      result.current.afterDelete(
        detailWith({ stock: [stockRow(10, 1, '2030-04-15')] }),
      ),
    ).resolves.toBe('skipped');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(
      Notifications.cancelScheduledNotificationAsync,
    ).not.toHaveBeenCalled();
  });

  test('a native permission failure degrades to silence, never a throw', async () => {
    Notifications.getPermissionsAsync.mockRejectedValue(
      new Error('native down'),
    );
    Notifications.requestPermissionsAsync.mockRejectedValue(
      new Error('native down'),
    );
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('denied'));
    await expect(
      result.current.afterSave(
        detailWith({ totalQuantity: 5 }),
        detailWith({ totalQuantity: 1 }),
      ),
    ).resolves.toBe('skipped');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('useReminders after an inventory import', () => {
  // Import replaces every id, so the pre-import inventory's scheduled
  // expiry keys are orphans: they must cancel, and the imported
  // inventory's own low-stock pings and expiry schedules must fire.
  const prevDetail = () =>
    detailWith({
      id: 1,
      name: 'Rice',
      lowStockThreshold: 2,
      totalQuantity: 5,
      stock: [stockRow(10, 5, '2030-04-15')],
    });
  const nextDetail = () =>
    detailWith({
      id: 7,
      name: 'Rice',
      lowStockThreshold: 2,
      totalQuantity: 1,
      stock: [stockRow(20, 1, '2031-06-01')],
    });

  test('stale keys cancel and imported keys schedule', async () => {
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    Notifications.scheduleNotificationAsync.mockClear();
    Notifications.cancelScheduledNotificationAsync.mockClear();

    await expect(
      result.current.afterImport([prevDetail()], [nextDetail()]),
    ).resolves.toBe('handled');
    // The pre-import row key cancels: it belongs to an id that no
    // longer exists after the wipe.
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      'tengo-expiry-1-10',
    );
    // The imported low item pings once (first sighting at the threshold).
    const immediates =
      Notifications.scheduleNotificationAsync.mock.calls.filter(
        ([request]) => (request as { trigger: unknown }).trigger === null,
      );
    expect(immediates).toHaveLength(1);
    expect(
      (immediates[0][0] as { content: { body: string } }).content.body,
    ).toMatch(/Rice/);
    // The imported expiry row schedules under its own new key.
    const dated = Notifications.scheduleNotificationAsync.mock.calls.find(
      ([request]) =>
        (request as { identifier?: string }).identifier === 'tengo-expiry-7-20',
    );
    expect(dated).toBeTruthy();
  });

  test('an empty import cancels stale keys and schedules nothing', async () => {
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('granted'));
    Notifications.scheduleNotificationAsync.mockClear();
    Notifications.cancelScheduledNotificationAsync.mockClear();

    await expect(result.current.afterImport([prevDetail()], [])).resolves.toBe(
      'handled',
    );
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
      'tengo-expiry-1-10',
    );
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  test('denied permission touches nothing and resolves skipped', async () => {
    denyPermission();
    const { result } = await renderReminders();
    await waitFor(() => expect(result.current.permission).toBe('denied'));
    Notifications.scheduleNotificationAsync.mockClear();
    Notifications.cancelScheduledNotificationAsync.mockClear();

    await expect(
      result.current.afterImport([prevDetail()], [nextDetail()]),
    ).resolves.toBe('skipped');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(
      Notifications.cancelScheduledNotificationAsync,
    ).not.toHaveBeenCalled();
  });
});
