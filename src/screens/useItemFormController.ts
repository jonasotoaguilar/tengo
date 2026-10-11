/**
 * U2a controlled item-form controller hook (no navigation, no DB open).
 *
 * Owns the `ItemForm` contract for one add/edit session: blank create
 * values (verbatim prefill, never a default quantity), latest-detail edit
 * loads with stale-round guards, explicit `ItemDraftInput` conversion that
 * ignores UI-only fields (`pendingNewCategoryName` until Add,
 * `stashedNewLocation` until new is selected), localized client errors via
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
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { ItemFormErrors, ItemFormValues } from '../components/ItemForm';
import { parseQuantityRaw } from '../components/ItemForm';
import type { RepositoryDb } from '../inventory/database';
import {
  EntityNotFoundError,
  LocationInUseError,
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
  ItemLocationDraft,
} from '../inventory/types';

export type ItemFormRoute =
  | { kind: 'create'; prefilledName?: string }
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
   * M4 Gap B blur validation: validates ONLY the named field against
   * the current values and merges the result into the errors state
   * (sets the localized message when invalid, clears it when valid).
   * Never touches any other field's error; never runs while
   * `submitting`, while either write guard owns the screen, or on a
   * mixed route epoch. Reuses the submit-time rules and i18n keys.
   */
  onFieldBlur: (field: 'name' | 'quantity') => void;
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

/** Blank controlled values: empty raw quantity, never a default of 1. */
export function blankItemFormValues(prefilledName = ''): ItemFormValues {
  return {
    name: prefilledName,
    quantityRaw: '',
    location: null,
    categories: [],
    pendingNewCategoryName: '',
    stashedNewLocation: null,
  };
}

function detailToValues(detail: ItemDetail): ItemFormValues {
  return {
    name: detail.name,
    quantityRaw: String(detail.quantity),
    location: { kind: 'existing', locationId: detail.locationId },
    categories: detail.categoryIds.map((categoryId) => ({
      kind: 'existing' as const,
      categoryId,
    })),
    pendingNewCategoryName: '',
    stashedNewLocation: null,
  };
}

function sameValues(a: ItemFormValues, b: ItemFormValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Shared route identity (kind + itemId + prefill): the single definition
 * of a route epoch used by the session-epoch guard. Do not duplicate.
 */
function routeIdentityOf(route: ItemFormRoute): string {
  return route.kind === 'create'
    ? `create:${route.prefilledName ?? ''}`
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

  const [values, setValues] = useState<ItemFormValues>(() =>
    route.kind === 'create'
      ? blankItemFormValues(route.prefilledName ?? '')
      : blankItemFormValues(),
  );
  const [baseline, setBaseline] = useState<ItemFormValues>(() =>
    route.kind === 'create'
      ? blankItemFormValues(route.prefilledName ?? '')
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
    (error: unknown): { errors: ItemFormErrors; code: string | null } => {
      if (error instanceof ValidationError) {
        if (error.field === 'name') {
          return {
            errors: { name: t('itemFormErrorNameRequired') },
            code: null,
          };
        }
        if (error.field === 'quantity') {
          return {
            errors: { quantity: t('itemFormErrorQuantityInvalid') },
            code: null,
          };
        }
        if (error.field === 'location' || error.field === 'locationId') {
          return {
            errors: { location: t('itemFormErrorLocationRequired') },
            code: null,
          };
        }
        return { errors: { form: error.code }, code: error.code };
      }
      if (error instanceof EntityNotFoundError) {
        return { errors: { form: 'not-found' }, code: 'not-found' };
      }
      if (error instanceof LocationInUseError) {
        return { errors: { form: 'in-use' }, code: 'in-use' };
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
          const mapped = mapFailure(error);
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
      const blank = blankItemFormValues(routePrefill);
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
  }, [routeKind, routeItemId, routePrefill]);

  const validateForSave = useCallback(
    (
      current: ItemFormValues,
    ): { errors: ItemFormErrors } | { draft: ItemDraftInput } => {
      const fieldErrors: ItemFormErrors = {};
      if (current.name.trim() === '') {
        fieldErrors.name = t('itemFormErrorNameRequired');
      }
      const quantity = parseQuantityRaw(current.quantityRaw);
      if (quantity === null) {
        fieldErrors.quantity = t('itemFormErrorQuantityInvalid');
      }
      let location: ItemLocationDraft | null = null;
      const selector = current.location;
      if (selector?.kind === 'existing') {
        if (
          !Number.isSafeInteger(selector.locationId) ||
          selector.locationId <= 0
        ) {
          fieldErrors.location = t('itemFormErrorLocationRequired');
        } else {
          location = {
            kind: 'existing',
            locationId: selector.locationId,
          };
        }
      } else if (selector?.kind === 'new') {
        if (
          typeof selector.location.name !== 'string' ||
          selector.location.name.trim() === ''
        ) {
          fieldErrors.location = t('itemFormErrorLocationRequired');
        } else {
          location = {
            kind: 'new',
            location: {
              name: selector.location.name,
              address: selector.location.address ?? null,
            },
          };
        }
      } else {
        fieldErrors.location = t('itemFormErrorLocationRequired');
      }
      // Zero-to-many by distinct existing id (never by name); new drafts
      // carry verbatim names. UI-only pending/stash text stays out.
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
          categories.push({
            kind: 'new',
            category: { name: entry.category.name },
          });
        } else {
          fieldErrors.categories = 'invalid';
          break;
        }
      }
      if (
        fieldErrors.name !== undefined ||
        fieldErrors.quantity !== undefined ||
        fieldErrors.location !== undefined ||
        fieldErrors.categories !== undefined
      ) {
        return { errors: fieldErrors };
      }
      return {
        draft: {
          name: current.name,
          quantity: quantity as number,
          location: location as ItemLocationDraft,
          categories,
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
    (field: 'name' | 'quantity') => {
      // Mixed epoch (route changed before the session reset ran):
      // refuse rather than publishing a stale blur error.
      if (!epochMatchesLiveRoute()) return;
      // A pending write owns the screen: blur validates nothing.
      if (saveOwner.current !== null || deleteOwner.current !== null) return;
      if (saving || deleting) return;
      const ticket = loadTicket.current;
      const current = valuesRef.current;
      const message =
        field === 'name'
          ? current.name.trim() === ''
            ? t('itemFormErrorNameRequired')
            : undefined
          : parseQuantityRaw(current.quantityRaw) === null
            ? t('itemFormErrorQuantityInvalid')
            : undefined;
      // Route moved mid-blur: drop the stale result.
      if (ticket !== loadTicket.current || !epochMatchesLiveRoute()) return;
      setErrors((prev) => {
        if (message === undefined) {
          if (prev[field] === undefined) return prev;
          const next = { ...prev };
          delete next[field];
          return next;
        }
        if (prev[field] === message) return prev;
        return { ...prev, [field]: message };
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
        const mapped = mapFailure(error);
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
        const mapped = mapFailure(error);
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

  return {
    mode: route.kind === 'create' ? 'add' : 'edit',
    loadState,
    detail,
    values,
    errors,
    formErrorCode,
    submitting: saving || deleting,
    dirty: !sameValues(values, baseline),
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
