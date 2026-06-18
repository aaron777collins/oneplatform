/**
 * Vitest integration for the benchmark suites.
 *
 * This file wraps runBenchmarkSuites() in a vitest describe/it block so the
 * full benchmark run can be triggered via `pnpm test:bench-run` or
 * `vitest run --config tests/vitest.bench.config.ts run-all`.
 *
 * Tests in this file are intentionally excluded from the default `pnpm test`
 * run (Turborepo test task) because benchmarks are long-running and not
 * suitable as part of the standard unit-test pass.
 */

import { describe, it } from "vitest";
import { runBenchmarkSuites } from "./run-all.js";

describe("Benchmark suites", () => {
  it(
    "all benchmark suites complete without errors",
    async () => {
      const { hasRegressions } = await runBenchmarkSuites();
      // Regressions are only flagged when --compare is passed; in CI the
      // benchmark.sh script handles exit codes.  In test mode we just ensure
      // the suites run to completion without throwing.
      if (hasRegressions) {
        throw new Error("Performance regressions detected — see stdout above for details.");
      }
    },
    600_000, // 10-minute timeout — benchmarks can be slow on constrained CI
  );
});
