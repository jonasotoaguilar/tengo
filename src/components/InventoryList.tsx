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
 */
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
}

interface Palette {
  background: string;
  text: string;
  secondary: string;
  surface: string;
  border: string;
  skeleton: string;
  accent: string;
  accentOn: string;
  error: string;
}

const LIGHT: Palette = {
  background: '#FFFFFF',
  text: '#1A1C19',
  secondary: '#5C5F58',
  surface: '#F4F2EC',
  border: '#C9C5B8',
  skeleton: '#E5E1D5',
  accent: '#2F6B3A',
  accentOn: '#FFFFFF',
  error: '#B3261E',
};

const DARK: Palette = {
  background: '#121212',
  text: '#F2F1ED',
  secondary: '#AEB0AD',
  surface: '#1C1C1E',
  border: '#38383A',
  skeleton: '#2C2C2E',
  accent: '#7BC79A',
  accentOn: '#0B2E18',
  error: '#FFB4AB',
};

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
          borderColor: palette.border,
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
  | { kind: 'group'; locationId: number; name: string; count: number }
  | { kind: 'item'; item: ItemDetail };

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
}: InventoryListProps) {
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const palette = scheme === 'dark' ? DARK : LIGHT;
  const os = resolveOs();

  const query = filter.query ?? '';
  const locationId = filter.locationId ?? null;
  const categoryIds = filter.categoryIds ?? [];
  const selectedCategories = [...new Set(categoryIds)];
  const trimmedQuery = query.trim();
  const isFiltered =
    trimmedQuery !== '' || locationId !== null || selectedCategories.length > 0;
  const isFirstRun = state === 'ready' && totalCount === 0;
  const isNoResults = state === 'ready' && totalCount > 0 && items.length === 0;
  const showPlatformAdd = state === 'ready' && !isFirstRun && !isNoResults;
  const showFab = showPlatformAdd && os === 'android';
  const addDisabled = onAdd === undefined;

  const emitSearch = (nextQuery: string) => {
    onFilterChange({ ...filter, query: nextQuery });
  };
  const emitLocation = (next: number | null) => {
    onFilterChange({ ...filter, locationId: next });
  };
  const emitCategoryToggle = (id: number) => {
    const base = [...new Set(categoryIds)];
    const next = base.includes(id)
      ? base.filter((entry) => entry !== id)
      : [...base, id];
    onFilterChange({ ...filter, categoryIds: next });
  };
  const emitClearAll = () => {
    onFilterChange({ query: '', locationId: null, categoryIds: [] });
  };

  const selectedLocation =
    locationId === null
      ? null
      : (locations.find((entry) => entry.id === locationId) ?? null);

  const entries: ListEntry[] = [];
  {
    const groupIndex = new Map<number, number>();
    const grouped: {
      locationId: number;
      name: string;
      items: ItemDetail[];
    }[] = [];
    for (const item of items) {
      let index = groupIndex.get(item.locationId);
      if (index === undefined) {
        index = grouped.length;
        groupIndex.set(item.locationId, index);
        grouped.push({
          locationId: item.locationId,
          name: item.location.name,
          items: [],
        });
      }
      grouped[index].items.push(item);
    }
    for (const group of grouped) {
      entries.push({
        kind: 'group',
        locationId: group.locationId,
        name: group.name,
        count: group.items.length,
      });
      for (const item of group.items) entries.push({ kind: 'item', item });
    }
  }

  const renderEntry = ({ item: entry }: { item: ListEntry }) => {
    if (entry.kind === 'group') {
      const countLabel =
        entry.count === 1
          ? t('inventoryGroupCountOne', { count: entry.count })
          : t('inventoryGroupCountOther', { count: entry.count });
      return (
        <View
          testID={`inventory-group-${entry.locationId}`}
          style={styles.groupHeader}
        >
          <Text
            testID={`inventory-group-${entry.locationId}-name`}
            style={[styles.groupName, { color: palette.text }]}
          >
            {entry.name}
          </Text>
          <Text
            testID={`inventory-group-${entry.locationId}-count`}
            style={[styles.groupCount, { color: palette.secondary }]}
          >
            {countLabel}
          </Text>
        </View>
      );
    }
    const item = entry.item;
    const rowId = `inventory-row-${item.id}`;
    // One composed label so a screen reader announces the whole row as a
    // single unit; shared by the static and pressable rows. It mirrors what
    // is rendered, including the exhausted state and the categories, so no
    // visible information stays silent for a screen-reader user.
    const categoryNames = item.categories.map((entry) => entry.name).join(', ');
    const rowLabel = [
      item.name,
      `${t('inventoryQuantityLabel')} ${item.quantity}`,
      item.quantity === 0 ? t('inventoryExhausted') : null,
      item.location.name,
      categoryNames === '' ? t('inventoryNoCategories') : categoryNames,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');
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
          <Text style={styles.tabular}>{item.quantity}</Text>
        </Text>
        {item.quantity === 0 ? (
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
          {item.location.name}
        </Text>
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
          style={[styles.row, { borderColor: palette.border }]}
        >
          {body}
        </View>
      );
    }
    const open = onOpenItem;
    return (
      <Pressable
        testID={rowId}
        accessibilityRole="button"
        accessibilityLabel={rowLabel}
        accessibilityHint={t('inventoryOpenItemHint')}
        accessibilityState={{ disabled: false }}
        onPress={() => open(item.id)}
        style={[styles.row, { borderColor: palette.border }]}
      >
        {body}
      </Pressable>
    );
  };

  const controls = (
    <View testID="inventory-header" style={styles.header}>
      {state === 'ready' ? (
        <View style={styles.titleRow}>
          <Text
            testID="inventory-count"
            style={[styles.count, { color: palette.secondary }]}
          >
            {t('inventoryCount', { shown: items.length, total: totalCount })}
          </Text>
          {showPlatformAdd && os === 'ios' ? (
            <TextAction
              testID="inventory-add-header"
              label={t('inventoryAdd')}
              hint={addDisabled ? t('inventoryAddUnavailableHint') : undefined}
              disabled={addDisabled}
              onPress={() => onAdd?.()}
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
          { color: palette.text, borderColor: palette.border },
        ]}
      />
      {query !== '' ? (
        <TextAction
          testID="inventory-search-clear"
          label={t('inventorySearchClear')}
          onPress={() => emitSearch('')}
          palette={palette}
        />
      ) : null}
      <Text style={[styles.groupLabel, { color: palette.secondary }]}>
        {t('inventoryLocationsLabel')}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.chipRow}>
          <FilterChip
            testID="inventory-location-all"
            selected={locationId === null}
            onPress={() => emitLocation(null)}
            palette={palette}
            label={t('inventoryLocationAll')}
          />
          {locations.map((location) => (
            <FilterChip
              key={location.id}
              testID={`inventory-location-${location.id}`}
              selected={location.id === locationId}
              onPress={() => emitLocation(location.id)}
              palette={palette}
              label={location.name}
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
            <FilterChip
              key={category.id}
              testID={`inventory-category-${category.id}`}
              selected={selectedCategories.includes(category.id)}
              onPress={() => emitCategoryToggle(category.id)}
              palette={palette}
              label={category.name}
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
    </View>
  );

  let emptyComponent: React.ReactNode = null;
  if (state === 'loading') {
    emptyComponent = (
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
  } else if (state === 'error') {
    emptyComponent = (
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
          onPress={onRetry}
          palette={palette}
        />
      </View>
    );
  } else if (isFirstRun) {
    emptyComponent = (
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
          onPress={() => onAdd?.()}
          palette={palette}
        />
      </View>
    );
  } else if (isNoResults) {
    emptyComponent = (
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
            onPress={() => onAdd?.(trimmedQuery)}
            palette={palette}
          />
        ) : null}
      </View>
    );
  }

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
        data={state === 'ready' ? entries : []}
        keyExtractor={(entry) =>
          entry.kind === 'group'
            ? `group-${entry.locationId}`
            : `item-${entry.item.id}`
        }
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
          onPress={() => onAdd?.()}
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
