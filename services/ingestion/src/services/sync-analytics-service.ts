// Sync analytics service: computes historical performance trends, success
// rates, throughput, and tenant-wide overviews from BullMQ job history.
//
// Design note: sync_state is a single-row-per-connector table (current state
// only) — it carries no per-run history. All historical run data comes from
// BullMQ's job store via the SyncService.listSyncs interface. Analytics are
// computed in-process from that data rather than via new database tables, in
// accordance with the G-050 constraint of no new tables.

import type { SyncService, SyncJobSummary } from "./sync-service.js";
import type { ConnectorRepository } from "./connector-service.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TrendPeriod = "hourly" | "daily" | "weekly";

export interface SyncTrendPoint {
  /** ISO date string for the start of the aggregation period. */
  period: string;
  syncCount: number;
  successCount: number;
  failureCount: number;
  totalRecords: number;
  avgDurationMs: number;
  /** 95th-percentile sync duration across all completed runs in this period. */
  p95DurationMs: number;
}

export interface SyncHistoryResult {
  items: SyncJobSummary[];
  nextCursor: string | null;
  total: number;
}

export interface ConnectorSyncStat {
  id: string;
  name: string;
  syncCount: number;
}

export interface FailingConnectorStat {
  id: string;
  name: string;
  /** Fraction of runs that ended in failure: 0.0–1.0. */
  failureRate: number;
}

export interface TenantSyncOverview {
  totalSyncs24h: number;
  totalSyncs7d: number;
  totalSyncs30d: number;
  totalRecords: number;
  topConnectors: ConnectorSyncStat[];
  failingConnectors: FailingConnectorStat[];
  avgDurationMs: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Enough history to cover any analytics window. We fetch up to this limit
// from BullMQ — more is always available via repeated paginated calls but
// for trend computation we need a recent snapshot, not the entire history.
const ANALYTICS_FETCH_LIMIT = 10_000;

// Minimum run count required before a connector is reported as "failing".
// Connectors with very few runs should not skew the failing list.
const MIN_RUNS_FOR_FAILURE_REPORT = 3;

// A trend is only reported as failing if the failure rate exceeds this threshold.
const FAILURE_RATE_THRESHOLD = 0.25;

/**
 * Returns the floor timestamp (ms since epoch) for the period containing `ts`.
 * Periods are aligned to UTC calendar boundaries to ensure consistent grouping
 * regardless of when the analytics query is made.
 */
function periodFloor(ts: number, period: TrendPeriod): number {
  const d = new Date(ts);
  switch (period) {
    case "hourly": {
      d.setUTCMinutes(0, 0, 0);
      return d.getTime();
    }
    case "daily": {
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "weekly": {
      // Align to Monday 00:00 UTC — ISO week convention.
      const dayOfWeek = d.getUTCDay(); // 0=Sun … 6=Sat
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      d.setUTCDate(d.getUTCDate() - daysToMonday);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
  }
}

/**
 * Computes the p-th percentile of a sorted numeric array.
 * `sorted` must be pre-sorted ascending. Returns 0 for empty arrays.
 *
 * Uses the "nearest rank" method so the result is always an observed value
 * rather than an interpolated estimate — appropriate for duration data.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Clamp p to [0, 100].
  const clamped = Math.max(0, Math.min(100, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  // rank-1 is safe because rank >= 1 (clamped >= 0, length >= 1 → rank >= 1).
  return sorted[rank - 1] ?? 0;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface SyncAnalyticsService {
  getSyncHistory(
    connectorId: string,
    options: { from?: Date; to?: Date; limit?: number; cursor?: string },
  ): Promise<SyncHistoryResult>;

  getSyncTrends(connectorId: string, period: TrendPeriod): Promise<SyncTrendPoint[]>;

  getTenantOverview(tenantId: string): Promise<TenantSyncOverview>;
}

export interface SyncAnalyticsServiceDeps {
  syncService: SyncService;
  connectorRepo: ConnectorRepository;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSyncAnalyticsService(
  deps: SyncAnalyticsServiceDeps,
): SyncAnalyticsService {
  const { syncService, connectorRepo } = deps;

  // -------------------------------------------------------------------------
  // getSyncHistory — paginated, optionally date-filtered run list.
  // Delegates pagination to SyncService.listSyncs and post-filters by date.
  // -------------------------------------------------------------------------

  async function getSyncHistory(
    connectorId: string,
    options: { from?: Date; to?: Date; limit?: number; cursor?: string },
  ): Promise<SyncHistoryResult> {
    if (connectorId.trim() === "") {
      throw new Error("getSyncHistory: connectorId must not be empty.");
    }

    const limit = options.limit ?? 50;
    if (limit < 1 || limit > 200) {
      throw new Error("getSyncHistory: limit must be between 1 and 200.");
    }

    // Fetch enough raw history so date-range filtering leaves a full page.
    const raw = await syncService.listSyncs(connectorId, {
      limit: ANALYTICS_FETCH_LIMIT,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });

    const fromMs = options.from !== undefined ? options.from.getTime() : -Infinity;
    const toMs = options.to !== undefined ? options.to.getTime() : Infinity;

    const filtered = raw.items.filter((item) => {
      const startMs = new Date(item.startedAt).getTime();
      return startMs >= fromMs && startMs <= toMs;
    });

    const page = filtered.slice(0, limit);
    const nextCursor =
      filtered.length > limit ? (page[page.length - 1]?.syncJobId ?? null) : null;

    return { items: page, nextCursor, total: filtered.length };
  }

  // -------------------------------------------------------------------------
  // getSyncTrends — aggregate runs into calendar-aligned periods.
  // -------------------------------------------------------------------------

  async function getSyncTrends(
    connectorId: string,
    period: TrendPeriod,
  ): Promise<SyncTrendPoint[]> {
    if (connectorId.trim() === "") {
      throw new Error("getSyncTrends: connectorId must not be empty.");
    }

    const raw = await syncService.listSyncs(connectorId, {
      limit: ANALYTICS_FETCH_LIMIT,
    });

    if (raw.items.length === 0) return [];

    // Bucket jobs into period-keyed maps.
    // Using a Map<number, SyncJobSummary[]> keyed on period floor timestamp
    // avoids repeated string parsing during aggregation.
    const buckets = new Map<number, SyncJobSummary[]>();

    for (const item of raw.items) {
      const startMs = new Date(item.startedAt).getTime();
      const bucket = periodFloor(startMs, period);
      const existing = buckets.get(bucket);
      if (existing !== undefined) {
        existing.push(item);
      } else {
        buckets.set(bucket, [item]);
      }
    }

    // Sort bucket timestamps ascending so trend points are chronological.
    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);

    return sortedKeys.map((bucketTs): SyncTrendPoint => {
      const items = buckets.get(bucketTs) ?? [];

      const successCount = items.filter((i) => i.status === "success").length;
      const failureCount = items.filter((i) => i.status === "failed").length;
      const totalRecords = items.reduce((sum, i) => sum + i.rowsIngested, 0);

      // Compute duration stats only over completed runs (durationMs is null for
      // in-flight jobs) so in-progress syncs don't skew the distribution.
      const completedDurations = items
        .filter((i) => i.durationMs !== null)
        .map((i) => i.durationMs as number)
        .sort((a, b) => a - b);

      const avgDurationMs =
        completedDurations.length > 0
          ? completedDurations.reduce((s, d) => s + d, 0) / completedDurations.length
          : 0;

      const p95DurationMs = percentile(completedDurations, 95);

      return {
        period: new Date(bucketTs).toISOString(),
        syncCount: items.length,
        successCount,
        failureCount,
        totalRecords,
        avgDurationMs: Math.round(avgDurationMs),
        p95DurationMs,
      };
    });
  }

  // -------------------------------------------------------------------------
  // getTenantOverview — fan-out over all connectors for the tenant.
  // -------------------------------------------------------------------------

  async function getTenantOverview(tenantId: string): Promise<TenantSyncOverview> {
    if (tenantId.trim() === "") {
      throw new Error("getTenantOverview: tenantId must not be empty.");
    }

    // Fetch all connectors for the tenant. We page through all of them since
    // we need the full set to compute accurate overview metrics.
    const allConnectors = await fetchAllConnectors(tenantId);

    if (allConnectors.length === 0) {
      return emptyOverview();
    }

    const now = Date.now();
    const ms24h = 24 * 60 * 60 * 1_000;
    const ms7d = 7 * ms24h;
    const ms30d = 30 * ms24h;

    let totalSyncs24h = 0;
    let totalSyncs7d = 0;
    let totalSyncs30d = 0;
    let totalRecords = 0;
    let totalDurationMs = 0;
    let totalCompletedRuns = 0;

    interface ConnectorAgg {
      id: string;
      name: string;
      syncCount: number;
      failCount: number;
      totalRuns: number;
    }

    const connectorAggs = new Map<string, ConnectorAgg>();

    // Fan out listSyncs across all connectors concurrently with a concurrency
    // limit to avoid saturating BullMQ's Redis connection under wide tenants.
    const CONCURRENCY = 10;
    for (let i = 0; i < allConnectors.length; i += CONCURRENCY) {
      const batch = allConnectors.slice(i, i + CONCURRENCY);

      const results = await Promise.all(
        batch.map((connector) =>
          syncService
            .listSyncs(connector.id, { limit: ANALYTICS_FETCH_LIMIT })
            .then((r) => ({ connector, items: r.items }))
            .catch(() => ({ connector, items: [] as SyncJobSummary[] })),
        ),
      );

      for (const { connector, items } of results) {
        let syncCount = 0;
        let failCount = 0;

        for (const item of items) {
          const startMs = new Date(item.startedAt).getTime();
          const age = now - startMs;

          if (age <= ms30d) {
            totalSyncs30d++;
            syncCount++;
            if (age <= ms7d) {
              totalSyncs7d++;
              if (age <= ms24h) totalSyncs24h++;
            }
            if (item.status === "failed") failCount++;
            totalRecords += item.rowsIngested;

            if (item.durationMs !== null) {
              totalDurationMs += item.durationMs;
              totalCompletedRuns++;
            }
          }
        }

        connectorAggs.set(connector.id, {
          id: connector.id,
          name: connector.name,
          syncCount,
          failCount,
          totalRuns: syncCount,
        });
      }
    }

    const allAggs = Array.from(connectorAggs.values());

    const topConnectors: ConnectorSyncStat[] = allAggs
      .filter((a) => a.syncCount > 0)
      .sort((a, b) => b.syncCount - a.syncCount)
      .slice(0, 5)
      .map(({ id, name, syncCount }) => ({ id, name, syncCount }));

    const failingConnectors: FailingConnectorStat[] = allAggs
      .filter(
        (a) =>
          a.totalRuns >= MIN_RUNS_FOR_FAILURE_REPORT &&
          a.failCount / a.totalRuns >= FAILURE_RATE_THRESHOLD,
      )
      .sort((a, b) => b.failCount / b.totalRuns - a.failCount / a.totalRuns)
      .slice(0, 10)
      .map(({ id, name, failCount, totalRuns }) => ({
        id,
        name,
        failureRate: totalRuns > 0 ? failCount / totalRuns : 0,
      }));

    const avgDurationMs =
      totalCompletedRuns > 0
        ? Math.round(totalDurationMs / totalCompletedRuns)
        : 0;

    return {
      totalSyncs24h,
      totalSyncs7d,
      totalSyncs30d,
      totalRecords,
      topConnectors,
      failingConnectors,
      avgDurationMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Pages through the connector repository until all connectors are returned. */
  async function fetchAllConnectors(
    tenantId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const all: Array<{ id: string; name: string }> = [];
    const PAGE = 100;
    let cursor: string | undefined;

    do {
      const page = await connectorRepo.findByTenantId(tenantId, {
        limit: PAGE,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const row of page) {
        all.push({ id: row.id, name: row.name });
      }
      cursor = page.length === PAGE ? page[page.length - 1]?.id : undefined;
    } while (cursor !== undefined);

    return all;
  }

  function emptyOverview(): TenantSyncOverview {
    return {
      totalSyncs24h: 0,
      totalSyncs7d: 0,
      totalSyncs30d: 0,
      totalRecords: 0,
      topConnectors: [],
      failingConnectors: [],
      avgDurationMs: 0,
    };
  }

  return {
    getSyncHistory,
    getSyncTrends,
    getTenantOverview,
  };
}
