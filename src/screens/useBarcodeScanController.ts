/**
 * U3 barcode scan decision logic (no camera view, no permissions request).
 *
 * Keeps the two honest decisions in one testable unit, separate from the
 * `CameraView` in `ScanScreen`: `resolveCameraAccess` maps an expo-camera
 * permission snapshot to the screen state (a null snapshot is still
 * loading; a denied-but-askable grant retries in place; a denied-and-final
 * grant must go through system settings), and `decideScanRoute` maps one
 * scanned string to its route — a known code opens that item for edit, an
 * unknown code opens create carrying the code as its identity (there is no
 * product catalog, so a code cannot supply a name, but a re-scan of the
 * same code reaches the same item), and a blank/misshapen code is invalid
 * without ever touching the database. Camera-hardware absence is NOT
 * decided here: expo-camera 57 reports it through `CameraView`
 * `onMountError`, which `ScanScreen` turns into its unavailable state.
 * Local-first (S4): the lookup is the on-device `findItemByBarcode`, no
 * network anywhere.
 */
import type { RepositoryDb } from '../inventory/database';
import { findItemByBarcode } from '../inventory/itemRepository';
import type { ItemDetail } from '../inventory/types';
import { normalizeBarcode } from '../inventory/validation';

/** Permission snapshot read off the expo-camera hook (null while loading). */
export interface CameraPermissionSnapshot {
  granted: boolean;
  canAskAgain: boolean;
}

/** Screen state derived from permission alone; hardware failure is separate. */
export type CameraAccessState =
  | 'loading'
  | 'granted'
  | 'denied'
  | 'permanently-denied';

/**
 * Decide what the permission snapshot means. Never bricks: every
 * non-granted state has its own way out in `ScanScreen` (retry, settings,
 * or close).
 */
export function resolveCameraAccess(
  permission: CameraPermissionSnapshot | null,
): CameraAccessState {
  if (permission === null) return 'loading';
  if (permission.granted) return 'granted';
  return permission.canAskAgain ? 'denied' : 'permanently-denied';
}

/** Where one scan goes: edit the known item, create with the code, or stop. */
export type ScanRoute =
  | { kind: 'edit'; itemId: number }
  | { kind: 'create'; barcode: string }
  | { kind: 'invalid' };

/** Injectable lookup seam: the real `findItemByBarcode` by default, fakes in tests. */
export type ScanLookup = (
  db: RepositoryDb,
  barcode: string,
) => Promise<ItemDetail | null>;

/**
 * Map one scanned string to its route. Trims first (surrounding
 * whitespace scans the same code); blank and misshapen codes return
 * `invalid` with zero database calls. A found item resolves to its edit
 * route; an unknown code resolves to create carrying the normalized code
 * so the created item owns that identity.
 */
export async function decideScanRoute(
  db: RepositoryDb,
  rawBarcode: string,
  lookup: ScanLookup = findItemByBarcode,
): Promise<ScanRoute> {
  const trimmed = rawBarcode.trim();
  if (trimmed === '') return { kind: 'invalid' };
  let normalized: string;
  try {
    // `normalizeBarcode` returns null only for blank input (excluded
    // above) and throws `ValidationError` for a misshapen code: both
    // stay `invalid`, never a driver round trip.
    const shaped = normalizeBarcode(trimmed);
    if (shaped === null) return { kind: 'invalid' };
    normalized = shaped;
  } catch {
    return { kind: 'invalid' };
  }
  const found = await lookup(db, normalized);
  if (found === null) return { kind: 'create', barcode: normalized };
  return { kind: 'edit', itemId: found.id };
}
