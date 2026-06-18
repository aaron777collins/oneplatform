/**
 * Ingestion service benchmarks.
 *
 * All dependencies are mocked in-process — no running PostgreSQL, Redis, or
 * BullMQ workers are required.  This makes the suite safe to run in CI on
 * every PR without docker-compose infrastructure.
 *
 * What is measured:
 *   - Batch insert throughput at different batch sizes (100 / 1K / 10K records)
 *   - Sync cycle latency — the validation, state-check, and queue-enqueue path
 *     inside triggerSync (the most common hot path for incremental syncs)
 *   - Concurrent sync throughput — N parallel triggerSync calls
 *   - Schema inference performance — inferring field schemas from records of
 *     varying complexity via the normalizeToEnvelope + schema extraction path
 */

import { runBenchmark, type BenchmarkResult } from "./framework.js";
import { normalizeToEnvelope, type DataRecord } from "../../services/ingestion/src/utils/data-envelope.js";

// ---------------------------------------------------------------------------
// Mock builder helpers — return the narrowest interface needed by each test so
// mocks don't need to implement every repository method.
// ---------------------------------------------------------------------------

interface MinimalRawTableRepo {
  upsertBatch(tableName: string, envelopes: ReturnType<typeof normalizeToEnvelope>[]): Promise<void>;
}

function buildRawTableRepo(): MinimalRawTableRepo {
  return {
    // Simulates the upsert round-trip cost without hitting a real database.
    // The mock is intentionally zero-delay: the benchmark measures the
    // overhead of envelope construction + repository call dispatch, not
    // PostgreSQL I/O (that belongs to integration benchmarks with a live DB).
    async upsertBatch(_tableName, _envelopes) {
      // No-op — measures pure CPU overhead of building envelope objects
    },
  };
}

function buildDataRecord(index: number, complexity: "simple" | "medium" | "complex"): DataRecord {
  const base: DataRecord = {
    sourceId: `record-${index}`,
    data: { id: index, name: `item-${index}` },
  };

  if (complexity === "medium") {
    base.data = {
      ...base.data,
      email: `user${index}@example.com`,
      createdAt: new Date().toISOString(),
      tags: ["tag-a", "tag-b"],
      meta: { source: "api", version: 2 },
    };
  }

  if (complexity === "complex") {
    base.data = {
      ...base.data,
      email: `user${index}@example.com`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ["tag-a", "tag-b", "tag-c"],
      meta: { source: "api", version: 2, flags: { active: true, verified: false } },
      address: {
        street: `${index} Main St`,
        city: "Anytown",
        zip: "12345",
        country: "US",
        geo: { lat: 40.7128, lng: -74.006 },
      },
      preferences: {
        notifications: { email: true, sms: false, push: true },
        theme: "dark",
        language: "en-US",
      },
      history: Array.from({ length: 5 }, (_, i) => ({
        eventType: `event-${i}`,
        timestamp: new Date().toISOString(),
        payload: { value: i * 10 },
      })),
    };
  }

  return base;
}

// Must be a valid RFC 4122 UUID (4th group first nibble in [89ab]).
// Using the DNS namespace UUID (5.0 predefined) as a stable benchmark fixture.
const CONNECTOR_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const TENANT_ID = "tenant-bench";
const BATCH_ID = "batch-bench-0001";

function buildEnvelopeContext() {
  return {
    connectorId: CONNECTOR_ID,
    connectorName: "benchmark-connector",
    batchId: BATCH_ID,
    tenantId: TENANT_ID,
    syncMode: "full" as const,
    cursor: null,
  };
}

// ---------------------------------------------------------------------------
// Benchmark: batch insert throughput at various sizes
// ---------------------------------------------------------------------------

async function batchInsertBenchmark(
  batchSize: number,
): Promise<BenchmarkResult> {
  const repo = buildRawTableRepo();
  const ctx = buildEnvelopeContext();

  const records = Array.from({ length: batchSize }, (_, i) =>
    buildDataRecord(i, "medium"),
  );

  return runBenchmark(
    `ingestion/batch-insert-${batchSize}`,
    async () => {
      const envelopes = records.map((r) => normalizeToEnvelope(r, ctx));
      await repo.upsertBatch(`raw_${CONNECTOR_ID.replace(/-/g, "_")}`, envelopes);
    },
    { iterations: 50, warmupIterations: 5, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Benchmark: sync cycle latency — triggerSync hot path
//
// triggerSync's critical path is:
//   1. Validate connector
//   2. Check sync-state for duplicate guard
//   3. Enqueue BullMQ job
//   4. Write Redis progress key
//
// We mock these four operations with async no-ops that approximate real
// round-trip latencies via microtask scheduling rather than actual I/O.
// This isolates the service's own orchestration overhead.
// ---------------------------------------------------------------------------

interface MinimalSyncStateDeps {
  findByConnectorId(id: string): Promise<{ status: string } | null>;
  updateStatus(id: string, status: string): Promise<void>;
}

interface MinimalConnectorRepoDeps {
  findById(id: string): Promise<{
    id: string;
    tenant_id: string;
    is_enabled: boolean;
    sync_mode: "full" | "incremental";
    plugin_id: string;
    instance_id: string;
    name: string;
    config: Record<string, unknown>;
  } | null>;
}

function buildSyncCycleDeps(): {
  connectorRepo: MinimalConnectorRepoDeps;
  syncStateRepo: MinimalSyncStateDeps;
  enqueuedJobs: number;
} {
  const state = { enqueuedJobs: 0 };

  return {
    connectorRepo: {
      async findById(id) {
        return {
          id,
          tenant_id: TENANT_ID,
          is_enabled: true,
          sync_mode: "incremental",
          plugin_id: "plugin-bench",
          instance_id: "instance-bench",
          name: "bench-connector",
          config: {},
        };
      },
    },
    syncStateRepo: {
      async findByConnectorId(_id) {
        return { status: "success" };
      },
      async updateStatus(_id, _status) {
        // no-op
      },
    },
    enqueuedJobs: state.enqueuedJobs,
  };
}

/** Inline reproduction of triggerSync's validation + dispatch logic. */
async function simulateTriggerSync(
  connectorId: string,
  tenantId: string,
  deps: ReturnType<typeof buildSyncCycleDeps>,
): Promise<void> {
  const connector = await deps.connectorRepo.findById(connectorId);
  if (connector === null || connector.tenant_id !== tenantId) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  if (!connector.is_enabled) {
    throw new Error(`Connector ${connectorId} is disabled`);
  }
  const syncState = await deps.syncStateRepo.findByConnectorId(connectorId);
  if (syncState?.status === "running") {
    throw new Error(`Sync already running for ${connectorId}`);
  }
  await deps.syncStateRepo.updateStatus(connectorId, "running");
  // Simulates BullMQ enqueue + Redis progress-key write as microtasks.
  await Promise.resolve();
  await Promise.resolve();
}

async function syncCycleLatencyBenchmark(): Promise<BenchmarkResult> {
  const deps = buildSyncCycleDeps();

  return runBenchmark(
    "ingestion/sync-cycle-latency",
    async () => {
      await simulateTriggerSync(CONNECTOR_ID, TENANT_ID, deps);
    },
    { iterations: 1000, warmupIterations: 50, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Benchmark: concurrent sync throughput
// ---------------------------------------------------------------------------

async function concurrentSyncThroughputBenchmark(): Promise<BenchmarkResult> {
  const deps = buildSyncCycleDeps();

  return runBenchmark(
    "ingestion/concurrent-sync-throughput",
    async () => {
      await simulateTriggerSync(CONNECTOR_ID, TENANT_ID, deps);
    },
    { iterations: 500, warmupIterations: 20, concurrency: 10 },
  );
}

// ---------------------------------------------------------------------------
// Benchmark: schema inference performance at various record complexities
// ---------------------------------------------------------------------------

/**
 * Schema inference is the process of extracting field names and types from a
 * batch of raw records to detect drift.  We benchmark the cost of iterating
 * over records and building the field type map that schemaDriftService uses.
 */
function inferSchema(records: DataRecord[]): Map<string, Set<string>> {
  const fieldTypes = new Map<string, Set<string>>();

  function visitValue(prefix: string, value: unknown): void {
    const type = value === null ? "null" : typeof value;

    if (!fieldTypes.has(prefix)) {
      fieldTypes.set(prefix, new Set());
    }
    fieldTypes.get(prefix)!.add(type);

    // Recurse into plain objects one level to capture nested field paths.
    // Arrays are treated as a single "array" type entry — this matches the
    // schema-drift-service behaviour for the flat snapshot stored in the DB.
    if (type === "object" && value !== null && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visitValue(`${prefix}.${k}`, v);
      }
    }
  }

  for (const record of records) {
    for (const [key, value] of Object.entries(record.data)) {
      visitValue(key, value);
    }
  }

  return fieldTypes;
}

async function schemaInferenceBenchmark(
  complexity: "simple" | "medium" | "complex",
  recordCount: number,
): Promise<BenchmarkResult> {
  const records = Array.from({ length: recordCount }, (_, i) =>
    buildDataRecord(i, complexity),
  );

  return runBenchmark(
    `ingestion/schema-inference-${complexity}-${recordCount}`,
    () => {
      inferSchema(records);
    },
    { iterations: 200, warmupIterations: 10, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Entry point — run all ingestion benchmarks and return results
// ---------------------------------------------------------------------------

export async function runIngestionBenchmarks(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Batch insert at 3 batch sizes
  results.push(await batchInsertBenchmark(100));
  results.push(await batchInsertBenchmark(1_000));
  results.push(await batchInsertBenchmark(10_000));

  // Sync cycle latency
  results.push(await syncCycleLatencyBenchmark());

  // Concurrent sync throughput
  results.push(await concurrentSyncThroughputBenchmark());

  // Schema inference at simple / medium / complex record shapes
  results.push(await schemaInferenceBenchmark("simple", 500));
  results.push(await schemaInferenceBenchmark("medium", 500));
  results.push(await schemaInferenceBenchmark("complex", 500));

  return results;
}
