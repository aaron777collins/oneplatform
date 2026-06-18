/**
 * Vitest configuration for the benchmark suite.
 *
 * Benchmarks live in tests/benchmarks/ and are split into two categories:
 *
 *   *.bench.ts  — performance measurement files (run via the CLI runner or
 *                 the `pnpm bench` script; NOT picked up by this config)
 *   *.test.ts   — unit tests for benchmark infrastructure (framework, reporter)
 *
 * This config is used by `pnpm test:bench` (or vitest run --config) to
 * execute only the infrastructure unit tests on CI without needing the full
 * benchmark runtime (which takes minutes per suite).
 *
 * Run with: pnpm --filter oneplatform test:bench
 *           vitest run --config tests/vitest.bench.config.ts
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests for the benchmark infrastructure AND the full benchmark suites.
    //
    // *.test.ts  — fast unit tests for framework.ts and reporter.ts, plus
    //              run-all.test.ts which runs all benchmark suites end-to-end.
    //
    // Path is relative to the vitest root (cwd = project root).
    include: ["tests/benchmarks/**/*.test.ts"],

    environment: "node",

    // Benchmark infrastructure tests are fast (<5s total); 15s timeout is
    // generous enough to avoid flakes on slow CI runners.
    testTimeout: 15_000,

    // Run sequentially to keep latency measurements stable on shared runners.
    pool: "forks",
    sequence: {
      concurrent: false,
    },
  },
});
