// Reconciliation service — compares records in the source system against
// records that have been ingested into the platform raw table. Discrepancies
// are surfaced as a ReconciliationReport so operators can identify data gaps
// without running a full re-sync.
//
// Design rationale:
//   - Async job pattern: reconciliation is always enqueued and returns a job ID.
//     The caller polls /reconciliation-reports/:jobId to retrieve results.
//     This avoids HTTP timeouts on large datasets and follows the same pattern
//     as triggerSync in sync-service.ts.
//   - Sampling: field-value comparison is limited to a configurable sample to
//     prevent full table scans on production connectors with millions of rows.
//     Sampling is deterministic (ordered by _source_id) so repeated runs on
//     unchanged data produce stable reports.
//   - Source fetch: uses the Execution Service /internal/execution/run with
//     method "reconcileList" to ask the connector plugin for its current IDs.
//     Connectors that do not implement reconcileList fall back to a full
//     fetchBatch pass, which is capped at MAX_RECONCILE_FETCH_PAGES.
//   - executeReconcileJob is exported as a standalone function (matching the
//     executeWatchdog pattern in sync-service.ts) so unit tests can exercise
//     the full reconciliation logic without constructing a BullMQ Queue.

import { Queue, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { bullmqConnection } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
import type { ConnectorRepository } from "./connector-service.js";
import type { CredentialService } from "./credential-service.js";
import { ConnectorNotFoundError } from "./errors.js";
import type { DataRecord } from "../utils/data-envelope.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  /** Number of records to compare field-by-field. Defaults to 100. */
  sampleSize?: number;
  /** Specific field names to compare. When omitted, all fields are compared. */
  fields?: string[];
  /** Field in the source record used as the stable record identifier. */
  idField: string;
}

export interface FieldMismatch {
  recordId: string;
  field: string;
  sourceValue: unknown;
  platformValue: unknown;
}

export interface ReconciliationReport {
  /** Job ID assigned when the reconciliation was triggered. */
  jobId: string;
  connectorId: string;
  timestamp: string;
  sourceCount: number;
  platformCount: number;
  /** Source record IDs that exist in the source but not in the platform. */
  missingInPlatform: string[];
  /** Platform record IDs that exist in the platform but not in the source. */
  extraInPlatform: string[];
  fieldMismatches: FieldMismatch[];
  /** Percentage of sampled records that matched on all compared fields (0–100). */
  matchRate: number;
  status: "match" | "partial_match" | "mismatch";
}

export interface ReconcileJobPayload {
  jobId: string;
  connectorId: string;
  tenantId: string;
  options: Required<ReconcileOptions>;
}

export interface TriggerReconcileResult {
  jobId: string;
  status: "queued";
}

export interface ReconciliationService {
  /** Enqueue a reconciliation job and return the job ID immediately. */
  triggerReconcile(
    connectorId: string,
    tenantId: string,
    options: ReconcileOptions,
  ): Promise<TriggerReconcileResult>;

  /** Retrieve a completed or in-progress report by job ID. */
  getReport(jobId: string): Promise<ReconciliationReport | null>;

  /** List stored reports for a connector, newest first. */
  listReports(connectorId: string, query: { limit: number; cursor?: string }): Promise<{
    items: ReconciliationReport[];
    nextCursor: string | null;
    total: number;
  }>;

  /** Worker handler — delegates to executeReconcileJob. */
  processReconcileJob(job: Job<ReconcileJobPayload>): Promise<void>;
}

export interface ReconciliationReportRepository {
  save(report: ReconciliationReport): Promise<void>;
  findByJobId(jobId: string): Promise<ReconciliationReport | null>;
  findByConnectorId(
    connectorId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: ReconciliationReport[]; total: number }>;
}

// Exposes only the methods the reconciliation service needs from RawTableRepository
// to keep the dependency surface minimal.
export interface RawRecordReader {
  /** Returns the total count of non-deleted rows for this connector. */
  count(connectorId: string): Promise<number>;
  /**
   * Returns all _source_id values for non-deleted rows of this connector.
   * Used for ID set comparison; a separate sample query fetches field values.
   */
  listSourceIds(connectorId: string): Promise<string[]>;
  /**
   * Returns a deterministic sample of at most `limit` records ordered by
   * _source_id, restricted to the given source IDs when provided.
   */
  sampleRecords(
    connectorId: string,
    limit: number,
    sourceIds?: string[],
  ): Promise<Array<{ sourceId: string; data: Record<string, unknown> }>>;
}

export interface ReconciliationServiceDeps {
  connectorRepo: ConnectorRepository;
  credentialService: CredentialService;
  rawRecordReader: RawRecordReader;
  reportRepo: ReconciliationReportRepository;
  redis: Redis;
  masterKey: Buffer;
  logger: Logger;
  executionServiceUrl?: string;
  /** Redis URL for BullMQ queues. Falls back to OP_REDIS_URL env var. */
  redisUrl?: string;
}

// Deps required by the standalone executeReconcileJob function. Separated so
// unit tests can call it directly without constructing the full service.
export interface ExecuteReconcileJobDeps {
  connectorRepo: ConnectorRepository;
  credentialService: CredentialService;
  rawRecordReader: RawRecordReader;
  reportRepo: ReconciliationReportRepository;
  redis: Redis;
  masterKey: Buffer;
  logger: Logger;
  executionServiceUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Redis key TTL for report entries. Reports are also persisted in the DB;
// the Redis copy serves as a fast-path for polling requests.
const REPORT_REDIS_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Maximum pages to iterate during a fallback fetchBatch reconciliation.
// Each page is typically 100–500 records; 200 pages ≈ up to 100 k source IDs.
const MAX_RECONCILE_FETCH_PAGES = 200;

const DEFAULT_SAMPLE_SIZE = 100;

const DEFAULT_REDIS_URL = process.env["OP_REDIS_URL"] ?? "redis://localhost:6379";

// ---------------------------------------------------------------------------
// executeReconcileJob — standalone export matching the executeWatchdog pattern.
//
// Decoupled from the full ReconciliationService so tests can exercise the
// entire reconciliation algorithm without constructing a BullMQ Queue.
// createReconciliationService delegates its processReconcileJob to this function.
// ---------------------------------------------------------------------------

export async function executeReconcileJob(
  job: Job<ReconcileJobPayload>,
  deps: ExecuteReconcileJobDeps,
): Promise<void> {
  const {
    connectorRepo,
    credentialService,
    rawRecordReader,
    reportRepo,
    redis,
    masterKey,
    logger,
    executionServiceUrl,
  } = deps;

  const { jobId, connectorId, tenantId, options } = job.data;

  logger.info("Reconciliation started", { jobId, connectorId });

  const connector = await connectorRepo.findById(connectorId);
  if (connector === null) {
    throw new ConnectorNotFoundError(
      `Connector ${connectorId} not found during reconciliation.`,
      { connectorId, tenantId },
    );
  }

  // --- Step 1: collect source record IDs via Execution Service ---

  const credentialAccessor = credentialService.createCredentialAccessor(
    connectorId,
    masterKey,
  );
  const credentialFields = await credentialAccessor.list();

  const sourceIds = await fetchSourceIds({
    connector,
    tenantId,
    credentialFields,
    executionServiceUrl,
    idField: options.idField,
    logger,
  });

  // --- Step 2: collect platform record IDs from raw table ---

  const platformSourceIds = await rawRecordReader.listSourceIds(connectorId);
  const platformCount = platformSourceIds.length;
  const sourceCount = sourceIds.length;

  // --- Step 3: ID set comparison ---

  const sourceSet = new Set(sourceIds);
  const platformSet = new Set(platformSourceIds);

  const missingInPlatform: string[] = [];
  for (const id of sourceSet) {
    if (!platformSet.has(id)) missingInPlatform.push(id);
  }

  const extraInPlatform: string[] = [];
  for (const id of platformSet) {
    if (!sourceSet.has(id)) extraInPlatform.push(id);
  }

  // --- Step 4: field-value comparison on a deterministic sample ---

  // Intersection: IDs present in both — only these can have field mismatches.
  const commonIds: string[] = [];
  for (const id of sourceSet) {
    if (platformSet.has(id)) commonIds.push(id);
  }

  const sampleIds = commonIds.slice(0, options.sampleSize);

  const fieldMismatches: FieldMismatch[] = [];

  if (sampleIds.length > 0) {
    // Fetch source records for the sample via execution service.
    const sourceRecords = await fetchSourceRecords({
      connector,
      tenantId,
      credentialFields,
      executionServiceUrl,
      sampleIds,
      idField: options.idField,
      logger,
    });

    // Fetch platform records for the same sample IDs.
    const platformRecords = await rawRecordReader.sampleRecords(
      connectorId,
      options.sampleSize,
      sampleIds,
    );

    const platformBySourceId = new Map(
      platformRecords.map((r) => [r.sourceId, r.data]),
    );

    const fieldsToCompare =
      options.fields.length > 0 ? new Set(options.fields) : null;

    for (const sourceRecord of sourceRecords) {
      const recordId = String(sourceRecord.data[options.idField] ?? sourceRecord.sourceId);
      const platformData = platformBySourceId.get(sourceRecord.sourceId);
      if (platformData === undefined) continue;

      const allFields =
        fieldsToCompare !== null
          ? [...fieldsToCompare]
          : [...new Set([...Object.keys(sourceRecord.data), ...Object.keys(platformData)])];

      for (const field of allFields) {
        const sourceValue = sourceRecord.data[field];
        const platformValue = platformData[field];

        // JSON serialization comparison handles nested objects and arrays
        // without deep-equality complexity; edge-case: undefined vs absent key.
        if (!valuesEqual(sourceValue, platformValue)) {
          fieldMismatches.push({ recordId, field, sourceValue, platformValue });
        }
      }
    }
  }

  // --- Step 5: compute match rate and overall status ---

  const matchRate = computeMatchRate({
    sampleSize: sampleIds.length,
    fieldMismatches,
    missingInPlatform,
    extraInPlatform,
    sourceCount,
    platformCount,
  });

  const status = deriveStatus(missingInPlatform, extraInPlatform, fieldMismatches);

  const report: ReconciliationReport = {
    jobId,
    connectorId,
    timestamp: new Date().toISOString(),
    sourceCount,
    platformCount,
    missingInPlatform,
    extraInPlatform,
    fieldMismatches,
    matchRate,
    status,
  };

  // Persist in DB first, then write Redis for fast polling.
  await reportRepo.save(report);
  await redis.set(redisReportKey(jobId), JSON.stringify(report), "EX", REPORT_REDIS_TTL_SECONDS);

  logger.info("Reconciliation completed", {
    jobId,
    connectorId,
    sourceCount,
    platformCount,
    missingInPlatform: missingInPlatform.length,
    extraInPlatform: extraInPlatform.length,
    fieldMismatches: fieldMismatches.length,
    matchRate,
    status,
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReconciliationService(
  deps: ReconciliationServiceDeps,
): ReconciliationService {
  const {
    connectorRepo,
    credentialService,
    rawRecordReader,
    reportRepo,
    redis,
    masterKey,
    logger,
  } = deps;

  const executionServiceUrl =
    deps.executionServiceUrl ??
    process.env["EXECUTION_SERVICE_URL"] ??
    "http://execution-service:3000";

  // Derive BullMQ Redis URL from the injected dependency, falling back to the
  // module-level default.
  const redisUrl = deps.redisUrl ?? DEFAULT_REDIS_URL;

  const reconcileQueue = new Queue<ReconcileJobPayload>("ingestion.reconcile", {
    connection: { ...bullmqConnection(redisUrl), lazyConnect: true },
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: REPORT_REDIS_TTL_SECONDS },
      removeOnFail: { age: REPORT_REDIS_TTL_SECONDS },
    },
  });

  const jobDeps: ExecuteReconcileJobDeps = {
    connectorRepo,
    credentialService,
    rawRecordReader,
    reportRepo,
    redis,
    masterKey,
    logger,
    executionServiceUrl,
  };

  // -------------------------------------------------------------------------
  // triggerReconcile
  // -------------------------------------------------------------------------

  async function triggerReconcile(
    connectorId: string,
    tenantId: string,
    options: ReconcileOptions,
  ): Promise<TriggerReconcileResult> {
    if (!connectorId) {
      throw new Error("triggerReconcile: connectorId is required");
    }
    if (!options.idField) {
      throw new Error("triggerReconcile: options.idField is required");
    }

    const connector = await connectorRepo.findById(connectorId);
    if (connector === null || connector.tenant_id !== tenantId) {
      throw new ConnectorNotFoundError(
        `Connector ${connectorId} not found.`,
        { connectorId, tenantId },
      );
    }

    const normalized: Required<ReconcileOptions> = {
      sampleSize: options.sampleSize ?? DEFAULT_SAMPLE_SIZE,
      fields: options.fields ?? [],
      idField: options.idField,
    };

    const jobId = crypto.randomUUID();

    await reconcileQueue.add(
      "reconcile",
      { jobId, connectorId, tenantId, options: normalized },
      // Stable job ID so duplicate requests for the same UUID are deduplicated
      // by BullMQ (jobId is used as the BullMQ job ID, not a separate field).
      { jobId },
    );

    logger.info("Reconciliation enqueued", { jobId, connectorId, tenantId });

    return { jobId, status: "queued" };
  }

  // -------------------------------------------------------------------------
  // getReport — Redis fast-path, falls back to DB
  // -------------------------------------------------------------------------

  async function getReport(jobId: string): Promise<ReconciliationReport | null> {
    const key = redisReportKey(jobId);
    const raw = await redis.get(key);
    if (raw !== null) {
      try {
        return JSON.parse(raw) as ReconciliationReport;
      } catch {
        logger.warn("Failed to parse reconciliation report from Redis", { jobId });
      }
    }
    return reportRepo.findByJobId(jobId);
  }

  // -------------------------------------------------------------------------
  // listReports
  // -------------------------------------------------------------------------

  async function listReports(
    connectorId: string,
    query: { limit: number; cursor?: string },
  ): Promise<{ items: ReconciliationReport[]; nextCursor: string | null; total: number }> {
    if (query.limit < 1 || query.limit > 100) {
      throw new Error("listReports: limit must be between 1 and 100");
    }

    const result = await reportRepo.findByConnectorId(connectorId, query);

    const nextCursor =
      result.items.length === query.limit
        ? (result.items[result.items.length - 1]?.jobId ?? null)
        : null;

    return { items: result.items, nextCursor, total: result.total };
  }

  // -------------------------------------------------------------------------
  // processReconcileJob — delegates to executeReconcileJob so the core
  // reconciliation logic can be tested independently of Queue construction.
  // -------------------------------------------------------------------------

  function processReconcileJob(job: Job<ReconcileJobPayload>): Promise<void> {
    return executeReconcileJob(job, jobDeps);
  }

  return {
    triggerReconcile,
    getReport,
    listReports,
    processReconcileJob,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing without constructing the service
// ---------------------------------------------------------------------------

export function computeMatchRate(params: {
  sampleSize: number;
  fieldMismatches: FieldMismatch[];
  missingInPlatform: string[];
  extraInPlatform: string[];
  sourceCount: number;
  platformCount: number;
}): number {
  const { sampleSize, fieldMismatches, missingInPlatform, extraInPlatform, sourceCount } = params;

  // No source records — perfectly empty on both sides means 100 %.
  if (sourceCount === 0) return 100;

  // ID-level discrepancies reduce the rate based on proportion of missing records.
  const missingProportion = missingInPlatform.length / sourceCount;
  const extraProportion =
    params.platformCount > 0 ? extraInPlatform.length / params.platformCount : 0;
  const idPenalty = (missingProportion + extraProportion) / 2;

  // Field-level discrepancies are counted per (record × field) pair, capped by
  // the total fields that could have been compared in the sample.
  let fieldPenalty = 0;
  if (sampleSize > 0 && fieldMismatches.length > 0) {
    // Count unique records with at least one mismatch — one bad record does not
    // count as many penalties as it has mismatched fields.
    const mismatchedRecords = new Set(fieldMismatches.map((m) => m.recordId)).size;
    fieldPenalty = mismatchedRecords / sampleSize;
  }

  const combined = idPenalty + fieldPenalty;
  const rate = Math.max(0, Math.min(100, (1 - combined) * 100));
  return Math.round(rate * 100) / 100;
}

export function deriveStatus(
  missingInPlatform: string[],
  extraInPlatform: string[],
  fieldMismatches: FieldMismatch[],
): "match" | "partial_match" | "mismatch" {
  const hasDiscrepancies =
    missingInPlatform.length > 0 ||
    extraInPlatform.length > 0 ||
    fieldMismatches.length > 0;

  if (!hasDiscrepancies) return "match";

  // "mismatch" only when we have both missing AND extra records (data replaced
  // without delete+insert) or a substantial number of field mismatches.
  const severeIdDiscrepancy =
    missingInPlatform.length > 0 && extraInPlatform.length > 0;
  const manyFieldMismatches = fieldMismatches.length > 10;

  if (severeIdDiscrepancy || manyFieldMismatches) return "mismatch";

  return "partial_match";
}

// Stable equality: serialize to JSON for structural comparison. undefined
// values in objects serialize to absent keys, so {a: undefined} === {}.
// This is intentional — it matches how the pg JSONB driver round-trips values.
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object" && typeof b !== "object") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Internal helpers — side-effectful, not exported
// ---------------------------------------------------------------------------

function redisReportKey(jobId: string): string {
  return `ingestion:reconcile:${jobId}:report`;
}

interface ConnectorLike {
  id: string;
  plugin_id: string;
  instance_id: string;
  config: Record<string, unknown>;
}

interface FetchSourceIdsParams {
  connector: ConnectorLike;
  tenantId: string;
  credentialFields: string[];
  executionServiceUrl: string;
  idField: string;
  logger: Logger;
}

// fetchSourceIds calls the connector plugin via the Execution Service.
// It first attempts the "reconcileList" method which connectors can implement
// to return IDs cheaply. If that method is unavailable (HTTP 400/404) it falls
// back to paginating fetchBatch and extracting the idField from each record.
async function fetchSourceIds(params: FetchSourceIdsParams): Promise<string[]> {
  const { connector, tenantId, credentialFields, executionServiceUrl, idField, logger } = params;

  // Try the dedicated reconcileList method first.
  // credentialBundleId must be the connector's primary key (id) — this is how
  // the credential vault keys its entries, matching sync-service.ts line 718.
  const listResponse = await callExecution(executionServiceUrl, {
    pluginId: connector.plugin_id,
    instanceId: connector.instance_id,
    tenantId,
    method: "reconcileList",
    config: connector.config,
    credentialBundleId: connector.id,
    credentialFields,
  });

  if (listResponse.ok) {
    const body = await listResponse.json() as { ids?: unknown[] };
    if (Array.isArray(body.ids)) {
      return body.ids.map(String);
    }
  }

  // reconcileList not supported — fall back to paginating fetchBatch.
  // Log at debug rather than warn: most connectors won't implement reconcileList.
  logger.debug("reconcileList not supported by connector — falling back to fetchBatch pagination", {
    pluginId: connector.plugin_id,
  });

  const ids: string[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (page < MAX_RECONCILE_FETCH_PAGES) {
    const res = await callExecution(executionServiceUrl, {
      pluginId: connector.plugin_id,
      instanceId: connector.instance_id,
      tenantId,
      method: "fetchBatch",
      config: connector.config,
      credentialBundleId: connector.id,
      credentialFields,
      cursor,
      syncMode: "full",
      timeoutMs: 60_000,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
      const msg = typeof errBody["message"] === "string"
        ? errBody["message"]
        : `Execution service returned HTTP ${res.status} during reconcile fetchBatch`;
      throw new Error(msg);
    }

    const batch = await res.json() as { records: DataRecord[]; nextCursor: string | null; hasMore: boolean };

    for (const record of batch.records) {
      const id = record.data[idField] !== undefined
        ? String(record.data[idField])
        : record.sourceId;
      ids.push(id);
    }

    page += 1;

    if (!batch.hasMore) break;
    cursor = batch.nextCursor;
  }

  return ids;
}

interface FetchSourceRecordsParams {
  connector: ConnectorLike;
  tenantId: string;
  credentialFields: string[];
  executionServiceUrl: string;
  sampleIds: string[];
  idField: string;
  logger: Logger;
}

// fetchSourceRecords asks the connector plugin for the full record data of
// a specific set of IDs. Uses the "fetchRecords" method when available;
// falls back to filtering from a fetchBatch pass over the full dataset
// when the connector does not implement fetchRecords.
async function fetchSourceRecords(params: FetchSourceRecordsParams): Promise<DataRecord[]> {
  const { connector, tenantId, credentialFields, executionServiceUrl, sampleIds, idField, logger } = params;

  // Try the targeted fetchRecords method first.
  // credentialBundleId must be the connector's primary key (id) — this is how
  // the credential vault keys its entries, matching sync-service.ts line 718.
  const res = await callExecution(executionServiceUrl, {
    pluginId: connector.plugin_id,
    instanceId: connector.instance_id,
    tenantId,
    method: "fetchRecords",
    config: connector.config,
    credentialBundleId: connector.id,
    credentialFields,
    recordIds: sampleIds,
    timeoutMs: 60_000,
  });

  if (res.ok) {
    const body = await res.json() as { records?: DataRecord[] };
    if (Array.isArray(body.records)) {
      return body.records;
    }
  }

  // fetchRecords not supported — fall back to fetchBatch pagination to collect
  // the sample records. When neither method works the sample is empty and
  // fieldMismatches stays [].
  logger.debug("fetchRecords not supported by connector — scanning via fetchBatch for sample", {
    pluginId: connector.plugin_id,
  });

  const sampleSet = new Set(sampleIds);
  let cursor: string | null = null;
  const records: DataRecord[] = [];
  let page = 0;

  while (page < MAX_RECONCILE_FETCH_PAGES && records.length < sampleIds.length) {
    const batchRes = await callExecution(executionServiceUrl, {
      pluginId: connector.plugin_id,
      instanceId: connector.instance_id,
      tenantId,
      method: "fetchBatch",
      config: connector.config,
      credentialBundleId: connector.id,
      credentialFields,
      cursor,
      syncMode: "full",
      timeoutMs: 60_000,
    });

    if (!batchRes.ok) break;

    const batch = await batchRes.json() as { records: DataRecord[]; nextCursor: string | null; hasMore: boolean };

    for (const record of batch.records) {
      const id = record.data[idField] !== undefined
        ? String(record.data[idField])
        : record.sourceId;
      if (sampleSet.has(id)) {
        records.push(record);
      }
    }

    page += 1;

    if (!batch.hasMore) break;
    cursor = batch.nextCursor;
  }

  return records;
}

// callExecution is a thin wrapper around the Execution Service HTTP call,
// adding a 65-second hard timeout to match the sync-service pattern.
async function callExecution(
  executionServiceUrl: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65_000);
  try {
    return await fetch(`${executionServiceUrl}/internal/execution/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
