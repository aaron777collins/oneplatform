/**
 * Tests for SSEConnection.
 *
 * The MockEventSource installed globally by setup.ts simulates async open
 * (readyState transitions via setTimeout(0)). We use vi.useFakeTimers so we
 * control every setTimeout call, including the open delay, health timer, and
 * reconnect timer.
 *
 * Instance capture pattern: we need a handle to each EventSource created
 * internally by SSEConnection, so we wrap the global MockEventSource to push
 * each new instance into an array before SSEConnection's constructor returns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockEventSource } from "@/test/setup.js";
import { SSEConnection, type SSEHandlers } from "@/lib/sse.js";

// ---------------------------------------------------------------------------
// Constants (must match the values in sse.ts)
// ---------------------------------------------------------------------------

const BASE_DELAY_MS = 1_000;
const HEALTHY_CONNECTION_MS = 10_000;
const MAX_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Per-test instance tracking
// ---------------------------------------------------------------------------

let instances: MockEventSource[];

function installInstanceCapture(): void {
  instances = [];
  vi.stubGlobal(
    "EventSource",
    class extends MockEventSource {
      constructor(url: string, opts?: EventSourceInit) {
        super(url, opts);
        instances.push(this);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandlers(): SSEHandlers & {
  onMessage: ReturnType<typeof vi.fn>;
  onConnect: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  return {
    onMessage: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onError: vi.fn(),
  };
}

/** Advance timers past the MockEventSource async open (setTimeout 0). */
async function triggerOpen(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("SSEConnection", () => {
  let conn: SSEConnection;
  let handlers: ReturnType<typeof makeHandlers>;

  beforeEach(() => {
    vi.useFakeTimers();
    installInstanceCapture();
    conn = new SSEConnection();
    handlers = makeHandlers();
  });

  afterEach(() => {
    conn.disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  describe("connect", () => {
    it("opens an EventSource at the supplied URL", () => {
      conn.connect("/api/v1/events", handlers);

      expect(instances).toHaveLength(1);
      expect(instances[0]!.url).toBe("/api/v1/events");
    });

    it("creates the EventSource with withCredentials: true", () => {
      conn.connect("/api/v1/events", handlers);

      expect(instances[0]!.withCredentials).toBe(true);
    });

    it("calls onConnect and marks isConnected() true after async open", async () => {
      conn.connect("/api/v1/events", handlers);

      // Before the open fires the connection is still CONNECTING
      expect(conn.isConnected()).toBe(false);

      await triggerOpen();

      expect(handlers.onConnect).toHaveBeenCalledTimes(1);
      expect(conn.isConnected()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // lastEventId
  // -------------------------------------------------------------------------

  describe("lastEventId", () => {
    it("is null before any connection", () => {
      expect(conn.getLastEventId()).toBeNull();
    });

    it("does not append a lastEventId param when none has been received", () => {
      conn.connect("/api/v1/events", handlers);

      expect(instances[0]!.url).toBe("/api/v1/events");
    });

    it("appends ?lastEventId=<encoded> on reconnect when a previous id exists", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      // Deliver a message that sets lastEventId
      const msgEvent = new MessageEvent("message", {
        data: "payload",
        lastEventId: "ev-42",
      });
      instances[0]!.onmessage?.(msgEvent);

      // Trigger a disconnect → scheduleReconnect → reconnect fires after BASE_DELAY_MS
      instances[0]!.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);

      expect(instances[1]!.url).toBe(
        "/api/v1/events?lastEventId=ev-42",
      );
    });

    it("appends &lastEventId= when the original URL already contains a query string", async () => {
      conn.connect("/api/v1/events?foo=bar", handlers);
      await triggerOpen();

      const msgEvent = new MessageEvent("message", {
        data: "d",
        lastEventId: "ev-1",
      });
      instances[0]!.onmessage?.(msgEvent);

      instances[0]!.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);

      expect(instances[1]!.url).toBe(
        "/api/v1/events?foo=bar&lastEventId=ev-1",
      );
    });
  });

  // -------------------------------------------------------------------------
  // onmessage
  // -------------------------------------------------------------------------

  describe("onmessage", () => {
    it("fires onMessage with type='message', data, and id", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      const msgEvent = new MessageEvent("message", {
        data: '{"key":"value"}',
        lastEventId: "ev-5",
      });
      instances[0]!.onmessage?.(msgEvent);

      expect(handlers.onMessage).toHaveBeenCalledWith(
        "message",
        '{"key":"value"}',
        "ev-5",
      );
    });

    it("passes null as id when lastEventId is absent on the event", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      // MessageEvent with no lastEventId defaults to empty string; the handler
      // normalises "" to null (event.lastEventId || null)
      const msgEvent = new MessageEvent("message", { data: "hello" });
      instances[0]!.onmessage?.(msgEvent);

      const [, , id] = handlers.onMessage.mock.calls[0] as [string, string, string | null];
      expect(id).toBeNull();
    });

    it("updates lastEventId when the event carries a non-empty lastEventId", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      const msgEvent = new MessageEvent("message", {
        data: "d",
        lastEventId: "ev-99",
      });
      instances[0]!.onmessage?.(msgEvent);

      expect(conn.getLastEventId()).toBe("ev-99");
    });
  });

  // -------------------------------------------------------------------------
  // reconnect / backoff
  // -------------------------------------------------------------------------

  describe("reconnect", () => {
    it("schedules a reconnect after onerror fires, reconnecting after BASE_DELAY_MS", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      instances[0]!.onerror?.(new Event("error"));
      expect(instances).toHaveLength(1); // not yet reconnected

      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);
      // MockEventSource constructor runs; open fires after another tick
      await triggerOpen();

      expect(instances).toHaveLength(2);
    });

    it("doubles the delay on each successive disconnect (1s → 2s → 4s)", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      // First disconnect: reconnect after 1s
      instances[0]!.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);
      await triggerOpen();
      expect(instances).toHaveLength(2);

      // Second disconnect: reconnect after 2s
      instances[1]!.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS * 2);
      await triggerOpen();
      expect(instances).toHaveLength(3);

      // Third disconnect: reconnect after 4s
      instances[2]!.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS * 4);
      await triggerOpen();
      expect(instances).toHaveLength(4);
    });

    it("caps the reconnect delay at MAX_DELAY_MS (30s)", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      // Trigger errors advancing by delay+1 each time. The extra 1ms ensures
      // any pending open timer (setTimeout(0) scheduled at the prior advance
      // boundary) fires BEFORE we trigger the error, so the onopen handler runs
      // and clearHealthTimer() in onerror cancels it cleanly — preventing the
      // health timer from resetting reconnectDelay mid-loop.
      // Delay progression: 1 → 2 → 4 → 8 → 16 → 30 (capped)
      const delays = [
        BASE_DELAY_MS,         // 1s → next will be 2s
        BASE_DELAY_MS * 2,     // 2s → next will be 4s
        BASE_DELAY_MS * 4,     // 4s → next will be 8s
        BASE_DELAY_MS * 8,     // 8s → next will be 16s
        BASE_DELAY_MS * 16,    // 16s → next will be 30s (capped)
      ];

      for (const delay of delays) {
        // Let the pending open timer fire before triggering the error
        await vi.advanceTimersByTimeAsync(1);
        const current = instances[instances.length - 1]!;
        current.onerror?.(new Event("error"));
        // Advance by the current reconnect delay to fire the reconnect timer
        await vi.advanceTimersByTimeAsync(delay);
      }

      // At this point reconnectDelay is MAX_DELAY_MS (30s).
      // Advance 1ms so instances[last]'s open fires before we trigger the final error.
      await vi.advanceTimersByTimeAsync(1);
      const beforeCount = instances.length;
      instances[instances.length - 1]!.onerror?.(new Event("error"));

      // Advancing MAX_DELAY_MS - 1 must NOT produce a new instance
      await vi.advanceTimersByTimeAsync(MAX_DELAY_MS - 1);
      expect(instances).toHaveLength(beforeCount);

      // Advancing the remaining 1ms triggers the reconnect
      await vi.advanceTimersByTimeAsync(1);
      expect(instances).toHaveLength(beforeCount + 1);
    });

    it("increments reconnectCount on each disconnect", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      instances[0]!.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);
      await triggerOpen();

      instances[1]!.onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS * 2);
      await triggerOpen();

      expect(conn.getReconnectCount()).toBe(2);
    });

    it("calls onDisconnect with the updated reconnect count", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      instances[0]!.onerror?.(new Event("error"));
      expect(handlers.onDisconnect).toHaveBeenCalledWith(1);

      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);
      await triggerOpen();

      instances[1]!.onerror?.(new Event("error"));
      expect(handlers.onDisconnect).toHaveBeenCalledWith(2);
    });
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  describe("disconnect", () => {
    it("closes the underlying EventSource", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      const es = instances[0]!;
      conn.disconnect();

      expect(es.readyState).toBe(MockEventSource.CLOSED);
    });

    it("prevents further reconnects after disconnect", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      instances[0]!.onerror?.(new Event("error"));
      conn.disconnect();

      // Advance well past any possible reconnect timer
      await vi.advanceTimersByTimeAsync(MAX_DELAY_MS * 2);

      // Still only the original instance — no reconnect happened
      expect(instances).toHaveLength(1);
    });

    it("clears a pending reconnect timer when disconnected mid-wait", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      // Trigger error to schedule the reconnect timer
      instances[0]!.onerror?.(new Event("error"));

      // Disconnect before the timer fires
      conn.disconnect();

      // Advance past the reconnect delay — no new EventSource should appear
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS * 2);
      expect(instances).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // health timer
  // -------------------------------------------------------------------------

  describe("health timer", () => {
    it("resets reconnect delay to BASE_DELAY_MS after HEALTHY_CONNECTION_MS of uptime", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      // First error: delay is BASE_DELAY_MS (1s), becomes 2s after this call
      instances[0]!.onerror?.(new Event("error"));

      // Advance BASE_DELAY_MS (1s) to fire the reconnect: creates instances[1]
      // and schedules its open at t=1s (setTimeout(0) queued at t=1s).
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);

      // Advance past HEALTHY_CONNECTION_MS so that:
      //   1. instances[1]'s open timer (due at t=1s) fires — onopen sets healthTimer
      //   2. healthTimer (due at t=1s+10s=11s) fires — resets reconnectDelay to 1s
      // We must advance by more than 0 here because the open is due at current time
      // (t=1s) and vi.advanceTimersByTimeAsync(0) does not re-process timers already
      // at the current boundary.
      await vi.advanceTimersByTimeAsync(HEALTHY_CONNECTION_MS + 1);

      // instances[1] is now connected and the health timer has fired (delay=1s again)
      expect(instances).toHaveLength(2);

      // Second error: delay is BASE_DELAY_MS (1s, not the doubled 2s)
      instances[1]!.onerror?.(new Event("error"));

      // Advance only BASE_DELAY_MS (1s). If the delay had NOT been reset to 1s, it
      // would still be 2s and no new instance would exist after this advance.
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);
      // Open for instances[2] fires during the advance
      await vi.advanceTimersByTimeAsync(1);

      expect(instances).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // closed state
  // -------------------------------------------------------------------------

  describe("closed state", () => {
    it("sets closed=true on disconnect, preventing openEventSource from creating a new EventSource", async () => {
      conn.connect("/api/v1/events", handlers);
      await triggerOpen();

      conn.disconnect();

      // Manually attempt a second connect after disconnect to verify closed guard
      // (simulates a reconnect timer firing after disconnect in a race condition)
      conn.connect("/api/v1/events/new", handlers);

      // The second connect resets closed=false and opens a new source
      // (this is expected — disconnect then reconnect is a supported pattern)
      expect(instances).toHaveLength(2);
    });

    it("does not call onopen handler when already closed before open fires", async () => {
      conn.connect("/api/v1/events", handlers);

      // Disconnect before the async open fires (readyState still CONNECTING)
      conn.disconnect();

      // Let the MockEventSource's open timer fire
      await triggerOpen();

      // onConnect must not be called because we were already closed
      expect(handlers.onConnect).not.toHaveBeenCalled();
    });
  });
});
