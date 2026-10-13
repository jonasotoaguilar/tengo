/**
 * P3b2 App-wired inventory container (read-only M3 integration, Android-only).
 *
 * Owns the single default `initializeDatabase()` bootstrap and retains the
 * resulting managed handle for the app lifetime: the outer handle is never
 * closed on filter changes, retries, or unmount (isolated exclusive mutation
 * handles self-close inside the existing factory, untouched here). Reads go
 * through the bounded `queryItems` model (never N+1 `listItems`) plus
 * `listLocations`/`listCategories`; the unfiltered total comes from a
 * separate `queryItems(db, {})` so a filtered zero with a nonzero total
 * renders no-results rather than first-run. Filter/retry/unmount races are
 * settled by a monotonic request id: earlier rounds and every completion
 * after unmount (bootstrap included) are ignored, and a rejected bootstrap
 * leaves no handle so retry opens fresh. Failures surface only the existing
 * generic translated list error, never raw SQLite text. U2b adds the opt-in
 * `enableMutations` route state (create/edit over the managed handle via
 * `ItemFormScreen`) with a post-write background refresh that never blanks
 * a ready list; the default stays read-only (`onAdd`/`onOpenItem` literally
 * `undefined`) so the DEV fixture and the recorded M3 proof are unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import EntityManager from '../components/EntityManager';
import InventoryList, {
  type InventoryListState,
} from '../components/InventoryList';
import { initializeDatabase } from '../db';
import type { RepositoryDb } from '../inventory/database';
import { listCategories, listLocations } from '../inventory/entityRepository';
import { getLastUsedLocationId, queryItems } from '../inventory/itemQuery';
import type {
  Category,
  ItemDetail,
  ItemFilter,
  Location,
} from '../inventory/types';
import ItemFormScreen from './ItemFormScreen';
import ScanScreen from './ScanScreen';
import type { ScanRoute } from './useBarcodeScanController';
import type { ItemFormRoute } from './useItemFormController';
import useReducedMotion from './useReducedMotion';

interface Palette {
  noticeBackground: string;
  noticeText: string;
}

// Inverse-surface pair (DESIGN.md §5 roles): dark toast on the light
// list background, light toast on the dark list background. Values
// mirror the sibling `text`/`background` roles so the pair stays
// legible and distinct from the list in both schemes.
const LIGHT: Palette = {
  noticeBackground: '#1A1C19',
  noticeText: '#FFFFFF',
};
const DARK: Palette = {
  noticeBackground: '#F2F1ED',
  noticeText: '#121212',
};

// T1: search debounce window. Keystrokes that land inside this window
// collapse into one filtered item query; the choice lists and the
// unfiltered total never re-fire for typing (see the read effect).
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Stable default bootstrap: the single production `tengo.db` open. A
 * module-level function (never a per-render closure) so the effect below
 * keeps its cached single-flight semantics when no override is injected.
 */
function defaultBootstrap(): Promise<RepositoryDb> {
  return initializeDatabase().then(
    // The runtime managed handle also serves reads; narrow here rather
    // than widening the migration `DatabaseLike` contract.
    (ready) => ready as unknown as RepositoryDb,
  );
}

export interface InventoryContainerProps {
  /**
   * Optional isolated bootstrap for the DEV-only query fixture: returns
   * the cached fixture handle instead of opening production `tengo.db`.
   * Defaults to the stable production bootstrap above.
   */
  bootstrap?: () => Promise<RepositoryDb>;
  /**
   * Opt-in U2b writes. Default `false`: Add/Open stay literally
   * `undefined` (disabled with honest hints) and the DEV read-only
   * fixture is preserved unchanged. When true, Add/Open arm only once
   * the managed handle is reactively available, so the modal can never
   * mount with a null handle.
   */
  enableMutations?: boolean;
}

export default function InventoryContainer({
  bootstrap = defaultBootstrap,
  enableMutations = false,
}: InventoryContainerProps = {}) {
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const reduceMotion = useReducedMotion();
  const palette = scheme === 'dark' ? DARK : LIGHT;
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<ItemFilter>({});
  // T1: debounced search text. Typing updates `filter` (and the visible
  // input) immediately, but the read effect below only sees
  // `debouncedQuery`, so a burst of keystrokes settles into a single
  // filtered item query instead of one full round per character.
  // Location/category selections bypass the debounce: they flow through
  // `filter` directly (see the read effect deps).
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');
  const [retryToken, setRetryToken] = useState(0);
  // Post-write refresh trigger (U2b): re-reads list/total/choices without
  // blanking a ready list. Trigger-only dep, like `retryToken`.
  const [refreshToken, setRefreshToken] = useState(0);
  const [viewState, setViewState] = useState<InventoryListState>('loading');
  const [items, setItems] = useState<ItemDetail[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  // Reactive mirror of the app-lifetime handle below: write affordances
  // derive from this state (never a ref read during render) so enabling
  // them cannot race the bootstrap.
  const [dbHandle, setDbHandle] = useState<RepositoryDb | null>(null);
  // Open add/edit route. Independent of the read effect below so a
  // post-write refresh never unmounts the screen before dismissal.
  const [route, setRoute] = useState<ItemFormRoute | null>(null);
  // Entity-management route (D6/S12 adopted): opened from the list's
  // manage entry point, hosted in the same slide Modal pattern as the
  // form screen. Independent of the read effect so a post-write refresh
  // never unmounts it before dismissal.
  const [entitiesOpen, setEntitiesOpen] = useState(false);
  // U3 scanner entry: hosted in the same conditional pattern as the form
  // screen (`ScanScreen` owns its own Modal). Independent of the read
  // effect so a background refresh never unmounts it mid-scan.
  const [scanOpen, setScanOpen] = useState(false);
  // M4 Gap A transient confirmation: a small non-blocking notice near
  // the bottom of the container, rendered OUTSIDE the form modal so it
  // stays visible after the modal dismisses. The token lets a newer
  // message replace an older one and restart the auto-clear timer.
  const [notice, setNotice] = useState<{
    kind: 'saved' | 'deleted';
    token: number;
  } | null>(null);

  // App-lifetime managed handle: set once by a successful bootstrap and
  // reused by every filter/retry round. Never closed here.
  const dbRef = useRef<RepositoryDb | null>(null);
  // U1: live mirror of the loaded locations so the Add press can
  // validate the derived last-used id without churning handleAdd's
  // identity (which the list holds by ref).
  const locationsRef = useRef<Location[]>([]);
  locationsRef.current = locations;
  // Pending bootstrap shared by every round: a filter change or retry while
  // the first open is still in flight must reuse it, never open again (the
  // stale winner's handle would otherwise be discarded and leak). Cleared
  // on rejection so retry opens fresh.
  const bootstrapRef = useRef<Promise<RepositoryDb> | null>(null);
  const requestRef = useRef(0);
  // Armed by a post-write success before bumping `refreshToken`: the next
  // effect round re-reads in the background, keeping a ready list visible
  // instead of blanking it into full-screen loading. Consumed (reset) by
  // exactly one round; a batched filter change shares that round and
  // still converges to the newest page.
  const backgroundRefreshRef = useRef(false);
  // T1: near-static read cache. The unfiltered total and the
  // location/category choice lists do not depend on the search text, so
  // filter-only rounds reuse them with zero extra reads. `staticKeyRef`
  // records which retry/refresh generation filled the cache; any retry
  // or post-write refresh bumps the key and forces a full reload, so the
  // total and the choices stay right after saves, deletes, and entity
  // writes. `allItemsRef` caches the last unfiltered page so clearing
  // back to an unfiltered view costs no query at all.
  const staticKeyRef = useRef<string | null>(null);
  const staticLoadedRef = useRef(false);
  const allItemsRef = useRef<ItemDetail[]>([]);

  // U1 quick capture: the form opens already pointed at the household's
  // last-used location, derived from the database (bounded single-row
  // read, no new state). A fresh database (null), a location deleted
  // after the choice lists loaded (unknown id), and a read failure all
  // fall back to the blank form, exactly as today — Add never fails.
  const handleAdd = useCallback((prefilledName?: string) => {
    const db = dbRef.current;
    const open = (prefilledLocationId?: number) => {
      setRoute({ kind: 'create', prefilledName, prefilledLocationId });
    };
    if (db === null) {
      open();
      return;
    }
    const known = new Set(locationsRef.current.map((location) => location.id));
    void (async () => {
      try {
        const lastUsed = await getLastUsedLocationId(db);
        if (lastUsed !== null && known.has(lastUsed)) {
          open(lastUsed);
          return;
        }
      } catch {
        // Fall through to the blank form below: a prefill miss must
        // never block adding an item.
      }
      open();
    })();
  }, []);
  const handleOpenItem = useCallback((id: number) => {
    setRoute({ kind: 'edit', itemId: id });
  }, []);
  const handleSaved = useCallback(() => {
    backgroundRefreshRef.current = true;
    setRefreshToken((token) => token + 1);
    setNotice((prev) => ({ kind: 'saved', token: (prev?.token ?? 0) + 1 }));
  }, []);
  const handleDeleted = useCallback(() => {
    backgroundRefreshRef.current = true;
    setRefreshToken((token) => token + 1);
    setNotice((prev) => ({ kind: 'deleted', token: (prev?.token ?? 0) + 1 }));
  }, []);
  const handleDismiss = useCallback(() => {
    setRoute(null);
  }, []);
  const handleManageEntities = useCallback(() => {
    setEntitiesOpen(true);
  }, []);
  const handleOpenScan = useCallback(() => {
    setScanOpen(true);
  }, []);
  const handleCloseScan = useCallback(() => {
    setScanOpen(false);
  }, []);
  // U3 scan-to-route: a known code opens that item's edit route; an
  // unknown code opens create carrying the normalized code as its
  // invisible identity, so the saved item owns the code and a re-scan
  // reaches it (closed loop via `prefilledBarcode`).
  const handleScanResolved = useCallback((route: ScanRoute) => {
    setScanOpen(false);
    if (route.kind === 'edit') {
      setRoute({ kind: 'edit', itemId: route.itemId });
      return;
    }
    if (route.kind === 'create') {
      setRoute({ kind: 'create', prefilledBarcode: route.barcode });
    }
  }, []);
  const handleCloseEntities = useCallback(() => {
    setEntitiesOpen(false);
  }, []);
  const handleEntitiesChanged = useCallback(() => {
    backgroundRefreshRef.current = true;
    setRefreshToken((token) => token + 1);
  }, []);

  // Write affordances arm only when opted in AND the handle is reactively
  // available. Literally `undefined` otherwise, preserving the disabled
  // rendering and the DEV read-only fixture.
  const mutationsReady = enableMutations && dbHandle !== null;

  // Transient-notice lifecycle: announce once per new message, then
  // auto-clear after about 3 seconds. The cleanup clears the pending
  // timer on unmount and whenever a newer message replaces the older
  // one (the effect re-runs, restarting the countdown). Keyed on the
  // notice token ONLY: `t` is not referentially stable across the
  // background-refresh renders, and re-running here would both
  // re-announce and restart the countdown on every list render.
  const noticeToken = notice?.token ?? null;
  const noticeMessage =
    notice === null
      ? null
      : notice.kind === 'saved'
        ? t('itemFormSaved')
        : t('itemFormDeleted');
  // biome-ignore lint/correctness/useExhaustiveDependencies: token-keyed announce+timer by design (see above)
  useEffect(() => {
    if (noticeToken === null || noticeMessage === null) return;
    AccessibilityInfo.announceForAccessibility(noticeMessage);
    const timer = setTimeout(() => {
      setNotice(null);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [noticeToken]);

  // T1 search debounce: commit the visible query into `debouncedQuery`
  // 300ms after the last keystroke. Rapid typing restarts the timer, so
  // only the settled value reaches the read effect. Selections that do
  // not type (location/category chips) never touch this timer.
  const liveQuery = filter.query ?? '';
  useEffect(() => {
    // Already settled: mount and programmatic clears stay immediate.
    if (liveQuery === debouncedQuery) return;
    const timer = setTimeout(() => {
      setDebouncedQuery(liveQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [liveQuery, debouncedQuery]);

  // `retryToken` and `refreshToken` below are trigger-only deps by
  // design: they replay the current filter (retry after a failure,
  // refresh after a write) while the handle lives in its ref, so no dep
  // value is consumed for reading. `debouncedQuery` (not `filter.query`)
  // drives item queries so keystrokes debounce; `filter.categoryIds`
  // drives them immediately (chip taps are discrete, never keystrokes);
  // `filter.locationId` is intentionally NOT a dep: the location selects
  // the rendered view only, so switching it costs zero reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: debounced query + immediate categories + trigger tokens by design (see above)
  useEffect(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && requestRef.current === requestId;
    // A post-write round keeps the previous page visible; every other
    // round (mount, filter change, retry) loads exactly as before.
    const isBackgroundRefresh = backgroundRefreshRef.current;
    backgroundRefreshRef.current = false;
    // The static generation this round belongs to: a retry or a
    // post-write refresh forces the total and the choice lists to
    // reload; a filter-only round reuses the cache.
    const staticKey = `${retryToken}:${refreshToken}`;
    const needStatic =
      !staticLoadedRef.current || staticKeyRef.current !== staticKey;
    if (!isBackgroundRefresh) {
      setViewState('loading');
    }

    (async () => {
      try {
        let db = dbRef.current;
        if (db === null) {
          let pendingBootstrap = bootstrapRef.current;
          if (pendingBootstrap === null) {
            const opened: Promise<RepositoryDb> = bootstrap().then(
              undefined,
              (error: unknown) => {
                if (bootstrapRef.current === opened)
                  bootstrapRef.current = null;
                throw error;
              },
            );
            bootstrapRef.current = opened;
            pendingBootstrap = opened;
          }
          try {
            db = await pendingBootstrap;
          } catch {
            if (!isCurrent()) return;
            setViewState('error');
            return;
          }
          // Retain the shared handle even for a stale request: it is the
          // app-lifetime connection, not the round's result. Only the
          // reads below stay gated on the current request. The reactive
          // mirror arms the write affordances; the functional guard
          // bails out when the handle is already set.
          dbRef.current = db;
          setDbHandle((prev) => (prev === null ? db : prev));
          if (!isCurrent()) return;
        }
        const activeCategoryIds = filter.categoryIds;
        // The location selects the list's view (which quantity each row
        // shows), never the queried rows: items with 0 at the selected
        // location but stock elsewhere stay visible marked sin stock
        // (L9a), so the membership predicate must not filter them out.
        // Search text and the category OR still filter server-side.
        // The query text comes from the DEBOUNCED value; categories apply
        // immediately.
        const queryFilter: ItemFilter = {
          query: debouncedQuery,
          categoryIds: activeCategoryIds,
        };
        const isUnfiltered =
          (queryFilter.query?.trim() ?? '') === '' &&
          (queryFilter.categoryIds ?? []).length === 0;
        if (!needStatic) {
          // Filter-only round: the total and the choice lists are already
          // correct, so pay only for the filtered page (or nothing when
          // the view is unfiltered and the cached page still applies).
          if (isUnfiltered) {
            if (!isCurrent()) return;
            setItems(allItemsRef.current);
            setViewState('ready');
            return;
          }
          const assuredDb = db as RepositoryDb;
          const filteredItems = await queryItems(assuredDb, queryFilter);
          if (!isCurrent()) return;
          setItems(filteredItems);
          setViewState('ready');
          return;
        }
        const assuredDb = db as RepositoryDb;
        const unfilteredPromise = queryItems(assuredDb, {});
        // Reuse the unfiltered page when nothing but the location view
        // is set, so switching locations costs no second item query.
        const filteredPromise = isUnfiltered
          ? unfilteredPromise
          : queryItems(assuredDb, queryFilter);
        const [filteredItems, unfilteredItems, nextLocations, nextCategories] =
          await Promise.all([
            filteredPromise,
            unfilteredPromise,
            listLocations(assuredDb),
            listCategories(assuredDb),
          ]);
        if (!isCurrent()) return;
        allItemsRef.current = unfilteredItems;
        staticLoadedRef.current = true;
        staticKeyRef.current = staticKey;
        setItems(filteredItems);
        setTotalCount(unfilteredItems.length);
        setLocations(nextLocations);
        setCategories(nextCategories);
        setViewState('ready');
      } catch {
        if (!isCurrent()) return;
        setViewState('error');
      }
    })();

    return () => {
      // Invalidate immediately: no late bootstrap/read completion may
      // publish or close after a filter change, retry, or unmount.
      cancelled = true;
      requestRef.current += 1;
    };
  }, [debouncedQuery, filter.categoryIds, retryToken, refreshToken]);

  // The scanner resolves into the same add/edit routes as the list, so
  // its entry arms under the same readiness gate; otherwise it stays
  // honestly disabled with a hint, like Add/Open/Manage.
  const scanReady = mutationsReady;

  return (
    <View style={styles.root}>
      <View style={styles.scanBar}>
        <Pressable
          testID="inventory-scan-open"
          accessibilityRole="button"
          accessibilityLabel={t('inventoryScan')}
          accessibilityHint={
            scanReady ? undefined : t('inventoryScanUnavailableHint')
          }
          accessibilityState={{ disabled: !scanReady }}
          disabled={!scanReady}
          onPress={handleOpenScan}
          style={styles.scanButton}
        >
          <Text style={styles.scanButtonText}>{t('inventoryScan')}</Text>
        </Pressable>
      </View>
      <InventoryList
        state={viewState}
        items={items}
        totalCount={totalCount}
        locations={locations}
        categories={categories}
        filter={filter}
        onFilterChange={setFilter}
        onRetry={() => setRetryToken((token) => token + 1)}
        onAdd={mutationsReady ? handleAdd : undefined}
        onOpenItem={mutationsReady ? handleOpenItem : undefined}
        onManageEntities={mutationsReady ? handleManageEntities : undefined}
      />
      {scanOpen && dbHandle !== null ? (
        <ScanScreen
          db={dbHandle}
          onResolved={handleScanResolved}
          onClose={handleCloseScan}
        />
      ) : null}
      {route !== null && dbHandle !== null ? (
        <ItemFormScreen
          db={dbHandle}
          route={route}
          locations={locations}
          categories={categories}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          onDismiss={handleDismiss}
        />
      ) : null}
      {entitiesOpen && dbHandle !== null ? (
        <Modal
          testID="entity-manager-screen"
          visible
          animationType={reduceMotion ? 'none' : 'slide'}
          onRequestClose={handleCloseEntities}
        >
          <EntityManager
            db={dbHandle}
            locations={locations}
            categories={categories}
            onChanged={handleEntitiesChanged}
            onClose={handleCloseEntities}
          />
        </Modal>
      ) : null}
      {notice !== null ? (
        <View
          testID="inventory-notice"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          pointerEvents="none"
          style={[
            styles.notice,
            {
              backgroundColor: palette.noticeBackground,
              bottom: insets.bottom + 24,
            },
          ]}
        >
          <Text
            testID="inventory-notice-text"
            style={[styles.noticeText, { color: palette.noticeText }]}
          >
            {notice.kind === 'saved'
              ? t('itemFormSaved')
              : t('itemFormDeleted')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // U3 scanner entry: a compact bar above the list (the list component
  // itself is outside this unit's edit surfaces, so the entry lives
  // here). Unstyled chrome on purpose: the translated label carries the
  // meaning, and the disabled state mirrors Add/Open/Manage.
  scanBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  scanButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  scanButtonText: {
    fontSize: 17,
    fontWeight: '600',
  },
  // Transient confirmation (DESIGN.md §3.4/§4): small, non-blocking,
  // never focusable, never intercepts touches (`pointerEvents="none"`)
  // so the list stays fully interactive underneath. Colors come from
  // the semantic palette above (never inline hex); `bottom` is applied
  // inline so the toast clears the bottom safe area instead of hiding
  // behind the Android navigation bar, like the list FAB.
  notice: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  noticeText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
