/**
 * P5a useReducedMotion unit (Jest only, no device proof).
 *
 * Covers the reduced-motion hook: the initial value comes from
 * `AccessibilityInfo.isReduceMotionEnabled()`, mounted updates follow the
 * `reduceMotionChanged` listener, the listener is removed on unmount, and
 * an unavailable API falls back to "no preference" without ever throwing.
 */
import { act, cleanup, renderHook } from '@testing-library/react-native';

import useReducedMotion from '../src/screens/useReducedMotion';

const { AccessibilityInfo } = require('react-native') as {
  AccessibilityInfo: {
    isReduceMotionEnabled?: () => Promise<boolean>;
    addEventListener?: (
      event: string,
      handler: (value: boolean) => void,
    ) => { remove: () => void };
  };
};

const realIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled;
const realAddEventListener = AccessibilityInfo.addEventListener;

afterEach(async () => {
  AccessibilityInfo.isReduceMotionEnabled = realIsReduceMotionEnabled;
  AccessibilityInfo.addEventListener = realAddEventListener;
  await cleanup();
});

function mockMotion(initial: boolean) {
  let handler: ((value: boolean) => void) | null = null;
  const remove = jest.fn();
  AccessibilityInfo.isReduceMotionEnabled = jest
    .fn()
    .mockResolvedValue(initial);
  AccessibilityInfo.addEventListener = jest.fn(
    (_event: string, next: (value: boolean) => void) => {
      handler = next;
      return { remove };
    },
  );
  return {
    emit: (value: boolean) => {
      const seen = handler as unknown as ((next: boolean) => void) | null;
      if (seen) seen(value);
    },
    remove,
  };
}

async function flushMotion(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

test('resolves the initial value from the platform setting', async () => {
  mockMotion(true);
  const { result } = await renderHook(() => useReducedMotion());
  await flushMotion();
  expect(result.current).toBe(true);
  expect(AccessibilityInfo.isReduceMotionEnabled).toHaveBeenCalledTimes(1);
});

test('stays false when the platform reports no preference', async () => {
  mockMotion(false);
  const { result } = await renderHook(() => useReducedMotion());
  await flushMotion();
  expect(result.current).toBe(false);
});

test('follows reduceMotionChanged events while mounted', async () => {
  const motion = mockMotion(false);
  const { result } = await renderHook(() => useReducedMotion());
  await flushMotion();
  expect(AccessibilityInfo.addEventListener).toHaveBeenCalledWith(
    'reduceMotionChanged',
    expect.any(Function),
  );
  await act(async () => {
    motion.emit(true);
  });
  expect(result.current).toBe(true);
  await act(async () => {
    motion.emit(false);
  });
  expect(result.current).toBe(false);
});

test('removes the listener on unmount', async () => {
  const motion = mockMotion(false);
  const { unmount } = await renderHook(() => useReducedMotion());
  await flushMotion();
  expect(motion.remove).not.toHaveBeenCalled();
  await unmount();
  expect(motion.remove).toHaveBeenCalledTimes(1);
});

test('falls back to no preference when the API is unavailable', async () => {
  AccessibilityInfo.isReduceMotionEnabled =
    undefined as unknown as () => Promise<boolean>;
  AccessibilityInfo.addEventListener = undefined as unknown as (
    event: string,
    handler: (value: boolean) => void,
  ) => { remove: () => void };
  let seen: boolean | null = null;
  await expect(
    (async () => {
      const { result } = await renderHook(() => useReducedMotion());
      await flushMotion();
      seen = result.current;
    })(),
  ).resolves.toBeUndefined();
  expect(seen).toBe(false);
});
