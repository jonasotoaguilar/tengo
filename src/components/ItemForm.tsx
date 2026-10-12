/**
 * P4 U1 controlled item add/edit form (no persistence, no navigation).
 *
 * Fully controlled by the parent controller (U2): `values` carries verbatim
 * `name`, a per-location `stock` editor (one row per location with its raw
 * `quantityRaw`, so empty/invalid input stays representable), and
 * zero-to-many `categories` draft refs — plus one UI-only field,
 * `pendingNewCategoryName` (typed-but-not-appended text, never submitted as
 * a category until Add). Every edit emits `onChange`, so remounts and
 * failed saves rehydrate from props; U2 converts explicitly to
 * `ItemDraftInput` (a blank or zero row quantity means "no stock there"
 * and is dropped, never stored). The component never reads/writes the DB,
 * navigates, fabricates a synthetic location, clamps or rewrites raw input,
 * or creates repository entities (new locations/categories append drafts
 * only). A null-parse quantity (blank, invalid, non-integer, or unsafe)
 * disables both steppers without rewriting the raw text; save stays enabled
 * except while `submitting` or when `onSubmit` is absent so parent
 * validation can focus errors; absent save/close callbacks render
 * truthfully disabled, never no-op. Unit tests only — TalkBack/keyboard
 * focus needs Android proof, never claimed from Jest.
 */

import type { Ref, RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AccessibilityInfo,
  findNodeHandle,
  KeyboardAvoidingView,
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
  ItemCategoryDraft,
  ItemLocationDraft,
  Location,
  NewLocationInput,
} from '../inventory/types';
import { MAX_QUANTITY, PRODUCT_MAX_QUANTITY } from '../inventory/validation';
import { DARK, LIGHT, type PaletteBase } from '../theme/tokens';

export type ItemFormMode = 'add' | 'edit';

/**
 * Controlled form state; raw strings keep empty/invalid input visible.
 * `stock` is the per-location editor: one row per location with its raw
 * quantity. The UI-only `pendingNewCategoryName` is controlled so every
 * keystroke is observable and survives remount, but it is NOT part of the
 * domain draft: U2 converts explicitly.
 */
export interface ItemFormValues {
  name: string;
  stock: ItemStockRowValues[];
  categories: ItemCategoryDraft[];
  pendingNewCategoryName: string;
}

/** One per-location editor row: a location selector plus raw quantity. */
export interface ItemStockRowValues {
  location: ItemLocationDraft;
  quantityRaw: string;
}

/** Per-row inline errors, index-aligned with `values.stock`. */
export interface ItemStockRowErrors {
  location?: string;
  quantity?: string;
}

export type ItemFormField = 'name' | 'stock' | 'categories' | 'form';

export interface ItemFormErrors {
  name?: string;
  stock?: (ItemStockRowErrors | undefined)[];
  categories?: string;
  form?: string;
}

/** Mounted focus target descriptor for an error: a field or one row side. */
export type ItemFormErrorTarget =
  | 'name'
  | 'categories'
  | 'form'
  | { row: number; side: 'quantity' | 'location' };

export interface ItemFormProps {
  mode: ItemFormMode;
  values: ItemFormValues;
  onChange: (next: ItemFormValues) => void;
  onSubmit?: () => void;
  onRequestClose?: () => void;
  /**
   * Delete entry point (U2b): rendered as a bottom destructive zone only
   * in `edit` mode when provided. The screen confirms before deleting.
   */
  onRequestDelete?: () => void;
  /**
   * Blur validation entry (M4 Gap B): the parent validates a single
   * field against the current values and merges the inline error.
   * Wired to the name input and to each stock row's quantity input (with
   * its row index); never fired while `submitting` (the inputs are
   * non-editable then, and the handler guards regardless). Absent stays a
   * true no-op.
   */
  onFieldBlur?: (field: 'name' | 'quantity', index?: number) => void;
  /**
   * Called with the testID of the mounted focus target whenever the
   * component requests error focus (never alters selection). Lets unit
   * tests prove target selection and request routing per state.
   */
  onRequestErrorFocus?: (targetTestID: string) => void;
  errors?: ItemFormErrors;
  submitting?: boolean;
  locations: Location[];
  categories: Category[];
}

/** First error to focus: name, then stock rows in order (quantity before
 * location within a row), then categories, then form. */
export function firstErrorField(
  errors?: ItemFormErrors,
): ItemFormErrorTarget | null {
  if (!errors) return null;
  if (errors.name) return 'name';
  const rows = errors.stock ?? [];
  for (let row = 0; row < rows.length; row += 1) {
    if (rows[row]?.quantity) return { row, side: 'quantity' };
    if (rows[row]?.location) return { row, side: 'location' };
  }
  if (errors.categories) return 'categories';
  if (errors.form) return 'form';
  return null;
}

/**
 * Non-translatable symbols: the steppers and the draft-remove affordance
 * render these fixed glyphs inline. Their accessible names come from i18n
 * (`itemFormDecrement`, `itemFormIncrement`, `itemFormRemoveCategory`),
 * so never add the glyphs themselves to the translation resources.
 */
const DECREMENT_GLYPH = '−';
const INCREMENT_GLYPH = '+';
const REMOVE_GLYPH = '✕';

/**
 * Mounted focus target for an error in each editor state. Row quantity
 * errors target that row's quantity input; row location errors target the
 * inline name input for new-location rows and the row's announced location
 * error otherwise (always mounted, never steals selection); categories
 * target the always-mounted new-category input and form errors target the
 * announced form alert.
 */
export function resolveErrorFocusTarget(
  target: ItemFormErrorTarget | null,
  locationKind: ItemLocationDraft['kind'] | undefined,
): string | null {
  if (target === 'name') return 'item-form/name';
  if (typeof target === 'object' && target !== null) {
    if (target.side === 'quantity') {
      return `item-form/stock-${target.row}/quantity`;
    }
    return locationKind === 'new'
      ? `item-form/stock-${target.row}/location-new/name`
      : `item-form/error-stock-${target.row}-location`;
  }
  if (target === 'categories') return 'item-form/new-category/name';
  if (target === 'form') return 'item-form/error-form';
  return null;
}

/**
 * Parse the raw quantity text. Returns null for empty/invalid input so the
 * caller retains the raw string for explicit errors. Two bounds apply: the
 * technical MAX_SAFE_INTEGER guard (never user-reachable) and the adopted
 * product bound PRODUCT_MAX_QUANTITY — anything above the product bound is
 * null-parse, so the form keeps the raw text and the parent reports the
 * out-of-range error instead of clamping.
 */
export function parseQuantityRaw(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUANTITY) {
    return null;
  }
  if (value > PRODUCT_MAX_QUANTITY) return null;
  return value;
}

/**
 * True when the raw text is a safe integer above the adopted product bound
 * (and within the technical guard): the out-of-range case the parent maps
 * to the too-large copy instead of the generic invalid-quantity copy.
 * Unsafe/negative/non-numeric input is not out-of-range, it is invalid.
 */
export function isQuantityAboveProductMax(raw: string): boolean {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const value = Number(trimmed);
  return (
    Number.isSafeInteger(value) &&
    value > PRODUCT_MAX_QUANTITY &&
    value <= MAX_QUANTITY
  );
}

/** Best-effort native focus: a11y focus on device, direct focus fallback.
 * Deliberate no-op under Jest: unit tests prove routing through
 * `onRequestErrorFocus` plus target existence, never native focus. */
function focusNode(ref: RefObject<TextInput | View | null>) {
  if (process.env.NODE_ENV === 'test') return;
  const node = ref.current;
  if (!node) return;
  const handle = findNodeHandle(node);
  if (handle) {
    AccessibilityInfo.setAccessibilityFocus(handle);
    return;
  }
  const focusable = node as unknown as { focus?: () => void };
  if (typeof focusable.focus === 'function') focusable.focus();
}

type Palette = PaletteBase;

function FieldError({
  testID,
  message,
  palette,
  focusRef,
}: {
  testID: string;
  message: string;
  palette: Palette;
  focusRef?: Ref<View>;
}) {
  return (
    <View
      ref={focusRef}
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text selectable style={[styles.errorText, { color: palette.error }]}>
        {message}
      </Text>
    </View>
  );
}

export default function ItemForm({
  mode,
  values,
  onChange,
  onSubmit,
  onRequestClose,
  onRequestDelete,
  onFieldBlur,
  onRequestErrorFocus,
  errors,
  submitting = false,
  locations,
  categories,
}: ItemFormProps) {
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const palette = scheme === 'dark' ? DARK : LIGHT;
  const pending = submitting === true;

  // Mounted-node registry for error focus: every focusable target
  // registers its testID here, and the error effect routes through
  // `onRequestErrorFocus` plus this map (never native focus under Jest).
  const nodeRefs = useRef(new Map<string, TextInput | View | null>());
  const registerNode = (testID: string) => (node: TextInput | View | null) => {
    if (node === null) nodeRefs.current.delete(testID);
    else nodeRefs.current.set(testID, node);
  };

  useEffect(() => {
    const field = firstErrorField(errors);
    const locationKind =
      typeof field === 'object' && field !== null
        ? values.stock[field.row]?.location.kind
        : undefined;
    const target = resolveErrorFocusTarget(field, locationKind);
    if (!field || !target) return;
    onRequestErrorFocus?.(target);
    focusNode({ current: nodeRefs.current.get(target) ?? null });
  }, [errors, values.stock, onRequestErrorFocus]);

  const setRow = (index: number, patch: Partial<ItemStockRowValues>) => {
    onChange({
      ...values,
      stock: values.stock.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    });
  };

  const stepRowQuantity = (index: number, delta: 1 | -1) => {
    if (pending) return;
    const base = parseQuantityRaw(values.stock[index]?.quantityRaw ?? '');
    if (base === null) return;
    const next = base + delta;
    if (next < 0 || next > PRODUCT_MAX_QUANTITY) return;
    setRow(index, { quantityRaw: String(next) });
  };

  const addedExistingIds = new Set<number>();
  for (const row of values.stock) {
    if (row.location.kind === 'existing') {
      addedExistingIds.add(row.location.locationId);
    }
  }
  const availableLocations = locations.filter(
    (location) => !addedExistingIds.has(location.id),
  );

  const appendExistingLocation = (locationId: number) => {
    if (pending || addedExistingIds.has(locationId)) return;
    onChange({
      ...values,
      stock: [
        ...values.stock,
        { location: { kind: 'existing', locationId }, quantityRaw: '' },
      ],
    });
  };

  const appendNewLocation = () => {
    if (pending) return;
    onChange({
      ...values,
      stock: [
        ...values.stock,
        {
          location: { kind: 'new', location: { name: '', address: null } },
          quantityRaw: '',
        },
      ],
    });
  };

  const editRowNewLocation = (
    index: number,
    patch: Partial<NewLocationInput>,
  ) => {
    if (pending) return;
    const row = values.stock[index];
    if (row?.location.kind !== 'new') return;
    const next: NewLocationInput = { ...row.location.location, ...patch };
    setRow(index, { location: { kind: 'new', location: next } });
  };

  const removeRow = (index: number) => {
    if (pending) return;
    onChange({
      ...values,
      stock: values.stock.filter((_, i) => i !== index),
    });
  };

  const toggleExistingCategory = (categoryId: number) => {
    if (pending) return;
    const selected = values.categories.some(
      (entry) => entry.kind === 'existing' && entry.categoryId === categoryId,
    );
    onChange({
      ...values,
      categories: selected
        ? values.categories.filter(
            (entry) =>
              !(entry.kind === 'existing' && entry.categoryId === categoryId),
          )
        : [...values.categories, { kind: 'existing', categoryId }],
    });
  };

  const addNewCategoryDraft = () => {
    if (pending || values.pendingNewCategoryName.trim() === '') return;
    onChange({
      ...values,
      categories: [
        ...values.categories,
        { kind: 'new', category: { name: values.pendingNewCategoryName } },
      ],
      pendingNewCategoryName: '',
    });
  };

  const removeCategoryAt = (index: number) => {
    if (pending) return;
    onChange({
      ...values,
      categories: values.categories.filter((_, i) => i !== index),
    });
  };

  // New-draft chips keyed by name + append ordinal (duplicates allowed);
  // removal still targets the draft's position in values.categories.
  const newDrafts: { name: string; index: number; key: string }[] = [];
  {
    let ordinal = 0;
    values.categories.forEach((entry, index) => {
      if (entry.kind !== 'new') return;
      ordinal += 1;
      newDrafts.push({
        name: entry.category.name,
        index,
        key: `new-category-${entry.category.name}-${ordinal}`,
      });
    });
  }

  const saveDisabled = pending || onSubmit === undefined;
  const closeDisabled = pending || onRequestClose === undefined;
  // Destructive zone (DESIGN.md §3.4): edit mode only, explicit request
  // callback only, never while a write is in flight.
  const showDelete = mode === 'edit' && onRequestDelete !== undefined;
  const deleteDisabled = pending;
  const addCategoryDisabled =
    pending || values.pendingNewCategoryName.trim() === '';

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: palette.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        testID="item-form"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 },
        ]}
      >
        <View style={styles.titleRow}>
          <Text
            testID="item-form/title"
            style={[styles.title, { color: palette.text }]}
          >
            {mode === 'add' ? t('itemFormTitleAdd') : t('itemFormTitleEdit')}
          </Text>
          <Pressable
            testID="item-form/close"
            accessibilityRole="button"
            accessibilityLabel={t('itemFormClose')}
            accessibilityState={{ disabled: closeDisabled }}
            disabled={closeDisabled}
            onPress={() => onRequestClose?.()}
            style={styles.closeButton}
          >
            <Text
              style={[
                styles.closeText,
                { color: closeDisabled ? palette.secondary : palette.accent },
              ]}
            >
              {t('itemFormClose')}
            </Text>
          </Pressable>
        </View>

        {errors?.form ? (
          <FieldError
            testID="item-form/error-form"
            message={errors.form}
            palette={palette}
            focusRef={registerNode('item-form/error-form')}
          />
        ) : null}

        <Text
          nativeID="item-form-name-label"
          style={[styles.label, { color: palette.text }]}
        >
          {t('itemFormNameLabel')}
        </Text>
        <TextInput
          testID="item-form/name"
          ref={registerNode('item-form/name')}
          accessibilityLabel={t('itemFormNameLabel')}
          aria-labelledby="item-form-name-label"
          placeholder={t('itemFormNamePlaceholder')}
          placeholderTextColor={palette.secondary}
          value={values.name}
          onChangeText={(next) => {
            if (!pending) onChange({ ...values, name: next });
          }}
          onBlur={() => {
            if (!pending) onFieldBlur?.('name');
          }}
          editable={!pending}
          autoCorrect={false}
          returnKeyType="next"
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.controlBorder },
          ]}
        />
        {errors?.name ? (
          <FieldError
            testID="item-form/error-name"
            message={errors.name}
            palette={palette}
          />
        ) : null}

        <Text style={[styles.label, { color: palette.text }]}>
          {t('itemFormStockLabel')}
        </Text>
        {values.stock.map((row, index) => {
          const parsed = parseQuantityRaw(row.quantityRaw);
          const rowValid = parsed !== null;
          // Null-parse raw (blank/invalid/non-integer/unsafe) disables
          // BOTH steppers: no quiet rewrite to a default, the text stays
          // for errors.
          const rowDecrementDisabled =
            pending || !rowValid || (parsed as number) <= 0;
          // Product cap: the stepper never steps above
          // PRODUCT_MAX_QUANTITY. At the cap increment is disabled; above
          // the cap the parse is null so both steppers stay disabled and
          // the raw text is preserved for the parent's out-of-range error.
          const rowIncrementDisabled =
            pending || !rowValid || parsed === PRODUCT_MAX_QUANTITY;
          const rowIsExhausted = parsed === 0;
          const rowErrors = errors?.stock?.[index];
          const selector = row.location;
          const rowName =
            selector.kind === 'existing'
              ? (locations.find(
                  (location) => location.id === selector.locationId,
                )?.name ?? `#${selector.locationId}`)
              : selector.location.name.trim() !== ''
                ? selector.location.name
                : t('itemFormLocationNew');
          const quantityTestID = `item-form/stock-${index}/quantity`;
          return (
            // Rows are append/remove-by-index with no stable id; the
            // controller aligns per-row errors by this same index.
            // biome-ignore lint/suspicious/noArrayIndexKey: index is the row identity here.
            <View key={`stock-${index}`} style={styles.stockRow}>
              <View style={styles.stockRowHeader}>
                <Text
                  testID={`item-form/stock-${index}/name`}
                  style={[styles.stockRowName, { color: palette.text }]}
                >
                  {rowName}
                </Text>
                <Pressable
                  testID={`item-form/stock-${index}/remove`}
                  accessibilityRole="button"
                  accessibilityLabel={t('itemFormRemoveStockRow', {
                    name: rowName,
                  })}
                  accessibilityState={{ disabled: pending }}
                  disabled={pending}
                  onPress={() => removeRow(index)}
                  style={styles.draftRemove}
                >
                  <Text
                    style={[styles.draftRemoveText, { color: palette.accent }]}
                  >
                    {REMOVE_GLYPH}
                  </Text>
                </Pressable>
              </View>
              {row.location.kind === 'new' ? (
                <View style={styles.inlineGroup}>
                  <Text style={[styles.subLabel, { color: palette.text }]}>
                    {t('itemFormNewLocationNameLabel')}
                  </Text>
                  <TextInput
                    testID={`item-form/stock-${index}/location-new/name`}
                    ref={registerNode(
                      `item-form/stock-${index}/location-new/name`,
                    )}
                    accessibilityLabel={t('itemFormNewLocationNameLabel')}
                    placeholder={t('itemFormNewLocationNamePlaceholder')}
                    placeholderTextColor={palette.secondary}
                    value={row.location.location.name}
                    onChangeText={(next) =>
                      editRowNewLocation(index, { name: next })
                    }
                    editable={!pending}
                    autoCorrect={false}
                    style={[
                      styles.input,
                      {
                        color: palette.text,
                        borderColor: palette.controlBorder,
                      },
                    ]}
                  />
                  <Text style={[styles.subLabel, { color: palette.text }]}>
                    {t('itemFormNewLocationAddressLabel')}
                  </Text>
                  <TextInput
                    testID={`item-form/stock-${index}/location-new/address`}
                    accessibilityLabel={t('itemFormNewLocationAddressLabel')}
                    placeholder={t('itemFormNewLocationAddressPlaceholder')}
                    placeholderTextColor={palette.secondary}
                    value={row.location.location.address ?? ''}
                    onChangeText={(next) =>
                      editRowNewLocation(index, {
                        address: next === '' ? null : next,
                      })
                    }
                    editable={!pending}
                    autoCorrect={false}
                    style={[
                      styles.input,
                      {
                        color: palette.text,
                        borderColor: palette.controlBorder,
                      },
                    ]}
                  />
                </View>
              ) : null}
              <View style={styles.quantityRow}>
                <Pressable
                  testID={`item-form/stock-${index}/decrement`}
                  accessibilityRole="button"
                  accessibilityLabel={t('itemFormDecrement')}
                  accessibilityState={{ disabled: rowDecrementDisabled }}
                  disabled={rowDecrementDisabled}
                  onPress={() => stepRowQuantity(index, -1)}
                  style={[
                    styles.stepper,
                    {
                      borderColor: palette.controlBorder,
                      backgroundColor: rowDecrementDisabled
                        ? palette.surface
                        : 'transparent',
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.stepperText,
                      {
                        color: rowDecrementDisabled
                          ? palette.secondary
                          : palette.text,
                      },
                    ]}
                  >
                    {DECREMENT_GLYPH}
                  </Text>
                </Pressable>
                <TextInput
                  testID={quantityTestID}
                  ref={registerNode(quantityTestID)}
                  accessibilityLabel={`${rowName}, ${t('itemFormQuantityLabel')}`}
                  placeholder={t('itemFormQuantityPlaceholder')}
                  placeholderTextColor={palette.secondary}
                  value={row.quantityRaw}
                  onChangeText={(next) => {
                    if (!pending) setRow(index, { quantityRaw: next });
                  }}
                  onBlur={() => {
                    if (!pending) onFieldBlur?.('quantity', index);
                  }}
                  editable={!pending}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  returnKeyType="done"
                  style={[
                    styles.quantityInput,
                    {
                      color: palette.text,
                      borderColor: palette.controlBorder,
                    },
                  ]}
                />
                <Pressable
                  testID={`item-form/stock-${index}/increment`}
                  accessibilityRole="button"
                  accessibilityLabel={t('itemFormIncrement')}
                  accessibilityState={{ disabled: rowIncrementDisabled }}
                  disabled={rowIncrementDisabled}
                  onPress={() => stepRowQuantity(index, 1)}
                  style={[
                    styles.stepper,
                    {
                      borderColor: palette.controlBorder,
                      backgroundColor: rowIncrementDisabled
                        ? palette.surface
                        : 'transparent',
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.stepperText,
                      {
                        color: rowIncrementDisabled
                          ? palette.secondary
                          : palette.text,
                      },
                    ]}
                  >
                    {INCREMENT_GLYPH}
                  </Text>
                </Pressable>
              </View>
              {rowIsExhausted ? (
                <Text
                  testID={`item-form/stock-${index}/exhausted`}
                  style={[styles.exhausted, { color: palette.error }]}
                >
                  {t('inventoryExhausted')}
                </Text>
              ) : null}
              {rowErrors?.quantity ? (
                <FieldError
                  testID={`item-form/error-stock-${index}-quantity`}
                  message={rowErrors.quantity}
                  palette={palette}
                />
              ) : null}
              {rowErrors?.location ? (
                <FieldError
                  testID={`item-form/error-stock-${index}-location`}
                  message={rowErrors.location}
                  palette={palette}
                  focusRef={registerNode(
                    `item-form/error-stock-${index}-location`,
                  )}
                />
              ) : null}
            </View>
          );
        })}
        <Text style={[styles.subLabel, { color: palette.text }]}>
          {t('itemFormAddLocationLabel')}
        </Text>
        <View style={styles.chipWrap}>
          {availableLocations.map((location) => (
            <Pressable
              key={location.id}
              testID={`item-form/location-${location.id}`}
              accessibilityRole="button"
              accessibilityLabel={location.name}
              accessibilityState={{ selected: false, disabled: pending }}
              disabled={pending}
              onPress={() => appendExistingLocation(location.id)}
              style={[
                styles.chip,
                {
                  borderColor: palette.controlBorder,
                  backgroundColor: 'transparent',
                },
              ]}
            >
              <Text style={{ color: palette.text }}>{location.name}</Text>
            </Pressable>
          ))}
          <Pressable
            testID="item-form/location-new"
            accessibilityRole="button"
            accessibilityLabel={t('itemFormLocationNew')}
            accessibilityState={{ selected: false, disabled: pending }}
            disabled={pending}
            onPress={appendNewLocation}
            style={[
              styles.chip,
              {
                borderColor: palette.controlBorder,
                backgroundColor: 'transparent',
              },
            ]}
          >
            <Text style={{ color: palette.text }}>
              {t('itemFormLocationNew')}
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.label, { color: palette.text }]}>
          {t('itemFormCategoriesLabel')}
        </Text>
        <View style={styles.chipWrap}>
          {categories.map((category) => {
            const selected = values.categories.some(
              (entry) =>
                entry.kind === 'existing' && entry.categoryId === category.id,
            );
            return (
              <Pressable
                key={category.id}
                testID={`item-form/category-${category.id}`}
                accessibilityRole="button"
                accessibilityLabel={category.name}
                accessibilityState={{ selected, disabled: pending }}
                disabled={pending}
                onPress={() => toggleExistingCategory(category.id)}
                style={[
                  styles.chip,
                  {
                    borderColor: palette.controlBorder,
                    backgroundColor: selected ? palette.accent : 'transparent',
                  },
                ]}
              >
                <Text
                  style={{
                    color: selected ? palette.accentOn : palette.text,
                  }}
                >
                  {category.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {newDrafts.length > 0 ? (
          <View style={styles.draftRow}>
            {newDrafts.map(({ name, index, key }) => (
              <View
                key={key}
                style={[styles.draftChip, { borderColor: palette.separator }]}
              >
                <Text
                  style={[styles.draftText, { color: palette.text }]}
                  numberOfLines={1}
                >
                  {name}
                </Text>
                <Pressable
                  testID={`item-form/new-category/remove-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('itemFormRemoveCategory', {
                    name,
                  })}
                  accessibilityState={{ disabled: pending }}
                  disabled={pending}
                  onPress={() => removeCategoryAt(index)}
                  style={styles.draftRemove}
                >
                  <Text
                    style={[styles.draftRemoveText, { color: palette.accent }]}
                  >
                    {REMOVE_GLYPH}
                  </Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <Text style={[styles.subLabel, { color: palette.text }]}>
          {t('itemFormNewCategoryLabel')}
        </Text>
        <View style={styles.newCategoryRow}>
          <TextInput
            testID="item-form/new-category/name"
            ref={registerNode('item-form/new-category/name')}
            accessibilityLabel={t('itemFormNewCategoryLabel')}
            placeholder={t('itemFormNewCategoryPlaceholder')}
            placeholderTextColor={palette.secondary}
            value={values.pendingNewCategoryName}
            onChangeText={(next) => {
              if (!pending)
                onChange({ ...values, pendingNewCategoryName: next });
            }}
            editable={!pending}
            autoCorrect={false}
            style={[
              styles.newCategoryInput,
              { color: palette.text, borderColor: palette.controlBorder },
            ]}
          />
          <Pressable
            testID="item-form/new-category/add"
            accessibilityRole="button"
            accessibilityLabel={t('itemFormNewCategoryAdd')}
            accessibilityState={{
              disabled: addCategoryDisabled,
            }}
            disabled={addCategoryDisabled}
            onPress={addNewCategoryDraft}
            style={[
              styles.addButton,
              {
                backgroundColor: addCategoryDisabled
                  ? palette.surface
                  : palette.accent,
              },
            ]}
          >
            <Text
              style={[
                styles.addButtonText,
                {
                  color: addCategoryDisabled
                    ? palette.secondary
                    : palette.accentOn,
                },
              ]}
            >
              {t('itemFormNewCategoryAdd')}
            </Text>
          </Pressable>
        </View>
        {errors?.categories ? (
          <FieldError
            testID="item-form/error-categories"
            message={errors.categories}
            palette={palette}
          />
        ) : null}

        <Pressable
          testID="item-form/save"
          accessibilityRole="button"
          accessibilityLabel={pending ? t('itemFormSaving') : t('itemFormSave')}
          accessibilityState={{ disabled: saveDisabled, busy: pending }}
          disabled={saveDisabled}
          onPress={() => onSubmit?.()}
          style={[
            styles.saveButton,
            {
              backgroundColor: saveDisabled ? palette.surface : palette.accent,
            },
          ]}
        >
          <Text
            style={[
              styles.saveText,
              { color: saveDisabled ? palette.secondary : palette.accentOn },
            ]}
          >
            {pending ? t('itemFormSaving') : t('itemFormSave')}
          </Text>
        </Pressable>

        {showDelete ? (
          <View
            testID="item-form/delete-zone"
            accessibilityRole="alert"
            style={[styles.deleteZone, { borderColor: palette.error }]}
          >
            <Pressable
              testID="item-form/delete"
              accessibilityRole="button"
              accessibilityLabel={t('itemFormDelete')}
              accessibilityState={{ disabled: deleteDisabled }}
              disabled={deleteDisabled}
              onPress={() => onRequestDelete?.()}
              style={[
                styles.deleteButton,
                {
                  backgroundColor: deleteDisabled
                    ? palette.surface
                    : 'transparent',
                },
              ]}
            >
              <Text
                style={[
                  styles.deleteText,
                  {
                    color: deleteDisabled ? palette.secondary : palette.error,
                  },
                ]}
              >
                {t('itemFormDelete')}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 16,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  title: {
    flex: 1,
    flexShrink: 1,
    fontSize: 22,
    fontWeight: '700',
  },
  closeButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  closeText: {
    fontSize: 17,
    fontWeight: '600',
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 16,
  },
  subLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 12,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 17,
    marginTop: 6,
  },
  errorText: {
    fontSize: 14,
    marginTop: 4,
  },
  quantityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  stepper: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 10,
  },
  stepperText: {
    fontSize: 22,
    fontWeight: '600',
  },
  quantityInput: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 17,
    textAlign: 'center',
  },
  exhausted: {
    fontSize: 15,
    fontWeight: '700',
    marginTop: 4,
  },
  stockRow: {
    marginTop: 8,
    gap: 2,
  },
  stockRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  stockRowName: {
    flex: 1,
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
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
  inlineGroup: {
    marginTop: 4,
  },
  draftRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  draftChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingLeft: 14,
    paddingRight: 6,
    minHeight: 48,
    maxWidth: '100%',
  },
  draftText: {
    flexShrink: 1,
    fontSize: 15,
  },
  draftRemove: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  draftRemoveText: {
    fontSize: 17,
    fontWeight: '700',
  },
  newCategoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  newCategoryInput: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 17,
  },
  addButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 16,
  },
  addButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  saveButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 20,
    marginTop: 24,
  },
  saveText: {
    fontSize: 17,
    fontWeight: '600',
  },
  deleteZone: {
    marginTop: 24,
    borderTopWidth: 1,
    paddingTop: 8,
  },
  deleteButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 20,
  },
  deleteText: {
    fontSize: 17,
    fontWeight: '600',
  },
});
