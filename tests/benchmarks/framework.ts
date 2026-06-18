/**
 * Benchmark framework for OnePlatform performance measurements.
 *
 * Design goals:
 *   - Self-contained: no external services or databases required.
 *   - Statistical correctness: warmup iterations are discarded before
 *     computing latency percentiles so JIT compilation overhead does not
 *     skew production-representative numbers.
 *   - Concurrency aware: concurrent load is modelled with Promise.all
 *     worker pools that match the given concurrency setting.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
  /** Number of timed iterations to run after warmup. */
  iterations: number;
  /** Iterations to run before timing starts (JIT warmup). */
  warmupIterations: number;
  /** Number of parallel workers executing fn simultaneously. */
  concurrency: number;
}

export interface BenchmarkResult {
  name: string;
  iterations: number;
  concurrency: number;
  /** Wall-clock elapsed across all iterations in ms. */
  totalMs: number;
  /** Operations per second (iterations / totalMs * 1000). */
  throughputOpsPerSec: number;
  latency: {
    minMs: number;
    maxMs: number;
    meanMs: number;
    medianMs: number;
    p95Ms: number;
    p99Ms: number;
  };
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run a benchmark and return structured statistics.
 *
 * The function under test is called `options.iterations` times after
 * `options.warmupIterations` warmup calls are discarded.  When concurrency > 1
 * the timed batch dispatches `concurrency` parallel calls per "round" so that
 * throughput measurements reflect real concurrent pressure rather than serial
 * queue drain.
 */
export async function runBenchmark(
  name: string,
  fn: () => Promise<void> | void,
  options: BenchmarkOptions,
): Promise<BenchmarkResult> {
  if (options.iterations < 1) {
    throw new Error(`runBenchmark: iterations must be >= 1, got ${options.iterations}`);
  }
  if (options.warmupIterations < 0) {
    throw new Error(`runBenchmark: warmupIterations must be >= 0, got ${options.warmupIterations}`);
  }
  if (options.concurrency < 1) {
    throw new Error(`runBenchmark: concurrency must be >= 1, got ${options.concurrency}`);
  }

  // Warmup — discard timing so JIT compilation doesn't inflate latency numbers.
  for (let i = 0; i < options.warmupIterations; i++) {
    await fn();
  }

  const latencySamples: number[] = [];
  const wallStart = performance.now();

  if (options.concurrency === 1) {
    // Serial path: simplest, lowest overhead.
    for (let i = 0; i < options.iterations; i++) {
      const start = performance.now();
      await fn();
      latencySamples.push(performance.now() - start);
    }
  } else {
    // Concurrent path: dispatch workers in batches of `concurrency`.
    // Each worker records its own wall-clock latency independently so
    // per-operation measurements remain accurate under parallel load.
    let dispatched = 0;
    while (dispatched < options.iterations) {
      const batchSize = Math.min(options.concurrency, options.iterations - dispatched);
      const batchPromises: Promise<void>[] = [];

      for (let i = 0; i < batchSize; i++) {
        batchPromises.push(
          (async () => {
            const start = performance.now();
            await fn();
            latencySamples.push(performance.now() - start);
          })(),
        );
      }

      await Promise.all(batchPromises);
      dispatched += batchSize;
    }
  }

  const totalMs = performance.now() - wallStart;

  return {
    name,
    iterations: options.iterations,
    concurrency: options.concurrency,
    totalMs,
    throughputOpsPerSec: (options.iterations / totalMs) * 1000,
    latency: computeLatencyStats(latencySamples),
  };
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

function computeLatencyStats(samples: number[]): BenchmarkResult["latency"] {
  if (samples.length === 0) {
    throw new Error("computeLatencyStats: empty sample array");
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);

  return {
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: sum / sorted.length,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
  };
}

/**
 * Compute the p-th percentile of a pre-sorted sample array.
 *
 * Uses the nearest-rank method which avoids interpolation complexity while
 * remaining accurate enough for benchmark decision-making.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // nearest-rank: index = ceil(p/100 * n) - 1, clamped to valid range
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

// ---------------------------------------------------------------------------
// Formatting helpers — used by reporter.ts and direct console output
// ---------------------------------------------------------------------------

/**
 * Format a BenchmarkResult as a human-readable single-line summary.
 * The full table rendering lives in reporter.ts.
 */
export function formatResultSummary(result: BenchmarkResult): string {
  const throughput = result.throughputOpsPerSec.toFixed(1);
  const mean = result.latency.meanMs.toFixed(3);
  const p95 = result.latency.p95Ms.toFixed(3);
  const p99 = result.latency.p99Ms.toFixed(3);
  return (
    `${result.name}: ${throughput} ops/sec | ` +
    `mean=${mean}ms p95=${p95}ms p99=${p99}ms | ` +
    `${result.iterations} iters x${result.concurrency} concurrent`
  );
}
