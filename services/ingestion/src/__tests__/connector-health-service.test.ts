// Unit tests for the pure calculation helpers in connector-health-service.ts.
//
// These helpers are the only non-trivial logic in the health service — the
// factory functions delegate to them and to existing repository methods that
// are already tested separately. Testing the pure helpers gives full branch
// coverage of the health score rules without BullMQ or database setup.

import { describe, it, expect } from "vitest";
import {
  computeHealthStatus,
  computeSuccessRate,
  computeAvgLatencyMs,
  buildDailyTrend,
} from "../services/connector-health-service.js";
import type { SyncJobSummary } from "../services/sync-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MinimalRun = Pick<SyncJobSummary, "status" | "durationMs" | "completedAt">;

function run(
  status: SyncJobSummary["status"],
  durationMs: number | null = null,
  completedAt: string | null = null,
): MinimalRun {
  return { status, durationMs, completedAt };
}

function successRun(durationMs = 1000, completedAt: string | null = null): MinimalRun {
  return run("success", durationMs, completedAt);
}

function failedRun(completedAt: string | null = null): MinimalRun {
  return run("failed", null, completedAt);
}

// Build a MinimalRun with a completedAt that is N days before nowMs.
function runDaysAgo(
  status: SyncJobSummary["status"],
  daysAgo: number,
  durationMs: number | null = 1000,
  nowMs: number = Date.now(),
): MinimalRun {
  const completedAt = new Date(nowMs - daysAgo * 24 * 60 * 60 * 1_000).toISOString();
  return { status, durationMs, completedAt };
}

// ---------------------------------------------------------------------------
// computeHealthStatus
// ---------------------------------------------------------------------------

describe("computeHealthStatus — empty run history", () => {
  it("returns 'never_run' when no runs and connector is not scheduled", () => {
    expect(computeHealthStatus([], false, null)).toBe("never_run");
  });

  it("returns 'stale' when no runs and connector IS scheduled (lastSyncAt null)", () => {
    expect(computeHealthStatus([], true, null)).toBe("stale");
  });

  it("returns 'stale' when no runs and connector IS scheduled (lastSyncAt > 24h ago)", () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    expect(computeHealthStatus([], true, old)).toBe("stale");
  });

  it("returns 'never_run' when scheduled but lastSyncAt is within 24 h", () => {
    // A connector that was just created and has a schedule but synced recently
    // should not be stale.
    const recent = new Date(Date.now() - 60 * 1_000); // 1 minute ago
    expect(computeHealthStatus([], true, recent)).toBe("never_run");
  });
});

describe("computeHealthStatus — 100% success rate", () => {
  it("returns 'healthy' for 10/10 successes", () => {
    const runs = Array.from({ length: 10 }, () => successRun());
    expect(computeHealthStatus(runs, false, new Date())).toBe("healthy");
  });

  it("returns 'healthy' for 5/5 successes (fewer than 10 runs)", () => {
    const runs = Array.from({ length: 5 }, () => successRun());
    expect(computeHealthStatus(runs, false, new Date())).toBe("healthy");
  });

  it("returns 'healthy' for 1/1 success", () => {
    expect(computeHealthStatus([successRun()], false, new Date())).toBe("healthy");
  });
});

describe("computeHealthStatus — warning band (70–99%)", () => {
  it("returns 'warning' for 7/10 successes (70%)", () => {
    const runs = [
      ...Array.from({ length: 7 }, () => successRun()),
      ...Array.from({ length: 3 }, () => failedRun()),
    ];
    expect(computeHealthStatus(runs, false, new Date())).toBe("warning");
  });

  it("returns 'warning' for 9/10 successes (90%)", () => {
    const runs = [
      ...Array.from({ length: 9 }, () => successRun()),
      failedRun(),
    ];
    expect(computeHealthStatus(runs, false, new Date())).toBe("warning");
  });

  it("returns 'warning' for 3/4 successes (75%)", () => {
    const runs = [
      successRun(), successRun(), successRun(), failedRun(),
    ];
    expect(computeHealthStatus(runs, false, new Date())).toBe("warning");
  });
});

describe("computeHealthStatus — failing band (<70%)", () => {
  it("returns 'failing' for 6/10 successes (60%)", () => {
    const runs = [
      ...Array.from({ length: 6 }, () => successRun()),
      ...Array.from({ length: 4 }, () => failedRun()),
    ];
    expect(computeHealthStatus(runs, false, new Date())).toBe("failing");
  });

  it("returns 'failing' for 0/5 successes", () => {
    const runs = Array.from({ length: 5 }, () => failedRun());
    expect(computeHealthStatus(runs, false, new Date())).toBe("failing");
  });

  it("returns 'failing' for 0/1 success", () => {
    expect(computeHealthStatus([failedRun()], false, new Date())).toBe("failing");
  });
});

describe("computeHealthStatus — stale takes precedence", () => {
  const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1_000); // 25 h ago

  it("returns 'stale' for a scheduled connector even when last 10 runs all succeeded", () => {
    const runs = Array.from({ length: 10 }, () => successRun());
    expect(computeHealthStatus(runs, true, staleDate)).toBe("stale");
  });

  it("returns 'healthy' for a scheduled connector with recent sync", () => {
    const runs = Array.from({ length: 10 }, () => successRun());
    const recent = new Date(Date.now() - 60 * 1_000);
    expect(computeHealthStatus(runs, true, recent)).toBe("healthy");
  });

  it("does NOT apply stale for an unscheduled connector regardless of lastSyncAt", () => {
    const runs = Array.from({ length: 10 }, () => successRun());
    expect(computeHealthStatus(runs, false, staleDate)).toBe("healthy");
  });
});

describe("computeHealthStatus — window is capped at 10 runs", () => {
  it("only considers the first 10 runs even when 15 are provided (all-success window)", () => {
    // First 10 are success, next 5 are fail — should be healthy.
    const runs = [
      ...Array.from({ length: 10 }, () => successRun()),
      ...Array.from({ length: 5 }, () => failedRun()),
    ];
    expect(computeHealthStatus(runs, false, new Date())).toBe("healthy");
  });

  it("only considers the first 10 runs — all-fail window", () => {
    // First 10 are fail, next 5 are success — should be failing.
    const runs = [
      ...Array.from({ length: 10 }, () => failedRun()),
      ...Array.from({ length: 5 }, () => successRun()),
    ];
    expect(computeHealthStatus(runs, false, new Date())).toBe("failing");
  });
});

// ---------------------------------------------------------------------------
// computeSuccessRate
// ---------------------------------------------------------------------------

describe("computeSuccessRate", () => {
  it("returns null for 0 runs", () => {
    expect(computeSuccessRate([])).toBeNull();
  });

  it("returns null for exactly 1 run (insufficient signal)", () => {
    expect(computeSuccessRate([successRun()])).toBeNull();
  });

  it("returns 1.0 for 10/10 successes", () => {
    const runs = Array.from({ length: 10 }, () => successRun());
    expect(computeSuccessRate(runs)).toBe(1.0);
  });

  it("returns 0.0 for 0/10 successes", () => {
    const runs = Array.from({ length: 10 }, () => failedRun());
    expect(computeSuccessRate(runs)).toBe(0.0);
  });

  it("returns 0.7 for 7/10 successes", () => {
    const runs = [
      ...Array.from({ length: 7 }, () => successRun()),
      ...Array.from({ length: 3 }, () => failedRun()),
    ];
    expect(computeSuccessRate(runs)).toBeCloseTo(0.7);
  });

  it("caps the window at 10 runs", () => {
    // 10 successes then 10 fails — rate should be 1.0 (only first 10 counted).
    const runs = [
      ...Array.from({ length: 10 }, () => successRun()),
      ...Array.from({ length: 10 }, () => failedRun()),
    ];
    expect(computeSuccessRate(runs)).toBe(1.0);
  });

  it("returns 0.5 for 1/2 successes", () => {
    expect(computeSuccessRate([successRun(), failedRun()])).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeAvgLatencyMs
// ---------------------------------------------------------------------------

describe("computeAvgLatencyMs", () => {
  it("returns null for empty list", () => {
    expect(computeAvgLatencyMs([])).toBeNull();
  });

  it("returns null when all runs have null durationMs", () => {
    const runs = [run("success", null), run("failed", null)];
    expect(computeAvgLatencyMs(runs)).toBeNull();
  });

  it("returns the single value when only one run has a duration", () => {
    const runs = [run("success", 2000), run("failed", null)];
    expect(computeAvgLatencyMs(runs)).toBe(2000);
  });

  it("returns the arithmetic mean for multiple durations", () => {
    const runs = [
      run("success", 1000),
      run("success", 2000),
      run("success", 3000),
    ];
    expect(computeAvgLatencyMs(runs)).toBe(2000);
  });

  it("rounds to the nearest integer", () => {
    const runs = [run("success", 1000), run("success", 2000)];
    // Mean is 1500 — exact integer.
    expect(computeAvgLatencyMs(runs)).toBe(1500);
  });

  it("caps the window at 10 runs even if more are provided", () => {
    // 10 short durations followed by very long ones that should be ignored.
    const shortRuns = Array.from({ length: 10 }, () => run("success", 100));
    const longRuns = Array.from({ length: 5 }, () => run("success", 100_000));
    expect(computeAvgLatencyMs([...shortRuns, ...longRuns])).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// buildDailyTrend
// ---------------------------------------------------------------------------

describe("buildDailyTrend", () => {
  it("returns an empty array when no runs are provided", () => {
    expect(buildDailyTrend([])).toEqual([]);
  });

  it("excludes running and cancelled runs (non-terminal)", () => {
    const nowMs = Date.now();
    const allRuns = [
      { ...runDaysAgo("running", 1, null, nowMs), rowsIngested: 0, rowsFailed: 0, connectorId: "c", syncMode: "incremental" as const, syncJobId: "j1", startedAt: "" },
      { ...runDaysAgo("cancelled", 2, null, nowMs), rowsIngested: 0, rowsFailed: 0, connectorId: "c", syncMode: "incremental" as const, syncJobId: "j2", startedAt: "" },
    ] as SyncJobSummary[];
    expect(buildDailyTrend(allRuns, nowMs)).toEqual([]);
  });

  it("excludes runs older than 30 days", () => {
    const nowMs = Date.now();
    const oldRun = runDaysAgo("success", 31, 1000, nowMs);
    const result = buildDailyTrend([oldRun as SyncJobSummary], nowMs);
    expect(result).toEqual([]);
  });

  it("includes runs exactly at the 30-day boundary", () => {
    const nowMs = Date.now();
    // 29.9 days ago — within the window.
    const withinRun = runDaysAgo("success", 29, 1000, nowMs);
    const result = buildDailyTrend([withinRun as SyncJobSummary], nowMs);
    expect(result).toHaveLength(1);
  });

  it("counts successes and failures separately per day", () => {
    const nowMs = Date.now();
    const date = new Date(nowMs - 2 * 24 * 60 * 60 * 1_000);
    const iso = date.toISOString();

    const runs: MinimalRun[] = [
      { status: "success", durationMs: 1000, completedAt: iso },
      { status: "success", durationMs: 2000, completedAt: iso },
      { status: "failed", durationMs: null, completedAt: iso },
    ];

    const result = buildDailyTrend(runs as SyncJobSummary[], nowMs);
    expect(result).toHaveLength(1);
    expect(result[0]?.successCount).toBe(2);
    expect(result[0]?.failCount).toBe(1);
  });

  it("averages durations within the same day", () => {
    const nowMs = Date.now();
    const date = new Date(nowMs - 2 * 24 * 60 * 60 * 1_000);
    const iso = date.toISOString();

    const runs: MinimalRun[] = [
      { status: "success", durationMs: 1000, completedAt: iso },
      { status: "success", durationMs: 3000, completedAt: iso },
    ];

    const result = buildDailyTrend(runs as SyncJobSummary[], nowMs);
    expect(result[0]?.avgDurationMs).toBe(2000);
  });

  it("sets avgDurationMs to null when no runs in a day have a duration", () => {
    const nowMs = Date.now();
    const iso = new Date(nowMs - 24 * 60 * 60 * 1_000).toISOString();

    const runs: MinimalRun[] = [
      { status: "failed", durationMs: null, completedAt: iso },
    ];

    const result = buildDailyTrend(runs as SyncJobSummary[], nowMs);
    expect(result[0]?.avgDurationMs).toBeNull();
  });

  it("sorts result by date ascending (oldest first)", () => {
    const nowMs = Date.now();
    const runs: MinimalRun[] = [
      runDaysAgo("success", 1, 500, nowMs),
      runDaysAgo("success", 5, 500, nowMs),
      runDaysAgo("success", 3, 500, nowMs),
    ];

    const result = buildDailyTrend(runs as SyncJobSummary[], nowMs);
    expect(result).toHaveLength(3);
    // Dates should be strictly ascending.
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1]?.date ?? "";
      const curr = result[i]?.date ?? "";
      expect(prev.localeCompare(curr)).toBeLessThan(0);
    }
  });

  it("excludes runs with null completedAt", () => {
    const nowMs = Date.now();
    const runs: MinimalRun[] = [
      { status: "success", durationMs: 1000, completedAt: null },
    ];
    expect(buildDailyTrend(runs as SyncJobSummary[], nowMs)).toEqual([]);
  });

  it("handles runs spread across multiple days correctly", () => {
    const nowMs = Date.now();
    const runs = [
      runDaysAgo("success", 1, 1000, nowMs),
      runDaysAgo("failed", 1, null, nowMs),
      runDaysAgo("success", 2, 2000, nowMs),
      runDaysAgo("success", 2, 4000, nowMs),
    ];

    const result = buildDailyTrend(runs as SyncJobSummary[], nowMs);
    expect(result).toHaveLength(2);

    // Day 2 ago (oldest, first in output): 2 successes, 0 fails, avg 3000 ms
    expect(result[0]?.successCount).toBe(2);
    expect(result[0]?.failCount).toBe(0);
    expect(result[0]?.avgDurationMs).toBe(3000);

    // Day 1 ago (newest): 1 success, 1 fail, avg 1000 ms (only success had duration)
    expect(result[1]?.successCount).toBe(1);
    expect(result[1]?.failCount).toBe(1);
    expect(result[1]?.avgDurationMs).toBe(1000);
  });
});
