/**
 * U2a controlled item-form controller hook (no navigation, no DB open).
 *
 * Owns the `ItemForm` contract for one add/edit session: blank create
 * values (verbatim prefill, zero stock rows), latest-detail edit
 * loads with stale-round guards, explicit `ItemDraftInput` conversion that
 * ignores the UI-only field (`pendingNewCategoryName` until Add), localized client errors via
 * the existing `itemFormError*` keys, coded persistence failures (never raw
 * SQL), immediate single-flight save/delete guards, dirty discard
 * confirmation, and confirmed-only delete. Never opens, reopens, or closes
 * the database: it uses the injected already-open `RepositoryDb` handle
 * plus an injectable repository adapter (fakes in unit tests, real
 * `createItemFromDraft`/`updateItemFromDraft`/`getItem`/`deleteItem` in
 * production). Success closes only after persistence and notifies via
 * `onSaved`/`onDeleted` so U2b can refresh the current list, total, and
 * choices; the hook performs no refresh itself. Unit tests only — no
 * native persistence proof (existing domain atomic proof stands).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ItemFormErrors,
  ItemFormValues,
  ItemStockRowErrors,
  ItemStockRowValues,
} from '../components/ItemForm';
import {
  isQuantityAboveProductMax,
  parseQuantityRaw,
} from '../components/ItemForm';
import type { RepositoryDb } from '../inventory/database';
import {
  EntityConflictError,
  EntityNotFoundError,
  ValidationError,
} from '../inventory/errors';
import {
  createItemFromDraft,
  deleteItem,
  getItem,
  updateItemFromDraft,
} from '../inventory/itemRepository';
import type {
  ItemCategoryDraft,
  ItemDetail,
  ItemDraftInput,
  ItemStockDraft,
} from '../inventory/types';
import {
  CATEGORY_NAME_MAX_LENGTH,
  ITEM_NAME_MAX_LENGTH,
  LOCATION_NAME_MAX_LENGTH,
  normalizeBarcode,
} from '../inventory/validation';

export type ItemFormRoute =
  | {
      kind: 'create';
      prefilledName?: string;
      /**
       * U1 quick capture: the derived last-used location. The create
       * session starts with exactly one stock row pointed at it (empty
       * quantity, so the blank-and-droppable rule is unchanged). Absent
       * or invalid means the blank form, exactly as before; edit routes
       * never carry it and never change.
       */
      prefilledLocationId?: number;
      /**
       * U3 scanned identity: the normalized barcode from an unknown
       * scan. The create session carries it invisibly (no input
       * renders it) into the draft, so a re-scan reaches the created
       * item. Absent, blank, or misshapen means no code; edit routes
       * never carry it and never change.
       */
      prefilledBarcode?: string;
    }
  | { kind: 'edit'; itemId: number };

/** Injectable repository seam: real functions by default, fakes in tests. */
export interface ItemFormRepository {
  getItem: (db: RepositoryDb, id: number) => Promise<ItemDetail>;
  createItemFromDraft: (
    db: RepositoryDb,
    draft: ItemDraftInput,
  ) => Promise<ItemDetail>;
  updateItemFromDraft: (
    db: RepositoryDb,
    id: number,
    draft: ItemDraftInput,
  ) => Promise<ItemDetail>;
  deleteItem: (db: RepositoryDb, id: number) => Promise<void>;
}

const defaultRepository: ItemFormRepository = {
  getItem,
  createItemFromDraft,
  updateItemFromDraft,
  deleteItem,
};

export interface ItemFormControllerOptions {
  /** Already-open managed handle. Never opened, reopened, or closed here. */
  db: RepositoryDb;
  route: ItemFormRoute;
  repository?: ItemFormRepository;
  /** Fired after a successful persist so U2b refreshes list/total/choices. */
  onSaved?: (detail: ItemDetail) => void;
  onDeleted?: (id: number) => void;
  /** Fired on explicit dismiss (clean close, confirmed discard, post-write). */
  onDismissed?: () => void;
}

export interface SaveOutcome {
  persisted: boolean;
  detail?: ItemDetail;
}

export interface DeleteOutcome {
  deleted: boolean;
}

export type ItemFormLoadState = 'loading' | 'ready' | 'error';

export interface ItemFormController {
  mode: 'add' | 'edit';
  loadState: ItemFormLoadState;
  /** Latest loaded detail in edit mode; null while loading or on create. */
  detail: ItemDetail | null;
  values: ItemFormValues;
  errors: ItemFormErrors;
  /**
   * Stable persistence-failure code (`storage` | `not-found` | `in-use`)
   * mirroring `errors.form` for the U2b modal mapping. Null when no coded
   * failure is shown; field-mapped validation errors leave this null.
   */
  formErrorCode: string | null;
  submitting: boolean;
  dirty: boolean;
  confirmDiscard: boolean;
  confirmDelete: boolean;
  onChange: (next: ItemFormValues) => void;
  /**
   * M4 Gap B blur validation: `name` validates only the name; `quantity`
   * with a row index validates only that row's quantity side (blank and
   * zero are droppable, so they clear the row's quantity error while
   * leaving its location error intact). Merges the result into the errors
   * state. Never touches any other field's error; never runs while
   * `submitting`, while either write guard owns the screen, or on a
   * mixed route epoch. Reuses the submit-time rules and i18n keys.
   */
  onFieldBlur: (field: 'name' | 'quantity', index?: number) => void;
  /** Persists the latest values; resolves the explicit outcome. */
  onSave: () => Promise<SaveOutcome>;
  onRequestClose: () => void;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => Promise<DeleteOutcome>;
  onCancelDelete: () => void;
  onRetry: () => void;
}

/**
 * Blank controlled values: a name plus zero stock rows (sin stock) — or,
 * for U1 quick capture, exactly one row pointed at the derived last-used
 * location with an empty quantity (still droppable on save). Only a
 * positive safe-integer location id prefills; anything else (absent,
 * stale, malformed) falls back to the blank form rather than a stale row.
 */
/**
 * Sanitize a carried barcode: normalized code or `undefined` (no code).
 * Blank, absent, non-string, and misshapen input all mean no code — an
 * invalid code never reaches the draft, it is dropped, never an error.
 */
function sanitizeCarriedBarcode(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  if (value.trim() === '') return undefined;
  try {
    const normalized = normalizeBarcode(value);
    return normalized ?? undefined;
  } catch {
    return undefined;
  }
}

export function blankItemFormValues(
  prefilledName = '',
  prefilledLocationId?: number,
  prefilledBarcode?: string,
): ItemFormValues {
  const prefilled =
    prefilledLocationId !== undefined &&
    Number.isSafeInteger(prefilledLocationId) &&
    prefilledLocationId > 0
      ? [
          {
            location: {
              kind: 'existing' as const,
              locationId: prefilledLocationId,
            },
            quantityRaw: '',
          },
        ]
      : [];
  const barcode = sanitizeCarriedBarcode(prefilledBarcode);
  return {
    name: prefilledName,
    stock: prefilled,
    categories: [],
    pendingNewCategoryName: '',
    // Omitted when absent so blank sessions stay byte-identical to
    // before (`toEqual` ignores `undefined`, but the key is absent
    // anyway); present only as the invisible scanned identity.
    ...(barcode !== undefined ? { barcode } : {}),
  };
}

function detailToValues(detail: ItemDetail): ItemFormValues {
  const barcode = sanitizeCarriedBarcode(detail.barcode);
  return {
    name: detail.name,
    stock: detail.stock.map((level) => ({
      location: { kind: 'existing', locationId: level.locationId },
      quantityRaw: String(level.quantity),
    })),
    categories: detail.categoryIds.map((categoryId) => ({
      kind: 'existing' as const,
      categoryId,
    })),
    pendingNewCategoryName: '',
    ...(barcode !== undefined ? { barcode } : {}),
  };
}

function locationDraftEquals(
  a: ItemStockRowValues['location'],
  b: ItemStockRowValues['location'],
): boolean {
  if (a?.kind !== b?.kind) return false;
  if (a.kind === 'existing' && b.kind === 'existing') {
    return a.locationId === b.locationId;
  }
  if (a.kind === 'new' && b.kind === 'new') {
    return (
      a.location.name === b.location.name &&
      a.location.address === b.location.address
    );
  }
  return false;
}

function stockRowEquals(a: ItemStockRowValues, b: ItemStockRowValues): boolean {
  return (
    a.quantityRaw === b.quantityRaw &&
    locationDraftEquals(a.location, b.location)
  );
}

function categoryDraftEquals(
  a: ItemCategoryDraft,
  b: ItemCategoryDraft,
): boolean {
  if (a?.kind !== b?.kind) return false;
  if (a.kind === 'existing' && b.kind === 'existing') {
    return a.categoryId === b.categoryId;
  }
  if (a.kind === 'new' && b.kind === 'new') {
    return a.category?.name === b.category?.name;
  }
  return false;
}

// Cheap dirty comparison: field-wise with early exit, no JSON
// serialization. Compares every persisted field plus the UI-only pending
// text (which still counts as dirty), so it agrees with the previous
// stringify comparison on every value the form can produce.
function sameValues(a: ItemFormValues, b: ItemFormValues): boolean {
  if (a === b) return true;
  if (
    a.name !== b.name ||
    a.pendingNewCategoryName !== b.pendingNewCategoryName
  ) {
    return false;
  }
  const aStock = a.stock ?? [];
  const bStock = b.stock ?? [];
  if (aStock.length !== bStock.length) return false;
  for (let index = 0; index < aStock.length; index += 1) {
    if (!stockRowEquals(aStock[index], bStock[index])) return false;
  }
  const aCategories = a.categories ?? [];
  const bCategories = b.categories ?? [];
  if (aCategories.length !== bCategories.length) return false;
  for (let index = 0; index < aCategories.length; index += 1) {
    if (!categoryDraftEquals(aCategories[index], bCategories[index])) {
      return false;
    }
  }
  // Invisible scanned identity: sanitized so blank/invalid/null all
  // mean no code and compare equal; a prefill is clean, not dirty.
  if (sanitizeCarriedBarcode(a.barcode) !== sanitizeCarriedBarcode(b.barcode)) {
    return false;
  }
  return true;
}

/**
 * Shared route identity (kind + itemId + prefill): the single definition
 * of a route epoch used by the session-epoch guard. Do not duplicate.
 */
function routeIdentityOf(route: ItemFormRoute): string {
  // The create identity carries the prefill: two creates at different
  // last-used locations or scanned codes are different epochs, so a
  // stale session can never publish one route's prefill onto another.
  // Edit identity is byte-identical to before (U1 leaves edit mode
  // untouched; edits carry the stored code in values, not the route).
  return route.kind === 'create'
    ? `create:${route.prefilledName ?? ''}:${route.prefilledLocationId ?? ''}:${sanitizeCarriedBarcode(route.prefilledBarcode) ?? ''}`
    : `edit:${route.itemId}`;
}

export default function useItemFormController(
  options: ItemFormControllerOptions,
): ItemFormController {
  const { db, route, repository = defaultRepository } = options;
  const { t } = useTranslation();
  const routeKind = route.kind;
  const routeItemId = route.kind === 'edit' ? route.itemId : null;
  const routePrefill =
    route.kind === 'create' ? (route.prefilledName ?? '') : '';
  const routePrefilledLocationId =
    route.kind === 'create' ? route.prefilledLocationId : undefined;
  const routePrefilledBarcode =
    route.kind === 'create' ? route.prefilledBarcode : undefined;

  const [values, setValues] = useState<ItemFormValues>(() =>
    route.kind === 'create'
      ? blankItemFormValues(
          route.prefilledName ?? '',
          route.prefilledLocationId,
          route.prefilledBarcode,
        )
      : blankItemFormValues(),
  );
  const [baseline, setBaseline] = useState<ItemFormValues>(() =>
    route.kind === 'create'
      ? blankItemFormValues(
          route.prefilledName ?? '',
          route.prefilledLocationId,
          route.prefilledBarcode,
        )
      : blankItemFormValues(),
  );
  const [errors, setErrors] = useState<ItemFormErrors>({});
  const [formErrorCode, setFormErrorCode] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<ItemFormLoadState>(
    route.kind === 'create' ? 'ready' : 'loading',
  );
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Armed-discard mirror, synced at every setConfirmDiscard site exactly
  // like confirmDeleteArmed, so onConfirmDiscard is confirmed-only.
  const confirmDiscardArmed = useRef(false);
  // Armed-confirm mirror: onConfirmDelete must be confirmed-only, so it
  // reads this ref (effective before React rerenders) instead of state.
  // Every site that sets confirmDelete state syncs this ref, including
  // route entry, so a confirm armed on one route can never fire on another.
  const confirmDeleteArmed = useRef(false);

  // Latest-values mirror so onSave reads current input, never stale state.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  // Current-baseline mirror so onRequestClose compares against the live
  // baseline instead of a stale render closure. Synced everywhere the
  // baseline state is set: route-entry reset (both branches), successful
  // load, successful save. Initialized from the initial baseline so the
  // first commit already agrees.
  const baselineRef = useRef(baseline);
  // Ticket-owned single-flight guards (effective before React rerenders).
  // Each guard holds the loadTicket of the route-epoch that started the
  // in-flight write, or null when free. A second write on the same ticket
  // (double tap) is rejected, but a write on a newer ticket preempts: the
  // stale write still reports its own persistence outcome, yet only the
  // current owner may release the guard or clear the pending flag.
  const saveOwner = useRef<number | null>(null);
  const deleteOwner = useRef<number | null>(null);
  const unmounted = useRef(false);
  const loadTicket = useRef(0);
  const savedCallbacks = useRef(options);
  savedCallbacks.current = options;
  // Session epoch: the route identity the current session state belongs
  // to, recorded synchronously with the layout-phase reset below. Because
  // `savedCallbacks` updates during render (before passive effects), a
  // callback that runs between commit and the reset would otherwise see a
  // new route with stale session state; the epoch guard refuses those.
  // Initialized from the initial route (like the armed/baseline mirrors)
  // so the very first commit already has a matching epoch: a clean
  // first-mount action from any layout-phase caller is allowed.
  const sessionEpoch = useRef<string | null>(routeIdentityOf(route));
  // True only when the live route still matches the recorded session
  // epoch. Stable (refs + module helper only) for callback dep lists.
  const epochMatchesLiveRoute = useCallback((): boolean => {
    if (sessionEpoch.current === null) return false;
    return (
      sessionEpoch.current === routeIdentityOf(savedCallbacks.current.route)
    );
  }, []);

  useEffect(() => {
    // StrictMode mounts, runs cleanup, then remounts with live refs: reset
    // here so the remount recovers, while genuine unmount still suppresses.
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const mapFailure = useCallback(
    (
      error: unknown,
      stockRows?: ItemStockRowValues[],
    ): { errors: ItemFormErrors; code: string | null } => {
      // Row-scoped backend errors land on one mounted row when rows
      // exist; with no rows (a backend rejection of a stockless payload)
      // the message falls back to the form level, never to a ghost row.
      const rowError = (
        index: number,
        side: 'location' | 'quantity',
        message: string,
      ): { errors: ItemFormErrors; code: string | null } => {
        if (!stockRows || stockRows.length === 0) {
          return { errors: { form: message }, code: null };
        }
        const at = Math.min(Math.max(index, 0), stockRows.length - 1);
        const stock: (ItemStockRowErrors | undefined)[] = [];
        stock[at] = { [side]: message };
        return { errors: { stock }, code: null };
      };
      if (error instanceof ValidationError) {
        if (error.field === 'name') {
          if (error.code === 'too-long') {
            return {
              errors: { name: t('itemFormErrorNameTooLong') },
              code: null,
            };
          }
          return {
            errors: { name: t('itemFormErrorNameRequired') },
            code: null,
          };
        }
        if (error.field === 'quantity') {
          if (error.code === 'out-of-range') {
            return rowError(0, 'quantity', t('itemFormErrorQuantityTooLarge'));
          }
          return rowError(0, 'quantity', t('itemFormErrorQuantityInvalid'));
        }
        if (
          error.field === 'location' ||
          error.field === 'locationId' ||
          error.field === 'stock'
        ) {
          if (error.code === 'too-long') {
            return rowError(
              0,
              'location',
              t('itemFormErrorLocationNameTooLong'),
            );
          }
          if (error.code === 'duplicate') {
            return rowError(
              0,
              'location',
              t('itemFormErrorStockDuplicateLocation'),
            );
          }
          return rowError(0, 'location', t('itemFormErrorLocationRequired'));
        }
        return { errors: { form: error.code }, code: error.code };
      }
      if (error instanceof EntityNotFoundError) {
        return { errors: { form: 'not-found' }, code: 'not-found' };
      }
      if (error instanceof EntityConflictError) {
        if (error.entity === 'location') {
          const message = t('itemFormErrorLocationNameConflict');
          const firstNew = (stockRows ?? []).findIndex(
            (row) => row.location.kind === 'new',
          );
          return rowError(firstNew >= 0 ? firstNew : 0, 'location', message);
        }
        return {
          errors: { categories: t('itemFormErrorCategoryNameConflict') },
          code: null,
        };
      }
      return { errors: { form: 'storage' }, code: 'storage' };
    },
    [t],
  );

  const loadEdit = useCallback(
    (itemId: number) => {
      const ticket = ++loadTicket.current;
      setLoadState('loading');
      setErrors({});
      setFormErrorCode(null);
      void (async () => {
        try {
          const loaded = await repository.getItem(db, itemId);
          if (unmounted.current || ticket !== loadTicket.current) return;
          const next = detailToValues(loaded);
          valuesRef.current = next;
          setValues(next);
          setBaseline(next);
          baselineRef.current = next;
          setDetail(loaded);
          setErrors({});
          setFormErrorCode(null);
          setLoadState('ready');
        } catch (error) {
          if (unmounted.current || ticket !== loadTicket.current) return;
          const mapped = mapFailure(error, []);
          setErrors(mapped.errors);
          setFormErrorCode(mapped.code);
          setLoadState('error');
        }
      })();
    },
    [db, repository, mapFailure],
  );

  // Latest loader mirror: the route-entry effect below must not depend on
  // function identity (an inline `repository` prop changes it every render),
  // so it reads the current loader from this ref on genuine route changes.
  const loadEditRef = useRef(loadEdit);
  loadEditRef.current = loadEdit;

  // Route entry: every entry resets the full session state (values and
  // baseline to the same blank object so dirty is false, detail, errors,
  // form code, both confirms, loadState), then create renders ready while
  // edit loads fresh detail into the blank session. No armed confirm or
  // dirty flag survives a route change. This runs in the layout phase so
  // the reset (and the session-epoch record) lands before parents and
  // later-registered layout effects; earlier-registered callers in the
  // same commit still see the previous epoch and are refused by the epoch
  // guard instead. Depends on route primitives only: the loader is read
  // via loadEditRef, so an unstable repository/db identity across renders
  // can never retrigger this effect. The async load kickoff itself is
  // unchanged.
  useLayoutEffect(() => {
    sessionEpoch.current = routeIdentityOf(savedCallbacks.current.route);
    if (routeKind === 'create') {
      loadTicket.current += 1;
      const blank = blankItemFormValues(
        routePrefill,
        routePrefilledLocationId,
        routePrefilledBarcode,
      );
      valuesRef.current = blank;
      setValues(blank);
      setBaseline(blank);
      baselineRef.current = blank;
      setDetail(null);
      setErrors({});
      setFormErrorCode(null);
      setConfirmDiscard(false);
      confirmDiscardArmed.current = false;
      setConfirmDelete(false);
      confirmDeleteArmed.current = false;
      setLoadState('ready');
      return;
    }
    const blank = blankItemFormValues();
    valuesRef.current = blank;
    setValues(blank);
    setBaseline(blank);
    baselineRef.current = blank;
    setDetail(null);
    setErrors({});
    setFormErrorCode(null);
    setConfirmDiscard(false);
    confirmDiscardArmed.current = false;
    setConfirmDelete(false);
    confirmDeleteArmed.current = false;
    setLoadState('loading');
    if (routeItemId !== null) loadEditRef.current(routeItemId);
  }, [
    routeKind,
    routeItemId,
    routePrefill,
    routePrefilledLocationId,
    routePrefilledBarcode,
  ]);

  const validateForSave = useCallback(
    (
      current: ItemFormValues,
    ): { errors: ItemFormErrors } | { draft: ItemDraftInput } => {
      const fieldErrors: ItemFormErrors = {};
      const trimmedName = current.name.trim();
      if (trimmedName === '') {
        fieldErrors.name = t('itemFormErrorNameRequired');
      } else if (trimmedName.length > ITEM_NAME_MAX_LENGTH) {
        fieldErrors.name = t('itemFormErrorNameTooLong');
      }
      // Per-row stock validation, index-aligned with `current.stock`. A
      // blank or zero quantity means "no stock there" and drops the row
      // (never an error); anything else unparsable reports the row's
      // quantity copy. Duplicate existing locations reject on the later
      // rows, mirroring the domain (which rejects even when one side is
      // a dropped zero row).
      const rows = current.stock ?? [];
      const rowErrors: (ItemStockRowErrors | undefined)[] = rows.map(
        () => undefined,
      );
      const seenLocationIds = new Set<number>();
      const duplicateRows = new Set<number>();
      rows.forEach((row, index) => {
        const selector = row.location;
        if (selector?.kind === 'existing') {
          if (
            !Number.isSafeInteger(selector.locationId) ||
            selector.locationId <= 0
          ) {
            rowErrors[index] = {
              ...rowErrors[index],
              location: t('itemFormErrorLocationRequired'),
            };
          } else if (seenLocationIds.has(selector.locationId)) {
            duplicateRows.add(index);
          } else {
            seenLocationIds.add(selector.locationId);
          }
        } else if (selector?.kind === 'new') {
          const newLocationName = selector.location.name;
          if (
            typeof newLocationName !== 'string' ||
            newLocationName.trim() === ''
          ) {
            rowErrors[index] = {
              ...rowErrors[index],
              location: t('itemFormErrorLocationRequired'),
            };
          } else if (newLocationName.trim().length > LOCATION_NAME_MAX_LENGTH) {
            rowErrors[index] = {
              ...rowErrors[index],
              location: t('itemFormErrorLocationNameTooLong'),
            };
          }
        } else {
          rowErrors[index] = {
            ...rowErrors[index],
            location: t('itemFormErrorLocationRequired'),
          };
        }
        const raw = row.quantityRaw ?? '';
        if (raw.trim() === '') return;
        const quantity = parseQuantityRaw(raw);
        if (quantity === null) {
          rowErrors[index] = {
            ...rowErrors[index],
            quantity: isQuantityAboveProductMax(raw)
              ? t('itemFormErrorQuantityTooLarge')
              : t('itemFormErrorQuantityInvalid'),
          };
        }
      });
      for (const index of duplicateRows) {
        rowErrors[index] = {
          ...rowErrors[index],
          location: t('itemFormErrorStockDuplicateLocation'),
        };
      }
      // Zero-to-many by distinct existing id (never by name); new drafts
      // carry verbatim names. UI-only pending text stays out.
      const seen = new Set<number>();
      const categories: ItemCategoryDraft[] = [];
      for (const entry of current.categories ?? []) {
        if (entry?.kind === 'existing') {
          if (
            !Number.isSafeInteger(entry.categoryId) ||
            entry.categoryId <= 0 ||
            seen.has(entry.categoryId)
          ) {
            fieldErrors.categories = 'invalid';
            break;
          }
          seen.add(entry.categoryId);
          categories.push({
            kind: 'existing',
            categoryId: entry.categoryId,
          });
        } else if (
          entry?.kind === 'new' &&
          typeof entry.category?.name === 'string' &&
          entry.category.name.trim() !== ''
        ) {
          if (entry.category.name.trim().length > CATEGORY_NAME_MAX_LENGTH) {
            fieldErrors.categories = t('itemFormErrorCategoryNameTooLong');
            break;
          }
          categories.push({
            kind: 'new',
            category: { name: entry.category.name },
          });
        } else {
          fieldErrors.categories = 'invalid';
          break;
        }
      }
      const hasRowErrors = rowErrors.some(
        (entry) =>
          entry?.location !== undefined || entry?.quantity !== undefined,
      );
      if (
        fieldErrors.name !== undefined ||
        hasRowErrors ||
        fieldErrors.categories !== undefined
      ) {
        return {
          errors: {
            ...fieldErrors,
            ...(hasRowErrors ? { stock: rowErrors } : {}),
          },
        };
      }
      const stock: ItemStockDraft[] = [];
      for (const row of rows) {
        const quantity = parseQuantityRaw(row.quantityRaw ?? '');
        if (quantity === null || quantity === 0) continue;
        stock.push({ location: row.location, quantity });
      }
      // U3 scanned identity: the invisible carried code. Sanitized so
      // blank/misshapen input means no code and never reaches the
      // draft; omitted when absent so manual creates stay barcode-free
      // and the explicit-draft key assertion still holds.
      const barcode = sanitizeCarriedBarcode(current.barcode);
      return {
        draft: {
          name: current.name,
          stock,
          categories,
          ...(barcode !== undefined ? { barcode } : {}),
        },
      };
    },
    [t],
  );

  const onChange = useCallback((next: ItemFormValues) => {
    valuesRef.current = next;
    setValues(next);
  }, []);

  const onFieldBlur = useCallback(
    (field: 'name' | 'quantity', index?: number) => {
      // Mixed epoch (route changed before the session reset ran):
      // refuse rather than publishing a stale blur error.
      if (!epochMatchesLiveRoute()) return;
      // A pending write owns the screen: blur validates nothing.
      if (saveOwner.current !== null || deleteOwner.current !== null) return;
      if (saving || deleting) return;
      const ticket = loadTicket.current;
      const current = valuesRef.current;
      if (field === 'name') {
        const trimmedBlurName = current.name.trim();
        const message =
          trimmedBlurName === ''
            ? t('itemFormErrorNameRequired')
            : trimmedBlurName.length > ITEM_NAME_MAX_LENGTH
              ? t('itemFormErrorNameTooLong')
              : undefined;
        // Route moved mid-blur: drop the stale result.
        if (ticket !== loadTicket.current || !epochMatchesLiveRoute()) return;
        setErrors((prev) => {
          if (message === undefined) {
            if (prev.name === undefined) return prev;
            const next = { ...prev };
            delete next.name;
            return next;
          }
          if (prev.name === message) return prev;
          return { ...prev, name: message };
        });
        return;
      }
      // Row quantity blur: quantity side only, so a row location error
      // survives a quantity blur and vice versa. Blank and zero are
      // droppable, so they clear the row's quantity error.
      if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
        return;
      }
      const row = (current.stock ?? [])[index];
      if (!row) return;
      const raw = row.quantityRaw ?? '';
      const message =
        raw.trim() !== '' && parseQuantityRaw(raw) === null
          ? isQuantityAboveProductMax(raw)
            ? t('itemFormErrorQuantityTooLarge')
            : t('itemFormErrorQuantityInvalid')
          : undefined;
      // Route moved mid-blur: drop the stale result.
      if (ticket !== loadTicket.current || !epochMatchesLiveRoute()) return;
      setErrors((prev) => {
        const prevRows = prev.stock ?? [];
        const prevMessage = prevRows[index]?.quantity;
        if (message === undefined) {
          if (prevMessage === undefined) return prev;
          const nextRows = prevRows.slice();
          const nextRow = { ...nextRows[index] };
          delete nextRow.quantity;
          nextRows[index] =
            nextRow.location === undefined ? undefined : nextRow;
          return { ...prev, stock: nextRows };
        }
        if (prevMessage === message) return prev;
        const nextRows = prevRows.slice();
        nextRows[index] = { ...nextRows[index], quantity: message };
        return { ...prev, stock: nextRows };
      });
    },
    [epochMatchesLiveRoute, saving, deleting, t],
  );

  const onSave = useCallback((): Promise<SaveOutcome> => {
    // Mixed epoch (route changed before the session reset ran): refuse
    // the write rather than misapplying stale session state to the new
    // route. No repository call, no state touched.
    if (!epochMatchesLiveRoute()) {
      return Promise.resolve({ persisted: false });
    }
    const ticket = loadTicket.current;
    // Same-ticket double tap is rejected; a newer route-epoch preempts a
    // stale in-flight write and takes guard ownership.
    if (saveOwner.current !== null && saveOwner.current === ticket) {
      return Promise.resolve({ persisted: false });
    }
    // A delete owns the screen: saves wait, they never run concurrently.
    if (deleteOwner.current !== null) {
      return Promise.resolve({ persisted: false });
    }
    const current = valuesRef.current;
    const validated = validateForSave(current);
    if ('errors' in validated) {
      setErrors(validated.errors);
      return Promise.resolve({ persisted: false });
    }
    saveOwner.current = ticket;
    setSaving(true);
    setErrors({});
    setFormErrorCode(null);
    const activeRoute = savedCallbacks.current.route;
    const activeRepository = savedCallbacks.current.repository ?? repository;
    const activeDb = savedCallbacks.current.db;
    return (async (): Promise<SaveOutcome> => {
      try {
        const detail =
          activeRoute.kind === 'create'
            ? await activeRepository.createItemFromDraft(
                activeDb,
                validated.draft,
              )
            : await activeRepository.updateItemFromDraft(
                activeDb,
                activeRoute.itemId,
                validated.draft,
              );
        if (unmounted.current) {
          if (saveOwner.current === ticket) saveOwner.current = null;
          return { persisted: true, detail };
        }
        if (ticket !== loadTicket.current) {
          // Route moved on mid-write: the row persisted, so release the
          // guard and the saving flag only if this write still owns them,
          // notify the route-independent refresh, and leave the newer
          // route's form-local state (values/baseline/errors/loadState)
          // alone.
          if (saveOwner.current === ticket) {
            saveOwner.current = null;
            setSaving(false);
          }
          try {
            savedCallbacks.current.onSaved?.(detail);
          } catch {
            // Refresh notification must never fail the persisted write.
          }
          return { persisted: true, detail };
        }
        saveOwner.current = null;
        setSaving(false);
        setBaseline(current);
        baselineRef.current = current;
        setErrors({});
        setFormErrorCode(null);
        // Each callback is isolated: a throw in one never blocks its
        // sibling and never maps to a persistence failure.
        try {
          savedCallbacks.current.onSaved?.(detail);
        } catch {
          // Refresh notification must never fail the persisted write.
        }
        try {
          savedCallbacks.current.onDismissed?.();
        } catch {
          // Dismissal must never fail the persisted write.
        }
        return { persisted: true, detail };
      } catch (error) {
        const ownsGuard = saveOwner.current === ticket;
        if (ownsGuard) saveOwner.current = null;
        if (unmounted.current) {
          return { persisted: false };
        }
        if (ownsGuard) setSaving(false);
        if (ticket !== loadTicket.current) {
          return { persisted: false };
        }
        const mapped = mapFailure(error, valuesRef.current.stock);
        setErrors(mapped.errors);
        setFormErrorCode(mapped.code);
        return { persisted: false };
      }
    })();
  }, [repository, validateForSave, mapFailure, epochMatchesLiveRoute]);

  const onRequestClose = useCallback(() => {
    // Mixed epoch: the session state belongs to a route that is no longer
    // current, so neither arm a confirm nor dismiss.
    if (!epochMatchesLiveRoute()) return;
    // A pending write owns the screen: close stays blocked, no confirm.
    if (saveOwner.current !== null || deleteOwner.current !== null) return;
    if (!sameValues(valuesRef.current, baselineRef.current)) {
      setConfirmDiscard(true);
      confirmDiscardArmed.current = true;
      return;
    }
    savedCallbacks.current.onDismissed?.();
  }, [epochMatchesLiveRoute]);

  const onConfirmDiscard = useCallback(() => {
    // Confirmed-only discard: without an armed discard (e.g. armed on a
    // previous route), or on a mixed epoch, never dismiss.
    if (!confirmDiscardArmed.current || !epochMatchesLiveRoute()) return;
    confirmDiscardArmed.current = false;
    setConfirmDiscard(false);
    savedCallbacks.current.onDismissed?.();
  }, [epochMatchesLiveRoute]);

  const onCancelDiscard = useCallback(() => {
    confirmDiscardArmed.current = false;
    setConfirmDiscard(false);
  }, []);

  const onRequestDelete = useCallback(() => {
    // Mixed epoch: never arm a confirm for a route the session no longer
    // belongs to.
    if (!epochMatchesLiveRoute()) return;
    if (savedCallbacks.current.route.kind !== 'edit') return;
    if (deleteOwner.current !== null) return;
    confirmDeleteArmed.current = true;
    setConfirmDelete(true);
  }, [epochMatchesLiveRoute]);

  const onCancelDelete = useCallback(() => {
    confirmDeleteArmed.current = false;
    setConfirmDelete(false);
  }, []);

  const onConfirmDelete = useCallback((): Promise<DeleteOutcome> => {
    // Mixed epoch (route changed before the session reset ran): refuse
    // rather than deleting the wrong row. No repository call.
    if (!epochMatchesLiveRoute()) {
      return Promise.resolve({ deleted: false });
    }
    const activeRoute = savedCallbacks.current.route;
    if (activeRoute.kind !== 'edit') return Promise.resolve({ deleted: false });
    // Confirmed-only delete: without an armed confirm (e.g. a confirm
    // armed on a previous route), never touch the repository.
    if (!confirmDeleteArmed.current) return Promise.resolve({ deleted: false });
    const ticket = loadTicket.current;
    // Same-ticket double confirm is rejected; a newer route-epoch preempts
    // a stale in-flight delete and takes guard ownership.
    if (deleteOwner.current !== null && deleteOwner.current === ticket) {
      return Promise.resolve({ deleted: false });
    }
    // A save owns the screen: deletes wait, they never run concurrently.
    if (saveOwner.current !== null) {
      return Promise.resolve({ deleted: false });
    }
    deleteOwner.current = ticket;
    setDeleting(true);
    const activeRepository = savedCallbacks.current.repository ?? repository;
    const activeDb = savedCallbacks.current.db;
    return (async (): Promise<DeleteOutcome> => {
      try {
        await activeRepository.deleteItem(activeDb, activeRoute.itemId);
        if (unmounted.current) {
          if (deleteOwner.current === ticket) deleteOwner.current = null;
          return { deleted: true };
        }
        if (ticket !== loadTicket.current) {
          if (deleteOwner.current === ticket) {
            deleteOwner.current = null;
            setDeleting(false);
          }
          try {
            savedCallbacks.current.onDeleted?.(activeRoute.itemId);
          } catch {
            // Refresh notification must never fail the confirmed delete.
          }
          return { deleted: true };
        }
        deleteOwner.current = null;
        setDeleting(false);
        confirmDeleteArmed.current = false;
        setConfirmDelete(false);
        // Each callback is isolated: a throw in one never blocks its
        // sibling and never maps to a persistence failure.
        try {
          savedCallbacks.current.onDeleted?.(activeRoute.itemId);
        } catch {
          // Refresh notification must never fail the confirmed delete.
        }
        try {
          savedCallbacks.current.onDismissed?.();
        } catch {
          // Dismissal must never fail the confirmed delete.
        }
        return { deleted: true };
      } catch (error) {
        const ownsGuard = deleteOwner.current === ticket;
        if (ownsGuard) deleteOwner.current = null;
        if (unmounted.current) {
          return { deleted: false };
        }
        if (ownsGuard) setDeleting(false);
        if (ticket !== loadTicket.current) {
          return { deleted: false };
        }
        confirmDeleteArmed.current = false;
        setConfirmDelete(false);
        const mapped = mapFailure(error, []);
        setErrors(mapped.errors);
        setFormErrorCode(mapped.code);
        return { deleted: false };
      }
    })();
  }, [repository, mapFailure, epochMatchesLiveRoute]);

  const onRetry = useCallback(() => {
    const activeRoute = savedCallbacks.current.route;
    if (activeRoute.kind !== 'edit') return;
    loadEdit(activeRoute.itemId);
  }, [loadEdit]);

  // Cheap dirty flag, memoized so renders that touch neither values nor
  // baseline (error updates, submitting toggles) skip the comparison
  // entirely; keystrokes run the early-exit field walk, never stringify.
  const dirty = useMemo(
    () => !sameValues(values, baseline),
    [values, baseline],
  );

  return {
    mode: route.kind === 'create' ? 'add' : 'edit',
    loadState,
    detail,
    values,
    errors,
    formErrorCode,
    submitting: saving || deleting,
    dirty,
    confirmDiscard,
    confirmDelete,
    onChange,
    onFieldBlur,
    onSave,
    onRequestClose,
    onConfirmDiscard,
    onCancelDiscard,
    onRequestDelete,
    onConfirmDelete,
    onCancelDelete,
    onRetry,
  };
}
