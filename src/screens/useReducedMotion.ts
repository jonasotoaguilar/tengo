/**
 * P5a reduced-motion hook (no animation policy of its own).
 *
 * Returns whether the platform currently requests reduced motion. The
 * initial value comes from `AccessibilityInfo.isReduceMotionEnabled()`
 * and mounted updates follow the `reduceMotionChanged` listener, which is
 * removed on unmount. Safe when the API is unavailable (falls back to "no
 * preference") and never throws: every platform call is guarded.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

type ReduceMotionHandler = (reduceMotion: boolean) => void;

interface RemovableSubscription {
  remove: () => void;
}

function readInitial(setReduced: (value: boolean) => void): void {
  try {
    const info = AccessibilityInfo as unknown as {
      isReduceMotionEnabled?: () => Promise<boolean>;
    };
    if (typeof info?.isReduceMotionEnabled !== 'function') return;
    info
      .isReduceMotionEnabled()
      .then((reduceMotion) => {
        setReduced(reduceMotion === true);
      })
      .catch(() => {
        // Unavailable native module: keep the "no preference" default.
      });
  } catch {
    // Never let a platform query throw into the render tree.
  }
}

function subscribe(handler: ReduceMotionHandler): (() => void) | undefined {
  try {
    const info = AccessibilityInfo as unknown as {
      addEventListener?: (
        event: 'reduceMotionChanged',
        handler: ReduceMotionHandler,
      ) => RemovableSubscription | (() => void) | undefined;
      removeEventListener?: (
        event: 'reduceMotionChanged',
        handler: ReduceMotionHandler,
      ) => void;
    };
    if (typeof info?.addEventListener !== 'function') return undefined;
    const subscription = info.addEventListener('reduceMotionChanged', handler);
    if (
      subscription !== null &&
      typeof subscription === 'object' &&
      typeof (subscription as RemovableSubscription).remove === 'function'
    ) {
      return () => {
        try {
          (subscription as RemovableSubscription).remove();
        } catch {
          // Listener teardown must never throw on unmount.
        }
      };
    }
    if (typeof subscription === 'function') {
      return () => {
        try {
          (subscription as () => void)();
        } catch {
          // Listener teardown must never throw on unmount.
        }
      };
    }
    if (typeof info.removeEventListener === 'function') {
      return () => {
        try {
          (
            info.removeEventListener as NonNullable<
              typeof info.removeEventListener
            >
          )('reduceMotionChanged', handler);
        } catch {
          // Listener teardown must never throw on unmount.
        }
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export default function useReducedMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    readInitial((value) => {
      if (mounted) setReduceMotion(value);
    });
    const unsubscribe = subscribe((value) => {
      if (mounted) setReduceMotion(value);
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  return reduceMotion;
}
