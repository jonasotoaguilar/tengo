/**
 * P3b1 presentational controlled inventory list (no queries, no DB access).
 *
 * Controlled by the parent: `state` selects loading/error/ready, `items` is
 * the already-filtered page, `totalCount` is the unfiltered inventory size
 * (0 selects first-run empty; >0 with zero items selects no-results), and
 * `filter` is the current `ItemFilter` (query defaults to '', location to
 * null, categories to []). Every control invokes its real callback
 * (`onFilterChange`, `onRetry`, `onAdd`, `onOpenItem`) exactly once per
 * action; rows are pressable only when `onOpenItem` exists and Add actions
 * are disabled with an honest hint when `onAdd` is absent. Real add/open
 * routes land later (P4); this unit never fakes them.
 *
 * Platform idiom: iOS gets a compose-style header Add action, Android an
 * extended FAB; empty states expose exactly one primary Add CTA instead.
 * Ready items render grouped by location (first-encounter group order,
 * input order within groups) with verbatim location names and honest
 * filtered counts; a location-only zero match names the place instead of
 * showing an empty header.
 * Names render verbatim (Unicode case preserved, no accent folding, literal
 * `%_\`); quantity zero renders an explicit translated Exhausted label, not
 * color alone. Unit tests only — no device proof (P3b2/P3b3 integrate).
 *
 * Render isolation (T6): rows and group headers are memoized components
 * whose props stay referentially stable across a data-unchanged parent
 * render (a filter/search keystroke whose page did not change). The emitters
 * read the latest filter/callbacks through refs so their `useCallback`
 * identities never change, and the derived entry list is a `useMemo` keyed
 * on the values that actually affect it. No `getItemLayout`: rows have
 * variable height (breakdown text), so a fixed layout would be wrong.
 */
import { memo, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type {
  Category,
  ItemDetail,
  ItemFilter,
  Location,
} from '../inventory/types';
import {
  DARK as DARK_BASE,
  LIGHT as LIGHT_BASE,
  type PaletteBase,
} from '../theme/tokens';

export type InventoryListState = 'loading' | 'error' | 'ready';

export interface InventoryListProps {
  state: InventoryListState;
  /** Already-filtered page to render; never fetched here. */
  items: ItemDetail[];
  /** Unfiltered inventory size; selects first-run vs no-results empty. */
  totalCount: number;
  locations: Location[];
  categories: Category[];
  filter: ItemFilter;
  onFilterChange: (next: ItemFilter) => void;
  onRetry: () => void;
  onAdd?: (prefilledName?: string) => void;
  onOpenItem?: (id: number) => void;
  onManageEntities?: () => void;
}

interface Palette extends PaletteBase {
  skeleton: string;
}

const LIGHT: Palette = {
  ...LIGHT_BASE,
  skeleton: '#E5E1D5',
};

const DARK: Palette = {
  ...DARK_BASE,
  skeleton: '#2C2C2E',
};

/** Shared empty identities so data/error props keep their references. */
const EMPTY_ITEMS: ItemDetail[] = [];
const EMPTY_CATEGORY_IDS: number[] = [];
const EMPTY_ENTRIES: ListEntry[] = [];

function resolveOs(): 'android' | 'ios' {
  const env = process.env.EXPO_OS;
  if (env === 'android' || env === 'ios') return env;
  return Platform.OS === 'android' ? 'android' : 'ios';
}

interface ChipProps {
  testID: string;
  selected: boolean;
  onPress: () => void;
  palette: Palette;
  label: string;
}

function FilterChip({ testID, selected, onPress, palette, label }: ChipProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: palette.controlBorder,
          backgroundColor: selected ? palette.accent : 'transparent',
        },
      ]}
    >
      <Text style={{ color: selected ? palette.accentOn : palette.text }}>
        {label}
      </Text>
    </Pressable>
  );
}

interface LocationChipProps {
  testID: string;
  selected: boolean;
  palette: Palette;
  label: string;
  locationId: number | null;
  onSelect: (id: number | null) => void;
}

/**
 * Location chip binding its own press handler, so the parent can pass the
 * stable `emitLocation` once and every chip keeps referentially stable
 * props across unrelated (e.g. search-text) renders.
 */
const LocationFilterChip = memo(function LocationFilterChip({
  testID,
  selected,
  palette,
  label,
  locationId,
  onSelect,
}: LocationChipProps) {
  const handlePress = useCallback(
    () => onSelect(locationId),
    [onSelect, locationId],
  );
  return (
    <FilterChip
      testID={testID}
      selected={selected}
      onPress={handlePress}
      palette={palette}
      label={label}
    />
  );
});

interface CategoryChipProps {
  testID: string;
  selected: boolean;
  palette: Palette;
  label: string;
  categoryId: number;
  onSelect: (id: number) => void;
}

/** Category chip with the same stable-props contract as LocationFilterChip. */
const CategoryFilterChip = memo(function CategoryFilterChip({
  testID,
  selected,
  palette,
  label,
  categoryId,
  onSelect,
}: CategoryChipProps) {
  const handlePress = useCallback(
    () => onSelect(categoryId),
    [onSelect, categoryId],
  );
  return (
    <FilterChip
      testID={testID}
      selected={selected}
      onPress={handlePress}
      palette={palette}
      label={label}
    />
  );
});

interface ActionProps {
  testID: string;
  label: string;
  onPress: () => void;
  palette: Palette;
  hint?: string;
  disabled?: boolean;
}

function PrimaryAction({
  testID,
  label,
  onPress,
  palette,
  hint,
  disabled = false,
}: ActionProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.primaryButton,
        { backgroundColor: disabled ? palette.surface : palette.accent },
      ]}
    >
      <Text
        style={[
          styles.primaryText,
          { color: disabled ? palette.secondary : palette.accentOn },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function TextAction({
  testID,
  label,
  onPress,
  palette,
  hint,
  disabled = false,
  containerStyle = styles.clearButton,
  labelStyle,
}: ActionProps & {
  containerStyle?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={disabled ? { disabled } : undefined}
      disabled={disabled}
      onPress={onPress}
      style={containerStyle}
    >
      <Text
        style={[
          styles.clearText,
          { color: disabled ? palette.secondary : palette.accent },
          labelStyle,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

type ListEntry =
  | {
      kind: 'group';
      key: string;
      locationId: number | null;
      name: string;
      count: number;
    }
  | { kind: 'item'; item: ItemDetail };

/** Quantity of one item at one location; 0 when it holds no stock there. */
function stockQuantityAt(item: ItemDetail, locationId: number): number {
  return (
    item.stock.find((level) => level.locationId === locationId)?.quantity ?? 0
  );
}

/** Per-location breakdown, e.g. `Heladera 1 · Alacena 2`. */
function breakdownText(item: ItemDetail): string {
  return item.stock
    .map((level) => `${level.location.name} ${level.quantity}`)
    .join(' · ');
}

interface GroupHeaderProps {
  entryKey: string;
  name: string;
  count: number;
  palette: Palette;
}

/**
 * One memoized group header. Props are primitives (plus the stable palette
 * constant), so a filter/search keystroke that leaves the grouping
 * untouched keeps every header's props — and skips its re-render.
 */
export const InventoryGroupHeader = memo(function InventoryGroupHeader({
  entryKey,
  name,
  count,
  palette,
}: GroupHeaderProps) {
  const { t } = useTranslation();
  const countLabel =
    count === 1
      ? t('inventoryGroupCountOne', { count })
      : t('inventoryGroupCountOther', { count });
  return (
    <View testID={`inventory-${entryKey}`} style={styles.groupHeader}>
      <Text
        testID={`inventory-${entryKey}-name`}
        style={[styles.groupName, { color: palette.text }]}
      >
        {name}
      </Text>
      <Text
        testID={`inventory-${entryKey}-count`}
        style={[styles.groupCount, { color: palette.secondary }]}
      >
        {countLabel}
      </Text>
    </View>
  );
});

interface ItemRowProps {
  item: ItemDetail;
  locationId: number | null;
  locationName: string;
  palette: Palette;
  onOpenItem?: (id: number) => void;
}

/**
 * One memoized product row. The parent passes the stable `handleOpenItem`
 * wrapper (or `undefined` when rows are static), so an unchanged row keeps
 * identical props — same `item` reference, same location primitives, same
 * palette and handler — and React skips it while siblings change.
 */
export const InventoryItemRow = memo(function InventoryItemRow({
  item,
  locationId,
  locationName,
  palette,
  onOpenItem,
}: ItemRowProps) {
  const { t } = useTranslation();
  const rowId = `inventory-row-${item.id}`;
  // The shown quantity depends on the view: the total across locations
  // in the general view, that location's quantity in a location view.
  const shownQuantity =
    locationId === null
      ? item.totalQuantity
      : stockQuantityAt(item, locationId);
  const isExhausted = shownQuantity === 0;
  // Location line: the breakdown in the general view (or the sin-stock
  // group name when there is nothing to break down), the selected
  // location's name in a location view.
  const locationLine =
    locationId === null
      ? item.stock.length > 0
        ? breakdownText(item)
        : t('inventoryNoStockGroup')
      : locationName;
  const breakdown =
    locationId !== null && isExhausted && item.stock.length > 0
      ? breakdownText(item)
      : null;
  // One composed label so a screen reader announces the whole row as a
  // single unit; shared by the static and pressable rows. It mirrors what
  // is rendered, including the exhausted state and the categories, so no
  // visible information stays silent for a screen-reader user.
  const categoryNames = item.categories.map((entry) => entry.name).join(', ');
  const rowLabel = [
    item.name,
    `${t('inventoryQuantityLabel')} ${shownQuantity}`,
    isExhausted ? t('inventoryExhausted') : null,
    locationLine === '' ? null : locationLine,
    breakdown,
    categoryNames === '' ? t('inventoryNoCategories') : categoryNames,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  const handlePress = useCallback(
    () => onOpenItem?.(item.id),
    [onOpenItem, item.id],
  );
  const body = (
    <>
      <Text selectable style={[styles.itemName, { color: palette.text }]}>
        {item.name}
      </Text>
      <Text
        selectable
        testID={`${rowId}-quantity`}
        style={[styles.itemMeta, { color: palette.text }]}
      >
        {t('inventoryQuantityLabel')}{' '}
        <Text style={styles.tabular}>{shownQuantity}</Text>
      </Text>
      {isExhausted ? (
        <Text
          testID={`${rowId}-exhausted`}
          style={[styles.exhausted, { color: palette.error }]}
        >
          {t('inventoryExhausted')}
        </Text>
      ) : null}
      <Text
        selectable
        testID={`${rowId}-location`}
        style={[styles.itemMeta, { color: palette.secondary }]}
      >
        {locationLine}
      </Text>
      {breakdown !== null ? (
        <Text
          selectable
          testID={`${rowId}-breakdown`}
          style={[styles.itemMeta, { color: palette.secondary }]}
        >
          {breakdown}
        </Text>
      ) : null}
      <Text
        selectable
        testID={`${rowId}-categories`}
        style={[styles.itemMeta, { color: palette.secondary }]}
      >
        {item.categories.length > 0
          ? item.categories.map((entry) => entry.name).join(', ')
          : t('inventoryNoCategories')}
      </Text>
    </>
  );
  if (onOpenItem === undefined) {
    return (
      <View
        testID={rowId}
        accessibilityRole="text"
        accessibilityLabel={rowLabel}
        accessibilityHint={t('inventoryOpenUnavailableHint')}
        style={[styles.row, { borderColor: palette.separator }]}
      >
        {body}
      </View>
    );
  }
  return (
    <Pressable
      testID={rowId}
      accessibilityRole="button"
      accessibilityLabel={rowLabel}
      accessibilityHint={t('inventoryOpenItemHint')}
      accessibilityState={{ disabled: false }}
      onPress={handlePress}
      style={[styles.row, { borderColor: palette.separator }]}
    >
      {body}
    </Pressable>
  );
});

export default function InventoryList({
  state,
  items,
  totalCount,
  locations,
  categories,
  filter,
  onFilterChange,
  onRetry,
  onAdd,
  onOpenItem,
  onManageEntities,
}: InventoryListProps) {
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const palette = scheme === 'dark' ? DARK : LIGHT;
  const os = resolveOs();

  // Latest filter/callbacks live in refs so every emitter below keeps a
  // stable `useCallback` identity: a search keystroke must not give rows
  // and chips fresh handler props, or their memoization would never hit.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;
  const onOpenItemRef = useRef(onOpenItem);
  onOpenItemRef.current = onOpenItem;
  const onManageEntitiesRef = useRef(onManageEntities);
  onManageEntitiesRef.current = onManageEntities;

  const emitSearch = useCallback((nextQuery: string) => {
    onFilterChangeRef.current({ ...filterRef.current, query: nextQuery });
  }, []);
  const emitLocation = useCallback((next: number | null) => {
    onFilterChangeRef.current({ ...filterRef.current, locationId: next });
  }, []);
  const emitCategoryToggle = useCallback((id: number) => {
    const base = [...new Set(filterRef.current.categoryIds ?? [])];
    const next = base.includes(id)
      ? base.filter((entry) => entry !== id)
      : [...base, id];
    onFilterChangeRef.current({ ...filterRef.current, categoryIds: next });
  }, []);
  const emitClearAll = useCallback(() => {
    onFilterChangeRef.current({ query: '', locationId: null, categoryIds: [] });
  }, []);
  const clearSearch = useCallback(() => {
    emitSearch('');
  }, [emitSearch]);
  const handleRetry = useCallback(() => {
    onRetryRef.current();
  }, []);
  const handleAdd = useCallback(() => {
    onAddRef.current?.();
  }, []);
  const handleAddNamed = useCallback((name: string) => {
    onAddRef.current?.(name);
  }, []);
  const handleManageEntities = useCallback(() => {
    onManageEntitiesRef.current?.();
  }, []);
  // Stable open handler: `undefined` stays `undefined` (static rows) and
  // the wrapper keeps one identity otherwise, so memo rows never see a
  // fresh callback from a parent re-render.
  const handleOpenItem = useCallback((id: number) => {
    onOpenItemRef.current?.(id);
  }, []);
  const openItem = onOpenItem === undefined ? undefined : handleOpenItem;

  const query = filter.query ?? '';
  const locationId = filter.locationId ?? null;
  const categoryIds = filter.categoryIds ?? EMPTY_CATEGORY_IDS;
  const selectedCategories = useMemo(
    () => [...new Set(categoryIds)],
    [categoryIds],
  );
  const trimmedQuery = query.trim();
  const isFiltered =
    trimmedQuery !== '' || locationId !== null || selectedCategories.length > 0;
  const selectedLocation = useMemo(
    () =>
      locationId === null
        ? null
        : (locations.find((entry) => entry.id === locationId) ?? null),
    [locationId, locations],
  );
  // A location id with no known location is a stale filter: nothing can
  // be shown for it, so the list renders the generic no-results copy
  // instead of an empty header.
  const locationKnown = locationId === null || selectedLocation !== null;
  const visibleItems = locationKnown ? items : EMPTY_ITEMS;
  const selectedLocationName = selectedLocation?.name ?? '';
  const isFirstRun = state === 'ready' && totalCount === 0;
  const isNoResults =
    state === 'ready' && totalCount > 0 && visibleItems.length === 0;
  const showPlatformAdd = state === 'ready' && !isFirstRun && !isNoResults;
  const showFab = showPlatformAdd && os === 'android';
  const addDisabled = onAdd === undefined;
  const manageDisabled = onManageEntities === undefined;

  const entries: ListEntry[] = useMemo(() => {
    const next: ListEntry[] = [];
    if (locationId === null) {
      // General view ("Todas"): one row per product grouped under its
      // first stock location (first-encounter group order, input order
      // within groups). Items with no stock anywhere trail in their own
      // sin-stock group, never hidden (R6).
      const groupIndex = new Map<number, number>();
      const grouped: {
        locationId: number;
        name: string;
        items: ItemDetail[];
      }[] = [];
      const stockless: ItemDetail[] = [];
      for (const item of visibleItems) {
        const first = item.stock[0];
        if (first === undefined) {
          stockless.push(item);
          continue;
        }
        let index = groupIndex.get(first.locationId);
        if (index === undefined) {
          index = grouped.length;
          groupIndex.set(first.locationId, index);
          grouped.push({
            locationId: first.locationId,
            name: first.location.name,
            items: [],
          });
        }
        grouped[index].items.push(item);
      }
      for (const group of grouped) {
        next.push({
          kind: 'group',
          key: `group-${group.locationId}`,
          locationId: group.locationId,
          name: group.name,
          count: group.items.length,
        });
        for (const item of group.items) next.push({ kind: 'item', item });
      }
      if (stockless.length > 0) {
        next.push({
          kind: 'group',
          key: 'group-nostock',
          locationId: null,
          name: t('inventoryNoStockGroup'),
          count: stockless.length,
        });
        for (const item of stockless) next.push({ kind: 'item', item });
      }
    } else if (selectedLocation !== null && visibleItems.length > 0) {
      // Location view: the grouping stays (one group for the selected
      // location) and every row shows THAT location's quantity. An item
      // with 0 there but stock elsewhere appears marked sin stock with
      // its breakdown visible (L9a). An empty view renders no group
      // header: the no-results copy covers it.
      next.push({
        kind: 'group',
        key: `group-${selectedLocation.id}`,
        locationId: selectedLocation.id,
        name: selectedLocation.name,
        count: visibleItems.length,
      });
      for (const item of visibleItems) next.push({ kind: 'item', item });
    }
    return next;
    // `visibleItems` carries the page identity: same array reference with
    // the same location view yields the same entry list, so rows below
    // keep their `item` references and skip re-rendering.
  }, [visibleItems, locationId, selectedLocation, t]);

  const keyExtractor = useCallback(
    (entry: ListEntry) =>
      entry.kind === 'group' ? entry.key : `item-${entry.item.id}`,
    [],
  );

  const renderEntry = useCallback(
    ({ item: entry }: { item: ListEntry }) => {
      if (entry.kind === 'group') {
        return (
          <InventoryGroupHeader
            entryKey={entry.key}
            name={entry.name}
            count={entry.count}
            palette={palette}
          />
        );
      }
      return (
        <InventoryItemRow
          item={entry.item}
          locationId={locationId}
          locationName={selectedLocationName}
          palette={palette}
          onOpenItem={openItem}
        />
      );
      // Deliberately keyed on view primitives (not the query text): typing
      // in search keeps this identity, so memoized rows with unchanged
      // `item` references are skipped by React.
    },
    [locationId, selectedLocationName, palette, openItem],
  );

  const controls = useMemo(
    () => (
      <View testID="inventory-header" style={styles.header}>
        {state === 'ready' ? (
          <View style={styles.titleRow}>
            <Text
              testID="inventory-count"
              style={[styles.count, { color: palette.secondary }]}
            >
              {t('inventoryCount', {
                shown: visibleItems.length,
                total: totalCount,
              })}
            </Text>
            {showPlatformAdd && os === 'ios' ? (
              <TextAction
                testID="inventory-add-header"
                label={t('inventoryAdd')}
                hint={
                  addDisabled ? t('inventoryAddUnavailableHint') : undefined
                }
                disabled={addDisabled}
                onPress={handleAdd}
                palette={palette}
                containerStyle={styles.headerAdd}
                labelStyle={styles.headerAddText}
              />
            ) : null}
          </View>
        ) : null}
        <TextInput
          testID="inventory-search"
          accessibilityRole="search"
          accessibilityLabel={t('inventorySearchLabel')}
          placeholder={t('inventorySearchPlaceholder')}
          placeholderTextColor={palette.secondary}
          value={query}
          onChangeText={emitSearch}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={[
            styles.search,
            { color: palette.text, borderColor: palette.controlBorder },
          ]}
        />
        {query !== '' ? (
          <TextAction
            testID="inventory-search-clear"
            label={t('inventorySearchClear')}
            onPress={clearSearch}
            palette={palette}
          />
        ) : null}
        <Text style={[styles.groupLabel, { color: palette.secondary }]}>
          {t('inventoryLocationsLabel')}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.chipRow}>
            <LocationFilterChip
              testID="inventory-location-all"
              selected={locationId === null}
              onSelect={emitLocation}
              palette={palette}
              label={t('inventoryLocationAll')}
              locationId={null}
            />
            {locations.map((location) => (
              <LocationFilterChip
                key={location.id}
                testID={`inventory-location-${location.id}`}
                selected={location.id === locationId}
                onSelect={emitLocation}
                palette={palette}
                label={location.name}
                locationId={location.id}
              />
            ))}
          </View>
        </ScrollView>
        <Text style={[styles.groupLabel, { color: palette.secondary }]}>
          {t('inventoryCategoriesLabel')}
        </Text>
        <Text style={[styles.orHint, { color: palette.secondary }]}>
          {t('inventoryCategoryOrHint')}
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.chipRow}>
            {categories.map((category) => (
              <CategoryFilterChip
                key={category.id}
                testID={`inventory-category-${category.id}`}
                selected={selectedCategories.includes(category.id)}
                onSelect={emitCategoryToggle}
                palette={palette}
                label={category.name}
                categoryId={category.id}
              />
            ))}
          </View>
        </ScrollView>
        {isFiltered && !isNoResults ? (
          <TextAction
            testID="inventory-filters-clear"
            label={t('inventoryFiltersClear')}
            onPress={emitClearAll}
            palette={palette}
          />
        ) : null}
        <TextAction
          testID="inventory-manage-entities"
          label={t('inventoryManageEntities')}
          hint={
            manageDisabled
              ? t('inventoryManageEntitiesUnavailableHint')
              : undefined
          }
          disabled={manageDisabled}
          onPress={handleManageEntities}
          palette={palette}
        />
      </View>
    ),
    [
      state,
      query,
      locations,
      categories,
      locationId,
      selectedCategories,
      isFiltered,
      isNoResults,
      palette,
      os,
      t,
      visibleItems,
      totalCount,
      showPlatformAdd,
      addDisabled,
      manageDisabled,
      emitSearch,
      clearSearch,
      emitLocation,
      emitCategoryToggle,
      emitClearAll,
      handleAdd,
      handleManageEntities,
    ],
  );

  const emptyComponent: React.ReactNode = useMemo(() => {
    if (state === 'loading') {
      return (
        <View testID="inventory-loading" style={styles.stateBlock}>
          <Text style={[styles.stateText, { color: palette.text }]}>
            {t('inventoryLoading')}
          </Text>
          {[0, 1, 2].map((index) => (
            <View
              key={index}
              accessible={false}
              style={[styles.skeleton, { backgroundColor: palette.skeleton }]}
            />
          ))}
        </View>
      );
    }
    if (state === 'error') {
      return (
        <View style={styles.stateBlock}>
          <Text
            selectable
            testID="inventory-error-message"
            style={[styles.stateText, { color: palette.text }]}
          >
            {t('inventoryErrorMessage')}
          </Text>
          <PrimaryAction
            testID="inventory-retry"
            label={t('inventoryRetry')}
            onPress={handleRetry}
            palette={palette}
          />
        </View>
      );
    }
    if (isFirstRun) {
      return (
        <View style={styles.stateBlock}>
          <Text
            testID="inventory-empty-title"
            style={[styles.stateText, { color: palette.text }]}
          >
            {t('inventoryEmptyTitle')}
          </Text>
          <Text style={[styles.stateSubtext, { color: palette.secondary }]}>
            {t('inventoryEmptyMessage')}
          </Text>
          <PrimaryAction
            testID="inventory-add-empty"
            label={t('inventoryAddFirst')}
            hint={addDisabled ? t('inventoryAddUnavailableHint') : undefined}
            disabled={addDisabled}
            onPress={handleAdd}
            palette={palette}
          />
        </View>
      );
    }
    if (isNoResults) {
      const addNamed = () => handleAddNamed(trimmedQuery);
      return (
        <View style={styles.stateBlock}>
          <Text
            testID="inventory-noresults-message"
            style={[styles.stateText, { color: palette.text }]}
          >
            {trimmedQuery !== ''
              ? t('inventoryNoResultsForQuery', { query: trimmedQuery })
              : selectedLocation !== null
                ? t('inventoryNoResultsInLocation', {
                    location: selectedLocation.name,
                  })
                : t('inventoryNoResultsGeneric')}
          </Text>
          <PrimaryAction
            testID="inventory-noresults-clear"
            label={t('inventoryFiltersClear')}
            onPress={emitClearAll}
            palette={palette}
          />
          {trimmedQuery !== '' ? (
            <TextAction
              testID="inventory-add-noresults"
              label={t('inventoryAddNamed', { query: trimmedQuery })}
              hint={addDisabled ? t('inventoryAddUnavailableHint') : undefined}
              disabled={addDisabled}
              onPress={addNamed}
              palette={palette}
            />
          ) : null}
        </View>
      );
    }
    return null;
  }, [
    state,
    isFirstRun,
    isNoResults,
    trimmedQuery,
    selectedLocation,
    palette,
    t,
    addDisabled,
    handleRetry,
    handleAdd,
    handleAddNamed,
    emitClearAll,
  ]);

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: palette.background, paddingTop: insets.top },
      ]}
    >
      <FlatList
        testID="inventory-list"
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: insets.bottom + (showFab ? 96 : 16) },
        ]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        data={state === 'ready' ? entries : EMPTY_ENTRIES}
        keyExtractor={keyExtractor}
        renderItem={renderEntry}
        ListHeaderComponent={controls}
        ListEmptyComponent={emptyComponent}
      />
      {showFab ? (
        <Pressable
          testID="inventory-add-fab"
          accessibilityRole="button"
          accessibilityLabel={t('inventoryAdd')}
          accessibilityHint={
            addDisabled ? t('inventoryAddUnavailableHint') : undefined
          }
          accessibilityState={{ disabled: addDisabled }}
          disabled={addDisabled}
          onPress={handleAdd}
          style={[
            styles.fab,
            {
              backgroundColor: addDisabled ? palette.surface : palette.accent,
              bottom: insets.bottom + 16,
            },
          ]}
        >
          <Text
            style={[
              styles.primaryText,
              { color: addDisabled ? palette.secondary : palette.accentOn },
            ]}
          >
            {t('inventoryAdd')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
  },
  header: {
    paddingBottom: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  count: {
    flex: 1,
    flexShrink: 1,
    fontSize: 13,
  },
  headerAdd: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  headerAddText: {
    fontSize: 17,
    fontWeight: '600',
  },
  search: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 17,
    marginTop: 8,
  },
  clearButton: {
    minHeight: 48,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  clearText: {
    fontSize: 15,
    fontWeight: '600',
  },
  groupLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
  },
  orHint: {
    fontSize: 13,
    marginTop: 2,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingTop: 16,
    paddingBottom: 4,
  },
  groupName: {
    flex: 1,
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  groupCount: {
    fontSize: 13,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
    paddingRight: 16,
  },
  chip: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
  },
  row: {
    borderTopWidth: 1,
    minHeight: 48,
    paddingVertical: 12,
    gap: 2,
  },
  itemName: {
    fontSize: 17,
    flexShrink: 1,
  },
  itemMeta: {
    fontSize: 15,
    flexShrink: 1,
  },
  tabular: {
    fontVariant: ['tabular-nums'],
  },
  exhausted: {
    fontSize: 15,
    fontWeight: '700',
  },
  stateBlock: {
    paddingVertical: 24,
    gap: 12,
  },
  stateText: {
    fontSize: 17,
  },
  stateSubtext: {
    fontSize: 15,
  },
  skeleton: {
    height: 56,
    borderRadius: 10,
  },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 20,
    alignSelf: 'flex-start',
  },
  primaryText: {
    fontSize: 17,
    fontWeight: '600',
  },
  fab: {
    position: 'absolute',
    right: 16,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingHorizontal: 20,
  },
});
