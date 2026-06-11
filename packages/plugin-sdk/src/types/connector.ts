/**
 * Connector interface and supporting types.
 *
 * A Connector is a data source. The Ingestion Service drives its lifecycle:
 * it calls connect() once per ingestion job, then calls fetchBatch() in a cursor
 * loop until hasMore is false, then calls disconnect().
 *
 * Connectors are NOT pipeline hooks — they are registered as named data sources
 * and appear in the "Data Sources" section of the platform UI.
 */

import type { DataRecord } from "./primitives.js";
import type { PluginContext } from "./context.js";
import type { ConnectorMetadata } from "./metadata.js";

export interface ConnectorHandle {
  /**
   * Opaque identifier for this active connection, assigned by the plugin.
   * Used to correlate fetchBatch and disconnect calls to the same connection.
   * Must be a string. The platform stores this between fetchBatch calls to
   * support resumable ingestion.
   */
  connectionId: string;

  /**
   * Plugin-managed connection state. May include auth tokens, base URLs,
   * or other values needed by fetchBatch and disconnect.
   * Must be JSON-serializable (the platform may checkpoint this between calls).
   */
  metadata: Record<string, unknown>;
}

export interface BatchResult {
  records: DataRecord[];

  /**
   * Cursor for the next fetchBatch call. Set to null to signal that all records
   * have been returned. The cursor value is opaque to the platform — it may be
   * a page token, timestamp, offset, or any string the connector uses internally.
   */
  nextCursor: string | null;

  /** Set to true if there are more records after this batch (i.e., nextCursor is non-null). */
  hasMore: boolean;

  /** ISO 8601 timestamp of when this batch was fetched. Used for freshness tracking. */
  fetchedAt: string;

  /**
   * Advisory hint for the platform progress UI. If unknown, omit this field.
   * The platform never makes correctness decisions based on this value.
   */
  estimatedTotal?: number;
}

export interface EventCallback {
  (event: DataRecord): Promise<void>;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
  isActive(): boolean;
}

export interface Connector {
  /**
   * Return the connector's metadata. Called by the Plugin Service at install time
   * to verify the entrypoint is valid, and by the Ingestion Service to display
   * connector details in the data source catalog.
   */
  metadata(): ConnectorMetadata;

  /**
   * Validate the plugin configuration and credentials, and establish a connection.
   * Called once per ingestion job before the first fetchBatch call.
   *
   * This method should be fast (< 5 seconds). If the external service requires
   * a round-trip for auth (e.g., OAuth token refresh), do it here and cache the
   * token in the context.cache.
   *
   * @throws PluginConfigError if config is invalid or missing required fields.
   * @throws PluginAuthError if credential validation fails.
   */
  connect(config: Record<string, unknown>, context: PluginContext): Promise<ConnectorHandle>;

  /**
   * Fetch the next batch of records from the external system.
   *
   * cursor=undefined signals the first call (fetch from the beginning of available data).
   * For incremental syncs, the cursor is the value returned by the previous fetchBatch.
   * The platform stores the last successful cursor and resumes from it on retry.
   *
   * Batch size should be controlled by the connector, typically 100-1000 records.
   * Avoid batches larger than 10,000 records — the platform's ingestion queue has
   * per-message limits.
   *
   * @throws PluginRateLimitError if the external API returns 429.
   * @throws PluginTimeoutError if a network call exceeds the configured timeout.
   * @throws PluginAuthError if the connection credentials have expired.
   */
  fetchBatch(
    handle: ConnectorHandle,
    cursor: string | undefined,
    context: PluginContext,
  ): Promise<BatchResult>;

  /**
   * Subscribe to real-time change events from the external system.
   * Only implement if ConnectorMetadata.supportsRealtime is true.
   *
   * The platform calls this method once when a real-time data source is activated.
   * The callback receives individual change events as they arrive. Each callback
   * invocation is an async operation — the connector must await it before processing
   * the next event to maintain ordering.
   *
   * The returned Subscription must remain active until unsubscribe() is called,
   * which happens when the tenant disables real-time on the data source.
   */
  subscribeToEvents?(
    handle: ConnectorHandle,
    callback: EventCallback,
    context: PluginContext,
  ): Promise<Subscription>;

  /**
   * Clean up the connection. Called after the ingestion job completes or on error.
   * Must not throw. If cleanup fails, log the error and return.
   *
   * Resources to release: HTTP connections, open file handles, WebSocket connections.
   * Do NOT revoke OAuth tokens here — they may be reused by the next ingestion run.
   */
  disconnect(handle: ConnectorHandle, context: PluginContext): Promise<void>;
}
