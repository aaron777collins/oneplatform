/**
 * Unit tests for benchmark reporter.
 *
 * Tests verify Markdown table formatting, regression detection logic, and
 * baseline comparison without touching the filesystem (saveBaseline /
 * loadBaseline are tested separately in an isolated tmp-file test).
 */

import { describe, it, expect } from "vitest";
import {
  formatAsMarkdownTable,
  compareToBaseline,
  formatRegressionReport,
  type BaselineEntry,
} from "./reporter.js";
import type { BenchmarkResult } from "./framework.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResult(name: string, throughput: number): BenchmarkResult {
  return {
    name,
    iterations: 100,
    concurrency: 1,
    totalMs: 1000,
    throughputOpsPerSec: throughput,
    latency: {
      minMs: 1,
      maxMs: 20,
      meanMs: 5,
      medianMs: 4,
      p95Ms: 15,
      p99Ms: 18,
    },
  };
}

function makeBaseline(name: string, throughput: number): BaselineEntry {
  return {
    name,
    throughputOpsPerSec: throughput,
    latency: { meanMs: 5, p95Ms: 15, p99Ms: 18 },
    recordedAt: "2026-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// formatAsMarkdownTable
// ---------------------------------------------------------------------------

describe("formatAsMarkdownTable", () => {
  it("includes a header row with expected column names", () => {
    const table = formatAsMarkdownTable([makeResult("bench-a", 100)]);
    expect(table).toContain("| Benchmark |");
    expect(table).toContain("ops/sec");
    expect(table).toContain("p95 ms");
    expect(table).toContain("p99 ms");
  });

  it("includes a separator row", () => {
    const table = formatAsMarkdownTable([makeResult("bench-a", 100)]);
    expect(table).toContain("---");
  });

  it("includes one data row per result", () => {
    const results = [makeResult("bench-a", 100), makeResult("bench-b", 200)];
    const table = formatAsMarkdownTable(results);
    expect(table).toContain("bench-a");
    expect(table).toContain("bench-b");
    // Header + separator + 2 data rows = 4 lines
    expect(table.split("\n")).toHaveLength(4);
  });

  it("formats throughput to 1 decimal place", () => {
    const table = formatAsMarkdownTable([makeResult("bench", 1234.5678)]);
    expect(table).toContain("1234.6");
  });

  it("returns just header and separator for empty results array", () => {
    const table = formatAsMarkdownTable([]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — no regressions
// ---------------------------------------------------------------------------

describe("compareToBaseline — no regressions", () => {
  it("returns hasRegressions=false when current throughput equals baseline", () => {
    const current = [makeResult("bench-a", 100)];
    const baseline = [makeBaseline("bench-a", 100)];
    const report = compareToBaseline(current, baseline);
    expect(report.hasRegressions).toBe(false);
    expect(report.regressions).toHaveLength(0);
  });

  it("returns hasRegressions=false when current throughput is higher than baseline", () => {
    const current = [makeResult("bench-a", 120)];
    const baseline = [makeBaseline("bench-a", 100)];
    const report = compareToBaseline(current, baseline);
    expect(report.hasRegressions).toBe(false);
  });

  it("ignores benchmarks not present in the baseline (new benchmarks)", () => {
    const current = [makeResult("new-bench", 100)];
    const baseline: BaselineEntry[] = [];
    const report = compareToBaseline(current, baseline);
    expect(report.hasRegressions).toBe(false);
  });

  it("does not flag a drop exactly at the threshold (10% is the cutoff)", () => {
    // Exactly 10% drop should NOT be flagged (threshold is strictly > 10%)
    const current = [makeResult("bench-a", 90)];
    const baseline = [makeBaseline("bench-a", 100)];
    const report = compareToBaseline(current, baseline);
    expect(report.hasRegressions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compareToBaseline — regressions detected
// ---------------------------------------------------------------------------

describe("compareToBaseline — regressions detected", () => {
  it("flags a throughput drop greater than 10%", () => {
    const current = [makeResult("bench-a", 89)]; // 11% drop
    const baseline = [makeBaseline("bench-a", 100)];
    const report = compareToBaseline(current, baseline);
    expect(report.hasRegressions).toBe(true);
    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0]?.name).toBe("bench-a");
  });

  it("records the correct drop percentage", () => {
    const current = [makeResult("bench-a", 75)]; // 25% drop
    const baseline = [makeBaseline("bench-a", 100)];
    const report = compareToBaseline(current, baseline);
    expect(report.regressions[0]?.dropPercent).toBeCloseTo(25, 1);
  });

  it("flags multiple regressions independently", () => {
    const current = [
      makeResult("bench-a", 70),  // 30% drop
      makeResult("bench-b", 100), // no drop
      makeResult("bench-c", 50),  // 50% drop
    ];
    const baseline = [
      makeBaseline("bench-a", 100),
      makeBaseline("bench-b", 100),
      makeBaseline("bench-c", 100),
    ];
    const report = compareToBaseline(current, baseline);
    expect(report.hasRegressions).toBe(true);
    expect(report.regressions).toHaveLength(2);
    const regressionNames = report.regressions.map((r) => r.name);
    expect(regressionNames).toContain("bench-a");
    expect(regressionNames).toContain("bench-c");
    expect(regressionNames).not.toContain("bench-b");
  });
});

// ---------------------------------------------------------------------------
// formatRegressionReport
// ---------------------------------------------------------------------------

describe("formatRegressionReport", () => {
  it("returns a clean message when there are no regressions", () => {
    const report = { regressions: [], hasRegressions: false };
    expect(formatRegressionReport(report)).toContain("No performance regressions");
  });

  it("includes the benchmark name for each regression", () => {
    const report = {
      hasRegressions: true,
      regressions: [
        {
          name: "bench-a",
          baselineThroughput: 100,
          currentThroughput: 75,
          dropPercent: 25,
        },
      ],
    };
    const text = formatRegressionReport(report);
    expect(text).toContain("bench-a");
    expect(text).toContain("25.0%");
  });

  it("includes baseline and current throughput values", () => {
    const report = {
      hasRegressions: true,
      regressions: [
        {
          name: "my-bench",
          baselineThroughput: 1000,
          currentThroughput: 800,
          dropPercent: 20,
        },
      ],
    };
    const text = formatRegressionReport(report);
    expect(text).toContain("1000.0");
    expect(text).toContain("800.0");
  });
});
