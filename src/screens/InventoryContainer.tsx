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
 * generic translated list error, never raw SQLite text. Add/Open stay
 * genuinely disabled (`undefined`) until P4; this unit performs no writes.
 */
import { useEffect, useRef, useState } from 'react';

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
}

function isFilterEmpty(filter: ItemFilter): boolean {
  const query = filter.query ?? '';
  const locationId = filter.locationId ?? null;
  const categoryIds = filter.categoryIds ?? [];
  return query.trim() === '' && locationId === null && categoryIds.length === 0;
}

export default function InventoryContainer({
  bootstrap = defaultBootstrap,
}: InventoryContainerProps = {}) {
  const [filter, setFilter] = useState<ItemFilter>({});
  const [retryToken, setRetryToken] = useState(0);
  const [viewState, setViewState] = useState<InventoryListState>('loading');
  const [items, setItems] = useState<ItemDetail[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  // App-lifetime managed handle: set once by a successful bootstrap and
  // reused by every filter/retry round. Never closed here.
  const dbRef = useRef<RepositoryDb | null>(null);
  // Pending bootstrap shared by every round: a filter change or retry while
  // the first open is still in flight must reuse it, never open again (the
  // stale winner's handle would otherwise be discarded and leak). Cleared
  // on rejection so retry opens fresh.
  const bootstrapRef = useRef<Promise<RepositoryDb> | null>(null);
  const requestRef = useRef(0);

  // `retryToken` below is a trigger-only dep by design: it replays the
  // current filter after a failure while the handle lives in its ref, so
  // no dep value is consumed for reading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryToken retriggers the round without being read
  useEffect(() => {
    requestRef.current += 1;
    const requestId = requestRef.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && requestRef.current === requestId;
    setViewState('loading');

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
          // reads below stay gated on the current request.
          dbRef.current = db;
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
  }, [filter, retryToken]);

  return (
    <InventoryList
      state={viewState}
      items={items}
      totalCount={totalCount}
      locations={locations}
      categories={categories}
      filter={filter}
      onFilterChange={setFilter}
      onRetry={() => setRetryToken((token) => token + 1)}
      onAdd={undefined}
      onOpenItem={undefined}
    />
  );
}
