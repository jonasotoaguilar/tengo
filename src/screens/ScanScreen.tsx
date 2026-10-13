/**
 * U3 barcode scanner screen (camera view only, no routing of its own).
 *
 * Hosts one expo-camera `CameraView` inside a full-screen `Modal` and
 * reports the scan through `onResolved` (edit for a known code, create
 * carrying the code for an unknown one); the decision itself lives in the
 * testable `decideScanRoute`/`resolveCameraAccess` unit, this screen only
 * wires the camera events to it. Invalid codes and lookup failures stay on
 * the scanner with translated copy (never raw error text) so the user can
 * rescan; a lookup resolves at most once (single-flight guard) so a second
 * frame cannot double-report. The permission path never bricks: loading,
 * denied (retry in place), permanently denied (system settings), and
 * mount failure (no/busy camera hardware via `onMountError`) each render
 * readable copy, and Close is always available. Local-first (S4): no
 * network anywhere; the lookup is the on-device `findItemByBarcode`.
 * Real capture needs a physical camera, so Jest only proves this wiring
 * against a mocked expo-camera — never claimed as device proof.
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { RepositoryDb } from '../inventory/database';
import type { ItemDetail } from '../inventory/types';
import {
  decideScanRoute,
  resolveCameraAccess,
} from './useBarcodeScanController';

export interface ScanScreenProps {
  /** Already-open managed handle. Never opened, reopened, or closed here. */
  db: RepositoryDb;
  /** Fired exactly once per scan session (invalid scans never report). */
  onResolved: (
    route:
      | { kind: 'edit'; itemId: number }
      | { kind: 'create'; barcode: string },
  ) => void;
  /** Fired on explicit close from any state. */
  onClose: () => void;
  /** Injectable lookup seam: the real `findItemByBarcode` by default. */
  lookup?: (db: RepositoryDb, barcode: string) => Promise<ItemDetail | null>;
  /** Injectable settings seam: `Linking.openSettings` by default. */
  openSettings?: () => Promise<void>;
}

/** Default settings escape: failures stay put, Close remains available. */
async function defaultOpenSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    // Stay on the permanent-denial message: the user still has Close.
  }
}

export default function ScanScreen({
  db,
  onResolved,
  onClose,
  lookup,
  openSettings = defaultOpenSettings,
}: ScanScreenProps) {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  // Mount failure (no/busy camera hardware) is reported by expo-camera
  // through `onMountError`, not through permission: it leaves the camera
  // state for the unavailable message below.
  const [mountFailed, setMountFailed] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [notice, setNotice] = useState<'invalid' | 'error' | null>(null);
  // Single-flight guard (effective before React rerenders): one lookup at
  // a time, and a resolved scan never reports twice.
  const busyRef = useRef(false);
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const access = resolveCameraAccess(
    permission === null
      ? null
      : { granted: permission.granted, canAskAgain: permission.canAskAgain },
  );

  const handleScanned = useCallback(
    async ({ data }: { data: string }): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setResolving(true);
      setNotice(null);
      try {
        const route = await decideScanRoute(db, data, lookup);
        if (unmounted.current) return;
        if (route.kind === 'invalid') {
          // Stay on the scanner so the user can rescan immediately.
          busyRef.current = false;
          setResolving(false);
          setNotice('invalid');
          return;
        }
        // The owner closes the screen; the guard stays armed so a second
        // frame cannot double-report while dismissal is in flight.
        if (!unmounted.current) setResolving(false);
        onResolved(route);
      } catch {
        if (unmounted.current) return;
        busyRef.current = false;
        setResolving(false);
        setNotice('error');
      }
    },
    [db, lookup, onResolved],
  );

  const handleMountError = useCallback(() => {
    setMountFailed(true);
  }, []);

  const handleRetryPermission = useCallback(() => {
    void requestPermission();
  }, [requestPermission]);

  const handleOpenSettings = useCallback(() => {
    void openSettings();
  }, [openSettings]);

  return (
    <Modal
      testID="scan-screen"
      visible
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <Text testID="scan-title" style={styles.title}>
            {t('scanTitle')}
          </Text>
          <Pressable
            testID="scan-close"
            accessibilityRole="button"
            accessibilityLabel={t('itemFormClose')}
            accessibilityState={{ disabled: false }}
            onPress={onClose}
            style={styles.textButton}
          >
            <Text style={styles.textButtonText}>{t('itemFormClose')}</Text>
          </Pressable>
        </View>

        {mountFailed ? (
          <View style={styles.stateBlock}>
            <Text testID="scan-no-camera-message" style={styles.message}>
              {t('scanNoCamera')}
            </Text>
          </View>
        ) : access === 'loading' ? (
          <View style={styles.stateBlock}>
            <Text testID="scan-loading" style={styles.message}>
              {t('scanLoading')}
            </Text>
          </View>
        ) : access === 'denied' ? (
          <View style={styles.stateBlock}>
            <Text testID="scan-denied-message" style={styles.message}>
              {t('scanPermissionDenied')}
            </Text>
            <Pressable
              testID="scan-retry-permission"
              accessibilityRole="button"
              accessibilityLabel={t('scanRetryPermission')}
              accessibilityState={{ disabled: false }}
              onPress={handleRetryPermission}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{t('scanRetryPermission')}</Text>
            </Pressable>
          </View>
        ) : access === 'permanently-denied' ? (
          <View style={styles.stateBlock}>
            <Text testID="scan-permanent-message" style={styles.message}>
              {t('scanPermissionPermanent')}
            </Text>
            <Pressable
              testID="scan-open-settings"
              accessibilityRole="button"
              accessibilityLabel={t('scanOpenSettings')}
              accessibilityState={{ disabled: false }}
              onPress={handleOpenSettings}
              style={styles.button}
            >
              <Text style={styles.buttonText}>{t('scanOpenSettings')}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.cameraBlock}>
            <CameraView
              testID="scan-camera"
              style={styles.camera}
              facing="back"
              onBarcodeScanned={handleScanned}
              onMountError={handleMountError}
            />
            <Text testID="scan-prompt" style={styles.message}>
              {t('scanPrompt')}
            </Text>
            {resolving ? (
              <Text testID="scan-checking" style={styles.message}>
                {t('scanChecking')}
              </Text>
            ) : null}
            {notice === 'invalid' ? (
              <Text testID="scan-invalid" style={styles.message}>
                {t('scanInvalidCode')}
              </Text>
            ) : null}
            {notice === 'error' ? (
              <Text testID="scan-error" style={styles.message}>
                {t('itemFormErrorStorage')}
              </Text>
            ) : null}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  cameraBlock: {
    flex: 1,
    paddingHorizontal: 16,
    gap: 12,
  },
  camera: {
    flex: 1,
  },
  stateBlock: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  message: {
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
