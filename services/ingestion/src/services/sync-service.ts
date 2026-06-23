import { Queue, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { AppError } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { CredentialService } from "./credential-service.js";
import type { ConnectorRepository, SyncStateRepository, ConnectorRow } from "./connector-service.js";
import {
  ConnectorNotFoundError,
  ConnectorDisabledError,
  SyncAlreadyRunningError,
  QueueFullError,
} from "./errors.js";
import {
  normalizeToEnvelope,
  type DataRecord,
} from "../utils/data-envelope.js";
import type { SchemaDriftService } from "./schema-drift-service.js";
import type { DataQualityService } from "./data-quality-service.js";

// ---------------------------------------------------------------------------
// Raw table repository interface — matches the concrete RawTableRepository.
// ---------------------------------------------------------------------------

export interface RawTableRepository {
  createRawTable(connectorId: string): Promise<void>;
  insertBatch(connectorId: string, envelopes: ReturnType<typeof normalizeToEnvelope>[]): Promise<void>;
  upsertBatch(tableName: string, envelopes: ReturnType<typeof normalizeToEnvelope>[]): Promise<void>;
  softDeleteNotInBatch(connectorId: string, currentBatchId: string): Promise<number>;
  /**
   * Delete rows older than the given cutoff.
   * Accepts either a Date (sync-service path) or a number of days
   * (retention-service path). The concrete repository handles both forms.
   */
  deleteOlderThan(connectorId: string, olderThan: Date | number): Promise<number>;
  dropTable(connectorId: string): Promise<void>;
  count(connectorId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// BullMQ job payload shapes
// ---------------------------------------------------------------------------

export interface SyncJobPayload {
  connectorId: string;
  tenantId: string;
  syncMode: "full" | "incremental";
  /** Populated when triggered from a pipeline connector step. */
  runId?: string;
  stepId?: string;
  force?: boolean;
}

export interface BatchJobPayload {
  syncJobId: string;
  connectorId: string;
  tenantId: string;
  batchId: string;
  batchSeqNum: number;
  syncMode: "full" | "incremental";
  cursor: string | null;
  // recordCount is stored for metrics/logging; actual records are read from
  // `records` (inline) or from the temp file referenced by `recordsFile`.
  recordCount: number;
  // For batches under BATCH_PAYLOAD_THRESHOLD, records are included inline for
  // low-latency processing without filesystem I/O. For larger batches, records
  // are written to a temp file and only the path is stored here. The worker
  // reads the file, processes it, then deletes it. This bounds Redis memory
  // usage even when connectors return very large batches.
  records?: DataRecord[];
  /**
   * Absolute path to a JSON file containing the record array. Populated
   * instead of `records` when the batch exceeds BATCH_PAYLOAD_THRESHOLD.
   * The worker deletes this file after successful (or failed) processing.
   */
  recordsFile?: string;
}

// ---------------------------------------------------------------------------
// Progress state stored in Redis under ingestion:sync:{syncJobId}:progress
// ---------------------------------------------------------------------------

export interface SyncProgress {
  syncJobId: string;
  connectorId: string;
  tenantId: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  syncMode: "full" | "incremental";
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  totalRecords: number;
  processedRecords: number;
  startedAt: string | null;
  completedAt: string | null;
  lastBatchAt: string | null;
  errors: Array<{
    batchId: string;
    message: string;
    code: string;
    recordCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Sync history summary from BullMQ job data
// ---------------------------------------------------------------------------

export interface SyncJobSummary {
  syncJobId: string;
  connectorId: string;
  status: "running" | "success" | "failed" | "cancelled";
  syncMode: "full" | "incremental";
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  rowsIngested: number;
  rowsFailed: number;
  error: string | null;
}

export interface ListSyncsOptions {
  cursor?: string;
  limit: number;
  filterStatus?: "running" | "success" | "failed" | "cancelled";
}

export interface ListSyncsResult {
  items: SyncJobSummary[];
  nextCursor: string | null;
  total: number;
}

// ---------------------------------------------------------------------------
// TriggerSync result
// ---------------------------------------------------------------------------

export interface TriggerSyncResult {
  syncJobId: string;
  status: "queued";
  estimatedStartMs: number;
}

// ---------------------------------------------------------------------------
// SyncService — public interface
// ---------------------------------------------------------------------------

export interface SyncService {
  triggerSync(
    connectorId: string,
    tenantId: string,
    options?: { mode?: "full" | "incremental"; force?: boolean },
  ): Promise<TriggerSyncResult>;
  getSyncProgress(syncJobId: string): Promise<SyncProgress | null>;
  listSyncs(connectorId: string, query: ListSyncsOptions): Promise<ListSyncsResult>;
  cancelSync(syncJobId: string): Promise<void>;
  processSyncJob(job: Job<SyncJobPayload>): Promise<void>;
  processBatchJob(job: Job<BatchJobPayload>): Promise<void>;
  // runWatchdog scans for sync_state rows stuck in 'running' beyond the stale
  // threshold and resets them. Returns the count of rows reset. Called
  // periodically by the background scheduler.
  runWatchdog(staleThresholdMs?: number): Promise<number>;
}

export interface SyncServiceDeps {
  connectorRepo: ConnectorRepository;
  syncStateRepo: SyncStateRepository;
  rawTableRepo: RawTableRepository;
  credentialService: CredentialService;
  redis: Redis;
  masterKey: Buffer;
  logger: Logger;
  executionServiceUrl?: string;
  /** Redis URL for BullMQ queues. Falls back to OP_REDIS_URL env var. */
  redisUrl?: string;
  /** Optional — when omitted, schema drift detection is skipped. */
  schemaDriftService?: SchemaDriftService;
  /** Optional — when omitted, data quality analysis is skipped. */
  dataQualityService?: DataQualityService;
}

// BullMQ queue capacity guard. Exceeding this triggers QueueFullError so the
// sync job reschedules itself rather than flooding the workers.
const BATCH_QUEUE_MAX = 50_000;

// When a batch payload exceeds this byte threshold, records are written to a
// temp file instead of being inlined in the BullMQ job payload. This prevents
// large batches from bloating Redis memory. 1,000 records × ~1 KB per record
// ≈ 1 MB, which matches the soft warning threshold already in place.
// Adjust via OP_BATCH_PAYLOAD_THRESHOLD_BYTES env var.
export const BATCH_PAYLOAD_THRESHOLD: number = (() => {
  const envVal = process.env["OP_BATCH_PAYLOAD_THRESHOLD_BYTES"];
  if (envVal !== undefined && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 1_048_576; // 1 MB default
})();

// Progress Redis key TTL applied once a sync reaches a terminal state.
// Matches BullMQ removeOnComplete age (7 days) so progress keys expire
// around the same time as the underlying BullMQ job data.
const PROGRESS_TERMINAL_TTL_SECONDS = 604_800;

// Fallback Redis URL — prefer the injected dependency's connection info when
// available, but fall back to the environment variable for BullMQ Queue
// construction which requires a URL string (not an ioredis client).
const DEFAULT_REDIS_URL = process.env["OP_REDIS_URL"] ?? "redis://localhost:6379";

// Shape of the response returned by the Execution Service fetchBatch method.
interface FetchBatchResponse {
  records: DataRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// executeWatchdog — pure watchdog logic, exported for direct unit testing.
//
// Decoupled from the full SyncService so tests can exercise the watchdog
// without constructing BullMQ queues. The createSyncService factory delegates
// its runWatchdog method to this function.
// ---------------------------------------------------------------------------

export async function executeWatchdog(
  syncStateRepo: SyncStateRepository,
  logger: Logger,
  staleThresholdMs: number,
): Promise<number> {
  try {
    // Phase 1: identify stale rows so we can emit a per-connector log entry.
    // This is a read-before-write; a concurrent trigger could race between
    // the SELECT and the UPDATE, but that is acceptable — worst case we log
    // a connector that was already reset by another instance, which is harmless.
    const staleRows = await syncStateRepo.findStaleSyncs(staleThresholdMs);

    for (const row of staleRows) {
      logger.warn("Watchdog detected stale sync — will reset to failed", {
        connectorId: row.connector_id,
        lastSyncJobId: row.last_sync_job_id,
        updatedAt: row.updated_at,
        staleThresholdMs,
      });
    }

    // Phase 2: bulk reset to 'failed'. Uses a single UPDATE statement to
    // avoid N individual queries and to be atomic relative to new triggers.
    const resetCount = await syncStateRepo.resetStaleSyncs(staleThresholdMs);

    if (resetCount > 0) {
      logger.warn("Watchdog reset stale sync states", {
        resetCount,
        staleThresholdMs,
      });
    } else {
      logger.debug("Watchdog: no stale sync states found", { staleThresholdMs });
    }

    return resetCount;
  } catch (err) {
    logger.error("Watchdog failed to reset stale syncs", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Do not rethrow — the watchdog must not crash the scheduler.
    return 0;
  }
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  const {
    connectorRepo,
    syncStateRepo,
    rawTableRepo,
    credentialService,
    masterKey,
    redis,
    logger,
    schemaDriftService,
    dataQualityService,
  } = deps;

  const executionServiceUrl =
    deps.executionServiceUrl ??
    process.env["EXECUTION_SERVICE_URL"] ??
    "http://execution-service:3000";

  // Derive BullMQ Redis URL from the injected dependency, falling back to the
  // module-level default. This ensures queues connect to the same Redis instance
  // as the rest of the service.
  const redisUrl = deps.redisUrl ?? DEFAULT_REDIS_URL;

  // Queues are created lazily once — constructed at module level but connected
  // on first use. This defers connection errors to the first actual enqueue,
  // not service startup, which is the BullMQ recommended pattern.
  const syncQueue = new Queue<SyncJobPayload>("ingestion.sync", {
    connection: { lazyConnect: true, url: redisUrl },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 604_800 },
      removeOnFail: { age: 2_592_000 },
    },
  });

  const batchQueue = new Queue<BatchJobPayload>("ingestion.batch", {
    connection: { lazyConnect: true, url: redisUrl },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
  });

  const ontologyQueue = new Queue("ontology.map", {
    connection: { lazyConnect: true, url: redisUrl },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
  });

  // -------------------------------------------------------------------------
  // writeProgress — writes the SyncProgress object to Redis and publishes to
  // the SSE pub/sub channel for real-time progress streaming.
  // -------------------------------------------------------------------------

  async function writeProgress(progress: SyncProgress): Promise<void> {
    const key = `ingestion:sync:${progress.syncJobId}:progress`;

    // Active syncs (queued/running) must not have a TTL — long-running jobs
    // (multi-day full syncs) would become unmonitorable if the progress key
    // expired mid-sync. Only apply the TTL once the job reaches a terminal
    // state so the key is eventually cleaned up without affecting visibility.
    const isTerminal =
      progress.status === "success" ||
      progress.status === "failed" ||
      progress.status === "cancelled";

    if (isTerminal) {
      await redis.set(key, JSON.stringify(progress), "EX", PROGRESS_TERMINAL_TTL_SECONDS);
    } else {
      // KEEPTTL preserves an existing TTL if one was somehow set previously;
      // omitting the option entirely writes with no expiry for fresh keys.
      await redis.set(key, JSON.stringify(progress));
    }

    await redis.publish(
      `ingestion:sync:${progress.syncJobId}:events`,
      JSON.stringify(progress),
    );
  }

  // -------------------------------------------------------------------------
  // triggerSync — validates connector state, enqueues the parent sync job,
  // and returns immediately with the job ID for the caller to poll.
  // -------------------------------------------------------------------------

  async function triggerSync(
    connectorId: string,
    tenantId: string,
    options: { mode?: "full" | "incremental"; force?: boolean } = {},
  ): Promise<TriggerSyncResult> {
    const connector = await connectorRepo.findById(connectorId);
    if (connector === null || connector.tenant_id !== tenantId) {
      throw new ConnectorNotFoundError(
        `Connector ${connectorId} not found.`,
        { connectorId, tenantId },
      );
    }

    if (!connector.is_enabled) {
      throw new ConnectorDisabledError(
        `Connector ${connectorId} is disabled.`,
        { connectorId },
      );
    }

    // Guard against duplicate concurrent syncs unless force=true.
    if (!options.force) {
      const syncState = await syncStateRepo.findByConnectorId(connectorId);
      if (syncState?.status === "running") {
        throw new SyncAlreadyRunningError(
          `Connector ${connectorId} already has a sync in progress.`,
          { connectorId },
        );
      }
    }

    const syncMode = options.mode ?? connector.sync_mode;

    const job = await syncQueue.add("sync", {
      connectorId,
      tenantId,
      syncMode,
      ...(options.force !== undefined ? { force: options.force } : {}),
    });

    if (job.id === undefined) {
      throw new Error(`Failed to enqueue sync job for connector ${connectorId}`);
    }

    // Mark sync_state as running immediately so a second trigger without
    // force=true is rejected before the worker picks up the job.
    await syncStateRepo.updateStatus(connectorId, "running");

    // Seed the progress key so progress polling works before the worker starts.
    await writeProgress({
      syncJobId: job.id,
      connectorId,
      tenantId,
      status: "queued",
      syncMode,
      totalBatches: 0,
      completedBatches: 0,
      failedBatches: 0,
      totalRecords: 0,
      processedRecords: 0,
      startedAt: null,
      completedAt: null,
      lastBatchAt: null,
      errors: [],
    });

    logger.info("Sync triggered", { connectorId, tenantId, syncMode, syncJobId: job.id });

    return { syncJobId: job.id, status: "queued", estimatedStartMs: 0 };
  }

  // -------------------------------------------------------------------------
  // getSyncProgress — reads from Redis. Returns null if the key is absent
  // (expired or job predates this implementation).
  // -------------------------------------------------------------------------

  async function getSyncProgress(syncJobId: string): Promise<SyncProgress | null> {
    const raw = await redis.get(`ingestion:sync:${syncJobId}:progress`);
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as SyncProgress;
    } catch {
      logger.warn("Failed to parse sync progress from Redis", { syncJobId });
      return null;
    }
  }

  // Atomically increments completedBatches and processedRecords on the progress
  // key using a Lua script so concurrent batch workers cannot lose updates.
  // The script is a compare-and-swap loop: read → decode → increment → write,
  // all within a single Redis execution context (no interleaving possible).
  const incrProgressScript = `
    local key = KEYS[1]
    local pubChannel = KEYS[2]
    local batchIncr = tonumber(ARGV[1])
    local recordIncr = tonumber(ARGV[2])
    local lastBatchAt = ARGV[3]
    local raw = redis.call('GET', key)
    if not raw then return nil end
    local ok, progress = pcall(cjson.decode, raw)
    if not ok then return nil end
    progress['completedBatches'] = (progress['completedBatches'] or 0) + batchIncr
    progress['processedRecords'] = (progress['processedRecords'] or 0) + recordIncr
    progress['lastBatchAt'] = lastBatchAt
    local encoded = cjson.encode(progress)
    -- KEEPTTL preserves any TTL set by processSyncJob on the terminal-state key,
    -- preventing the key from becoming permanent when a concurrent batch job
    -- updates the key after the terminal EX has already been applied.
    redis.call('SET', key, encoded, 'KEEPTTL')
    redis.call('PUBLISH', pubChannel, encoded)
    return 1
  `;

  async function incrementBatchProgress(
    syncJobId: string,
    recordCount: number,
  ): Promise<void> {
    const key = `ingestion:sync:${syncJobId}:progress`;
    const pubChannel = `ingestion:sync:${syncJobId}:events`;
    const result = await redis.eval(
      incrProgressScript,
      2,
      key,
      pubChannel,
      "1",
      String(recordCount),
      new Date().toISOString(),
    );
    if (result === null) {
      logger.warn("incrementBatchProgress: progress key missing, skipping update", { syncJobId });
    }
  }

  // Atomically increments failedBatches and appends an error entry.
  const incrFailedBatchScript = `
    local key = KEYS[1]
    local pubChannel = KEYS[2]
    local errorJson = ARGV[1]
    local raw = redis.call('GET', key)
    if not raw then return nil end
    local ok, progress = pcall(cjson.decode, raw)
    if not ok then return nil end
    progress['failedBatches'] = (progress['failedBatches'] or 0) + 1
    local errors = progress['errors'] or {}
    local errOk, errEntry = pcall(cjson.decode, errorJson)
    if errOk then
      table.insert(errors, errEntry)
    end
    progress['errors'] = errors
    local encoded = cjson.encode(progress)
    -- KEEPTTL mirrors the fix in incrProgressScript: preserve any EX applied by
    -- processSyncJob so the terminal-state key is not leaked as a permanent key.
    redis.call('SET', key, encoded, 'KEEPTTL')
    redis.call('PUBLISH', pubChannel, encoded)
    return 1
  `;

  async function incrementFailedBatch(
    syncJobId: string,
    errorEntry: { batchId: string; message: string; code: string; recordCount: number },
  ): Promise<void> {
    const key = `ingestion:sync:${syncJobId}:progress`;
    const pubChannel = `ingestion:sync:${syncJobId}:events`;
    const result = await redis.eval(
      incrFailedBatchScript,
      2,
      key,
      pubChannel,
      JSON.stringify(errorEntry),
    );
    if (result === null) {
      logger.warn("incrementFailedBatch: progress key missing, skipping update", { syncJobId });
    }
  }

  // -------------------------------------------------------------------------
  // listSyncs — reads job history from BullMQ.
  // -------------------------------------------------------------------------

  async function listSyncs(
    connectorId: string,
    query: ListSyncsOptions,
  ): Promise<ListSyncsResult> {
    const states: Array<"completed" | "failed" | "active"> = ["completed", "failed", "active"];
    // Cap the BullMQ fetch to a reasonable ceiling (default 100, caller may
    // raise via query.limit). The previous 10K cap loaded far more jobs than
    // any single page could display and caused unnecessary memory pressure
    // (V5-126).
    const fetchLimit = Math.min(query.limit * 10, 1_000);
    const jobs = await syncQueue.getJobs(states, 0, fetchLimit);

    const filtered = jobs
      .filter((job) => job.data.connectorId === connectorId)
      .map((job): SyncJobSummary => {
        const finishedOn = job.finishedOn;
        const processedOn = job.processedOn;

        const completedAt =
          finishedOn !== undefined ? new Date(finishedOn).toISOString() : null;
        const startedAt =
          processedOn !== undefined
            ? new Date(processedOn).toISOString()
            : new Date().toISOString();
        const durationMs =
          finishedOn !== undefined && processedOn !== undefined
            ? finishedOn - processedOn
            : null;

        const bullState =
          finishedOn !== undefined
            ? job.failedReason !== undefined
              ? ("failed" as const)
              : ("success" as const)
            : ("running" as const);

        const returnValue = job.returnvalue as Record<string, unknown> | null | undefined;
        const rowsIngested =
          typeof returnValue?.["rowsIngested"] === "number"
            ? returnValue["rowsIngested"]
            : 0;
        const rowsFailed =
          typeof returnValue?.["rowsFailed"] === "number"
            ? returnValue["rowsFailed"]
            : 0;

        return {
          syncJobId: job.id ?? "",
          connectorId,
          status: bullState,
          syncMode: job.data.syncMode,
          startedAt,
          completedAt,
          durationMs,
          rowsIngested,
          rowsFailed,
          error: job.failedReason ?? null,
        };
      });

    const statusFiltered =
      query.filterStatus !== undefined
        ? filtered.filter((item) => item.status === query.filterStatus)
        : filtered;

    let cursorIdx = 0;
    if (query.cursor !== undefined) {
      const found = statusFiltered.findIndex((item) => item.syncJobId === query.cursor);
      if (found === -1) {
        // Cursor not found — the job may have been removed from BullMQ between pages.
        // Return an empty page rather than silently restarting from the beginning.
        return { items: [], nextCursor: null, total: statusFiltered.length };
      }
      cursorIdx = found + 1;
    }

    const page = statusFiltered.slice(cursorIdx, cursorIdx + query.limit);
    const nextCursor =
      cursorIdx + query.limit < statusFiltered.length
        ? (page[page.length - 1]?.syncJobId ?? null)
        : null;

    return { items: page, nextCursor, total: statusFiltered.length };
  }

  // -------------------------------------------------------------------------
  // cancelSync — signals the BullMQ job to stop.
  // -------------------------------------------------------------------------

  async function cancelSync(syncJobId: string): Promise<void> {
    const job = await syncQueue.getJob(syncJobId);
    if (job === undefined) {
      logger.warn("cancelSync: job not found", { syncJobId });
      return;
    }

    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
    }

    // Write a cancelled progress entry so the processor can detect the signal.
    const existing = await getSyncProgress(syncJobId);
    if (existing !== null) {
      await writeProgress({ ...existing, status: "cancelled" });
    }

    logger.info("Sync cancellation requested", { syncJobId });
  }

  // -------------------------------------------------------------------------
  // processSyncJob — worker handler for ingestion:sync queue.
  // Ensures the raw table exists, reads the starting cursor for incremental
  // syncs, then drives the batch pagination loop.
  // -------------------------------------------------------------------------

  async function processSyncJob(job: Job<SyncJobPayload>): Promise<void> {
    const { connectorId, tenantId, syncMode } = job.data;
    const syncJobId = job.id ?? crypto.randomUUID();

    const progress: SyncProgress = {
      syncJobId,
      connectorId,
      tenantId,
      status: "running",
      syncMode,
      totalBatches: 0,
      completedBatches: 0,
      failedBatches: 0,
      totalRecords: 0,
      processedRecords: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastBatchAt: null,
      errors: [],
    };

    await writeProgress(progress);

    try {
      const connector = await connectorRepo.findById(connectorId);
      if (connector === null) {
        throw new ConnectorNotFoundError(
          `Connector ${connectorId} not found during sync.`,
          { connectorId, tenantId },
        );
      }

      // Ensure the raw staging table exists (idempotent — IF NOT EXISTS).
      await rawTableRepo.createRawTable(connectorId);

      // Read the starting cursor for incremental syncs.
      let cursor: string | null = null;
      if (syncMode === "incremental") {
        const syncState = await syncStateRepo.findByConnectorId(connectorId);
        cursor = syncState?.last_cursor ?? null;
      }

      const batchId = crypto.randomUUID();
      let batchSeqNum = 0;
      let totalRecords = 0;

      logger.info("Sync job started", { syncJobId, connectorId, syncMode, cursor });

      async function isCancelled(): Promise<boolean> {
        const current = await getSyncProgress(syncJobId);
        return current?.status === "cancelled";
      }

      // Credential accessor scoped to this sync job — lazy, cached decryption.
      const credentialAccessor = credentialService.createCredentialAccessor(
        connectorId,
        masterKey,
      );
      const credentialFields = await credentialAccessor.list();

      let hasMore = true;
      while (hasMore) {
        if (await isCancelled()) {
          logger.info("Sync cancelled by request", { syncJobId, connectorId });
          await syncStateRepo.updateStatus(connectorId, "cancelled", {
            last_sync_job_id: syncJobId,
          });
          progress.status = "cancelled";
          progress.completedAt = new Date().toISOString();
          await writeProgress(progress);
          return;
        }

        const waiting = await batchQueue.count();
        if (waiting >= BATCH_QUEUE_MAX) {
          throw new QueueFullError(
            "ingestion:batch queue at capacity — sync will retry.",
            { queueDepth: waiting },
          );
        }

        // Invoke the connector's fetchBatch method via the Execution Service.
        // The Execution Service runs the connector plugin in a sandbox and
        // returns the raw records + next cursor.
        const payload = {
          pluginId: connector.plugin_id,
          instanceId: connector.instance_id,
          tenantId,
          method: "fetchBatch" as const,
          config: connector.config,
          credentialBundleId: connectorId,
          credentialFields,
          cursor,
          syncMode,
          timeoutMs: 60_000,
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 65_000);
        let fetchResponse: Response;
        try {
          fetchResponse = await fetch(
            `${executionServiceUrl}/internal/execution/run`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: controller.signal,
            },
          );
        } finally {
          clearTimeout(timer);
        }

        if (!fetchResponse.ok) {
          const errBody = await fetchResponse.json().catch(() => ({})) as Record<string, unknown>;
          const errMsg =
            typeof errBody["message"] === "string"
              ? errBody["message"]
              : `Execution service returned HTTP ${fetchResponse.status}`;
          throw new Error(errMsg);
        }

        const batchResult = (await fetchResponse.json()) as FetchBatchResponse;
        const { records, nextCursor, hasMore: moreRecords } = batchResult;

        if (records.length > 0) {
          // Raw table writes are performed exclusively by processBatchJob to
          // prevent double-writes. processSyncJob is responsible only for
          // pagination and job dispatch; processBatchJob owns persistence.
          totalRecords += records.length;
          batchSeqNum += 1;
          progress.totalRecords = totalRecords;
          progress.totalBatches = batchSeqNum;
          progress.lastBatchAt = new Date().toISOString();
          await writeProgress(progress);

          // Measure records size before deciding inline vs file storage.
          // JSON.stringify once here; we reuse the string for inline payloads
          // to avoid serialising twice.
          const recordsJson = JSON.stringify(records);
          const recordsBytes = Buffer.byteLength(recordsJson, "utf8");

          let jobPayload: BatchJobPayload;

          if (recordsBytes >= BATCH_PAYLOAD_THRESHOLD) {
            // Write records to a temp file to keep the Redis payload small.
            // The file name embeds the sync job ID and batch sequence number so
            // it is unique across concurrent syncs and easy to trace in logs.
            const tmpFile = pathJoin(
              tmpdir(),
              `op-batch-${syncJobId}-${batchSeqNum}-${Date.now()}.json`,
            );
            await writeFile(tmpFile, recordsJson, "utf8");

            logger.info("Batch records offloaded to temp file to protect Redis memory", {
              syncJobId,
              connectorId,
              batchSeqNum,
              recordCount: records.length,
              recordsBytes,
              threshold: BATCH_PAYLOAD_THRESHOLD,
              tmpFile,
            });

            jobPayload = {
              syncJobId,
              connectorId,
              tenantId,
              batchId,
              batchSeqNum,
              syncMode,
              cursor,
              recordCount: records.length,
              recordsFile: tmpFile,
            };
          } else {
            jobPayload = {
              syncJobId,
              connectorId,
              tenantId,
              batchId,
              batchSeqNum,
              syncMode,
              cursor,
              recordCount: records.length,
              records,
            };
          }

          await batchQueue.add("batch", jobPayload);
        }

        cursor = nextCursor;
        hasMore = moreRecords;

        // Update cursor in sync_state after each successful batch so that a
        // crash mid-sync resumes from the last committed position.
        if (cursor !== null) {
          await syncStateRepo.updateCursor(connectorId, cursor);
        }
      }

      // For full sync mode: soft-delete records not in the current batchId.
      if (syncMode === "full" && batchSeqNum > 0) {
        await rawTableRepo.softDeleteNotInBatch(connectorId, batchId);
        logger.info("Full sync stale records soft-deleted", {
          syncJobId,
          connectorId,
          batchId,
        });
      }

      await syncStateRepo.updateStatus(connectorId, "success", {
        last_sync_at: new Date(),
        last_sync_job_id: syncJobId,
        ...(cursor !== null ? { last_cursor: cursor } : {}),
      });

      progress.status = "success";
      progress.completedAt = new Date().toISOString();
      await writeProgress(progress);

      logger.info("Sync job completed", {
        syncJobId,
        connectorId,
        totalRecords,
        totalBatches: batchSeqNum,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      await syncStateRepo.updateStatus(connectorId, "failed", {
        last_error: message,
        last_sync_job_id: syncJobId,
      });

      progress.status = "failed";
      progress.completedAt = new Date().toISOString();
      progress.errors.push({
        batchId: "sync",
        message,
        // Use err.code from AppError for machine-readable codes; fall back to
        // the error name only for non-AppError throws (e.g. network errors).
        code: err instanceof AppError ? err.code : (err instanceof Error ? err.name : "UNKNOWN"),
        recordCount: 0,
      });
      await writeProgress(progress);

      logger.error("Sync job failed", { syncJobId, connectorId, error: message });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // processBatchJob — upserts records to the raw table and enqueues the
  // ontology:map job. Each batch is idempotent via ON CONFLICT (_id) DO UPDATE.
  // -------------------------------------------------------------------------

  async function processBatchJob(job: Job<BatchJobPayload>): Promise<void> {
    const {
      syncJobId,
      connectorId,
      tenantId,
      batchId,
      batchSeqNum,
      syncMode,
      cursor,
    } = job.data;

    // Resolve records from inline payload or temp file.
    // The file is always deleted after processing (success or failure) to avoid
    // orphaned temp files from crashes. We track the path here so the catch
    // block can also delete it on failure.
    const recordsFile = job.data.recordsFile;
    let records: DataRecord[];

    if (recordsFile !== undefined) {
      try {
        const fileContent = await readFile(recordsFile, "utf8");
        records = JSON.parse(fileContent) as DataRecord[];
      } catch (readErr) {
        // File missing or corrupt — this is unrecoverable; throw so BullMQ retries
        throw new Error(
          `processBatchJob: failed to read records from temp file "${recordsFile}": ` +
            (readErr instanceof Error ? readErr.message : String(readErr)),
        );
      }
    } else if (job.data.records !== undefined) {
      records = job.data.records;
    } else {
      throw new Error(
        `processBatchJob: batch job payload is missing both 'records' and 'recordsFile'. ` +
          `syncJobId=${syncJobId} batchSeqNum=${batchSeqNum}`,
      );
    }

    try {
      const connector = await connectorRepo.findById(connectorId);
      if (connector === null) {
        throw new ConnectorNotFoundError(
          `Connector ${connectorId} not found during batch processing.`,
          { connectorId },
        );
      }

      const envelopes = records.map((record) =>
        normalizeToEnvelope(record, {
          connectorId,
          connectorName: connector.name,
          batchId,
          tenantId,
          syncMode,
          cursor,
        }),
      );

      await rawTableRepo.insertBatch(connectorId, envelopes);

      // Schema drift detection runs after the raw insert so it never delays
      // persistence. captureAndDetect swallows all errors internally and
      // returns an empty diff on failure, so the batch job is never blocked.
      if (schemaDriftService !== undefined) {
        const rawRecords = records.map((r) => r.data);
        const drift = await schemaDriftService.captureAndDetect(connectorId, rawRecords);

        if (drift.hasDrift) {
          // Publish to Redis so any subscriber (pipeline, alerting, SSE stream)
          // can react without polling the database.
          await redis.publish(
            "ingestion.schema.drift.detected",
            JSON.stringify({
              connectorId,
              tenantId,
              syncJobId,
              batchId,
              drift,
            }),
          );
        }
      }

      // Data quality analysis runs after the raw insert and schema drift check.
      // The entire block is fire-and-forget (void promise) — a quality check
      // failure must never fail the batch job. Issues are logged and published
      // to Redis for downstream alerting without blocking the critical path.
      if (dataQualityService !== undefined) {
        void (async () => {
          try {
            const previousStats = await dataQualityService.getStats(connectorId);
            const report = dataQualityService.analyzeBatch(connectorId, records, previousStats);

            if (report.issues.length > 0) {
              logger.warn("Data quality issues detected", {
                connectorId,
                tenantId,
                syncJobId,
                batchId,
                batchSeqNum,
                score: report.score,
                issueCount: report.issues.length,
                issues: report.issues,
              });

              await redis.publish(
                "ingestion.quality.issues.detected",
                JSON.stringify({
                  connectorId,
                  tenantId,
                  syncJobId,
                  batchId,
                  batchSeqNum,
                  score: report.score,
                  issues: report.issues,
                }),
              );
            }

            await dataQualityService.updateStats(connectorId, report, previousStats);
          } catch (qualityErr) {
            // Log but do not rethrow — quality analysis must never block ingestion.
            logger.error("Data quality analysis failed", {
              connectorId,
              batchId,
              error: qualityErr instanceof Error ? qualityErr.message : String(qualityErr),
            });
          }
        })();
      }

      try {
        await ontologyQueue.add("map", {
          connectorId,
          batchId,
          tenantId,
          batchSeqNum,
        });
      } catch (ontologyErr) {
        logger.error("Failed to enqueue ontology:map job after successful batch insert", {
          syncJobId,
          connectorId,
          batchId,
          batchSeqNum,
          error: ontologyErr instanceof Error ? ontologyErr.message : String(ontologyErr),
        });
      }

      await incrementBatchProgress(syncJobId, records.length);

      // Clean up temp file after successful processing.
      if (recordsFile !== undefined) {
        await unlink(recordsFile).catch((unlinkErr) => {
          // Non-fatal — log and continue. The file will be cleaned up by OS
          // on next restart or by a periodic temp file sweeper.
          logger.warn("processBatchJob: failed to delete temp records file", {
            recordsFile,
            error: unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr),
          });
        });
      }

      logger.info("Batch job completed", {
        syncJobId,
        connectorId,
        batchId,
        batchSeqNum,
        recordCount: records.length,
        ...(recordsFile !== undefined ? { recordsFile } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      await incrementFailedBatch(syncJobId, {
        batchId,
        message,
        code: err instanceof AppError ? err.code : (err instanceof Error ? err.name : "UNKNOWN"),
        recordCount: records.length,
      });

      // Do NOT delete the temp file on failure. BullMQ will retry this job
      // using the same recordsFile path; deleting it here would make every
      // subsequent attempt throw ENOENT and fail permanently. The file is
      // deleted only on the success path above.

      logger.error("Batch job failed", {
        syncJobId,
        connectorId,
        batchId,
        batchSeqNum,
        error: message,
      });
      throw err;
    }
  }

  // Default stale threshold: 15 minutes. A sync job that has been 'running'
  // for longer than this without a progress update is almost certainly dead
  // (process crashed or BullMQ worker never picked it up).
  const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1_000;

  // -------------------------------------------------------------------------
  // runWatchdog — delegates to the exported executeWatchdog function so the
  // watchdog logic remains testable without constructing BullMQ queues.
  // -------------------------------------------------------------------------

  function runWatchdog(staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS): Promise<number> {
    return executeWatchdog(syncStateRepo, logger, staleThresholdMs);
  }

  return {
    triggerSync,
    getSyncProgress,
    listSyncs,
    cancelSync,
    processSyncJob,
    processBatchJob,
    runWatchdog,
  };
}
