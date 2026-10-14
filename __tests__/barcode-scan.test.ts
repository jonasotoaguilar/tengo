/**
 * U3 barcode scanner unit (Jest/RNTL only, no device proof).
 *
 * Covers the scan-to-route decision (`decideScanRoute`: known code edits,
 * unknown code creates with the code as identity, blank/misshapen codes
 * never reach the database) and the honest camera-permission states
 * (`resolveCameraAccess`: loading/granted/denied/permanently-denied) plus the
 * mount-failure path (`onMountError` -> unavailable), and the `ScanScreen`
 * wiring against a mocked expo-camera:
 * every state renders readable copy with a way out, and a scan resolves
 * exactly once. The mocks prove decision and rendering logic only: real
 * barcode capture through a physical camera is NOT verified here (no
 * device flow runs in this unit).
 *
 * Plain `.ts` (no JSX): this surface is `barcode-scan.test.ts`, so every
 * element is built with `React.createElement`.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { type ComponentProps, type ComponentType, createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import type { RepositoryDb } from '../src/inventory/database';
import type { ItemDetail } from '../src/inventory/types';
import {
  decideScanRoute,
  resolveCameraAccess,
} from '../src/screens/useBarcodeScanController';

interface ScanScreenProps {
  db: RepositoryDb;
  onResolved: (
    route:
      | { kind: 'edit'; itemId: number }
      | { kind: 'create'; barcode: string },
  ) => void;
  onClose: () => void;
  lookup?: (db: RepositoryDb, barcode: string) => Promise<ItemDetail | null>;
  openSettings?: () => Promise<void>;
}

const ScanScreen = require('../src/screens/ScanScreen')
  .default as ComponentType<ScanScreenProps>;

jest.mock(
  'expo-camera',
  () => {
    const React = require('react');
    const { View } = require('react-native');
    return {
      CameraView: ({
        onBarcodeScanned,
        onMountError,
        testID,
      }: {
        onBarcodeScanned?: (event: { data: string }) => void;
        onMountError?: (event: { message: string }) => void;
        testID?: string;
      }) =>
        React.createElement(View, {
          testID: testID ?? 'scan-camera',
          // RNTL reads the handlers back off props; the mock never touches
          // a real camera.
          onBarcodeScanned,
          onMountError,
        }),
      useCameraPermissions: jest.fn(),
    };
  },
  { virtual: true },
);

const cameraMocks = require('expo-camera') as {
  useCameraPermissions: jest.Mock;
};

const requestPermission = jest.fn(async () => ({ granted: true }));

function grantCamera(): void {
  cameraMocks.useCameraPermissions.mockReturnValue([
    { granted: true, canAskAgain: true },
    requestPermission,
  ]);
}

const fakeDb = {} as RepositoryDb;

function detailWithId(id: number): ItemDetail {
  return {
    id,
    name: `Item ${id}`,
    stock: [],
    totalQuantity: 0,
    categoryIds: [],
    categories: [],
    created_at: `created-${id}`,
  };
}

// RNTL v14 `render` is async: every caller awaits this helper before
// touching `screen`, exactly like the `.tsx` suites await their render.
async function renderScan(
  props: Partial<ComponentProps<ComponentType<ScanScreenProps>>> = {},
): Promise<{
  onResolved: jest.Mock;
  onClose: jest.Mock;
}> {
  const onResolved = jest.fn();
  const onClose = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(I18nextProvider, { i18n, children });
  await render(
    createElement(ScanScreen, { db: fakeDb, onResolved, onClose, ...props }),
    { wrapper },
  );
  return { onResolved, onClose };
}

async function emitScan(data: string): Promise<void> {
  const camera = await screen.findByTestId('scan-camera');
  await act(async () => {
    await (
      camera.props as {
        onBarcodeScanned: (event: { data: string }) => void;
      }
    ).onBarcodeScanned({ data });
  });
}

beforeEach(() => {
  requestPermission.mockClear();
  cameraMocks.useCameraPermissions.mockReset();
  grantCamera();
});

afterEach(async () => {
  await cleanup();
});

describe('resolveCameraAccess (permission decision, no camera view)', () => {
  test('null permission is still loading', () => {
    expect(resolveCameraAccess(null)).toBe('loading');
  });

  test('granted permission scans', () => {
    expect(resolveCameraAccess({ granted: true, canAskAgain: true })).toBe(
      'granted',
    );
  });

  test('denied-but-askable permission can be retried in place', () => {
    expect(resolveCameraAccess({ granted: false, canAskAgain: true })).toBe(
      'denied',
    );
  });

  test('denied-and-final permission must go through system settings', () => {
    expect(resolveCameraAccess({ granted: false, canAskAgain: false })).toBe(
      'permanently-denied',
    );
  });
});

describe('decideScanRoute (scan to find or create)', () => {
  test('a known code opens that item for edit', async () => {
    const find = jest.fn(async () => detailWithId(7));
    const route = await decideScanRoute(fakeDb, 'ABC-1234', find);
    expect(route).toEqual({ kind: 'edit', itemId: 7 });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(fakeDb, 'ABC-1234');
  });

  test('an unknown code opens create carrying the code as identity', async () => {
    const find = jest.fn(async () => null);
    const route = await decideScanRoute(fakeDb, 'ZZZ-9999', find);
    expect(route).toEqual({ kind: 'create', barcode: 'ZZZ-9999' });
    expect(find).toHaveBeenCalledTimes(1);
  });

  test('surrounding whitespace scans the same code', async () => {
    const find = jest.fn(async () => detailWithId(3));
    const route = await decideScanRoute(fakeDb, '  ABC-1234\n', find);
    expect(route).toEqual({ kind: 'edit', itemId: 3 });
    expect(find).toHaveBeenCalledWith(fakeDb, 'ABC-1234');
  });

  test('a blank scan is invalid and never reaches the database', async () => {
    const find = jest.fn(async () => null);
    expect(await decideScanRoute(fakeDb, '   ', find)).toEqual({
      kind: 'invalid',
    });
    expect(find).not.toHaveBeenCalled();
  });

  test('a misshapen scan is invalid and never reaches the database', async () => {
    const find = jest.fn(async () => null);
    // Too short and illegal characters: both fail the U2 barcode shape.
    expect(await decideScanRoute(fakeDb, 'ab', find)).toEqual({
      kind: 'invalid',
    });
    expect(await decideScanRoute(fakeDb, '!!!nope!!!', find)).toEqual({
      kind: 'invalid',
    });
    expect(find).not.toHaveBeenCalled();
  });
});

describe('ScanScreen against mocked expo-camera', () => {
  test('granted permission shows the camera and a close way out', async () => {
    const { onClose } = await renderScan();
    expect(await screen.findByTestId('scan-camera')).toBeTruthy();
    expect(screen.getByTestId('scan-prompt')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('scan-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a known code resolves to edit exactly once even on double scan', async () => {
    const lookup = jest.fn(async () => detailWithId(7));
    const { onResolved } = await renderScan({ lookup });
    await emitScan('ABC-1234');
    await emitScan('ABC-1234');
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({ kind: 'edit', itemId: 7 }),
    );
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('an unknown code resolves to create carrying the barcode', async () => {
    const lookup = jest.fn(async () => null);
    const { onResolved } = await renderScan({ lookup });
    await emitScan('ZZZ-9999');
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({
        kind: 'create',
        barcode: 'ZZZ-9999',
      }),
    );
  });

  test('an invalid code stays on the scanner with a message and can rescan', async () => {
    const lookup = jest.fn(async () => null);
    const { onResolved } = await renderScan({ lookup });
    await emitScan('   ');
    expect(await screen.findByTestId('scan-invalid')).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    // Still on the scanner: a second, valid scan resolves.
    await emitScan('ZZZ-9999');
    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith({
        kind: 'create',
        barcode: 'ZZZ-9999',
      }),
    );
  });

  test('a lookup failure shows the storage message and stays open', async () => {
    const lookup = jest.fn(async () => {
      throw new Error('disk down');
    });
    const { onResolved } = await renderScan({ lookup });
    await emitScan('ABC-1234');
    expect(await screen.findByTestId('scan-error')).toBeTruthy();
    expect(screen.queryByText(/disk down/)).toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-camera')).toBeTruthy();
  });

  test('denied permission offers a retry in place plus close', async () => {
    cameraMocks.useCameraPermissions.mockReturnValue([
      { granted: false, canAskAgain: true },
      requestPermission,
    ]);
    const { onClose } = await renderScan();
    expect(await screen.findByTestId('scan-denied-message')).toBeTruthy();
    expect(screen.queryByTestId('scan-camera')).toBeNull();
    await fireEvent.press(screen.getByTestId('scan-retry-permission'));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('scan-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('permanently denied permission offers system settings plus close', async () => {
    cameraMocks.useCameraPermissions.mockReturnValue([
      { granted: false, canAskAgain: false },
      requestPermission,
    ]);
    const openSettings = jest.fn(async () => {});
    const { onClose } = await renderScan({ openSettings });
    expect(await screen.findByTestId('scan-permanent-message')).toBeTruthy();
    expect(screen.queryByTestId('scan-camera')).toBeNull();
    await fireEvent.press(screen.getByTestId('scan-open-settings'));
    expect(openSettings).toHaveBeenCalledTimes(1);
    // A settings failure must not trap the user: close still works.
    await fireEvent.press(screen.getByTestId('scan-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a camera mount failure is a readable dead end with only close', async () => {
    await renderScan();
    const camera = await screen.findByTestId('scan-camera');
    // expo-camera reports missing/busy hardware through onMountError: the
    // screen leaves the camera state for the unavailable message.
    await act(async () => {
      await (
        camera.props as {
          onMountError: (event: { message: string }) => void;
        }
      ).onMountError({ message: 'no camera on this device' });
    });
    expect(await screen.findByTestId('scan-no-camera-message')).toBeTruthy();
    expect(screen.queryByText(/no camera on this device/)).toBeNull();
    expect(screen.queryByTestId('scan-camera')).toBeNull();
    expect(screen.getByTestId('scan-close')).toBeTruthy();
  });
});
