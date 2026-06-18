/**
 * Tests for useQueryInvalidation hook.
 *
 * This hook's contract: when a mutation event (created/updated/deleted) arrives,
 * it calls queryCache.invalidate(entity). When autoInvalidate is false, or when
 * lastEvent is null, it must not call invalidate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQueryInvalidation } from "./useQueryInvalidation.js";
import { queryCache } from "../cache/QueryCache.js";
import type { EntityEvent } from "../types/entities.js";

vi.mock("../cache/QueryCache.js", () => ({
  queryCache: {
    invalidate: vi.fn(),
  },
}));

const mockInvalidate = vi.mocked(queryCache.invalidate);

function makeEvent(type: EntityEvent<unknown>["type"]): EntityEvent<unknown> {
  return {
    type,
    entity: "Order",
    id: "o1",
    data: {},
    timestamp: "2026-01-01T00:00:00Z",
    tenantId: "t1",
  };
}

describe("useQueryInvalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call invalidate on mount when lastEvent is null", () => {
    renderHook(() => useQueryInvalidation("Order", null, true));
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("calls invalidate with the event entity on a 'created' event", () => {
    const event = makeEvent("created");
    renderHook(() => useQueryInvalidation("Order", event, true));
    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(mockInvalidate).toHaveBeenCalledWith("Order");
  });

  it("calls invalidate with the event entity on an 'updated' event", () => {
    const event = makeEvent("updated");
    renderHook(() => useQueryInvalidation("Order", event, true));
    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(mockInvalidate).toHaveBeenCalledWith("Order");
  });

  it("calls invalidate with the event entity on a 'deleted' event", () => {
    const event = makeEvent("deleted");
    renderHook(() => useQueryInvalidation("Order", event, true));
    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(mockInvalidate).toHaveBeenCalledWith("Order");
  });

  it("does not call invalidate when autoInvalidate is false", () => {
    const event = makeEvent("created");
    renderHook(() => useQueryInvalidation("Order", event, false));
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("calls invalidate each time a new event arrives", () => {
    const firstEvent = makeEvent("created");
    const initialProps: { event: EntityEvent<unknown> | null } = { event: null };
    const { rerender } = renderHook(
      ({ event }: { event: EntityEvent<unknown> | null }) =>
        useQueryInvalidation("Order", event, true),
      { initialProps },
    );

    expect(mockInvalidate).not.toHaveBeenCalled();

    act(() => {
      rerender({ event: firstEvent });
    });
    expect(mockInvalidate).toHaveBeenCalledOnce();

    // A distinct object reference simulates a second event arriving.
    const secondEvent = makeEvent("updated");
    act(() => {
      rerender({ event: secondEvent });
    });
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });

  it("stops calling invalidate after autoInvalidate is toggled off mid-flight", () => {
    const event = makeEvent("created");
    const { rerender } = renderHook(
      ({ autoInvalidate }: { autoInvalidate: boolean }) =>
        useQueryInvalidation("Order", event, autoInvalidate),
      { initialProps: { autoInvalidate: true } },
    );
    // Initial render with an event fires once.
    expect(mockInvalidate).toHaveBeenCalledOnce();

    vi.clearAllMocks();

    // Same event reference — effect does not re-fire (deps unchanged).
    act(() => {
      rerender({ autoInvalidate: false });
    });
    // lastEvent reference didn't change, so effect doesn't re-run.
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("uses the event entity field, not the hook entity parameter", () => {
    // The event's entity is 'Product', but the hook was told 'Order'.
    // Invalidation should target the event's entity to match the server broadcast.
    const crossEntityEvent: EntityEvent<unknown> = {
      ...makeEvent("created"),
      entity: "Product",
    };
    renderHook(() => useQueryInvalidation("Order", crossEntityEvent, true));
    expect(mockInvalidate).toHaveBeenCalledWith("Product");
    expect(mockInvalidate).not.toHaveBeenCalledWith("Order");
  });
});
