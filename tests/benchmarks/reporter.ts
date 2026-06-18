/**
 * Benchmark result reporter.
 *
 * Responsibilities:
 *   1. Format results as a Markdown table for CI logs and PR comments.
 *   2. Persist results to tests/benchmarks/results/baseline.json so
 *      future runs can detect regressions.
 *   3. Compare a new result set against the stored baseline and flag
 *      any measurement that regressed more than REGRESSION_THRESHOLD_PERCENT.
 *
 * The baseline file schema is intentionally simple JSON — no external
 * dependency required to read or write it.
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BenchmarkResult } from "./framework.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** A regression is flagged when throughput drops by more than this fraction. */
const REGRESSION_THRESHOLD_PERCENT = 10;

/** Path written by saveBaseline and read by compareToBaseline. */
export const BASELINE_PATH = new URL(
  "results/baseline.json",
  import.meta.url,
).pathname;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BaselineEntry {
  name: string;
  throughputOpsPerSec: number;
  latency: {
    meanMs: number;
    p95Ms: number;
    p99Ms: number;
  };
  recordedAt: string;
}

export interface RegressionReport {
  regressions: Array<{
    name: string;
    baselineThroughput: number;
    currentThroughput: number;
    dropPercent: number;
  }>;
  hasRegressions: boolean;
}

// ---------------------------------------------------------------------------
// Markdown table renderer
// ---------------------------------------------------------------------------

/**
 * Render a list of benchmark results as a GitHub-flavoured Markdown table.
 */
export function formatAsMarkdownTable(results: BenchmarkResult[]): string {
  const header =
    "| Benchmark | Iters | Concur | ops/sec | mean ms | p95 ms | p99 ms | min ms | max ms |";
  const separator =
    "|-----------|------:|-------:|--------:|--------:|-------:|-------:|-------:|-------:|";

  const rows = results.map((r) => {
    const ops = r.throughputOpsPerSec.toFixed(1);
    const mean = r.latency.meanMs.toFixed(3);
    const p95 = r.latency.p95Ms.toFixed(3);
    const p99 = r.latency.p99Ms.toFixed(3);
    const min = r.latency.minMs.toFixed(3);
    const max = r.latency.maxMs.toFixed(3);
    return (
      `| ${r.name} | ${r.iterations} | ${r.concurrency} | ${ops} | ${mean} | ${p95} | ${p99} | ${min} | ${max} |`
    );
  });

  return [header, separator, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Baseline persistence
// ---------------------------------------------------------------------------

/**
 * Write results to the baseline JSON file, overwriting any previous baseline.
 *
 * The results directory is created if it does not exist so this works in a
 * fresh checkout without a manual mkdir step.
 */
export function saveBaseline(results: BenchmarkResult[]): void {
  const entries: BaselineEntry[] = results.map((r) => ({
    name: r.name,
    throughputOpsPerSec: r.throughputOpsPerSec,
    latency: {
      meanMs: r.latency.meanMs,
      p95Ms: r.latency.p95Ms,
      p99Ms: r.latency.p99Ms,
    },
    recordedAt: new Date().toISOString(),
  }));

  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

/**
 * Load the baseline from disk.  Returns null if no baseline file exists yet,
 * which is expected on a fresh run.
 */
export function loadBaseline(): BaselineEntry[] | null {
  try {
    const raw = readFileSync(BASELINE_PATH, "utf-8");
    return JSON.parse(raw) as BaselineEntry[];
  } catch {
    // File not found or corrupt — treat as no baseline
    return null;
  }
}

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

/**
 * Compare current results against a stored baseline and return a regression
 * report.  Only benchmarks present in both the baseline and current results
 * are compared.  New benchmarks (absent from baseline) are silently skipped.
 */
export function compareToBaseline(
  current: BenchmarkResult[],
  baseline: BaselineEntry[],
): RegressionReport {
  const baselineMap = new Map(baseline.map((b) => [b.name, b]));
  const regressions: RegressionReport["regressions"] = [];

  for (const result of current) {
    const base = baselineMap.get(result.name);
    if (base === undefined) continue; // new benchmark — no baseline to compare

    const dropPercent =
      ((base.throughputOpsPerSec - result.throughputOpsPerSec) /
        base.throughputOpsPerSec) *
      100;

    if (dropPercent > REGRESSION_THRESHOLD_PERCENT) {
      regressions.push({
        name: result.name,
        baselineThroughput: base.throughputOpsPerSec,
        currentThroughput: result.throughputOpsPerSec,
        dropPercent,
      });
    }
  }

  return {
    regressions,
    hasRegressions: regressions.length > 0,
  };
}

/**
 * Format a regression report as a human-readable string suitable for CI output.
 */
export function formatRegressionReport(report: RegressionReport): string {
  if (!report.hasRegressions) {
    return "No performance regressions detected.";
  }

  const lines = ["PERFORMANCE REGRESSIONS DETECTED:", ""];
  for (const r of report.regressions) {
    lines.push(
      `  ${r.name}: ${r.dropPercent.toFixed(1)}% slower ` +
        `(baseline ${r.baselineThroughput.toFixed(1)} ops/sec -> ` +
        `current ${r.currentThroughput.toFixed(1)} ops/sec)`,
    );
  }
  return lines.join("\n");
}
