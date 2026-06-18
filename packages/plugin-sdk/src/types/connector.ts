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
   * cursor=null signals the first call (fetch from the beginning of available data).
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
    cursor: string | null,
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

// ---------------------------------------------------------------------------
// CDC (Change Data Capture) extension
//
// CdcConnector is an extension of Connector for built-in connectors that
// support PostgreSQL WAL logical replication. Plugin SDK connectors that run
// in isolated-vm cannot implement this interface because they cannot hold a
// native pg.Client replication connection. Built-in connectors (e.g.,
// PostgresCdcConnector) implement this interface directly inside the
// ingestion service.
// ---------------------------------------------------------------------------

/** A single change event streamed from a CDC source. */
export interface CdcEvent {
  /** The type of DML operation. */
  type: "insert" | "update" | "delete";
  /** Fully-qualified table name (schema.table). */
  table: string;
  /** ISO 8601 timestamp when the event occurred (derived from WAL commit time). */
  timestamp: string;
  /** WAL LSN for this event (PostgreSQL: "XXXXXXXX/YYYYYYYY"). */
  lsn?: string;
  /** Generic position string for non-LSN sources. */
  position?: string;
  /** Row state before the change (populated for UPDATE and DELETE). */
  before?: Record<string, unknown>;
  /** Row state after the change (populated for INSERT and UPDATE). */
  after?: Record<string, unknown>;
}

/** Options passed to CdcConnector.startCdcStream(). */
export interface CdcOptions {
  /** Tables to capture. Fully-qualified names (schema.table). Empty = all tables in publication. */
  tables: string[];
  /** Resume from this position (LSN for PostgreSQL). Omit to start from the tip. */
  startPosition?: string;
  /** Number of events to accumulate before flushing a batch. Default: 500. */
  batchSize?: number;
  /** Maximum time in ms to wait before flushing a partial batch. Default: 1000. */
  batchTimeoutMs?: number;
}

/** Metadata about a PostgreSQL logical replication slot. */
export interface ReplicationSlotInfo {
  /** Replication slot name on the source database. */
  slotName: string;
  /** The LSN the slot has confirmed flushing up to. */
  confirmedFlushLsn: string;
  /** Approximate WAL accumulation behind this slot in bytes. */
  lagBytes: number;
  /** Whether the slot is currently active (i.e., a client is streaming from it). */
  active: boolean;
}

/**
 * Extension of Connector for sources that support real-time Change Data Capture.
 *
 * Implementors must set supportsRealtime = true and provide an async generator
 * via startCdcStream() that yields CdcEvent objects until stopCdcStream() is
 * called or the upstream connection drops.
 */
export interface CdcConnector extends Connector {
  readonly supportsRealtime: true;
  /**
   * Opens a CDC stream and returns an AsyncIterable of CdcEvent objects.
   * The iterable must stop yielding when stopCdcStream() is called.
   */
  startCdcStream(context: PluginContext, options: CdcOptions): AsyncIterable<CdcEvent>;
  /** Signals the CDC stream to stop. Must resolve after the stream has closed. */
  stopCdcStream(): Promise<void>;
  /**
   * Returns metadata about the replication slot (optional — only for connectors
   * that use PostgreSQL logical replication slots).
   */
  getReplicationSlotInfo?(): Promise<ReplicationSlotInfo>;
}

// ---------------------------------------------------------------------------
// Streaming connector types (Kafka, NATS, Pulsar, etc.)
//
// StreamingConnector models push-based message brokers where the consumer
// subscribes to topics and the broker delivers messages asynchronously.
// The fundamental difference from Connector (pull-based cursor pagination)
// is that the stream is unbounded — it runs until explicitly stopped.
// The caller must call acknowledge() after each batch is durably written so
// the broker can advance its committed offset.
//
// Offset resumability:
//   After a crash the service reads the last acknowledged offset from the
//   sync_state.last_cursor column and passes it as startOffset to subscribe().
//   The broker redelivers messages from that position onward, so at-least-once
//   delivery is guaranteed. The ingestion service deduplicates via upsert on
//   the envelope _id (derived from topic + partition + offset).
// ---------------------------------------------------------------------------

/** Subscription parameters passed to StreamingConnector.subscribe(). */
export interface StreamOptions {
  /** Topics to subscribe to. Must contain at least one entry. */
  topics: string[];
  /**
   * Consumer group identifier. All instances sharing the same groupId cooperate
   * on partition assignment (Kafka) or queue-group delivery (NATS).
   */
  groupId: string;
  /**
   * Where to start consuming when no committed offset exists for this group.
   *   "earliest" — start from the oldest available message
   *   "latest"   — start from the current end of the topic (default)
   *   "<cursor>" — connector-specific cursor string for deterministic resume
   */
  startOffset?: "earliest" | "latest" | string;
  /** Max messages to accumulate before yielding a batch. Default: 100. */
  maxBatchSize?: number;
  /** Max ms to wait for a full batch before yielding a partial one. Default: 1000. */
  maxWaitMs?: number;
}

/** A single message delivered from a message broker topic. */
export interface StreamMessage {
  /**
   * Stable, globally-unique identifier for this message within the broker.
   * Typically encoded as "<topic>:<partition>:<offset>" for Kafka or the
   * message sequence number for NATS.
   */
  id: string;
  /** Source topic name. */
  topic: string;
  /** Partition index within the topic. Undefined for brokers without partitions. */
  partition?: number;
  /** Broker-assigned monotonically increasing offset within the partition. */
  offset?: string;
  /** Optional message key for partition assignment and co-location. */
  key?: string;
  /** Decoded message payload. Must be a JSON object. */
  value: Record<string, unknown>;
  /** ISO 8601 timestamp when the message was produced (broker timestamp). */
  timestamp: string;
  /**
   * Optional broker-level headers. Values are string-coerced;
   * binary header values are base64-encoded.
   */
  headers?: Record<string, string>;
}

/** Current consumer state for monitoring and alerting. */
export interface ConsumerStatus {
  /** Whether the consumer is connected to the broker. */
  connected: boolean;
  /** Topics currently subscribed to. */
  topics: string[];
  /**
   * Per-topic consumer lag (messages behind the head of the topic).
   * Keys are topic names; values are message counts.
   */
  lag: Record<string, number>;
  /** Total messages consumed since subscribe() was first called. */
  messagesConsumed: number;
}

/**
 * A connector that reads from a message broker (Kafka, NATS, etc.).
 *
 * The ingestion service lifecycle:
 *   1. subscribe() — open consumer, return AsyncIterable<StreamMessage>
 *   2. consume the iterable, accumulate batches
 *   3. write batch to raw table
 *   4. acknowledge(messageIds) — commit offsets to the broker
 *   5. getConsumerStatus() — optional: poll lag for the status endpoint
 *
 * Implementations MUST NOT auto-commit offsets — the platform controls
 * offset commits via explicit acknowledge() calls so messages are never
 * discarded before they reach durable storage.
 */
export interface StreamingConnector {
  /** Discriminant that the ingestion service uses to identify stream connectors. */
  readonly type: "streaming";
  /**
   * Open a consumer subscription and return an AsyncIterable of StreamMessage
   * values. The iterable runs indefinitely until the caller breaks out of the
   * loop or the connector throws a fatal error.
   */
  subscribe(context: PluginContext, options: StreamOptions): AsyncIterable<StreamMessage>;
  /**
   * Acknowledge that the given message IDs have been durably written.
   * Must not throw — log errors and return on failure.
   */
  acknowledge(messageIds: string[]): Promise<void>;
  /** Return the current consumer status. Must not throw. */
  getConsumerStatus(): Promise<ConsumerStatus>;
}
