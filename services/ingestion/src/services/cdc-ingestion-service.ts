/**
 * CdcIngestionService — orchestrates Change Data Capture streams.
 *
 * Responsibilities:
 *   - Start and stop CDC streams for individual connectors
 *   - Batch incoming CdcEvent values and write them to the raw table
 *   - Track the current WAL position (LSN) for resume on restart
 *   - Publish status to Redis for the API status endpoint
 *   - Handle connection drops with exponential backoff reconnection
 *
 * Position tracking and exactly-once delivery:
 *   The confirmed LSN is written to Redis AND to the sync_state.last_cursor
 *   column after each durable raw-table write. On restart, startCdcIngestion()
 *   reads last_cursor to resume from the last confirmed position, bounding
 *   duplicates to the last uncommitted batch.
 *
 * Error isolation:
 *   Each connector stream runs in its own async loop. A fatal error in one
 *   stream does not affect other streams. The service retries with backoff
 *   up to MAX_RECONNECT_ATTEMPTS before marking the stream as "error".
 */

import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import type { CdcEvent, CdcOptions } from "@oneplatform/plugin-sdk";
import type { ConnectorRepository, SyncStateRepository } from "./connector-service.js";
import type { RawTableRepository } from "./sync-service.js";
import { normalizeToEnvelope } from "../utils/data-envelope.js";
import { PostgresCdcConnector } from "../connectors/postgres-cdc/index.js";
import { maxLsn } from "../connectors/postgres-cdc/lsn.js";
import { ConnectorNotFoundError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CdcStreamStatus = "running" | "stopped" | "error" | "reconnecting";

export interface CdcStatus {
  connectorId: string;
  status: CdcStreamStatus;
  /** Current confirmed WAL position (LSN). Null when the stream has never committed a batch. */
  currentPosition: string | null;
  /** Approximate number of events processed since the stream started. */
  eventsProcessed: number;
  /** ISO 8601 timestamp when the stream was started. Null if never started. */
  startedAt: string | null;
  /** ISO 8601 timestamp of the last committed batch. Null if no batch committed yet. */
  lastCommittedAt: string | null;
  /** Most recent error message. Null if the stream has not errored. */
  lastError: string | null;
}

export interface StartCdcOptions {
  /** Tables to capture. Empty array means all tables in the publication. */
  tables?: string[];
  /** Resume from this LSN instead of the persisted last_cursor. */
  startPosition?: string;
  /** CDC batch size. Default: 500. */
  batchSize?: number;
  /** CDC batch flush timeout in ms. Default: 1000. */
  batchTimeoutMs?: number;
}

export interface CdcIngestionService {
  startCdcIngestion(connectorId: string, tenantId: string, options?: StartCdcOptions): Promise<void>;
  stopCdcIngestion(connectorId: string): Promise<void>;
  getCdcStatus(connectorId: string): Promise<CdcStatus | null>;
}

export interface CdcIngestionServiceDeps {
  connectorRepo: ConnectorRepository;
  syncStateRepo: SyncStateRepository;
  rawTableRepo: RawTableRepository;
  redis: Redis;
  logger: Logger;
  /**
   * Optional factory for creating CDC connector instances. Defaults to creating
   * a PostgresCdcConnector. Provide a custom factory in tests to inject mocks
   * without requiring module-level vi.mock patching.
   */
  connectorFactory?: () => PostgresCdcConnector;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum reconnection attempts before marking the stream as "error". */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Base delay for reconnection backoff in milliseconds. */
const RECONNECT_BASE_DELAY_MS = 2_000;

/** Redis key prefix for CDC status objects. */
const CDC_STATUS_KEY_PREFIX = "ingestion:cdc:status:";

/** TTL for CDC status keys once a stream is stopped or in error state. */
const CDC_STATUS_TERMINAL_TTL_SECONDS = 86_400; // 24 hours

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface ActiveStream {
  connector: PostgresCdcConnector;
  tenantId: string;
  /** Mutable status — updated in place and written to Redis after each change. */
  status: CdcStatus;
  /** AbortController that signals the stream loop to stop cleanly. */
  abort: AbortController;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCdcIngestionService(deps: CdcIngestionServiceDeps): CdcIngestionService {
  const { connectorRepo, syncStateRepo, rawTableRepo, redis, logger } = deps;
  // Use the injected factory if provided (for testing), otherwise create
  // a default PostgresCdcConnector instance.
  const createConnector = deps.connectorFactory ?? (() => new PostgresCdcConnector());

  // Map from connectorId -> active stream state. Entries exist only while the
  // stream is running or reconnecting. Stopped/errored streams are removed
  // after their status is written to Redis.
  const activeStreams = new Map<string, ActiveStream>();

  // ---------------------------------------------------------------------------
  // Status persistence helpers
  // ---------------------------------------------------------------------------

  async function writeStatus(status: CdcStatus): Promise<void> {
    const key = `${CDC_STATUS_KEY_PREFIX}${status.connectorId}`;
    const isTerminal = status.status === "stopped" || status.status === "error";

    if (isTerminal) {
      await redis.set(key, JSON.stringify(status), "EX", CDC_STATUS_TERMINAL_TTL_SECONDS);
    } else {
      await redis.set(key, JSON.stringify(status));
    }
  }

  async function readStatus(connectorId: string): Promise<CdcStatus | null> {
    const raw = await redis.get(`${CDC_STATUS_KEY_PREFIX}${connectorId}`);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as CdcStatus;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Batch accumulation and flush
  // ---------------------------------------------------------------------------

  /**
   * Convert a CdcEvent into a DataEnvelope-compatible record and write it to
   * the raw table. Returns the LSN from the event for position tracking.
   *
   * Each CDC event becomes one raw record. The sourceId is derived from the
   * event's table + primary key values (after column) or the LSN itself for
   * deletes where no key is available.
   */
  async function flushBatch(
    connectorId: string,
    tenantId: string,
    connectorName: string,
    events: CdcEvent[],
    batchId: string,
  ): Promise<void> {
    if (events.length === 0) return;

    // Ensure the raw table exists. Idempotent DDL, negligible cost on hot path.
    await rawTableRepo.createRawTable(connectorId);

    const envelopes = events.map((event) => {
      // sourceId for CDC records encodes the table + LSN so that replaying
      // the same WAL position produces the same _id (idempotent upsert).
      const positionKey = event.lsn ?? event.position ?? new Date().toISOString();
      const sourceId = `${event.table}:${event.type}:${positionKey}`;

      // Embed the CDC metadata inside the data payload so downstream
      // consumers (ontology service, pipeline) see the full event shape.
      const data: Record<string, unknown> = {
        _cdc_type: event.type,
        _cdc_table: event.table,
        _cdc_timestamp: event.timestamp,
        ...(event.lsn !== undefined ? { _cdc_lsn: event.lsn } : {}),
        ...(event.position !== undefined ? { _cdc_position: event.position } : {}),
        ...(event.before !== undefined ? { _cdc_before: event.before } : {}),
        ...(event.after !== undefined ? { _cdc_after: event.after } : {}),
      };

      return normalizeToEnvelope(
        { sourceId, data },
        {
          connectorId,
          connectorName,
          batchId,
          tenantId,
          syncMode: "incremental",
          cursor: positionKey,
        },
      );
    });

    await rawTableRepo.insertBatch(connectorId, envelopes);
  }

  // ---------------------------------------------------------------------------
  // Stream loop with reconnection
  // ---------------------------------------------------------------------------

  async function runStreamLoop(
    connectorId: string,
    tenantId: string,
    cdcOptions: CdcOptions,
    stream: ActiveStream,
  ): Promise<void> {
    let attempt = 0;

    while (!stream.abort.signal.aborted && attempt <= MAX_RECONNECT_ATTEMPTS) {
      if (attempt > 0) {
        const delayMs = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn("CDC stream reconnecting", { connectorId, attempt, delayMs });

        stream.status.status = "reconnecting";
        await writeStatus(stream.status);

        // Wait for the backoff delay or until stopCdcIngestion() is called.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          stream.abort.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });

        if (stream.abort.signal.aborted) break;
      }

      const connector = stream.connector;

      try {
        // Re-read the connector config on each attempt in case credentials were
        // rotated between reconnections.
        const connectorRow = await connectorRepo.findById(connectorId);
        if (connectorRow === null) {
          throw new ConnectorNotFoundError(
            `Connector ${connectorId} not found during CDC stream.`,
            { connectorId, tenantId },
          );
        }

        // connect() creates a replication slot if absent and opens the control
        // connection. The replication connection is opened inside startCdcStream().
        // We use a minimal PluginContext since built-in connectors don't need the
        // sandbox abstractions.
        const handle = await connector.connect(connectorRow.config, makeMinimalContext());

        stream.status.status = "running";
        await writeStatus(stream.status);

        const batchSize = cdcOptions.batchSize ?? 500;
        const batchTimeoutMs = cdcOptions.batchTimeoutMs ?? 1_000;

        const eventBuffer: CdcEvent[] = [];
        let batchTimer: ReturnType<typeof setTimeout> | null = null;
        let batchId = crypto.randomUUID();

        const flushNow = async (): Promise<void> => {
          if (eventBuffer.length === 0) return;
          const toFlush = eventBuffer.splice(0, eventBuffer.length);
          const lastEvent = toFlush[toFlush.length - 1];
          const newLsn = lastEvent?.lsn;

          await flushBatch(connectorId, tenantId, connectorRow.name, toFlush, batchId);

          // Advance the confirmed position after a durable write.
          if (newLsn !== undefined) {
            const advanced = maxLsn(stream.status.currentPosition ?? "0/0", newLsn);
            stream.status.currentPosition = advanced;
            stream.status.lastCommittedAt = new Date().toISOString();

            // Persist cursor so the service can resume after a restart without
            // re-reading events already in the raw table.
            await syncStateRepo.updateCursor(connectorId, advanced);
          }

          stream.status.eventsProcessed += toFlush.length;
          stream.status.lastCommittedAt = new Date().toISOString();
          await writeStatus(stream.status);

          batchId = crypto.randomUUID();
        };

        const resetBatchTimer = (): void => {
          if (batchTimer !== null) clearTimeout(batchTimer);
          batchTimer = setTimeout(() => {
            void flushNow().catch((err: Error) => {
              logger.error("CDC batch flush failed", {
                connectorId,
                error: err.message,
              });
            });
          }, batchTimeoutMs);
        };

        // Consume the stream. The generator runs until stopCdcStream() is called.
        for await (const event of connector.startCdcStream(makeMinimalContext(), cdcOptions)) {
          if (stream.abort.signal.aborted) break;

          eventBuffer.push(event);
          resetBatchTimer();

          if (eventBuffer.length >= batchSize) {
            if (batchTimer !== null) {
              clearTimeout(batchTimer);
              batchTimer = null;
            }
            await flushNow();
          }
        }

        // Flush any remaining events after the generator finishes.
        if (batchTimer !== null) clearTimeout(batchTimer);
        await flushNow();

        await connector.disconnect(handle, makeMinimalContext());

        // Clean exit — the abort was requested, not an error.
        break;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("CDC stream error", { connectorId, attempt, error: message });
        stream.status.lastError = message;
        attempt += 1;

        // ConnectorNotFoundError is non-retryable — the connector was deleted.
        if (err instanceof ConnectorNotFoundError) break;
      }
    }

    // Stream has stopped (cleanly or after exhausting reconnect attempts).
    stream.status.status = attempt > MAX_RECONNECT_ATTEMPTS ? "error" : "stopped";
    stream.status.lastError =
      attempt > MAX_RECONNECT_ATTEMPTS
        ? stream.status.lastError ?? "Max reconnect attempts exceeded"
        : stream.status.lastError;
    await writeStatus(stream.status);
    activeStreams.delete(connectorId);

    logger.info("CDC stream terminated", {
      connectorId,
      status: stream.status.status,
      eventsProcessed: stream.status.eventsProcessed,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async function startCdcIngestion(
    connectorId: string,
    tenantId: string,
    options: StartCdcOptions = {},
  ): Promise<void> {
    if (activeStreams.has(connectorId)) {
      logger.warn("CDC stream already running — ignoring duplicate start request", { connectorId });
      return;
    }

    const connectorRow = await connectorRepo.findById(connectorId);
    if (connectorRow === null || connectorRow.tenant_id !== tenantId) {
      throw new ConnectorNotFoundError(
        `Connector ${connectorId} not found.`,
        { connectorId, tenantId },
      );
    }

    // Determine the resume position: explicit option > persisted cursor > null (start from tip).
    let startPosition = options.startPosition;
    if (startPosition === undefined) {
      const syncState = await syncStateRepo.findByConnectorId(connectorId);
      startPosition = syncState?.last_cursor ?? undefined;
    }

    const cdcOptions: CdcOptions = {
      tables: options.tables ?? [],
      ...(startPosition !== undefined ? { startPosition } : {}),
      batchSize: options.batchSize ?? 500,
      batchTimeoutMs: options.batchTimeoutMs ?? 1_000,
    };

    const connector = createConnector();
    const abort = new AbortController();

    const status: CdcStatus = {
      connectorId,
      status: "running",
      currentPosition: startPosition ?? null,
      eventsProcessed: 0,
      startedAt: new Date().toISOString(),
      lastCommittedAt: null,
      lastError: null,
    };

    const stream: ActiveStream = { connector, tenantId, status, abort };
    activeStreams.set(connectorId, stream);

    await writeStatus(status);
    logger.info("CDC stream starting", { connectorId, tenantId, startPosition });

    // Run in background — do not await so the HTTP handler returns immediately.
    void runStreamLoop(connectorId, tenantId, cdcOptions, stream).catch((err: unknown) => {
      logger.error("CDC stream loop threw unexpectedly", {
        connectorId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async function stopCdcIngestion(connectorId: string): Promise<void> {
    const stream = activeStreams.get(connectorId);
    if (stream === undefined) {
      logger.warn("stopCdcIngestion: no active stream for connector", { connectorId });
      return;
    }

    stream.abort.abort();
    await stream.connector.stopCdcStream();
    logger.info("CDC stream stop requested", { connectorId });
  }

  async function getCdcStatus(connectorId: string): Promise<CdcStatus | null> {
    // Check the in-memory map first for the live status of an active stream.
    const stream = activeStreams.get(connectorId);
    if (stream !== undefined) return { ...stream.status };

    // Fall back to Redis for the last known status of a stopped/errored stream.
    return readStatus(connectorId);
  }

  return { startCdcIngestion, stopCdcIngestion, getCdcStatus };
}

// ---------------------------------------------------------------------------
// Minimal PluginContext stub for built-in connectors
//
// Built-in connectors do not run in isolated-vm and therefore don't need the
// full sandbox PluginContext. We provide a minimal implementation that satisfies
// the type signature. Built-in connectors that need DB/Redis access should
// receive those dependencies directly rather than via PluginContext.
// ---------------------------------------------------------------------------

import type { PluginContext } from "@oneplatform/plugin-sdk";

function makeMinimalContext(): PluginContext {
  // Built-in connectors do not run inside the plugin sandbox, so most
  // PluginContext services are unavailable. Instead of throwing (which would
  // crash the CDC stream if any code path accidentally touches these),
  // we log a warning and return a safe no-op/empty value. This keeps the
  // connector resilient while making the gap visible through logs.

  const contextLogger: PluginContext["logger"] = {
    debug: () => {},
    info: () => {},
    warn: console.warn.bind(console, "[cdc-minimal-context]"),
    error: console.error.bind(console, "[cdc-minimal-context]"),
  };

  const notAvailable = (service: string, method: string) => {
    contextLogger.warn(
      `${service}.${method}() called on built-in connector minimal context — ` +
      `this method is not available outside the plugin sandbox. Returning empty/null.`,
    );
  };

  return {
    credentials: {
      get: async (name: string): Promise<string> => {
        notAvailable("credentials", "get");
        return `__credential_unavailable:${name}__`;
      },
      list: async (): Promise<string[]> => {
        notAvailable("credentials", "list");
        return [];
      },
    },
    fetch: {
      fetch: async (url: string): Promise<Response> => {
        notAvailable("fetch", "fetch");
        return new Response(null, { status: 503, statusText: "Plugin fetch proxy not available in built-in connector context" });
      },
    },
    cache: {
      get: async <T>(_key: string): Promise<T | null> => {
        notAvailable("cache", "get");
        return null;
      },
      set: async <T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> => {
        notAvailable("cache", "set");
      },
      delete: async (_key: string): Promise<void> => {
        notAvailable("cache", "delete");
      },
      lock: async (_key: string, _ttlSeconds: number): Promise<null> => {
        notAvailable("cache", "lock");
        return null;
      },
    },
    logger: contextLogger,
    tenant: {
      tenantId: "",
      tenantName: "",
      config: {},
      instanceId: "",
    },
    ontology: {
      getSchema: async () => {
        notAvailable("ontology", "getSchema");
        return { entityTypes: [], version: 0 } as any;
      },
      getEntitySchema: async (_entityType: string) => {
        notAvailable("ontology", "getEntitySchema");
        return null;
      },
    },
    tracing: {
      injectHeaders: (h) => h,
      startSpan: () => ({ setAttribute: () => {}, end: () => {} }),
    },
  };
}
