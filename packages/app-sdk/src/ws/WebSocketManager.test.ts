/**
 * Tests for WebSocketManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocketManager } from "./WebSocketManager.js";
import type { EntityEvent } from "../types/entities.js";

// ─── WebSocket mock ────────────────────────────────────────────────────────────

// WebSocket readyState constants (mirroring the WebSocket API spec)
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

class MockWebSocket {
  readyState: number = WS_CONNECTING;
  url: string;
  private handlers: Map<string, Array<(e: unknown) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, handler: (e: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  removeEventListener(event: string, handler: (e: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, list.filter((h) => h !== handler));
  }

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = WS_CLOSED;
    this._trigger("close", {});
  });

  _trigger(event: string, data: unknown): void {
    const list = this.handlers.get(event) ?? [];
    for (const handler of list) {
      handler(data);
    }
  }

  _open(): void {
    this.readyState = WS_OPEN;
    this._trigger("open", {});
  }

  static instances: MockWebSocket[] = [];
  static reset(): void {
    MockWebSocket.instances = [];
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("WebSocketManager", () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    MockWebSocket.reset();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    Object.defineProperty(window, "location", {
      value: { origin: "https://app.example.com" },
      writable: true,
    });
    manager = new WebSocketManager();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects to wss:// URL derived from window.location.origin", () => {
    manager.connect("my-app");
    const ws = MockWebSocket.instances[0];
    expect(ws?.url).toBe("wss://app.example.com/apps/my-app/ws");
  });

  it("getStatus returns isConnected: false before open", () => {
    manager.connect("my-app");
    expect(manager.getStatus().isConnected).toBe(false);
  });

  it("getStatus returns isConnected: true after open", () => {
    manager.connect("my-app");
    MockWebSocket.instances[0]?._open();
    expect(manager.getStatus().isConnected).toBe(true);
  });

  it("sends subscribe message when socket is open and registration is added", () => {
    manager.connect("my-app");
    MockWebSocket.instances[0]?._open();

    manager.register("sub-1", {
      entity: "orders",
      onEvent: vi.fn(),
    });

    const ws = MockWebSocket.instances[0];
    expect(ws?.send).toHaveBeenCalledOnce();
    const msg = JSON.parse((ws?.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string);
    expect(msg.type).toBe("subscribe");
    expect(msg.entity).toBe("orders");
    expect(msg.subscriptionId).toBe("sub-1");
  });

  it("replays registrations on reconnect", () => {
    manager.connect("my-app");
    const ws1 = MockWebSocket.instances[0]!;
    ws1._open();

    manager.register("sub-1", { entity: "orders", onEvent: vi.fn() });

    // Simulate disconnect
    ws1._trigger("close", {});

    // Advance timers to trigger reconnect
    vi.advanceTimersByTime(1_500);
    const ws2 = MockWebSocket.instances[1]!;
    ws2._open();

    // The subscribe message should have been sent again
    expect(ws2.send).toHaveBeenCalledOnce();
    const msg = JSON.parse((ws2.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string);
    expect(msg.type).toBe("subscribe");
  });

  it("sends unsubscribe when unregister is called on open socket", () => {
    manager.connect("my-app");
    MockWebSocket.instances[0]?._open();
    manager.register("sub-1", { entity: "orders", onEvent: vi.fn() });
    manager.unregister("sub-1");

    const ws = MockWebSocket.instances[0];
    const calls = (ws?.send as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0] as string;
    const msg = JSON.parse(lastCall);
    expect(msg.type).toBe("unsubscribe");
    expect(msg.subscriptionId).toBe("sub-1");
  });

  it("routes incoming messages to the correct registered handler", () => {
    const onEvent = vi.fn();
    manager.connect("my-app");
    const ws = MockWebSocket.instances[0]!;
    ws._open();
    manager.register("sub-1", { entity: "orders", onEvent });

    const event: EntityEvent<unknown> & { subscriptionId: string } = {
      type: "created",
      entity: "orders",
      id: "o1",
      data: { id: "o1" },
      timestamp: "2026-01-01T00:00:00Z",
      tenantId: "t1",
      subscriptionId: "sub-1",
    };

    ws._trigger("message", { data: JSON.stringify(event) });
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("ignores malformed JSON messages without crashing", () => {
    manager.connect("my-app");
    const ws = MockWebSocket.instances[0]!;
    ws._open();
    expect(() => {
      ws._trigger("message", { data: "not valid json{" });
    }).not.toThrow();
  });

  it("uses exponential backoff for reconnects", () => {
    manager.connect("my-app");
    MockWebSocket.instances[0]?._trigger("close", {});

    // Attempt 0: 1s delay
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_100);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1]?._trigger("close", {});

    // Attempt 1: 2s delay
    vi.advanceTimersByTime(1_100);
    expect(MockWebSocket.instances).toHaveLength(2); // not yet reconnected
    vi.advanceTimersByTime(1_100);
    expect(MockWebSocket.instances).toHaveLength(3); // reconnected after ~2s
  });

  it("notifies status listeners on connect/disconnect", () => {
    const listener = vi.fn();
    manager.subscribeToStatus(listener);
    manager.connect("my-app");
    MockWebSocket.instances[0]?._open();
    expect(listener).toHaveBeenCalled();
  });
});
