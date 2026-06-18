// Connector health monitoring service.
//
// Health is computed entirely from existing sync_state rows and BullMQ job
// history (via SyncService.listSyncs). No new database tables are required.
//
// The "last 10 runs" window for health scoring is intentionally small so a
// recently-fixed connector recovers quickly rather than staying in "warning"
// for days. The "last 30 days" trend window gives enough historical resolution
// for dashboards while keeping query fan-out bounded.

import type { SyncService, SyncJobSummary } from "./sync-service.js";
import type { ConnectorRepository, SyncStateRepository } from "./connector-service.js";
import { ConnectorNotFoundError } from "./errors.js";
import type { Logger } from "@oneplatform/core";
import { ForbiddenError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Coarse health bucket for a connector. */
export type HealthStatus = "healthy" | "warning" | "failing" | "stale" | "never_run";

export interface ConnectorHealthSummaryItem {
  connectorId: string;
  connectorName: string;
  status: HealthStatus;
  /** ISO timestamp of the most recent completed sync, or null. */
  lastSyncAt: string | null;
  /** Fraction of the last 10 runs that succeeded (0–1). Null when < 2 runs. */
  successRate: number | null;
  /** Mean duration in milliseconds over the last 10 completed runs. Null when 0. */
  avgLatencyMs: number | null;
  /** Total error count across all observed history. */
  errorCount: number;
}

export interface HealthSummary {
  tenantId: string;
  totalConnectors: number;
  healthyCount: number;
  warningCount: number;
  failingCount: number;
  staleCount: number;
  neverRunCount: number;
  connectors: ConnectorHealthSummaryItem[];
}

/** One data point in a daily trend series. */
export interface DailyTrendPoint {
  /** Date string in YYYY-MM-DD format (UTC). */
  date: string;
  successCount: number;
  failCount: number;
  /** Average duration in milliseconds for runs that completed on this day. */
  avgDurationMs: number | null;
}

export interface ConnectorHealthDetail {
  connectorId: string;
  connectorName: string;
  status: HealthStatus;
  lastSyncAt: string | null;
  successRate: number | null;
  avgLatencyMs: number | null;
  errorCount: number;
  /** The most recent error message, or null if last run succeeded. */
  lastErrorMessage: string | null;
  /** Up to 20 most recent sync runs, newest first. */
  recentRuns: SyncJobSummary[];
  /** Daily trend for the last 30 days (UTC), oldest first. */
  dailyTrend: DailyTrendPoint[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ConnectorHealthService {
  getHealthSummary(tenantId: string): Promise<HealthSummary>;
  getConnectorHealth(tenantId: string, connectorId: string): Promise<ConnectorHealthDetail>;
}

export interface ConnectorHealthServiceDeps {
  connectorRepo: ConnectorRepository;
  syncStateRepo: SyncStateRepository;
  syncService: SyncService;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Health score constants
// ---------------------------------------------------------------------------

// Number of recent runs used for the primary health status calculation.
const HEALTH_WINDOW_RUNS = 10;

// Threshold: above this success rate => healthy; above WARNING_THRESHOLD => warning.
const HEALTHY_THRESHOLD = 1.0;  // 100%
const WARNING_THRESHOLD = 0.7;  // 70%

// A scheduled connector that hasn't produced a completed run in this many
// milliseconds is considered stale regardless of its last success rate.
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1_000; // 24 hours

// Trend window: calendar days to include in the daily trend series.
const TREND_DAYS = 30;

// Maximum recent runs to surface in the detail view.
const DETAIL_RUN_LIMIT = 20;

// ---------------------------------------------------------------------------
// Pure calculation helpers — exported for unit testing without service wiring
// ---------------------------------------------------------------------------

/**
 * Compute the health status for a connector given its last N terminal runs and
 * whether it has a schedule configured.
 *
 * Terminal means "success" or "failed" — running/cancelled runs are excluded
 * from the success-rate window because they haven't produced a meaningful outcome.
 */
export function computeHealthStatus(
  terminalRuns: ReadonlyArray<{ status: string }>,
  hasSchedule: boolean,
  lastSyncAt: Date | null,
): HealthStatus {
  if (terminalRuns.length === 0) {
    // "Stale" beats "never_run" only when the connector is actually scheduled.
    // An unscheduled connector with no runs is simply "never_run".
    if (hasSchedule && isStale(lastSyncAt)) {
      return "stale";
    }
    return "never_run";
  }

  // Apply stale check first: a scheduled connector that hasn't completed a run
  // in 24 h is stale even if its most recent run succeeded weeks ago.
  if (hasSchedule && isStale(lastSyncAt)) {
    return "stale";
  }

  const window = terminalRuns.slice(0, HEALTH_WINDOW_RUNS);
  const successCount = window.filter((r) => r.status === "success").length;
  const rate = successCount / window.length;

  if (rate >= HEALTHY_THRESHOLD) return "healthy";
  if (rate >= WARNING_THRESHOLD) return "warning";
  return "failing";
}

/**
 * Calculate the success rate (0–1) over the last N terminal runs.
 * Returns null when fewer than 2 terminal runs exist — a single run is not
 * enough signal for a meaningful percentage.
 */
export function computeSuccessRate(
  terminalRuns: ReadonlyArray<{ status: string }>,
): number | null {
  const window = terminalRuns.slice(0, HEALTH_WINDOW_RUNS);
  if (window.length < 2) return null;
  const successes = window.filter((r) => r.status === "success").length;
  return successes / window.length;
}

/**
 * Calculate the mean duration in milliseconds across completed runs that have
 * a non-null durationMs. Returns null when no durations are available.
 */
export function computeAvgLatencyMs(
  runs: ReadonlyArray<{ durationMs: number | null }>,
): number | null {
  const durations = runs
    .slice(0, HEALTH_WINDOW_RUNS)
    .map((r) => r.durationMs)
    .filter((d): d is number => d !== null);

  if (durations.length === 0) return null;
  return Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length);
}

/**
 * Aggregate sync runs into a daily success/fail/avg-duration time series for
 * the last TREND_DAYS calendar days (UTC). Days with no runs are omitted.
 */
export function buildDailyTrend(
  runs: ReadonlyArray<SyncJobSummary>,
  nowMs: number = Date.now(),
): DailyTrendPoint[] {
  // Cutoff: midnight UTC exactly TREND_DAYS days ago.
  const cutoffMs = nowMs - TREND_DAYS * 24 * 60 * 60 * 1_000;

  // Bucket terminal runs by UTC date string.
  const buckets = new Map<string, { success: number; fail: number; durations: number[] }>();

  for (const run of runs) {
    if (run.status !== "success" && run.status !== "failed") continue;
    if (run.completedAt === null) continue;

    const completedMs = new Date(run.completedAt).getTime();
    if (completedMs < cutoffMs) continue;

    const dateKey = utcDateString(new Date(run.completedAt));
    let bucket = buckets.get(dateKey);
    if (bucket === undefined) {
      bucket = { success: 0, fail: 0, durations: [] };
      buckets.set(dateKey, bucket);
    }

    if (run.status === "success") {
      bucket.success += 1;
    } else {
      bucket.fail += 1;
    }
    if (run.durationMs !== null) {
      bucket.durations.push(run.durationMs);
    }
  }

  // Emit sorted by date ascending.
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, b]) => ({
      date,
      successCount: b.success,
      failCount: b.fail,
      avgDurationMs:
        b.durations.length > 0
          ? Math.round(b.durations.reduce((s, d) => s + d, 0) / b.durations.length)
          : null,
    }));
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function isStale(lastSyncAt: Date | null): boolean {
  if (lastSyncAt === null) return true;
  return Date.now() - lastSyncAt.getTime() > STALE_THRESHOLD_MS;
}

function utcDateString(d: Date): string {
  // YYYY-MM-DD in UTC without library dependencies.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Fetch enough runs from BullMQ to cover both the health window and the trend
// window without making the caller guess a limit.  We ask for 200 runs: 10 for
// the health window + up to ~120 for 30 days of daily runs (worst case 4/day).
// This keeps latency predictable while avoiding unbounded scans.
const HISTORY_FETCH_LIMIT = 200;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConnectorHealthService(
  deps: ConnectorHealthServiceDeps,
): ConnectorHealthService {
  const { connectorRepo, syncStateRepo, syncService, logger } = deps;

  // -------------------------------------------------------------------------
  // getHealthSummary — aggregate view across all connectors for a tenant.
  // -------------------------------------------------------------------------

  async function getHealthSummary(tenantId: string): Promise<HealthSummary> {
    if (!tenantId || tenantId.trim() === "") {
      throw new Error("tenantId is required for getHealthSummary.");
    }

    // Load all connectors for the tenant (no pagination — health view is aggregate).
    const listResult = await connectorRepo.list(tenantId, {
      limit: 10_000,
      sort: "-createdAt",
    });

    const items: ConnectorHealthSummaryItem[] = await Promise.all(
      listResult.items.map(async ({ connector, syncState }) => {
        const runsResult = await syncService.listSyncs(connector.id, {
          limit: HISTORY_FETCH_LIMIT,
        });

        const terminalRuns = runsResult.items.filter(
          (r) => r.status === "success" || r.status === "failed",
        );

        const status = computeHealthStatus(
          terminalRuns,
          connector.schedule_cron !== null,
          syncState.last_sync_at,
        );

        const errorCount = runsResult.items.filter((r) => r.status === "failed").length;

        return {
          connectorId: connector.id,
          connectorName: connector.name,
          status,
          lastSyncAt: syncState.last_sync_at?.toISOString() ?? null,
          successRate: computeSuccessRate(terminalRuns),
          avgLatencyMs: computeAvgLatencyMs(terminalRuns),
          errorCount,
        };
      }),
    );

    const counts = {
      healthy: 0,
      warning: 0,
      failing: 0,
      stale: 0,
      never_run: 0,
    };
    for (const item of items) {
      counts[item.status] += 1;
    }

    logger.debug("Health summary computed", {
      tenantId,
      totalConnectors: items.length,
      ...counts,
    });

    return {
      tenantId,
      totalConnectors: items.length,
      healthyCount: counts.healthy,
      warningCount: counts.warning,
      failingCount: counts.failing,
      staleCount: counts.stale,
      neverRunCount: counts.never_run,
      connectors: items,
    };
  }

  // -------------------------------------------------------------------------
  // getConnectorHealth — detailed view for a single connector.
  // -------------------------------------------------------------------------

  async function getConnectorHealth(
    tenantId: string,
    connectorId: string,
  ): Promise<ConnectorHealthDetail> {
    if (!tenantId || tenantId.trim() === "") {
      throw new Error("tenantId is required for getConnectorHealth.");
    }
    if (!connectorId || connectorId.trim() === "") {
      throw new Error("connectorId is required for getConnectorHealth.");
    }

    const connector = await connectorRepo.findById(connectorId);
    if (connector === null) {
      throw new ConnectorNotFoundError(
        `Connector ${connectorId} not found.`,
        { connectorId },
      );
    }
    // Enforce tenant isolation — the same check the connector service applies.
    if (connector.tenant_id !== tenantId) {
      throw new ForbiddenError(`You do not have access to connector ${connectorId}.`);
    }

    const syncState = await syncStateRepo.findByConnectorId(connectorId);

    const runsResult = await syncService.listSyncs(connectorId, {
      limit: HISTORY_FETCH_LIMIT,
    });
    const allRuns = runsResult.items;

    const terminalRuns = allRuns.filter(
      (r) => r.status === "success" || r.status === "failed",
    );

    const status = computeHealthStatus(
      terminalRuns,
      connector.schedule_cron !== null,
      syncState?.last_sync_at ?? null,
    );

    // The most recent error: scan newest-first for a failed run.
    const lastFailedRun = allRuns.find((r) => r.status === "failed");
    const lastErrorMessage = lastFailedRun?.error ?? syncState?.last_error ?? null;

    const errorCount = allRuns.filter((r) => r.status === "failed").length;

    logger.debug("Connector health detail computed", {
      connectorId,
      tenantId,
      status,
      totalRuns: allRuns.length,
    });

    return {
      connectorId: connector.id,
      connectorName: connector.name,
      status,
      lastSyncAt: syncState?.last_sync_at?.toISOString() ?? null,
      successRate: computeSuccessRate(terminalRuns),
      avgLatencyMs: computeAvgLatencyMs(terminalRuns),
      errorCount,
      lastErrorMessage,
      recentRuns: allRuns.slice(0, DETAIL_RUN_LIMIT),
      dailyTrend: buildDailyTrend(allRuns),
    };
  }

  return { getHealthSummary, getConnectorHealth };
}
