/**
 * Types for real-time event subscriptions via SSE.
 */

import type { NetworkError } from '../errors/network-error.js';
import type { AuthError } from '../errors/client-errors.js';

export interface PlatformEvent {
  /** Unique event ID. Used as Last-Event-ID for stream resumption. */
  readonly id: string;

  /** Dot-separated event type hierarchy. E.g. "pipeline.run.completed" */
  readonly type: string;

  /** Tenant this event belongs to. */
  readonly tenantId: string;

  /** ISO 8601 timestamp when the event occurred on the server. */
  readonly occurredAt: string;

  /** Event-specific payload. Type varies by event type. */
  readonly payload: unknown;
}

export interface SubscriptionOptions {
  /**
   * Event patterns to subscribe to.
   * Supports exact strings and trailing-wildcard patterns (e.g. "pipeline.*").
   */
  readonly events: string[];

  /**
   * Optional server-side filter to reduce unnecessary traffic.
   */
  readonly filter?: {
    readonly entityType?: string;
    readonly entityId?: string;
    readonly pipelineId?: string;
  };

  /**
   * Resume from a specific event ID.
   * The server replays events after this ID within its replay window.
   * Managed automatically by the SDK on reconnection via Last-Event-ID.
   */
  readonly fromEventId?: string;
}

export interface Subscription {
  /** Server-assigned subscription ID (from the first 'connected' SSE event). */
  readonly id: string;

  /** Current connection lifecycle state. */
  readonly status: 'connecting' | 'connected' | 'reconnecting' | 'closed';

  /** Last event ID received. Used for reconnection resumption. */
  readonly lastEventId: string | null;

  /** Terminate the subscription and close the SSE connection. */
  unsubscribe(): void;

  /** Register a listener for status changes or errors (generic overload). */
  on(event: 'status', handler: (status: Subscription['status']) => void): this;

  /**
   * Register a listener for connection errors (emitted before reconnect attempts).
   * AuthError is emitted for 401 responses — the subscription closes immediately
   * in that case and no reconnection is attempted.
   */
  on(event: 'error', handler: (error: NetworkError | AuthError) => void): this;

  /**
   * Type-safe shorthand for `on('status', handler)`.
   * Registers a listener invoked whenever the subscription status changes.
   */
  onStatus(handler: (status: Subscription['status']) => void): this;

  /**
   * Type-safe shorthand for `on('error', handler)`.
   * Registers a listener invoked on connection errors, including
   * {@link AuthError} for 401 responses (which close the subscription
   * immediately without reconnect).
   */
  onError(handler: (error: NetworkError | AuthError) => void): this;
}
