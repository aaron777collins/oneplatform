import { Queue, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { AppError } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
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

// ---------------------------------------------------------------------------
// Raw table repository interface — matches the concrete RawTableRepository.
// ---------------------------------------------------------------------------

export interface RawTableRepository {
  createRawTable(connectorId: string): Promise<void>;
  insertBatch(connectorId: string, envelopes: ReturnType<typeof normalizeToEnvelope>[]): Promise<void>;
  upsertBatch(tableName: string, envelopes: ReturnType<typeof normalizeToEnvelope>[]): Promise<void>;
  softDeleteNotInBatch(connectorId: string, currentBatchId: string): Promise<number>;
  deleteOlderThan(connectorId: string, olderThan: Date): Promise<number>;
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
  // recordCount is stored for metrics/logging; actual records are fetched from
  // the staging table by processBatchJob rather than carried in the payload.
  // Storing full record arrays in BullMQ payloads bloats Redis memory and risks
  // hitting the 512 MB default limit on large syncs.
  recordCount: number;
  records: DataRecord[];
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
}

// BullMQ queue capacity guard. Exceeding this triggers QueueFullError so the
// sync job reschedules itself rather than flooding the workers.
const BATCH_QUEUE_MAX = 50_000;

// Progress Redis key TTL applied once a sync reaches a terminal state.
// Matches BullMQ removeOnComplete age (7 days) so progress keys expire
// around the same time as the underlying BullMQ job data.
const PROGRESS_TERMINAL_TTL_SECONDS = 604_800;

const redisUrl = process.env["OP_REDIS_URL"] ?? "redis://localhost:6379";

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
  } = deps;

  const executionServiceUrl =
    deps.executionServiceUrl ??
    process.env["EXECUTION_SERVICE_URL"] ??
    "http://execution-service:3005";

  // Queues are created lazily once — constructed at module level but connected
  // on first use. This defers connection errors to the first actual enqueue,
  // not service startup, which is the BullMQ recommended pattern.
  const syncQueue = new Queue<SyncJobPayload>("ingestion:sync", {
    connection: { lazyConnect: true, url: redisUrl },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 604_800 },
      removeOnFail: { age: 2_592_000 },
    },
  });

  const batchQueue = new Queue<BatchJobPayload>("ingestion:batch", {
    connection: { lazyConnect: true, url: redisUrl },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
  });

  const ontologyQueue = new Queue("ontology:map", {
    connection: { lazyConnect: true, url: redisUrl },
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

  // -------------------------------------------------------------------------
  // listSyncs — reads job history from BullMQ.
  // -------------------------------------------------------------------------

  async function listSyncs(
    connectorId: string,
    query: ListSyncsOptions,
  ): Promise<ListSyncsResult> {
    const states: Array<"completed" | "failed" | "active"> = ["completed", "failed", "active"];
    // BullMQ returns jobs newest-first. We fetch up to 10,000 to ensure the
    // cursor-based page window can reach any historical job. Fetching only 100
    // (the old limit) meant jobs beyond position 100 were unreachable regardless
    // of the cursor the caller supplied.
    const jobs = await syncQueue.getJobs(states, 0, 10_000);

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

    const cursorIdx =
      query.cursor !== undefined
        ? statusFiltered.findIndex((item) => item.syncJobId === query.cursor) + 1
        : 0;

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

          const jobPayload: BatchJobPayload = {
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

          // Guard against Redis memory exhaustion from oversized payloads.
          // Batches over 1 MB indicate a connector returning excessively large
          // records; fail loudly so the issue is caught early rather than
          // silently bloating the queue.
          const payloadBytes = Buffer.byteLength(JSON.stringify(jobPayload), "utf8");
          if (payloadBytes > 1_048_576) {
            logger.error("Batch job payload exceeds 1 MB — aborting sync to protect Redis memory", {
              syncJobId,
              connectorId,
              batchSeqNum,
              payloadBytes,
              recordCount: records.length,
            });
            throw new Error(
              `Batch payload too large: ${payloadBytes} bytes (${records.length} records). ` +
              "Reduce connector batch size to keep BullMQ payloads under 1 MB.",
            );
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
      records,
    } = job.data;

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

      await ontologyQueue.add("map", {
        connectorId,
        batchId,
        tenantId,
        batchSeqNum,
      });

      const progressData = await getSyncProgress(syncJobId);
      if (progressData !== null) {
        await writeProgress({
          ...progressData,
          completedBatches: progressData.completedBatches + 1,
          processedRecords: progressData.processedRecords + records.length,
          lastBatchAt: new Date().toISOString(),
        });
      }

      logger.info("Batch job completed", {
        syncJobId,
        connectorId,
        batchId,
        batchSeqNum,
        recordCount: records.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      const progressData = await getSyncProgress(syncJobId);
      if (progressData !== null) {
        await writeProgress({
          ...progressData,
          failedBatches: progressData.failedBatches + 1,
          errors: [
            ...progressData.errors,
            {
              batchId,
              message,
              code: err instanceof AppError ? err.code : (err instanceof Error ? err.name : "UNKNOWN"),
              recordCount: records.length,
            },
          ],
        });
      }

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
