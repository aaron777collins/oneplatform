/**
 * Unit tests for the benchmark framework.
 *
 * These tests verify that runBenchmark produces statistically correct output
 * without relying on wall-clock timing being accurate (we mock async
 * operations rather than testing real performance).
 */

import { describe, it, expect, vi } from "vitest";
import {
  runBenchmark,
  formatResultSummary,
  type BenchmarkResult,
} from "./framework.js";

// ---------------------------------------------------------------------------
// runBenchmark — structural and statistical correctness
// ---------------------------------------------------------------------------

describe("runBenchmark", () => {
  it("returns the correct iteration count", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const result = await runBenchmark("test", fn, {
      iterations: 10,
      warmupIterations: 3,
      concurrency: 1,
    });

    // 3 warmup + 10 timed = 13 total calls
    expect(fn).toHaveBeenCalledTimes(13);
    expect(result.iterations).toBe(10);
  });

  it("calls fn during warmup but excludes warmup from statistics", async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
    };

    const result = await runBenchmark("test", fn, {
      iterations: 5,
      warmupIterations: 2,
      concurrency: 1,
    });

    expect(callCount).toBe(7); // 2 warmup + 5 timed
    expect(result.iterations).toBe(5);
  });

  it("dispatches concurrency many workers per batch", async () => {
    // Track the maximum concurrent in-flight calls to verify concurrency semantics.
    let inFlight = 0;
    let maxInFlight = 0;

    const fn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); // yield once to allow parallel dispatch
      inFlight--;
    };

    await runBenchmark("test", fn, {
      iterations: 20,
      warmupIterations: 0,
      concurrency: 5,
    });

    // Each batch dispatches exactly concurrency workers simultaneously.
    expect(maxInFlight).toBe(5);
  });

  it("produces latency stats where min <= median <= p95 <= p99 <= max", async () => {
    // Simulate variable-duration operations so all percentile ranks differ.
    let counter = 0;
    const fn = async () => {
      // Alternate fast/slow iterations to produce a non-trivial distribution.
      if (counter % 10 === 0) {
        await new Promise<void>((r) => setTimeout(r, 1));
      }
      counter++;
    };

    const result = await runBenchmark("test", fn, {
      iterations: 50,
      warmupIterations: 5,
      concurrency: 1,
    });

    const { minMs, medianMs, p95Ms, p99Ms, maxMs } = result.latency;
    expect(minMs).toBeGreaterThanOrEqual(0);
    expect(medianMs).toBeGreaterThanOrEqual(minMs);
    expect(p95Ms).toBeGreaterThanOrEqual(medianMs);
    expect(p99Ms).toBeGreaterThanOrEqual(p95Ms);
    expect(maxMs).toBeGreaterThanOrEqual(p99Ms);
  });

  it("computes throughput as iterations / totalMs * 1000", async () => {
    // Use a synchronous no-op to get predictable near-zero latency and ensure
    // the throughput formula is verified independently of timing accuracy.
    const result = await runBenchmark("test", () => {}, {
      iterations: 100,
      warmupIterations: 0,
      concurrency: 1,
    });

    const expectedThroughput = (result.iterations / result.totalMs) * 1000;
    expect(result.throughputOpsPerSec).toBeCloseTo(expectedThroughput, 5);
  });

  it("stores the concurrency setting in the result", async () => {
    const result = await runBenchmark("test", () => {}, {
      iterations: 10,
      warmupIterations: 0,
      concurrency: 4,
    });

    expect(result.concurrency).toBe(4);
  });

  it("sets the benchmark name on the result", async () => {
    const result = await runBenchmark("my-benchmark-name", () => {}, {
      iterations: 5,
      warmupIterations: 0,
      concurrency: 1,
    });

    expect(result.name).toBe("my-benchmark-name");
  });
});

// ---------------------------------------------------------------------------
// runBenchmark — input validation
// ---------------------------------------------------------------------------

describe("runBenchmark input validation", () => {
  it("throws when iterations < 1", async () => {
    await expect(
      runBenchmark("bad", () => {}, { iterations: 0, warmupIterations: 0, concurrency: 1 }),
    ).rejects.toThrow("iterations must be >= 1");
  });

  it("throws when warmupIterations < 0", async () => {
    await expect(
      runBenchmark("bad", () => {}, { iterations: 1, warmupIterations: -1, concurrency: 1 }),
    ).rejects.toThrow("warmupIterations must be >= 0");
  });

  it("throws when concurrency < 1", async () => {
    await expect(
      runBenchmark("bad", () => {}, { iterations: 1, warmupIterations: 0, concurrency: 0 }),
    ).rejects.toThrow("concurrency must be >= 1");
  });
});

// ---------------------------------------------------------------------------
// formatResultSummary
// ---------------------------------------------------------------------------

describe("formatResultSummary", () => {
  it("includes the benchmark name", () => {
    const result: BenchmarkResult = {
      name: "my-benchmark",
      iterations: 100,
      concurrency: 1,
      totalMs: 1000,
      throughputOpsPerSec: 100,
      latency: { minMs: 1, maxMs: 20, meanMs: 5, medianMs: 4, p95Ms: 15, p99Ms: 18 },
    };

    expect(formatResultSummary(result)).toContain("my-benchmark");
  });

  it("includes throughput", () => {
    const result: BenchmarkResult = {
      name: "bench",
      iterations: 100,
      concurrency: 2,
      totalMs: 500,
      throughputOpsPerSec: 200,
      latency: { minMs: 1, maxMs: 10, meanMs: 5, medianMs: 4, p95Ms: 9, p99Ms: 9.5 },
    };

    const summary = formatResultSummary(result);
    expect(summary).toContain("200.0 ops/sec");
    expect(summary).toContain("x2 concurrent");
  });

  it("includes p95 and p99 latency", () => {
    const result: BenchmarkResult = {
      name: "bench",
      iterations: 50,
      concurrency: 1,
      totalMs: 250,
      throughputOpsPerSec: 200,
      latency: { minMs: 1, maxMs: 15, meanMs: 5, medianMs: 4, p95Ms: 12.5, p99Ms: 14.1 },
    };

    const summary = formatResultSummary(result);
    expect(summary).toContain("p95=12.500ms");
    expect(summary).toContain("p99=14.100ms");
  });
});
