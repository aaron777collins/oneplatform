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
  /**
   * True when the manager has exhausted all reconnect attempts and given up.
   * The UI should surface a "Reconnect" button that calls WebSocketManager.connect()
   * to give the user an explicit recovery path without requiring a page reload.
   */
  reconnectExhausted: boolean;
}

// ─── WebSocketManager ──────────────────────────────────────────────────────────

export class WebSocketManager {
  private socket: WebSocket | null = null;
  private readonly registrations = new Map<string, SubscriptionRegistration>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private appSlug = "";
  // Guards scheduleReconnect and connect after destroy() is called so that a
  // close event racing with destroy() cannot resurrect the connection.
  private destroyed = false;

  // Listeners subscribed to connection status changes (useSyncExternalStore)
  private readonly statusListeners = new Set<() => void>();

  private static readonly BASE_RECONNECT_MS = 1_000;
  /**
   * Backoff cap: 60 s gives at-most 1 reconnect/minute during long outages
   * without flooding a recovering server.
   */
  private static readonly MAX_RECONNECT_MS = 60_000;
  /**
   * Maximum consecutive reconnect attempts before giving up.
   *
   * 20 attempts covers ~30 minutes of exponential backoff (1s, 2s, 4s …
   * capped at 60s) without silently abandoning connections during transient
   * outages that last tens of minutes. After exhaustion a "Reconnect" button
   * is surfaced to the user via the `reconnectDisabled` status flag so they
   * can explicitly retry without a full page reload.
   *
   * Callers can pass a custom value to the constructor to override this default.
   */
  private static readonly MAX_RECONNECT_ATTEMPTS = 20;
  /** When true, reconnection has been permanently disabled due to exhausted retries. */
  private reconnectDisabled = false;

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  /**
   * Opens the WebSocket connection to the App Service.
   * URL is derived from window.location.origin only (C-6).
   */
  connect(slug: string): void {
    // Allow a previously-destroyed instance to be reused when AppProvider remounts
    // (e.g. React Strict Mode double-mount or user-triggered retry via retryCount).
    // The refs in useProviderSingletons are non-null after the first mount, so
    // resetting here lets the existing instance reconnect rather than silently
    // refusing because the destroyed flag was set by the prior cleanup.
    this.destroyed = false;

    this.appSlug = slug;
    // A manual connect() call resets retry state so the manager gets a fresh
    // budget of reconnect attempts.
    this.reconnectDisabled = false;
    this.reconnectAttempts = 0;

    this.openSocket(slug);
  }

  /**
   * Opens the raw WebSocket to the given slug.
   * Shared between initial connect() and reconnect timer so that reconnect
   * can re-open without resetting the attempt counter.
   */
  private openSocket(slug: string): void {
    // Remove listeners from any previous socket before creating the new one so
    // stale close/error events from the old socket don't trigger a second reconnect.
    if (this.socket !== null) {
      this.socket.removeEventListener("open", this.handleOpen);
      this.socket.removeEventListener("message", this.handleMessage);
      this.socket.removeEventListener("close", this.handleClose);
      this.socket.removeEventListener("error", this.handleError);
    }

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
      reconnectExhausted: this.reconnectDisabled,
    };
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Closes the socket and cancels any pending reconnect.
   * Called by AppProvider on unmount.
   */
  destroy(): void {
    this.destroyed = true;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Remove all event listeners before closing so the close event fired by
    // socket.close() does not re-enter scheduleReconnect.
    if (this.socket !== null) {
      this.socket.removeEventListener("open", this.handleOpen);
      this.socket.removeEventListener("message", this.handleMessage);
      this.socket.removeEventListener("close", this.handleClose);
      this.socket.removeEventListener("error", this.handleError);
      this.socket.close();
      this.socket = null;
    }

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
    // Do not schedule a reconnect if destroy() has already been called or
    // reconnection has been permanently disabled (max attempts exhausted).
    if (this.destroyed || this.reconnectDisabled) return;

    // Check if we have exceeded the maximum number of reconnect attempts.
    // This prevents infinite retry loops when the WS endpoint does not exist
    // (e.g. App Service has no WebSocket route, returns 404).
    if (this.reconnectAttempts >= WebSocketManager.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectDisabled = true;
      console.warn(
        `[app-sdk] WebSocket reconnection disabled after ${this.reconnectAttempts} failed attempts. ` +
          "The WebSocket endpoint may be unavailable. " +
          "Real-time updates are paused. " +
          "Call WebSocketManager.connect() or click the 'Reconnect' button to retry.",
      );
      // Notify status listeners so the UI can surface a "Reconnect" button.
      // Callers check WsStatus.reconnectExhausted to determine whether to show it.
      this.notifyStatusListeners();
      return;
    }

    const delay = Math.min(
      WebSocketManager.BASE_RECONNECT_MS * 2 ** this.reconnectAttempts,
      WebSocketManager.MAX_RECONNECT_MS,
    );
    this.reconnectAttempts++;
    this.notifyStatusListeners();
    this.reconnectTimer = setTimeout(() => {
      // Use internal reconnect path that preserves attempt counter — do NOT
      // call this.connect() which resets reconnectAttempts to 0.
      if (this.appSlug && !this.destroyed && !this.reconnectDisabled) {
        this.openSocket(this.appSlug);
      }
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
