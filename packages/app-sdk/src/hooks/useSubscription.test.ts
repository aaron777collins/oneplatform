/**
 * Tests for useSubscription hook.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSubscription } from "./useSubscription.js";
import { useAppContext } from "../provider/AppContext.js";
import type { EntityEvent } from "../types/entities.js";
import type { SubscriptionRegistration, WsStatus } from "../ws/WebSocketManager.js";

vi.mock("../provider/AppContext.js", () => ({
  useAppContext: vi.fn(),
}));

const mockUseAppContext = vi.mocked(useAppContext);

// ─── Build a manually-controlled mock WebSocketManager ────────────────────────

function createMockWsManager() {
  const registrations = new Map<string, SubscriptionRegistration>();
  const statusListeners = new Set<() => void>();
  let status: WsStatus = { isConnected: false, reconnectAttempts: 0 };

  const manager = {
    register: vi.fn((id: string, reg: SubscriptionRegistration) => {
      registrations.set(id, reg);
    }),
    unregister: vi.fn((id: string) => {
      registrations.delete(id);
    }),
    connect: vi.fn(),
    destroy: vi.fn(),
    subscribeToStatus: vi.fn((listener: () => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    }),
    getStatus: vi.fn(() => status),
    // Test helper methods
    simulateConnect() {
      status = { isConnected: true, reconnectAttempts: 0 };
      for (const l of statusListeners) l();
    },
    simulateDisconnect(attempts = 1) {
      status = { isConnected: false, reconnectAttempts: attempts };
      for (const l of statusListeners) l();
    },
    getRegistrations() {
      return registrations;
    },
  };

  return manager;
}

type MockWsManager = ReturnType<typeof createMockWsManager>;

describe("useSubscription", () => {
  let mockWsManager: MockWsManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWsManager = createMockWsManager();
    mockUseAppContext.mockReturnValue({
      wsManager: mockWsManager,
    } as unknown as ReturnType<typeof useAppContext>);
  });

  it("registers subscription on mount and unregisters on unmount", () => {
    const { unmount } = renderHook(() => useSubscription("orders"));

    expect(mockWsManager.register).toHaveBeenCalledOnce();
    unmount();
    expect(mockWsManager.unregister).toHaveBeenCalledOnce();
  });

  it("returns isConnected: false initially", () => {
    const { result } = renderHook(() => useSubscription("orders"));
    expect(result.current.isConnected).toBe(false);
  });

  it("updates isConnected when WebSocket connects", () => {
    const { result } = renderHook(() => useSubscription("orders"));

    act(() => {
      mockWsManager.simulateConnect();
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.reconnectAttempts).toBe(0);
  });

  it("updates reconnectAttempts on disconnect", () => {
    const { result } = renderHook(() => useSubscription("orders"));

    act(() => {
      mockWsManager.simulateDisconnect(3);
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.reconnectAttempts).toBe(3);
  });

  it("lastEvent updates when event is received", () => {
    const { result } = renderHook(() => useSubscription<{ id: string }>("orders"));

    const registrations = mockWsManager.getRegistrations();
    const id = [...registrations.keys()][0];
    expect(id).toBeDefined();
    const registration = registrations.get(id!)!;

    const event: EntityEvent<{ id: string }> = {
      type: "created",
      entity: "orders",
      id: "o1",
      data: { id: "o1" },
      timestamp: "2026-01-01T00:00:00Z",
      tenantId: "t1",
    };

    act(() => {
      registration.onEvent(event);
    });

    expect(result.current.lastEvent).toEqual(event);
  });

  it("calls onEvent callback when event is received", () => {
    const onEvent = vi.fn();
    renderHook(() => useSubscription("orders", { onEvent }));

    const registrations = mockWsManager.getRegistrations();
    const id = [...registrations.keys()][0]!;
    const registration = registrations.get(id)!;

    const event: EntityEvent<unknown> = {
      type: "updated",
      entity: "orders",
      id: "o2",
      data: {},
      timestamp: "2026-01-01T00:00:00Z",
      tenantId: "t1",
    };

    act(() => {
      registration.onEvent(event);
    });

    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("starts with lastEvent: null", () => {
    const { result } = renderHook(() => useSubscription("orders"));
    expect(result.current.lastEvent).toBeNull();
  });
});
