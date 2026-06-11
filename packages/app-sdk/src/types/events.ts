/**
 * WebSocket message protocol types.
 *
 * These describe the messages exchanged over the persistent WebSocket
 * connection between the SDK and the App Service BFF. They are internal
 * wire types — not part of the public API.
 */

import type { FilterSpec, EntityEventType, EntityEvent } from "./entities.js";

// ─── Outbound messages (SDK → server) ────────────────────────────────────────

export interface SubscribeMessage {
  type: "subscribe";
  subscriptionId: string;
  entity: string;
  filter?: FilterSpec;
  events?: EntityEventType[];
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  subscriptionId: string;
}

export type OutboundWsMessage = SubscribeMessage | UnsubscribeMessage;

// ─── Inbound messages (server → SDK) ─────────────────────────────────────────

export interface InboundEventMessage extends EntityEvent<unknown> {
  subscriptionId: string;
}

export type InboundWsMessage = InboundEventMessage;
