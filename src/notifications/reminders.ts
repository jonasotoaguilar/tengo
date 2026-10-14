/**
 * U4 local-reminder decision logic (S4: entirely on device).
 *
 * Pure unit: no `expo-notifications` import, no scheduling calls, no
 * clock reads beyond parsing the stored ISO date. The `useReminders`
 * hook owns permission, channels, and every native call; this module
 * only answers *whether* something fires and *under which key*, so it
 * is fully testable without mocks.
 */
import type { ItemDetail } from '../inventory/types';

export interface LowStockCrossing {
  /**
   * Total before the mutation. `undefined` means there is no prior
   * level (a brand-new item): the first sighting at or below the
   * threshold counts as crossing, so the household still learns.
   */
  previousTotal?: number;
  /** Total after the mutation. */
  nextTotal: number;
  /** The item's threshold; null/undefined means no reminder. */
  threshold?: number | null;
}

/**
 * Low-stock crossing rule: fire only when the item moves from strictly
 * above its threshold to at or below it. Re-saving (or browsing) an
 * already-low item stays silent, restocking stays silent, and an item
 * without a threshold never fires.
 */
export function shouldNotifyLowStock({
  previousTotal,
  nextTotal,
  threshold,
}: LowStockCrossing): boolean {
  if (threshold === null || threshold === undefined) return false;
  if (previousTotal === undefined) return nextTotal <= threshold;
  return previousTotal > threshold && nextTotal <= threshold;
}

/** Strict `YYYY-MM-DD` shape guard (the stored form of `expires_on`). */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Map a stored expiry date to its local trigger moment: 09:00 on that
 * day, when the household is likely to see it. Returns null for absent
 * or misshapen input (including impossible calendar dates), so those
 * rows never schedule. A past date still maps (the OS then fires
 * immediately on schedule): delivery timing is device behavior the
 * unit tests cannot observe.
 */
export function expiryDateForNotification(
  expiresOn: string | null | undefined,
): Date | null {
  if (typeof expiresOn !== 'string') return null;
  const match = ISO_DATE_PATTERN.exec(expiresOn.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 9, 0, 0, 0);
  // Round-trip: rejects month 13, day 40, February 30th, and friends.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Deterministic scheduled-notification identifier for one stock row.
 * Rescheduling cancels this key first and re-schedules under it, so a
 * save can never stack duplicates; deleting cancels it, so a deleted
 * row or item cannot leave an orphan reminder behind.
 */
export function expiryNotificationKey(
  itemId: number,
  locationId: number,
): string {
  return `tengo-expiry-${itemId}-${locationId}`;
}

/** Every row key of a detail, for cancel-the-whole-item flows. */
export function expiryKeysForDetail(detail: ItemDetail): string[] {
  return detail.stock.map((row) =>
    expiryNotificationKey(detail.id, row.locationId),
  );
}
