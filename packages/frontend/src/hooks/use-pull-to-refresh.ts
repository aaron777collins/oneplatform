/**
 * usePullToRefresh — implements pull-to-refresh for mobile list pages.
 *
 * Tracks a downward touch drag from the top of the scroll container.
 * When the user releases after pulling more than the threshold, the provided
 * onRefresh callback is invoked (typically a React Query refetch).
 *
 * A visual indicator element is returned via `indicatorProps` so the caller
 * can render a spinner or "Pull to refresh" label without this hook knowing
 * about the UI — the hook owns the behaviour, the component owns the view.
 *
 * Design notes:
 * - Drag is only initiated when scrollTop === 0 to avoid interfering with
 *   normal scrolling partway through a list.
 * - The hook calls preventDefault during the drag to prevent the iOS
 *   rubber-band effect from competing with our custom indicator. This requires
 *   a non-passive listener, which is safe here because we're deliberately
 *   taking over the gesture.
 * - refreshing state is exposed so the caller can disable other interactions
 *   (e.g. the refetch button) while the refresh is in flight.
 */
import * as React from "react";

export interface PullToRefreshOptions {
  /** Called when the user completes a pull gesture. Should return a Promise. */
  onRefresh: () => Promise<void>;
  /**
   * How far in pixels the user must drag before releasing to trigger a refresh.
   * Default: 80.
   */
  threshold?: number;
  /**
   * Maximum visual drag distance in pixels. The indicator clamps here even if
   * the user continues dragging. Default: 120.
   */
  maxPull?: number;
}

export interface PullToRefreshResult {
  /** Ref to attach to the scrollable container element. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** True while the onRefresh promise is pending. */
  refreshing: boolean;
  /** 0–1 progress of the current pull (0 = no pull, 1 = threshold reached). */
  pullProgress: number;
  /** Whether the pull has exceeded the threshold and will trigger on release. */
  willRefresh: boolean;
}

export function usePullToRefresh(options: PullToRefreshOptions): PullToRefreshResult {
  const { onRefresh, threshold = 80, maxPull = 120 } = options;

  const containerRef = React.useRef<HTMLElement | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [pullDistance, setPullDistance] = React.useState(0);

  // Store mutable drag state in a ref to avoid stale closures in event handlers
  const dragRef = React.useRef({
    startY: 0,
    isDragging: false,
    currentDistance: 0,
  });

  const onRefreshRef = React.useRef(onRefresh);
  React.useEffect(() => {
    onRefreshRef.current = onRefresh;
  });

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function handleTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      if (touch === undefined) return;

      // Only initiate pull when already at the top of the scroll container
      if (el === null || el.scrollTop !== 0) return;

      dragRef.current = {
        startY: touch.clientY,
        isDragging: true,
        currentDistance: 0,
      };
    }

    function handleTouchMove(event: TouchEvent) {
      if (!dragRef.current.isDragging) return;
      const touch = event.touches[0];
      if (touch === undefined) return;

      const rawDistance = touch.clientY - dragRef.current.startY;
      if (rawDistance <= 0) {
        // Upward or neutral movement — cancel the drag
        dragRef.current.isDragging = false;
        setPullDistance(0);
        return;
      }

      // Prevent native scroll/overscroll while the pull gesture is active.
      // This is intentionally non-passive because we need preventDefault.
      event.preventDefault();

      const clamped = Math.min(rawDistance, maxPull);
      dragRef.current.currentDistance = clamped;
      setPullDistance(clamped);
    }

    function handleTouchEnd() {
      if (!dragRef.current.isDragging) return;
      dragRef.current.isDragging = false;

      const triggered = dragRef.current.currentDistance >= threshold;
      setPullDistance(0);
      dragRef.current.currentDistance = 0;

      if (triggered && !refreshing) {
        setRefreshing(true);
        void onRefreshRef.current().finally(() => {
          setRefreshing(false);
        });
      }
    }

    function handleTouchCancel() {
      dragRef.current.isDragging = false;
      dragRef.current.currentDistance = 0;
      setPullDistance(0);
    }

    // touchmove must be non-passive so we can call preventDefault during a drag
    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd, { passive: true });
    el.addEventListener("touchcancel", handleTouchCancel, { passive: true });

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      el.removeEventListener("touchcancel", handleTouchCancel);
    };
  }, [maxPull, refreshing, threshold]);

  const pullProgress = Math.min(pullDistance / threshold, 1);
  const willRefresh = pullProgress >= 1;

  return { containerRef, refreshing, pullProgress, willRefresh };
}
