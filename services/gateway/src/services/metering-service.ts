import { createHmac } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import { decrypt } from "@oneplatform/core";
import { validateWebhookUrl } from "../utils/ssrf-guard.js";
import type { UsageEventRepository, UsageSummaryRepository, BillingWebhookConfigRepository } from "../repositories/usage-event-repository.js";
import type { UsageEventType, UsagePeriodType } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// UsageSummary aggregates all event types for a tenant into a single object
// shaped for the billing API response.
export interface UsageSummary {
  tenantId: string;
  period: string;
  apiCalls: number;
  rowsIngested: number;
  rowsTransformed: number;
  storageBytes: number;
  pipelineExecutions: number;
  activeConnectors: number;
}

// UsageEvent is the unit of metering data returned in history / export APIs.
export interface UsageEvent {
  tenantId: string;
  type: UsageEventType;
  value: number;
  metadata?: Record<string, string>;
  timestamp: string;
}

export type UsagePeriod = 'hourly' | 'daily' | 'monthly';

// ---------------------------------------------------------------------------
// Internal Redis key helpers
//
// Real-time counters are stored as Redis hashes keyed by tenant. The hash
// field is the event type; the hash value is the running integer count.
// A secondary hash stores metadata for the most recent event of each type
// so that the flush job can attach it to the DB row.
//
// All keys carry a TTL of 25 hours so that a flush failure cannot leak
// stale counter values across day boundaries.
// ---------------------------------------------------------------------------

const REDIS_KEY_PREFIX = "metering:counters";
const REDIS_COUNTER_TTL_SECONDS = 25 * 60 * 60; // 25 h

function counterKey(tenantId: string): string {
  return `${REDIS_KEY_PREFIX}:${tenantId}`;
}

// Redis set that tracks which tenants have pending counter increments.
// The flush job iterates this set to avoid scanning all keys.
const PENDING_TENANTS_KEY = "metering:pending_tenants";

// ---------------------------------------------------------------------------
// Period boundary helpers
// ---------------------------------------------------------------------------

function truncateToPeriod(date: Date, period: UsagePeriodType): Date {
  const d = new Date(date);
  switch (period) {
    case "hourly":
      d.setUTCMinutes(0, 0, 0);
      return d;
    case "daily":
      d.setUTCHours(0, 0, 0, 0);
      return d;
    case "monthly":
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
  }
}

function periodEnd(periodStart: Date, period: UsagePeriodType): Date {
  const d = new Date(periodStart);
  switch (period) {
    case "hourly":
      d.setUTCHours(d.getUTCHours() + 1);
      return d;
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      return d;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
  }
}

function periodLabel(periodStart: Date, period: UsagePeriodType): string {
  switch (period) {
    case "hourly":
      return periodStart.toISOString().slice(0, 13); // "2024-01-15T14"
    case "daily":
      return periodStart.toISOString().slice(0, 10); // "2024-01-15"
    case "monthly":
      return periodStart.toISOString().slice(0, 7);  // "2024-01"
  }
}

// ---------------------------------------------------------------------------
// Billing webhook delivery
// ---------------------------------------------------------------------------

const BILLING_WEBHOOK_TIMEOUT_MS = 10_000;

async function deliverBillingWebhook(
  url: string,
  provider: string,
  secret: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (secret !== null) {
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    headers["X-OnePlatform-Signature"] = `sha256=${sig}`;
  }

  // Stripe expects the event wrapped under a specific key structure.
  // Custom endpoints receive the payload as-is.
  const finalBody = provider === "stripe"
    ? JSON.stringify({
        type: "platform.usage_threshold_crossed",
        data: { object: payload },
      })
    : body;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BILLING_WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: finalBody,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Billing webhook responded with HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MeteringService — public interface
// ---------------------------------------------------------------------------

export interface MeteringService {
  // Fire-and-forget Redis counter increments — never block the request path.
  recordApiCall(tenantId: string, endpoint: string, method: string): void;
  recordRowsIngested(tenantId: string, connectorId: string, count: number): void;
  recordStorageUsage(tenantId: string, bytes: number): void;
  recordPipelineExecution(tenantId: string, pipelineId: string): void;
  recordRowsTransformed(tenantId: string, pipelineId: string, count: number): void;

  // Synchronous aggregation reads for API responses.
  getUsageSummary(tenantId: string, period: UsagePeriod): Promise<UsageSummary>;
  getUsageByTenant(tenantId: string, from: Date, to: Date): Promise<UsageEvent[]>;

  // Periodic flush: drains Redis counters into the DB and triggers threshold checks.
  // Called by the background cron job; not exposed via HTTP.
  flushPendingEvents(): Promise<void>;
}

export interface MeteringServiceDeps {
  redis: Redis;
  usageEventRepo: UsageEventRepository;
  usageSummaryRepo: UsageSummaryRepository;
  billingWebhookConfigRepo: BillingWebhookConfigRepository;
  masterKey: Buffer;
  logger: Logger;
}

export function createMeteringService(deps: MeteringServiceDeps): MeteringService {
  const { redis, usageEventRepo, usageSummaryRepo, billingWebhookConfigRepo, masterKey, logger } = deps;

  // -------------------------------------------------------------------------
  // Internal: increment a Redis counter and track the tenant as pending.
  // Fire-and-forget — errors are swallowed so the caller's request is never
  // delayed or failed due to a metering write.
  // -------------------------------------------------------------------------

  function incrementCounter(
    tenantId: string,
    type: UsageEventType,
    value: number,
    metadata?: Record<string, string>,
  ): void {
    const key = counterKey(tenantId);

    // Promise chain is intentionally not awaited. We log errors to avoid
    // silent failures piling up, but we never block the request path.
    void (async () => {
      try {
        const pipeline = redis.pipeline();
        pipeline.hincrbyfloat(key, type, value);
        pipeline.expire(key, REDIS_COUNTER_TTL_SECONDS);
        pipeline.sadd(PENDING_TENANTS_KEY, tenantId);

        // Persist the metadata for the latest event of each type so the flush
        // job can attach it to the DB row. Only the most recent metadata wins —
        // this is an acceptable trade-off for a real-time counter pattern.
        if (metadata !== undefined) {
          pipeline.hset(
            `${key}:meta`,
            type,
            JSON.stringify(metadata),
          );
          pipeline.expire(`${key}:meta`, REDIS_COUNTER_TTL_SECONDS);
        }

        await pipeline.exec();
      } catch (err) {
        // Metering failures must not surface to callers — they are logged for
        // operator visibility but never re-thrown.
        logger.warn("Failed to increment metering counter in Redis", {
          tenantId,
          type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Public recording methods — all fire-and-forget
  // -------------------------------------------------------------------------

  function recordApiCall(tenantId: string, endpoint: string, method: string): void {
    incrementCounter(tenantId, "api_call", 1, { endpoint, method });
  }

  function recordRowsIngested(tenantId: string, connectorId: string, count: number): void {
    if (count <= 0) return;
    incrementCounter(tenantId, "rows_ingested", count, { connectorId });
  }

  function recordStorageUsage(tenantId: string, bytes: number): void {
    if (bytes === 0) return;
    incrementCounter(tenantId, "storage_delta", bytes, {});
  }

  function recordPipelineExecution(tenantId: string, pipelineId: string): void {
    incrementCounter(tenantId, "pipeline_execution", 1, { pipelineId });
  }

  function recordRowsTransformed(tenantId: string, pipelineId: string, count: number): void {
    if (count <= 0) return;
    incrementCounter(tenantId, "rows_transformed", count, { pipelineId });
  }

  // -------------------------------------------------------------------------
  // getUsageSummary — reads from usage_summaries for completed periods and
  // falls back to aggregating usage_events directly for the current partial period.
  // -------------------------------------------------------------------------

  async function getUsageSummary(tenantId: string, period: UsagePeriod): Promise<UsageSummary> {
    const now = new Date();
    const periodStart = truncateToPeriod(now, period);
    const pEnd = periodEnd(periodStart, period);

    // Try the pre-aggregated summary table first (fast path).
    const summaryRows = await usageSummaryRepo.findByTenantAndPeriodType(
      tenantId,
      period,
      periodStart,
      pEnd,
    );

    // Fall back to aggregating from the raw event log if the flush job hasn't
    // run yet for this period (common for the current partial period).
    const aggregated = summaryRows.length > 0
      ? summaryRows
      : await usageEventRepo.aggregateByTenantAndPeriod(tenantId, periodStart, pEnd);

    const totals: Record<UsageEventType, number> = {
      api_call: 0,
      rows_ingested: 0,
      rows_transformed: 0,
      storage_delta: 0,
      pipeline_execution: 0,
    };

    for (const row of aggregated) {
      const type = "event_type" in row ? row.event_type : row.type;
      const value = "total_value" in row ? Number(row.total_value) : Number(row.total);
      totals[type] = (totals[type] ?? 0) + value;
    }

    return {
      tenantId,
      period: periodLabel(periodStart, period),
      apiCalls: totals.api_call,
      rowsIngested: totals.rows_ingested,
      rowsTransformed: totals.rows_transformed,
      storageBytes: totals.storage_delta,
      pipelineExecutions: totals.pipeline_execution,
      // activeConnectors is derived from distinct connectorId metadata values.
      // For now we return 0 from the summary — the detailed history endpoint
      // can compute this from the raw events. (G-048 scope: metering not inventory)
      activeConnectors: 0,
    };
  }

  // -------------------------------------------------------------------------
  // getUsageByTenant — returns raw events for a time window
  // -------------------------------------------------------------------------

  async function getUsageByTenant(tenantId: string, from: Date, to: Date): Promise<UsageEvent[]> {
    const rows = await usageEventRepo.findByTenantIdAndPeriod(tenantId, from, to);
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      type: row.type,
      value: Number(row.value),
      ...(row.metadata !== null ? { metadata: row.metadata } : {}),
      timestamp: row.timestamp.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // flushPendingEvents — drains Redis counters into the DB.
  //
  // Algorithm per tenant:
  //   1. HGETALL the counter hash — returns {type: accumulatedCount}
  //   2. DEL the counter hash + meta hash atomically (so concurrent increments
  //      after this point land in a fresh counter for the next flush)
  //   3. Insert one usage_event row per non-zero counter
  //   4. Upsert into usage_summaries for hourly / daily / monthly buckets
  //   5. Check thresholds against the billing_webhook_config; if crossed, deliver
  //
  // The atomic GETDEL is implemented with HGETALL + DEL inside a MULTI/EXEC
  // block so a counter increment that races with the flush is either fully
  // captured or fully missed (and will be flushed in the next cycle).
  // -------------------------------------------------------------------------

  async function flushPendingEvents(): Promise<void> {
    const pendingTenants = await redis.smembers(PENDING_TENANTS_KEY);
    if (pendingTenants.length === 0) return;

    // Clear the pending-tenant set first. Tenants that get new increments
    // between here and the end of the loop will be re-added automatically
    // by the next increment call.
    await redis.del(PENDING_TENANTS_KEY);

    const now = new Date();

    for (const tenantId of pendingTenants) {
      const key = counterKey(tenantId);
      const metaKey = `${key}:meta`;

      // Atomic read-and-delete so we don't double-count. MULTI/EXEC guarantees
      // no other commands interleave between HGETALL and DEL, preventing loss
      // of increments that race with the flush.
      const [getallResult, metaResult] = await redis
        .multi()
        .hgetall(key)
        .hgetall(metaKey)
        .del(key)
        .del(metaKey)
        .exec() ?? [];

      const counters = (getallResult?.[1] ?? {}) as Record<string, string>;
      const metas = (metaResult?.[1] ?? {}) as Record<string, string>;

      const entries = Object.entries(counters).filter(
        ([, rawValue]) => parseFloat(rawValue) !== 0,
      );

      if (entries.length === 0) continue;

      const eventsToInsert = entries.map(([type, rawValue]) => {
        const value = parseFloat(rawValue);
        const rawMeta = metas[type];
        const metadata: Record<string, string> | undefined = rawMeta !== undefined
          ? JSON.parse(rawMeta) as Record<string, string>
          : undefined;

        return {
          tenant_id: tenantId,
          type: type as UsageEventType,
          value: Math.round(value),
          ...(metadata !== undefined ? { metadata } : {}),
          timestamp: now,
        };
      });

      try {
        await usageEventRepo.insertBatch(eventsToInsert);
      } catch (err) {
        logger.error("Failed to flush usage events to DB", {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue to the next tenant — do not abort the entire flush.
        continue;
      }

      // Upsert summary buckets for all three granularities.
      for (const event of eventsToInsert) {
        for (const periodType of ["hourly", "daily", "monthly"] as UsagePeriodType[]) {
          const ps = truncateToPeriod(now, periodType);
          try {
            await usageSummaryRepo.upsertBucket(
              tenantId,
              periodType,
              ps,
              event.type,
              BigInt(event.value),
              BigInt(1),
            );
          } catch (err) {
            logger.warn("Failed to upsert usage summary bucket", {
              tenantId,
              periodType,
              eventType: event.type,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Threshold check and billing webhook delivery.
      await checkAndDeliverThresholds(tenantId, now);
    }
  }

  // -------------------------------------------------------------------------
  // checkAndDeliverThresholds — reads the current monthly summary and
  // compares against the tenant's billing webhook thresholds. Delivers the
  // webhook if any threshold is exceeded.
  // -------------------------------------------------------------------------

  async function checkAndDeliverThresholds(tenantId: string, now: Date): Promise<void> {
    const config = await billingWebhookConfigRepo.findByTenantId(tenantId);
    if (config === null || !config.enabled) return;

    const monthStart = truncateToPeriod(now, "monthly");
    const monthEnd = periodEnd(monthStart, "monthly");
    const summaries = await usageSummaryRepo.findByTenantAndPeriodType(
      tenantId,
      "monthly",
      monthStart,
      monthEnd,
    );

    let apiCalls = 0n;
    let rowsIngested = 0n;
    let storageBytes = 0n;

    for (const row of summaries) {
      if (row.event_type === "api_call") apiCalls += row.total_value;
      if (row.event_type === "rows_ingested") rowsIngested += row.total_value;
      if (row.event_type === "storage_delta") storageBytes += row.total_value;
    }

    const exceeded: string[] = [];
    if (config.api_call_threshold !== null && apiCalls >= config.api_call_threshold) {
      exceeded.push("api_calls");
    }
    if (config.rows_ingested_threshold !== null && rowsIngested >= config.rows_ingested_threshold) {
      exceeded.push("rows_ingested");
    }
    if (config.storage_bytes_threshold !== null && storageBytes >= config.storage_bytes_threshold) {
      exceeded.push("storage_bytes");
    }

    if (exceeded.length === 0) return;

    // Validate the webhook URL against SSRF patterns before delivering.
    try {
      await validateWebhookUrl(config.url);
    } catch (err) {
      logger.warn("Billing webhook URL failed SSRF validation — skipping delivery", {
        tenantId,
        url: config.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Decrypt the signing secret before passing it to deliverBillingWebhook.
    // The column stores AES-256-GCM ciphertext; HMAC must be computed over the
    // plaintext shared secret so webhook consumers can verify signatures.
    let secret: string | null = null;
    if (config.secret_encrypted !== null) {
      secret = await decrypt(config.secret_encrypted, masterKey);
    }

    const payload = {
      tenantId,
      month: periodLabel(monthStart, "monthly"),
      exceededThresholds: exceeded,
      usage: {
        apiCalls: Number(apiCalls),
        rowsIngested: Number(rowsIngested),
        storageBytes: Number(storageBytes),
      },
      timestamp: now.toISOString(),
    };

    try {
      await deliverBillingWebhook(config.url, config.provider, secret, payload);
      logger.info("Billing webhook delivered", { tenantId, exceeded });
    } catch (err) {
      // Non-fatal — threshold alerts are best-effort. The next flush cycle
      // will re-evaluate and re-attempt if still exceeded.
      logger.warn("Billing webhook delivery failed", {
        tenantId,
        url: config.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    recordApiCall,
    recordRowsIngested,
    recordStorageUsage,
    recordPipelineExecution,
    recordRowsTransformed,
    getUsageSummary,
    getUsageByTenant,
    flushPendingEvents,
  };
}
