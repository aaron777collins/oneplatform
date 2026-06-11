/**
 * Tests for useSSEStream.
 *
 * SSEConnection is mocked so no real EventSource is opened. Each test
 * captures the mock instance created during the hook's effect, then drives
 * behaviour by invoking the SSEHandlers that the hook passed to
 * conn.connect(). This exercises the real hook logic while keeping the suite
 * fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSSEStream } from "@/hooks/use-sse-stream.js";
import { SSEConnection } from "@/lib/sse.js";
import type { SSEHandlers } from "@/lib/sse.js";

// ---------------------------------------------------------------------------
// Mock SSEConnection
//
// We replace the class with a factory that records every instance created.
// Each instance exposes jest-style spies so we can assert on connect/disconnect
// calls, and a `_triggerHandlers` helper so tests can drive callbacks.
// ---------------------------------------------------------------------------

vi.mock("@/lib/sse.js", () => ({
  SSEConnection: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    getReconnectCount: vi.fn().mockReturnValue(0),
  })),
}));

const MockSSEConnection = SSEConnection as unknown as ReturnType<typeof vi.fn>;

/**
 * Returns the most recent SSEConnection instance that was constructed.
 *
 * vi.fn() mock constructors track the returned object (the mock instance) in
 * mock.results, not in mock.instances (which captures `this`, the raw object
 * before any properties are set by mockImplementation). We read from
 * mock.results to get the full object with its vi.fn() properties.
 *
 * Throws if none has been constructed yet (catches test setup mistakes).
 */
function getLastInstance() {
  const results = MockSSEConnection.mock.results;
  if (results.length === 0) throw new Error("No SSEConnection instance created");
  const last = results[results.length - 1];
  if (last === undefined) throw new Error("No SSEConnection instance created");
  return last.value as {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    isConnected: ReturnType<typeof vi.fn>;
    getReconnectCount: ReturnType<typeof vi.fn>;
  };
}

/**
 * Extracts the SSEHandlers from the most recent connect() call so tests can
 * fire callbacks (onConnect, onMessage, onDisconnect) as if the server
 * responded.
 */
function getLastHandlers(): SSEHandlers {
  const instance = getLastInstance();
  const connectCalls = instance.connect.mock.calls;
  if (connectCalls.length === 0) throw new Error("connect() was never called");
  // connect(url, handlers) — handlers is the second argument
  const lastCall = connectCalls[connectCalls.length - 1];
  if (lastCall === undefined) throw new Error("connect() was never called");
  return lastCall[1] as SSEHandlers;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockSSEConnection.mockClear();
  // Re-apply the mock implementation after clearing so each test gets a fresh
  // instance with clean spies rather than accumulated call history.
  MockSSEConnection.mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    getReconnectCount: vi.fn().mockReturnValue(0),
  }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSSEStream", () => {
  describe("enabled=true (default)", () => {
    it("creates an SSEConnection and calls connect with the given URL", () => {
      renderHook(() => useSSEStream("/events/test"));

      expect(MockSSEConnection).toHaveBeenCalledTimes(1);
      const instance = getLastInstance();
      expect(instance.connect).toHaveBeenCalledWith("/events/test", expect.any(Object));
    });
  });

  describe("enabled=false", () => {
    it("does not create an SSEConnection when enabled is false", () => {
      renderHook(() => useSSEStream("/events/test", { enabled: false }));

      expect(MockSSEConnection).not.toHaveBeenCalled();
    });

    it("returns isConnected=false when enabled is false", () => {
      const { result } = renderHook(() =>
        useSSEStream("/events/test", { enabled: false }),
      );

      expect(result.current.isConnected).toBe(false);
    });
  });

  describe("toggling enabled false after initial mount", () => {
    it("calls disconnect and sets isConnected=false when enabled switches to false", async () => {
      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useSSEStream("/events/test", { enabled }),
        { initialProps: { enabled: true } },
      );

      const instance = getLastInstance();
      const handlers = getLastHandlers();

      // Simulate the server acknowledging the connection
      act(() => {
        handlers.onConnect?.();
      });

      await waitFor(() => expect(result.current.isConnected).toBe(true));

      // Disable the stream
      rerender({ enabled: false });

      await waitFor(() => expect(result.current.isConnected).toBe(false));
      expect(instance.disconnect).toHaveBeenCalled();
    });
  });

  describe("URL changes", () => {
    it("disconnects the old connection and opens a new one when URL changes", () => {
      const { rerender } = renderHook(
        ({ url }: { url: string }) => useSSEStream(url),
        { initialProps: { url: "/events/first" } },
      );

      const firstInstance = getLastInstance();
      expect(firstInstance.connect).toHaveBeenCalledWith(
        "/events/first",
        expect.any(Object),
      );

      rerender({ url: "/events/second" });

      // The effect cleanup disconnects the old instance before the new one is created.
      expect(firstInstance.disconnect).toHaveBeenCalled();

      // A second connection is created for the new URL.
      expect(MockSSEConnection).toHaveBeenCalledTimes(2);
      const secondInstance = getLastInstance();
      expect(secondInstance.connect).toHaveBeenCalledWith(
        "/events/second",
        expect.any(Object),
      );
    });
  });

  describe("onEvent callback", () => {
    it("calls onEvent with the event data when a message arrives", () => {
      const onEvent = vi.fn();
      renderHook(() => useSSEStream("/events/test", { onEvent }));

      const handlers = getLastHandlers();

      act(() => {
        handlers.onMessage("log", '{"level":"info"}', "evt-1");
      });

      expect(onEvent).toHaveBeenCalledWith({
        type: "log",
        data: '{"level":"info"}',
        id: "evt-1",
      });
    });
  });

  describe("onConnect callback", () => {
    it("sets isConnected=true and calls onConnect when the connection opens", async () => {
      const onConnect = vi.fn();
      const { result } = renderHook(() =>
        useSSEStream("/events/test", { onConnect }),
      );

      const handlers = getLastHandlers();

      act(() => {
        handlers.onConnect?.();
      });

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      expect(onConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("unmount", () => {
    it("calls disconnect when the hook unmounts", () => {
      const { unmount } = renderHook(() => useSSEStream("/events/test"));

      const instance = getLastInstance();
      unmount();

      expect(instance.disconnect).toHaveBeenCalled();
    });
  });
});
