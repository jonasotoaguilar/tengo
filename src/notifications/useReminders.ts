/**
 * U4 local-reminder scheduling hook (S4: no network, no push service).
 *
 * Owns the `expo-notifications` boundary: one permission step on mount
 * (which on Android 13+ is the `POST_NOTIFICATIONS` runtime prompt),
 * one Android channel, immediate low-stock pings, and per-row expiry
 * scheduling keyed by `expiryNotificationKey`. The *decisions* live in
 * `./reminders` (pure, mock-free tests); this hook only executes them
 * when `permission === 'granted'` and otherwise resolves `'skipped'`,
 * so a denied permission changes nothing else in the app and the app
 * never shows or schedules anything it cannot deliver. Every native
 * call is failure-isolated: a rejected promise degrades to silence,
 * never a throw into the save/delete flow.
 */

import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import type { ItemDetail } from '../inventory/types';
import {
  expiryDateForNotification,
  expiryKeysForDetail,
  expiryNotificationKey,
  shouldNotifyLowStock,
} from './reminders';

export type ReminderPermission = 'undetermined' | 'granted' | 'denied';

/** `'handled'` ran the reminder work; `'skipped'` left everything untouched. */
export type ReminderOutcome = 'handled' | 'skipped';

export interface UseRemindersOptions {
  /**
   * Reminders arm only for writers: read-only sessions never prompt
   * for permission and never schedule. False keeps the permission
   * state at `'undetermined'` with zero native calls.
   */
  enabled: boolean;
}

export interface RemindersApi {
  permission: ReminderPermission;
  /**
   * Run after a successful save: immediate low-stock ping on a
   * threshold crossing, then cancel-then-reschedule expiry for the
   * union of previous and current rows (so removed rows and removed
   * dates cancel instead of orphaning).
   */
  afterSave: (
    prev: ItemDetail | null,
    next: ItemDetail,
  ) => Promise<ReminderOutcome>;
  /** Run after a successful delete: cancel every row of the last-known detail. */
  afterDelete: (prev: ItemDetail | null) => Promise<ReminderOutcome>;
}

/** Single channel every reminder posts through on Android. */
export const REMINDER_CHANNEL_ID = 'tengo-reminders';

/**
 * Foreground presentation: the low-stock ping fires while the household
 * is inside the app (right after a save), so without this handler the OS
 * would deliver it silently. Best-effort at import: under Jest the
 * native boundary is a mock and this is a no-op.
 */
try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
} catch {
  // Native boundary unavailable: the permission effect below stays
  // honest (`'denied'`) and every entry point resolves `'skipped'`.
}

/** A rejected native call degrades to silence, never a throw upstream. */
async function bestEffort<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

export function useReminders({ enabled }: UseRemindersOptions): RemindersApi {
  const { t } = useTranslation();
  const [permission, setPermission] =
    useState<ReminderPermission>('undetermined');
  // Live mirrors: the save/delete entry points are stable callbacks
  // held by the container, so they must read current values from refs,
  // never stale render closures.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const permissionRef = useRef(permission);
  permissionRef.current = permission;
  const tRef = useRef(t);
  tRef.current = t;

  // The one permission step. Reads the current status first (a previous
  // grant or a permanent denial never re-prompts); otherwise asks once.
  // `requestPermissionsAsync` is where Android 13+ issues its
  // `POST_NOTIFICATIONS` runtime prompt — no manifest step is needed
  // beyond the plugin entry in `app.json`.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      let granted = false;
      const current = await bestEffort(() =>
        Notifications.getPermissionsAsync(),
      );
      if (cancelled) return;
      if (current?.granted === true) {
        granted = true;
        setPermission('granted');
      } else if (current?.canAskAgain === false) {
        // Permanently denied: honest silence, never a second prompt.
        setPermission('denied');
      } else {
        const next = await bestEffort(() =>
          Notifications.requestPermissionsAsync(),
        );
        if (cancelled) return;
        if (next?.granted === true) {
          granted = true;
          setPermission('granted');
        } else {
          // Denied, permanently denied, or entirely unreachable
          // native boundary: all three mean honest silence, and only
          // the askable-dismissed case (`canAskAgain` true) stays
          // `'undetermined'`.
          if (next?.canAskAgain !== true) {
            setPermission('denied');
          }
        }
        // Dismissed-but-askable stays `'undetermined'`: a later save
        // re-enters this effect only if it remounts, never mid-flow.
      }
      if (!cancelled && granted && Platform.OS === 'android') {
        // Channel creation is best-effort: its failure must not revoke
        // an honest grant.
        await bestEffort(() =>
          Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
            name: 'Tengo reminders',
            importance: Notifications.AndroidImportance.DEFAULT,
          }),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const afterSave = useCallback(
    async (
      prev: ItemDetail | null,
      next: ItemDetail,
    ): Promise<ReminderOutcome> => {
      if (!enabledRef.current || permissionRef.current !== 'granted') {
        return 'skipped';
      }
      const translate = tRef.current;
      if (
        shouldNotifyLowStock({
          previousTotal: prev?.totalQuantity,
          nextTotal: next.totalQuantity,
          threshold: next.lowStockThreshold,
        })
      ) {
        await bestEffort(() =>
          Notifications.scheduleNotificationAsync({
            content: {
              title: translate('reminderLowStockTitle'),
              body: translate('reminderLowStockBody', {
                name: next.name,
                quantity: next.totalQuantity,
              }),
            },
            // Immediate delivery: the crossing already happened, there
            // is no polling and no background task (S4).
            trigger: null,
          }),
        );
      }
      // Cancel-then-reschedule over the union of previous and current
      // row keys: edited dates re-fire at the new date, removed rows
      // and cleared dates cancel instead of orphaning.
      const prevKeys = prev === null ? [] : expiryKeysForDetail(prev);
      const nextKeys = expiryKeysForDetail(next);
      for (const key of new Set([...prevKeys, ...nextKeys])) {
        await bestEffort(() =>
          Notifications.cancelScheduledNotificationAsync(key),
        );
      }
      for (const row of next.stock) {
        const at = expiryDateForNotification(row.expiresOn);
        if (at === null) continue;
        await bestEffort(() =>
          Notifications.scheduleNotificationAsync({
            identifier: expiryNotificationKey(next.id, row.locationId),
            content: {
              title: translate('reminderExpiryTitle'),
              body: translate('reminderExpiryBody', {
                name: next.name,
                date: row.expiresOn ?? '',
              }),
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: at,
            },
          }),
        );
      }
      return 'handled';
    },
    [],
  );

  const afterDelete = useCallback(
    async (prev: ItemDetail | null): Promise<ReminderOutcome> => {
      if (!enabledRef.current || permissionRef.current !== 'granted') {
        return 'skipped';
      }
      // The item is gone: cancel every row key from its last-known
      // detail so no orphan reminder can survive it.
      for (const key of prev === null ? [] : expiryKeysForDetail(prev)) {
        await bestEffort(() =>
          Notifications.cancelScheduledNotificationAsync(key),
        );
      }
      return 'handled';
    },
    [],
  );

  return { permission, afterSave, afterDelete };
}
