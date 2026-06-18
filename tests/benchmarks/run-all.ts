/**
 * Main benchmark runner — shared core logic.
 *
 * This module exports runBenchmarkSuites() which is used by:
 *   - run-all.test.ts  (vitest integration)
 *   - scripts/benchmark.sh (via node --experimental-strip-types or tsx)
 *
 * Flags parsed from process.argv:
 *   --suite <name>      Run only the named suite: ingestion | pipeline | api
 *   --save-baseline     Overwrite tests/benchmarks/results/baseline.json
 *   --compare           Compare against baseline; returns hasRegressions=true
 */

import { runIngestionBenchmarks } from "./ingestion.bench.js";
import { runPipelineBenchmarks } from "./pipeline.bench.js";
import { runApiBenchmarks } from "./api.bench.js";
import {
  formatAsMarkdownTable,
  saveBaseline,
  loadBaseline,
  compareToBaseline,
  formatRegressionReport,
} from "./reporter.js";
import { formatResultSummary } from "./framework.js";
import type { BenchmarkResult } from "./framework.js";

// ---------------------------------------------------------------------------
// CLI flag / env var parsing
//
// Flags can be supplied two ways:
//   1. process.argv — when the runner is invoked directly with tsx/node.
//   2. Environment variables — when invoked via vitest (which does not
//      forward extra positional args to test files):
//        BENCH_SUITE=ingestion   maps to --suite ingestion
//        BENCH_SAVE_BASELINE=1   maps to --save-baseline
//        BENCH_COMPARE=1         maps to --compare
// ---------------------------------------------------------------------------

function hasFlag(flag: string): boolean {
  if (process.argv.includes(flag)) return true;
  // env-var fallbacks for vitest invocation
  if (flag === "--save-baseline") return process.env["BENCH_SAVE_BASELINE"] === "1";
  if (flag === "--compare") return process.env["BENCH_COMPARE"] === "1";
  return false;
}

function getFlagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) return process.argv[idx + 1];
  // env-var fallback
  if (flag === "--suite") return process.env["BENCH_SUITE"];
  return undefined;
}

// ---------------------------------------------------------------------------
// Suite registry
// ---------------------------------------------------------------------------

const SUITES: Record<string, () => Promise<BenchmarkResult[]>> = {
  ingestion: runIngestionBenchmarks,
  pipeline: runPipelineBenchmarks,
  api: runApiBenchmarks,
};

function validateSuiteFilter(filter: string | undefined): void {
  if (filter !== undefined && !(filter in SUITES)) {
    const valid = Object.keys(SUITES).join(", ");
    throw new Error(`Unknown suite "${filter}". Valid suites: ${valid}`);
  }
}

// ---------------------------------------------------------------------------
// Core runner — shared by vitest and direct-script modes
// ---------------------------------------------------------------------------

export async function runBenchmarkSuites(options?: {
  suite?: string;
  saveBaseline?: boolean;
  compare?: boolean;
}): Promise<{
  results: BenchmarkResult[];
  hasRegressions: boolean;
}> {
  const suiteFilter = options?.suite ?? getFlagValue("--suite");
  const saveBaselineFlag = options?.saveBaseline ?? hasFlag("--save-baseline");
  const compareFlag = options?.compare ?? hasFlag("--compare");

  validateSuiteFilter(suiteFilter);

  const suiteNames =
    suiteFilter !== undefined ? [suiteFilter] : Object.keys(SUITES);

  const allResults: BenchmarkResult[] = [];

  for (const suiteName of suiteNames) {
    const runSuite = SUITES[suiteName];
    if (runSuite === undefined) continue;

    console.log(`\nRunning suite: ${suiteName}`);
    console.log("─".repeat(60));

    const results = await runSuite();
    for (const r of results) {
      console.log("  " + formatResultSummary(r));
    }

    allResults.push(...results);
  }

  console.log("\n## Benchmark Results\n");
  console.log(formatAsMarkdownTable(allResults));

  if (saveBaselineFlag) {
    saveBaseline(allResults);
    console.log("\nBaseline saved.");
  }

  let hasRegressions = false;
  if (compareFlag) {
    const baseline = loadBaseline();
    if (baseline === null) {
      console.log("\nNo baseline found — skipping regression check.");
    } else {
      const report = compareToBaseline(allResults, baseline);
      console.log("\n" + formatRegressionReport(report));
      hasRegressions = report.hasRegressions;
    }
  }

  return { results: allResults, hasRegressions };
}
