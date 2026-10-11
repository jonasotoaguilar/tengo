/**
 * U2b add/edit item modal host (no DB open, no navigation).
 *
 * Owns ONE `useItemFormController` instance for ONE route over the
 * already-open managed handle: a full-screen slide `Modal` containing the
 * controlled `ItemForm`, a compact load-error surface with Retry/Close
 * (never blank, never raw SQL), and in-Modal discard/delete confirmation
 * overlays (never nested Modals). The hook emits the stable
 * `formErrorCode` (`storage` | `not-found` | `in-use`); this screen maps
 * it to localized `errors.form` copy while field errors pass through
 * unchanged. Success callbacks (`onSaved`/`onDeleted`) let the container
 * refresh the current list, total, and choices; dismissal clears the
 * route. Unit tests only — TalkBack/keyboard focus needs Android proof.
 */
import { useTranslation } from 'react-i18next';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';

import ItemForm, { type ItemFormErrors } from '../components/ItemForm';
import type { RepositoryDb } from '../inventory/database';
import type { Category, ItemDetail, Location } from '../inventory/types';
import useItemFormController, {
  type ItemFormRoute,
} from './useItemFormController';

export interface ItemFormScreenProps {
  /** Already-open managed handle. Never opened, reopened, or closed here. */
  db: RepositoryDb;
  route: ItemFormRoute;
  locations: Location[];
  categories: Category[];
  /** Fired after a successful persist so the owner refreshes its reads. */
  onSaved: (detail: ItemDetail) => void;
  onDeleted: (id: number) => void;
  /** Fired on explicit dismiss (clean close, confirmed discard, post-write). */
  onDismiss: () => void;
}

const LIGHT = {
  background: '#FFFFFF',
  text: '#1A1C19',
  surface: '#F4F2EC',
  border: '#C9C5B8',
  accent: '#2F6B3A',
  accentOn: '#FFFFFF',
  error: '#B3261E',
  overlay: 'rgba(0, 0, 0, 0.4)',
};

const DARK = {
  background: '#121212',
  text: '#F2F1ED',
  surface: '#1C1C1E',
  border: '#38383A',
  accent: '#7BC79A',
  accentOn: '#0B2E18',
  error: '#FFB4AB',
  overlay: 'rgba(0, 0, 0, 0.6)',
};

/** Map the hook's stable code to localized copy (never raw codes). */
function formMessageFor(
  code: string | null,
  t: (key: string) => string,
): string | null {
  if (code === null) return null;
  if (code === 'not-found') return t('itemFormErrorNotFound');
  if (code === 'in-use') return t('itemFormErrorInUse');
  return t('itemFormErrorStorage');
}

export default function ItemFormScreen({
  db,
  route,
  locations,
  categories,
  onSaved,
  onDeleted,
  onDismiss,
}: ItemFormScreenProps) {
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const palette = scheme === 'dark' ? DARK : LIGHT;

  const controller = useItemFormController({
    db,
    route,
    onSaved,
    onDeleted,
    onDismissed: onDismiss,
  });

  const formMessage = formMessageFor(controller.formErrorCode, t);
  const errors: ItemFormErrors =
    formMessage === null
      ? controller.errors
      : { ...controller.errors, form: formMessage };

  return (
    <Modal
      testID="item-form-screen"
      visible
      animationType="slide"
      onRequestClose={controller.onRequestClose}
    >
      <View style={[styles.container, { backgroundColor: palette.background }]}>
        {controller.loadState === 'error' ? (
          <View testID="item-form-screen/load-error" style={styles.loadError}>
            <Text
              testID="item-form-screen/load-error-title"
              style={[styles.dialogTitle, { color: palette.text }]}
            >
              {t('itemFormLoadErrorTitle')}
            </Text>
            <Pressable
              testID="item-form-screen/retry"
              accessibilityRole="button"
              accessibilityLabel={t('inventoryRetry')}
              onPress={controller.onRetry}
              style={[styles.button, { backgroundColor: palette.accent }]}
            >
              <Text style={[styles.buttonText, { color: palette.accentOn }]}>
                {t('inventoryRetry')}
              </Text>
            </Pressable>
            <Pressable
              testID="item-form-screen/load-close"
              accessibilityRole="button"
              accessibilityLabel={t('itemFormClose')}
              onPress={controller.onRequestClose}
              style={styles.textButton}
            >
              <Text style={[styles.textButtonText, { color: palette.accent }]}>
                {t('itemFormClose')}
              </Text>
            </Pressable>
          </View>
        ) : controller.loadState === 'loading' ? (
          // Edit load window: a dedicated surface with NO editable
          // inputs, so the user cannot type into the blank reset session
          // that the resolving load is about to overwrite. Close stays
          // available so the user is never trapped; a translated line
          // (never a bare spinner, per DESIGN.md §4) names the state.
          <View testID="item-form/loading" style={styles.loadError}>
            <Text
              testID="item-form/loading-message"
              style={[styles.dialogTitle, { color: palette.text }]}
            >
              {t('itemFormLoading')}
            </Text>
            <Pressable
              testID="item-form/loading-close"
              accessibilityRole="button"
              accessibilityLabel={t('itemFormClose')}
              onPress={controller.onRequestClose}
              style={styles.textButton}
            >
              <Text style={[styles.textButtonText, { color: palette.accent }]}>
                {t('itemFormClose')}
              </Text>
            </Pressable>
          </View>
        ) : (
          <ItemForm
            mode={controller.mode}
            values={controller.values}
            onChange={controller.onChange}
            onFieldBlur={controller.onFieldBlur}
            onSubmit={() => {
              void controller.onSave();
            }}
            onRequestClose={controller.onRequestClose}
            onRequestDelete={
              route.kind === 'edit' ? controller.onRequestDelete : undefined
            }
            errors={errors}
            submitting={controller.submitting}
            locations={locations}
            categories={categories}
          />
        )}

        {controller.confirmDiscard ? (
          <View
            testID="item-form-screen/discard-dialog"
            accessibilityViewIsModal
            style={[styles.overlay, { backgroundColor: palette.overlay }]}
          >
            <View
              style={[styles.dialog, { backgroundColor: palette.background }]}
            >
              <Text
                testID="item-form-screen/discard-title"
                style={[styles.dialogTitle, { color: palette.text }]}
              >
                {t('itemFormDiscardTitle')}
              </Text>
              <Text
                testID="item-form-screen/discard-message"
                style={[styles.dialogMessage, { color: palette.text }]}
              >
                {t('itemFormDiscardMessage')}
              </Text>
              <Pressable
                testID="item-form-screen/discard-cancel"
                accessibilityRole="button"
                accessibilityLabel={t('itemFormDiscardCancel')}
                onPress={controller.onCancelDiscard}
                style={styles.textButton}
              >
                <Text
                  style={[styles.textButtonText, { color: palette.accent }]}
                >
                  {t('itemFormDiscardCancel')}
                </Text>
              </Pressable>
              <Pressable
                testID="item-form-screen/discard-confirm"
                accessibilityRole="button"
                accessibilityLabel={t('itemFormDiscardConfirm')}
                onPress={controller.onConfirmDiscard}
                style={[styles.button, { backgroundColor: palette.error }]}
              >
                <Text style={[styles.buttonText, { color: '#FFFFFF' }]}>
                  {t('itemFormDiscardConfirm')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {controller.confirmDelete ? (
          <View
            testID="item-form-screen/delete-dialog"
            accessibilityViewIsModal
            style={[styles.overlay, { backgroundColor: palette.overlay }]}
          >
            <View
              style={[styles.dialog, { backgroundColor: palette.background }]}
            >
              <Text
                testID="item-form-screen/delete-title"
                style={[styles.dialogTitle, { color: palette.text }]}
              >
                {t('itemFormDeleteTitle', {
                  name: controller.detail?.name ?? controller.values.name,
                })}
              </Text>
              <Text
                testID="item-form-screen/delete-message"
                style={[styles.dialogMessage, { color: palette.text }]}
              >
                {t('itemFormDeleteMessage')}
              </Text>
              <Pressable
                testID="item-form-screen/delete-cancel"
                accessibilityRole="button"
                accessibilityLabel={t('itemFormDeleteCancel')}
                onPress={controller.onCancelDelete}
                style={styles.textButton}
              >
                <Text
                  style={[styles.textButtonText, { color: palette.accent }]}
                >
                  {t('itemFormDeleteCancel')}
                </Text>
              </Pressable>
              <Pressable
                testID="item-form-screen/delete-confirm"
                accessibilityRole="button"
                accessibilityLabel={t('itemFormDeleteConfirm')}
                onPress={() => {
                  void controller.onConfirmDelete();
                }}
                style={[styles.button, { backgroundColor: palette.error }]}
              >
                <Text style={[styles.buttonText, { color: '#FFFFFF' }]}>
                  {t('itemFormDeleteConfirm')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadError: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 16,
    gap: 12,
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
  button: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingHorizontal: 20,
    marginTop: 8,
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
});
