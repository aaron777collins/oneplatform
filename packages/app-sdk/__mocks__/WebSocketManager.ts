/**
 * Manual mock for WebSocketManager used in unit tests.
 *
 * Provides full control over connection status and subscription events
 * so tests do not need to simulate real WebSocket connections.
 *
 * Usage:
 *   import { mockWsManager, simulateEvent, simulateDisconnect } from "./__mocks__/WebSocketManager";
 */

import type {
  SubscriptionRegistration,
  WsStatus,
} from "../src/ws/WebSocketManager.js";
import type { EntityEvent } from "../src/types/entities.js";

// ─── Mock state ────────────────────────────────────────────────────────────────

let connected = false;
let reconnectAttempts = 0;
const registrations = new Map<string, SubscriptionRegistration>();
const statusListeners = new Set<() => void>();

export function resetWsManager(): void {
  connected = false;
  reconnectAttempts = 0;
  registrations.clear();
  statusListeners.clear();
}

// ─── Test helpers ──────────────────────────────────────────────────────────────

export function simulateConnect(): void {
  connected = true;
  reconnectAttempts = 0;
  notifyStatus();
}

export function simulateDisconnect(attempts = 0): void {
  connected = false;
  reconnectAttempts = attempts;
  notifyStatus();
}

export function simulateEvent(
  subscriptionId: string,
  event: EntityEvent<unknown>,
): void {
  const reg = registrations.get(subscriptionId);
  if (reg) reg.onEvent(event);
}

export function getRegistrations(): ReadonlyMap<string, SubscriptionRegistration> {
  return registrations;
}

function notifyStatus(): void {
  for (const listener of statusListeners) {
    listener();
  }
}

// ─── Mock WebSocketManager class ──────────────────────────────────────────────

export class WebSocketManager {
  connect(_slug: string): void {
    simulateConnect();
  }

  register(id: string, registration: SubscriptionRegistration): void {
    registrations.set(id, registration);
  }

  unregister(id: string): void {
    registrations.delete(id);
  }

  subscribeToStatus(listener: () => void): () => void {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }

  getStatus(): WsStatus {
    return { isConnected: connected, reconnectAttempts };
  }

  destroy(): void {
    registrations.clear();
    statusListeners.clear();
  }
}
