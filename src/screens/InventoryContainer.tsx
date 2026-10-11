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
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import InventoryList, {
  type InventoryListState,
} from '../components/InventoryList';
import { initializeDatabase } from '../db';
import type { RepositoryDb } from '../inventory/database';
import { listCategories, listLocations } from '../inventory/entityRepository';
import { queryItems } from '../inventory/itemQuery';
import type {
  Category,
  ItemDetail,
  ItemFilter,
  Location,
} from '../inventory/types';
import ItemFormScreen from './ItemFormScreen';
import type { ItemFormRoute } from './useItemFormController';

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

function isFilterEmpty(filter: ItemFilter): boolean {
  const query = filter.query ?? '';
  const locationId = filter.locationId ?? null;
  const categoryIds = filter.categoryIds ?? [];
  return query.trim() === '' && locationId === null && categoryIds.length === 0;
}

export default function InventoryContainer({
  bootstrap = defaultBootstrap,
  enableMutations = false,
}: InventoryContainerProps = {}) {
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const palette = scheme === 'dark' ? DARK : LIGHT;
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<ItemFilter>({});
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

  const handleAdd = useCallback((prefilledName?: string) => {
    setRoute({ kind: 'create', prefilledName });
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

  // `retryToken` and `refreshToken` below are trigger-only deps by
  // design: they replay the current filter (retry after a failure,
  // refresh after a write) while the handle lives in its ref, so no dep
  // value is consumed for reading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryToken/refreshToken retrigger the round without being read
  useEffect(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && requestRef.current === requestId;
    // A post-write round keeps the previous page visible; every other
    // round (mount, filter change, retry) loads exactly as before.
    const isBackgroundRefresh = backgroundRefreshRef.current;
    backgroundRefreshRef.current = false;
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
        const activeFilter = filter;
        const unfilteredPromise = queryItems(db, {});
        // Reuse the unfiltered page when nothing is filtered so an empty
        // filter costs no second item query.
        const filteredPromise = isFilterEmpty(activeFilter)
          ? unfilteredPromise
          : queryItems(db, activeFilter);
        const [filteredItems, unfilteredItems, nextLocations, nextCategories] =
          await Promise.all([
            filteredPromise,
            unfilteredPromise,
            listLocations(db),
            listCategories(db),
          ]);
        if (!isCurrent()) return;
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
  }, [filter, retryToken, refreshToken]);

  return (
    <View style={styles.root}>
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
      />
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
