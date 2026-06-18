/**
 * useSwipe — attaches touch event listeners to a ref'd element and fires
 * directional callbacks when the user completes a swipe gesture.
 *
 * Minimum distance threshold prevents accidental triggers during scrolling.
 * The hook is passive (never calls preventDefault) so it does not interfere
 * with native browser scroll or overscroll-behaviour.
 *
 * Supported directions: left, right, up, down.
 * The caller is responsible for mapping directions to actions, e.g.:
 *   right → router.history.back()
 */
import * as React from "react";

export interface SwipeHandlers {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
}

interface UseSwipeOptions extends SwipeHandlers {
  /**
   * Minimum number of pixels the touch must travel to count as a swipe.
   * A higher threshold reduces false positives during taps/scrolls.
   * Default: 60.
   */
  threshold?: number;
}

interface TouchOrigin {
  x: number;
  y: number;
}

/**
 * Attach to any element ref to detect directional swipe gestures.
 *
 * @example
 * const ref = useRef<HTMLDivElement>(null);
 * useSwipe(ref, { onSwipeRight: () => router.history.back() });
 */
export function useSwipe(
  ref: React.RefObject<HTMLElement | null>,
  options: UseSwipeOptions,
): void {
  const { threshold = 60, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown } =
    options;

  // Keep options in a ref so the event listener closure is never stale without
  // requiring re-registration (which would cause flickering on every render).
  const handlersRef = React.useRef(options);
  React.useEffect(() => {
    handlersRef.current = options;
  });

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let origin: TouchOrigin | null = null;

    function handleTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      if (touch === undefined) return;
      origin = { x: touch.clientX, y: touch.clientY };
    }

    function handleTouchEnd(event: TouchEvent) {
      if (origin === null) return;
      const touch = event.changedTouches[0];
      if (touch === undefined) return;

      const dx = touch.clientX - origin.x;
      const dy = touch.clientY - origin.y;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const t = handlersRef.current.threshold ?? threshold;

      // Require the gesture to exceed the threshold and be more axis-aligned
      // in the intended direction than the perpendicular one.
      if (Math.max(absDx, absDy) < t) {
        origin = null;
        return;
      }

      if (absDx > absDy) {
        if (dx > 0) {
          handlersRef.current.onSwipeRight?.();
        } else {
          handlersRef.current.onSwipeLeft?.();
        }
      } else {
        if (dy > 0) {
          handlersRef.current.onSwipeDown?.();
        } else {
          handlersRef.current.onSwipeUp?.();
        }
      }

      origin = null;
    }

    function handleTouchCancel() {
      origin = null;
    }

    // Passive: true — the listener never calls preventDefault so the browser
    // can optimize scrolling without waiting on the JS thread.
    const opts = { passive: true };
    el.addEventListener("touchstart", handleTouchStart, opts);
    el.addEventListener("touchend", handleTouchEnd, opts);
    el.addEventListener("touchcancel", handleTouchCancel, opts);

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [ref, threshold]);
}
