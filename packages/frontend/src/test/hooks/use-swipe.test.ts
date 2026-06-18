/**
 * useSwipe tests.
 *
 * jsdom does not dispatch touch events so we create and dispatch them manually.
 * Each test attaches the hook to a real DOM element so the listener registration
 * code runs end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import React from "react";
import { useSwipe } from "@/hooks/use-swipe.js";

// ---------------------------------------------------------------------------
// Touch event helpers
// ---------------------------------------------------------------------------

function createTouchEvent(type: string, clientX: number, clientY: number): TouchEvent {
  const touch = {
    clientX,
    clientY,
    identifier: 0,
    target: document.body,
    pageX: clientX,
    pageY: clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  } as unknown as Touch;

  return new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" ? [] : [touch],
    changedTouches: [touch],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSwipe", () => {
  let el: HTMLDivElement;
  let ref: React.RefObject<HTMLDivElement>;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    ref = { current: el };
  });

  it("calls onSwipeRight when the user swipes right beyond the threshold", () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipe(ref, { onSwipeRight, threshold: 60 }));

    el.dispatchEvent(createTouchEvent("touchstart", 100, 200));
    el.dispatchEvent(createTouchEvent("touchend", 165, 200)); // dx = 65 > 60

    expect(onSwipeRight).toHaveBeenCalledOnce();
  });

  it("calls onSwipeLeft when the user swipes left beyond the threshold", () => {
    const onSwipeLeft = vi.fn();
    renderHook(() => useSwipe(ref, { onSwipeLeft, threshold: 60 }));

    el.dispatchEvent(createTouchEvent("touchstart", 200, 200));
    el.dispatchEvent(createTouchEvent("touchend", 130, 200)); // dx = -70 < -60

    expect(onSwipeLeft).toHaveBeenCalledOnce();
  });

  it("calls onSwipeDown when the user swipes down beyond the threshold", () => {
    const onSwipeDown = vi.fn();
    renderHook(() => useSwipe(ref, { onSwipeDown, threshold: 60 }));

    el.dispatchEvent(createTouchEvent("touchstart", 200, 100));
    el.dispatchEvent(createTouchEvent("touchend", 200, 175)); // dy = 75 > 60

    expect(onSwipeDown).toHaveBeenCalledOnce();
  });

  it("calls onSwipeUp when the user swipes up beyond the threshold", () => {
    const onSwipeUp = vi.fn();
    renderHook(() => useSwipe(ref, { onSwipeUp, threshold: 60 }));

    el.dispatchEvent(createTouchEvent("touchstart", 200, 200));
    el.dispatchEvent(createTouchEvent("touchend", 200, 130)); // dy = -70 < -60

    expect(onSwipeUp).toHaveBeenCalledOnce();
  });

  it("does not fire when movement is below the threshold", () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipe(ref, { onSwipeRight, threshold: 60 }));

    el.dispatchEvent(createTouchEvent("touchstart", 100, 200));
    el.dispatchEvent(createTouchEvent("touchend", 150, 200)); // dx = 50 < 60

    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("does not fire the horizontal handler when the gesture is more vertical", () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipe(ref, { onSwipeRight, threshold: 60 }));

    // Predominantly vertical: dy=100 > dx=70 — should not trigger onSwipeRight
    el.dispatchEvent(createTouchEvent("touchstart", 100, 100));
    el.dispatchEvent(createTouchEvent("touchend", 170, 200));

    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("cleans up listeners on unmount", () => {
    const removeEventListenerSpy = vi.spyOn(el, "removeEventListener");
    const { unmount } = renderHook(() =>
      useSwipe(ref, { onSwipeRight: vi.fn() }),
    );
    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "touchstart",
      expect.any(Function),
    );
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "touchend",
      expect.any(Function),
    );
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "touchcancel",
      expect.any(Function),
    );
  });

  it("resets state on touchcancel so subsequent gestures work correctly", () => {
    const onSwipeRight = vi.fn();
    renderHook(() => useSwipe(ref, { onSwipeRight, threshold: 60 }));

    // Start a gesture, cancel it, then start a new one that should succeed
    el.dispatchEvent(createTouchEvent("touchstart", 100, 200));
    el.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true }));
    el.dispatchEvent(createTouchEvent("touchstart", 100, 200));
    el.dispatchEvent(createTouchEvent("touchend", 170, 200));

    expect(onSwipeRight).toHaveBeenCalledOnce();
  });
});
