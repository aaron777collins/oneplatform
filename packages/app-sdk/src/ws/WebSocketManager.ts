/**
 * WebSocket lifecycle manager (internal — not exported from package index).
 *
 * Manages a single persistent WebSocket connection shared across all
 * useSubscription instances within a single app. One connection regardless
 * of how many entities are subscribed — subscriptions are multiplexed over
 * the wire using a subscriptionId per registration.
 *
 * Reconnect policy: exponential backoff with a 30-second cap.
 * On reconnect, all active registrations are replayed to the server
 * automatically — useSubscription callers need no special handling.
 *
 * Security: the WebSocket URL is constructed from window.location.origin only,
 * preventing endpoint injection (C-6).
 */

import type { FilterSpec, EntityEventType, EntityEvent } from "../types/entities.js";
import type { OutboundWsMessage } from "../types/events.js";

// ─── Registration shape ────────────────────────────────────────────────────────

export interface SubscriptionRegistration {
  entity: string;
  filter?: FilterSpec;
  events?: EntityEventType[];
  onEvent: (event: EntityEvent<unknown>) => void;
}

// ─── Status shape ─────────────────────────────────────────────────────────────

export interface WsStatus {
  isConnected: boolean;
  reconnectAttempts: number;
}

// ─── WebSocketManager ──────────────────────────────────────────────────────────

export class WebSocketManager {
  private socket: WebSocket | null = null;
  private readonly registrations = new Map<string, SubscriptionRegistration>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private appSlug = "";

  // Listeners subscribed to connection status changes (useSyncExternalStore)
  private readonly statusListeners = new Set<() => void>();

  private static readonly BASE_RECONNECT_MS = 1_000;
  private static readonly MAX_RECONNECT_MS = 30_000;

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  /**
   * Opens the WebSocket connection to the App Service.
   * URL is derived from window.location.origin only (C-6).
   */
  connect(slug: string): void {
    this.appSlug = slug;
    // Replace http(s): with ws(s): to derive the WebSocket URL from the same origin
    const wsOrigin = window.location.origin.replace(/^http/, "ws");
    const url = `${wsOrigin}/apps/${encodeURIComponent(slug)}/ws`;
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", this.handleOpen);
    this.socket.addEventListener("message", this.handleMessage);
    this.socket.addEventListener("close", this.handleClose);
    this.socket.addEventListener("error", this.handleError);
  }

  /**
   * Registers a subscription. If the socket is already open, sends the
   * subscribe message immediately. Otherwise it will be replayed on open.
   */
  register(id: string, registration: SubscriptionRegistration): void {
    this.registrations.set(id, registration);
    if (this.socket?.readyState === 1 /* WebSocket.OPEN */) {
      this.send({
        type: "subscribe",
        subscriptionId: id,
        entity: registration.entity,
        ...(registration.filter ? { filter: registration.filter } : {}),
        ...(registration.events ? { events: registration.events } : {}),
      });
    }
  }

  /**
   * Unregisters a subscription and informs the server. Called on component unmount.
   */
  unregister(id: string): void {
    this.registrations.delete(id);
    if (this.socket?.readyState === 1 /* WebSocket.OPEN */) {
      this.send({ type: "unsubscribe", subscriptionId: id });
    }
  }

  // ─── Status subscription (useSyncExternalStore) ────────────────────────────

  subscribeToStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): WsStatus {
    return {
      isConnected: this.socket?.readyState === 1 /* WebSocket.OPEN */,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Closes the socket and cancels any pending reconnect.
   * Called by AppProvider on unmount.
   */
  destroy(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.statusListeners.clear();
  }

  // ─── Private event handlers ────────────────────────────────────────────────

  private handleOpen = (): void => {
    this.reconnectAttempts = 0;
    this.notifyStatusListeners();
    // Replay all active registrations — handles both initial open and reconnect
    for (const [id, reg] of this.registrations) {
      this.send({
        type: "subscribe",
        subscriptionId: id,
        entity: reg.entity,
        ...(reg.filter ? { filter: reg.filter } : {}),
        ...(reg.events ? { events: reg.events } : {}),
      });
    }
  };

  private handleMessage = (event: MessageEvent): void => {
    let msg: EntityEvent<unknown> & { subscriptionId?: string };
    try {
      msg = JSON.parse(event.data as string) as EntityEvent<unknown> & {
        subscriptionId?: string;
      };
    } catch {
      // Malformed message — ignore; do not crash the connection
      return;
    }
    const subscriptionId = msg.subscriptionId ?? "";
    const reg = this.registrations.get(subscriptionId);
    if (reg) {
      reg.onEvent(msg);
    }
  };

  private handleClose = (): void => {
    this.notifyStatusListeners();
    this.scheduleReconnect();
  };

  // WebSocket errors are always followed by a close event, so we let
  // handleClose drive the reconnect logic.
  private handleError = (): void => {
    // Intentionally no-op: close event fires immediately after error
  };

  // ─── Reconnect ─────────────────────────────────────────────────────────────

  /**
   * Schedules an exponential-backoff reconnect attempt.
   *
   * attempt 0 → 1s, 1 → 2s, 2 → 4s, 3 → 8s, 4 → 16s, 5+ → 30s (capped)
   */
  private scheduleReconnect(): void {
    const delay = Math.min(
      WebSocketManager.BASE_RECONNECT_MS * 2 ** this.reconnectAttempts,
      WebSocketManager.MAX_RECONNECT_MS,
    );
    this.reconnectAttempts++;
    this.notifyStatusListeners();
    this.reconnectTimer = setTimeout(() => {
      if (this.appSlug) this.connect(this.appSlug);
    }, delay);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private send(message: OutboundWsMessage): void {
    if (this.socket?.readyState === 1 /* WebSocket.OPEN */) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private notifyStatusListeners(): void {
    for (const listener of this.statusListeners) {
      listener();
    }
  }
}
