/**
 * Entity-management screen (D6/S12 adopted on the v4 model).
 *
 * Manages the two entity kinds: locations (name required, address
 * optional) and categories (name required). Create, rename and delete go
 * through the existing domain repository functions (`createLocation`,
 * `updateLocation`, `deleteLocation`, `createCategory`, `updateCategory`,
 * `deleteCategory`), so S11 uniqueness and the S10 trimmed bounds stay
 * enforced by the domain; typed conflict/bound errors surface as
 * localized inline copy, never raw storage text.
 *
 * Delete confirmations state the impact (the point of this screen):
 * a location counts its stock rows first (`locationDeleteImpact`) and
 * says the items themselves are NOT deleted (leftovers stay visible as
 * sin stock, R6); a category counts its linked items first
 * (`categoryDeleteImpact`) and says the items are NOT deleted. The
 * confirmation overlays reuse the ItemFormScreen modal pattern (an
 * in-screen overlay + dialog, never a second Modal).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RepositoryDb } from '../inventory/database';
import {
  categoryDeleteImpact,
  createCategory,
  createLocation,
  deleteCategory,
  deleteLocation,
  locationDeleteImpact,
  updateCategory,
  updateLocation,
} from '../inventory/entityRepository';
import {
  EntityConflictError,
  EntityNotFoundError,
  ValidationError,
} from '../inventory/errors';
import type {
  Category,
  CategoryDeleteImpact,
  Location,
  LocationDeleteImpact,
} from '../inventory/types';
import {
  CATEGORY_NAME_MAX_LENGTH,
  LOCATION_NAME_MAX_LENGTH,
} from '../inventory/validation';
import {
  DARK as DARK_BASE,
  LIGHT as LIGHT_BASE,
  type PaletteBase,
} from '../theme/tokens';

export interface EntityManagerProps {
  /** Already-open managed handle. Never opened, reopened, or closed here. */
  db: RepositoryDb;
  locations: Location[];
  categories: Category[];
  /** Fired after every successful write so the owner refreshes its reads. */
  onChanged: () => void;
  /** Fired on explicit close. */
  onClose: () => void;
}

type Palette = PaletteBase;

const LIGHT: Palette = { ...LIGHT_BASE };
const DARK: Palette = { ...DARK_BASE };

interface EditingState {
  kind: 'location' | 'category';
  id: number;
  name: string;
  address: string;
}

interface DeletingState {
  kind: 'location' | 'category';
  id: number;
  name: string;
  impact: LocationDeleteImpact | CategoryDeleteImpact;
}

export default function EntityManager({
  db,
  locations,
  categories,
  onChanged,
  onClose,
}: EntityManagerProps) {
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const palette = scheme === 'dark' ? DARK : LIGHT;
  const insets = useSafeAreaInsets();

  const [newLocationName, setNewLocationName] = useState('');
  const [newLocationAddress, setNewLocationAddress] = useState('');
  const [locationFormError, setLocationFormError] = useState<string | null>(
    null,
  );
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryFormError, setCategoryFormError] = useState<string | null>(
    null,
  );
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeletingState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** Map a repository failure to localized inline copy (never raw text). */
  function messageFor(error: unknown, kind: 'location' | 'category'): string {
    if (error instanceof EntityConflictError) {
      return kind === 'location'
        ? t('itemFormErrorLocationNameConflict')
        : t('itemFormErrorCategoryNameConflict');
    }
    if (error instanceof ValidationError) {
      if (error.code === 'blank') return t('itemFormErrorNameRequired');
      if (error.code === 'too-long') {
        return kind === 'location'
          ? t('itemFormErrorLocationNameTooLong')
          : t('itemFormErrorCategoryNameTooLong');
      }
      return t('itemFormErrorStorage');
    }
    if (error instanceof EntityNotFoundError) {
      return t('itemFormErrorNotFound');
    }
    return t('itemFormErrorStorage');
  }

  /** Local bound guard so over-long input never reaches the repository. */
  function locationNameError(name: string): string | null {
    if (name.trim().length === 0) return t('itemFormErrorNameRequired');
    if (name.trim().length > LOCATION_NAME_MAX_LENGTH) {
      return t('itemFormErrorLocationNameTooLong');
    }
    return null;
  }

  function categoryNameError(name: string): string | null {
    if (name.trim().length === 0) return t('itemFormErrorNameRequired');
    if (name.trim().length > CATEGORY_NAME_MAX_LENGTH) {
      return t('itemFormErrorCategoryNameTooLong');
    }
    return null;
  }

  async function handleAddLocation(): Promise<void> {
    const problem = locationNameError(newLocationName);
    if (problem !== null) {
      setLocationFormError(problem);
      return;
    }
    setSubmitting(true);
    setLocationFormError(null);
    try {
      await createLocation(db, {
        name: newLocationName,
        address:
          newLocationAddress.trim().length === 0 ? null : newLocationAddress,
      });
      setNewLocationName('');
      setNewLocationAddress('');
      onChanged();
    } catch (error) {
      setLocationFormError(messageFor(error, 'location'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddCategory(): Promise<void> {
    const problem = categoryNameError(newCategoryName);
    if (problem !== null) {
      setCategoryFormError(problem);
      return;
    }
    setSubmitting(true);
    setCategoryFormError(null);
    try {
      await createCategory(db, { name: newCategoryName });
      setNewCategoryName('');
      onChanged();
    } catch (error) {
      setCategoryFormError(messageFor(error, 'category'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveEdit(): Promise<void> {
    if (editing === null) return;
    const kind = editing.kind;
    const problem =
      kind === 'location'
        ? locationNameError(editing.name)
        : categoryNameError(editing.name);
    if (problem !== null) {
      setEditError(problem);
      return;
    }
    setSubmitting(true);
    setEditError(null);
    try {
      if (kind === 'location') {
        await updateLocation(db, editing.id, {
          name: editing.name,
          address: editing.address.trim().length === 0 ? null : editing.address,
        });
      } else {
        await updateCategory(db, editing.id, { name: editing.name });
      }
      setEditing(null);
      onChanged();
    } catch (error) {
      setEditError(messageFor(error, kind));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAskDelete(
    kind: 'location' | 'category',
    id: number,
    name: string,
  ): Promise<void> {
    setSubmitting(true);
    try {
      const impact =
        kind === 'location'
          ? await locationDeleteImpact(db, id)
          : await categoryDeleteImpact(db, id);
      setDeleting({ kind, id, name, impact });
    } catch (error) {
      if (kind === 'location') {
        setLocationFormError(messageFor(error, kind));
      } else {
        setCategoryFormError(messageFor(error, kind));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmDelete(): Promise<void> {
    if (deleting === null) return;
    const target = deleting;
    setSubmitting(true);
    try {
      if (target.kind === 'location') {
        await deleteLocation(db, target.id);
      } else {
        await deleteCategory(db, target.id);
      }
      setDeleting(null);
      onChanged();
    } catch (error) {
      if (target.kind === 'location') {
        setLocationFormError(messageFor(error, target.kind));
      } else {
        setCategoryFormError(messageFor(error, target.kind));
      }
      setDeleting(null);
    } finally {
      setSubmitting(false);
    }
  }

  const deleteTitle =
    deleting === null
      ? ''
      : deleting.kind === 'location'
        ? t('entityManagerLocationDeleteTitle', { name: deleting.name })
        : t('entityManagerCategoryDeleteTitle', { name: deleting.name });
  const deleteMessage =
    deleting === null
      ? ''
      : deleting.kind === 'location'
        ? t('entityManagerLocationDeleteMessage', {
            stockRows: (deleting.impact as LocationDeleteImpact).stockRows,
            unstocked: (deleting.impact as LocationDeleteImpact).unstockedItems,
          })
        : t('entityManagerCategoryDeleteMessage', {
            items: (deleting.impact as CategoryDeleteImpact).items,
          });

  return (
    <View
      testID="entity-manager"
      style={[
        styles.root,
        { backgroundColor: palette.background, paddingTop: insets.top },
      ]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 16 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.titleRow}>
          <Text
            testID="entity-manager-title"
            style={[styles.title, { color: palette.text }]}
          >
            {t('entityManagerTitle')}
          </Text>
          <Pressable
            testID="entity-close"
            accessibilityRole="button"
            accessibilityLabel={t('entityManagerClose')}
            accessibilityState={{ disabled: false }}
            onPress={onClose}
            style={styles.textButton}
          >
            <Text style={[styles.textButtonText, { color: palette.accent }]}>
              {t('entityManagerClose')}
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.sectionTitle, { color: palette.text }]}>
          {t('entityManagerLocationsTitle')}
        </Text>
        {locations.length === 0 ? (
          <Text
            testID="entity-locations-empty"
            style={[styles.emptyText, { color: palette.secondary }]}
          >
            {t('entityManagerEmptyLocations')}
          </Text>
        ) : null}
        {locations.map((location) => (
          <View
            key={location.id}
            testID={`entity-location-${location.id}`}
            accessibilityRole="text"
            accessibilityLabel={location.name}
            style={[styles.row, { borderColor: palette.separator }]}
          >
            <Text style={[styles.rowName, { color: palette.text }]}>
              {location.name}
            </Text>
            <View style={styles.rowActions}>
              <Pressable
                testID={`entity-location-${location.id}-rename`}
                accessibilityRole="button"
                accessibilityLabel={t('entityManagerRename')}
                accessibilityState={{ disabled: submitting }}
                disabled={submitting}
                onPress={() =>
                  setEditing({
                    kind: 'location',
                    id: location.id,
                    name: location.name,
                    address: location.address ?? '',
                  })
                }
                style={styles.rowButton}
              >
                <Text style={[styles.rowButtonText, { color: palette.accent }]}>
                  {t('entityManagerRename')}
                </Text>
              </Pressable>
              <Pressable
                testID={`entity-location-${location.id}-delete`}
                accessibilityRole="button"
                accessibilityLabel={t('entityManagerDelete')}
                accessibilityState={{ disabled: submitting }}
                disabled={submitting}
                onPress={() => {
                  void handleAskDelete('location', location.id, location.name);
                }}
                style={styles.rowButton}
              >
                <Text style={[styles.rowButtonText, { color: palette.error }]}>
                  {t('entityManagerDelete')}
                </Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Text style={[styles.fieldLabel, { color: palette.secondary }]}>
          {t('entityManagerLocationNameLabel')}
        </Text>
        <TextInput
          testID="entity-new-location-name"
          accessibilityLabel={t('entityManagerLocationNameLabel')}
          placeholder={t('entityManagerLocationNamePlaceholder')}
          placeholderTextColor={palette.secondary}
          value={newLocationName}
          onChangeText={setNewLocationName}
          autoCorrect={false}
          autoCapitalize="none"
          editable={!submitting}
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.controlBorder },
          ]}
        />
        <Text style={[styles.fieldLabel, { color: palette.secondary }]}>
          {t('entityManagerLocationAddressLabel')}
        </Text>
        <TextInput
          testID="entity-new-location-address"
          accessibilityLabel={t('entityManagerLocationAddressLabel')}
          placeholder={t('entityManagerLocationAddressPlaceholder')}
          placeholderTextColor={palette.secondary}
          value={newLocationAddress}
          onChangeText={setNewLocationAddress}
          autoCorrect={false}
          autoCapitalize="none"
          editable={!submitting}
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.controlBorder },
          ]}
        />
        {locationFormError !== null ? (
          <Text
            testID="entity-location-form-error"
            style={[styles.errorText, { color: palette.error }]}
          >
            {locationFormError}
          </Text>
        ) : null}
        <Pressable
          testID="entity-add-location"
          accessibilityRole="button"
          accessibilityLabel={t('entityManagerAddLocation')}
          accessibilityState={{ disabled: submitting }}
          disabled={submitting}
          onPress={() => {
            void handleAddLocation();
          }}
          style={[
            styles.button,
            { backgroundColor: submitting ? palette.surface : palette.accent },
          ]}
        >
          <Text
            style={[
              styles.buttonText,
              { color: submitting ? palette.secondary : palette.accentOn },
            ]}
          >
            {t('entityManagerAddLocation')}
          </Text>
        </Pressable>

        <Text style={[styles.sectionTitle, { color: palette.text }]}>
          {t('entityManagerCategoriesTitle')}
        </Text>
        {categories.length === 0 ? (
          <Text
            testID="entity-categories-empty"
            style={[styles.emptyText, { color: palette.secondary }]}
          >
            {t('entityManagerEmptyCategories')}
          </Text>
        ) : null}
        {categories.map((category) => (
          <View
            key={category.id}
            testID={`entity-category-${category.id}`}
            accessibilityRole="text"
            accessibilityLabel={category.name}
            style={[styles.row, { borderColor: palette.separator }]}
          >
            <Text style={[styles.rowName, { color: palette.text }]}>
              {category.name}
            </Text>
            <View style={styles.rowActions}>
              <Pressable
                testID={`entity-category-${category.id}-rename`}
                accessibilityRole="button"
                accessibilityLabel={t('entityManagerRename')}
                accessibilityState={{ disabled: submitting }}
                disabled={submitting}
                onPress={() =>
                  setEditing({
                    kind: 'category',
                    id: category.id,
                    name: category.name,
                    address: '',
                  })
                }
                style={styles.rowButton}
              >
                <Text style={[styles.rowButtonText, { color: palette.accent }]}>
                  {t('entityManagerRename')}
                </Text>
              </Pressable>
              <Pressable
                testID={`entity-category-${category.id}-delete`}
                accessibilityRole="button"
                accessibilityLabel={t('entityManagerDelete')}
                accessibilityState={{ disabled: submitting }}
                disabled={submitting}
                onPress={() => {
                  void handleAskDelete('category', category.id, category.name);
                }}
                style={styles.rowButton}
              >
                <Text style={[styles.rowButtonText, { color: palette.error }]}>
                  {t('entityManagerDelete')}
                </Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Text style={[styles.fieldLabel, { color: palette.secondary }]}>
          {t('entityManagerCategoryNameLabel')}
        </Text>
        <TextInput
          testID="entity-new-category-name"
          accessibilityLabel={t('entityManagerCategoryNameLabel')}
          placeholder={t('entityManagerCategoryNamePlaceholder')}
          placeholderTextColor={palette.secondary}
          value={newCategoryName}
          onChangeText={setNewCategoryName}
          autoCorrect={false}
          autoCapitalize="none"
          editable={!submitting}
          style={[
            styles.input,
            { color: palette.text, borderColor: palette.controlBorder },
          ]}
        />
        {categoryFormError !== null ? (
          <Text
            testID="entity-category-form-error"
            style={[styles.errorText, { color: palette.error }]}
          >
            {categoryFormError}
          </Text>
        ) : null}
        <Pressable
          testID="entity-add-category"
          accessibilityRole="button"
          accessibilityLabel={t('entityManagerAddCategory')}
          accessibilityState={{ disabled: submitting }}
          disabled={submitting}
          onPress={() => {
            void handleAddCategory();
          }}
          style={[
            styles.button,
            { backgroundColor: submitting ? palette.surface : palette.accent },
          ]}
        >
          <Text
            style={[
              styles.buttonText,
              { color: submitting ? palette.secondary : palette.accentOn },
            ]}
          >
            {t('entityManagerAddCategory')}
          </Text>
        </Pressable>
      </ScrollView>

      {editing !== null ? (
        <View
          testID="entity-edit-dialog"
          accessibilityRole="alert"
          accessibilityLabel={t('entityManagerEditTitle', {
            name: editing.kind === 'location' ? editing.name : editing.name,
          })}
          accessibilityViewIsModal
          style={styles.overlay}
        >
          <View
            style={[styles.dialog, { backgroundColor: palette.background }]}
          >
            <Text
              testID="entity-edit-title"
              style={[styles.dialogTitle, { color: palette.text }]}
            >
              {t('entityManagerEditTitle', { name: editing.name })}
            </Text>
            <TextInput
              testID="entity-edit-name"
              accessibilityLabel={t('entityManagerLocationNameLabel')}
              value={editing.name}
              onChangeText={(next) =>
                setEditing((prev) =>
                  prev === null ? prev : { ...prev, name: next },
                )
              }
              autoCorrect={false}
              autoCapitalize="none"
              editable={!submitting}
              style={[
                styles.input,
                { color: palette.text, borderColor: palette.controlBorder },
              ]}
            />
            {editError !== null ? (
              <Text
                testID="entity-edit-error"
                style={[styles.errorText, { color: palette.error }]}
              >
                {editError}
              </Text>
            ) : null}
            <Pressable
              testID="entity-edit-cancel"
              accessibilityRole="button"
              accessibilityLabel={t('entityManagerCancel')}
              accessibilityState={{ disabled: false }}
              onPress={() => {
                setEditing(null);
                setEditError(null);
              }}
              style={styles.textButton}
            >
              <Text style={[styles.textButtonText, { color: palette.accent }]}>
                {t('entityManagerCancel')}
              </Text>
            </Pressable>
            <Pressable
              testID="entity-edit-save"
              accessibilityRole="button"
              accessibilityLabel={t('entityManagerEditSave')}
              accessibilityState={{
                disabled: submitting,
                busy: submitting,
              }}
              disabled={submitting}
              onPress={() => {
                void handleSaveEdit();
              }}
              style={[
                styles.button,
                {
                  backgroundColor: submitting
                    ? palette.surface
                    : palette.accent,
                },
              ]}
            >
              <Text
                style={[
                  styles.buttonText,
                  { color: submitting ? palette.secondary : palette.accentOn },
                ]}
              >
                {t('entityManagerEditSave')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {deleting !== null ? (
        <View
          testID="entity-delete-dialog"
          accessibilityRole="alert"
          accessibilityLabel={deleteTitle}
          accessibilityViewIsModal
          style={styles.overlay}
        >
          <View
            style={[styles.dialog, { backgroundColor: palette.background }]}
          >
            <Text
              testID="entity-delete-title"
              style={[styles.dialogTitle, { color: palette.text }]}
            >
              {deleteTitle}
            </Text>
            <Text
              testID="entity-delete-message"
              style={[styles.dialogMessage, { color: palette.text }]}
            >
              {deleteMessage}
            </Text>
            <Pressable
              testID="entity-delete-cancel"
              accessibilityRole="button"
              accessibilityLabel={t('entityManagerCancel')}
              accessibilityState={{ disabled: false }}
              onPress={() => setDeleting(null)}
              style={styles.textButton}
            >
              <Text style={[styles.textButtonText, { color: palette.accent }]}>
                {t('entityManagerCancel')}
              </Text>
            </Pressable>
            <Pressable
              testID="entity-delete-confirm"
              accessibilityRole="button"
              accessibilityLabel={t('entityManagerConfirmDelete')}
              accessibilityHint={deleteMessage}
              accessibilityState={{
                disabled: submitting,
                busy: submitting,
              }}
              disabled={submitting}
              onPress={() => {
                void handleConfirmDelete();
              }}
              style={[styles.button, { backgroundColor: palette.error }]}
            >
              <Text style={[styles.buttonText, { color: palette.accentOn }]}>
                {t('entityManagerConfirmDelete')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    gap: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    flex: 1,
    flexShrink: 1,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 16,
  },
  emptyText: {
    fontSize: 15,
  },
  row: {
    borderTopWidth: 1,
    minHeight: 48,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  rowName: {
    fontSize: 17,
    flex: 1,
    flexShrink: 1,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 4,
  },
  rowButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  rowButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 8,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 17,
  },
  errorText: {
    fontSize: 15,
    fontWeight: '600',
  },
  button: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 20,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  buttonText: {
    fontSize: 17,
    fontWeight: '600',
  },
  textButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  textButtonText: {
    fontSize: 17,
    fontWeight: '600',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  dialog: {
    width: '100%',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  dialogTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  dialogMessage: {
    fontSize: 15,
  },
});
