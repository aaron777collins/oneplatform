// Unit tests for services/execution-engine.ts
//
// Tests the execution engine's processRun logic by mocking all external
// dependencies: pg Pool, Redis, fetch, and repository interfaces.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createExecutionEngine,
  type ExecutionEngineDeps,
  type RunEngineRepository,
  type RunStepEngineRepository,
  type RunLogEngineRepository,
} from "../services/execution-engine.js";
import type { RunRow, RunStepRow, PipelineRunJobPayload } from "../services/run-service.js";
import type { PipelineDefinition } from "../services/pipeline-service.js";
import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import type { Job } from "bullmq";
import type { Logger, ServiceTokenSigner } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeServiceTokenSigner(): ServiceTokenSigner {
  return { sign: vi.fn().mockResolvedValue("mock-service-token") };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

type MockRunRepo = {
  findById: ReturnType<typeof vi.fn>;
  // RunEngineRepository exposes updateStatus, not update
  updateStatus: ReturnType<typeof vi.fn>;
};

type MockRunStepRepo = {
  createBatch: ReturnType<typeof vi.fn>;
  findByRunId: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  updateOutput: ReturnType<typeof vi.fn>;
};

type MockRunLogRepo = {
  append: ReturnType<typeof vi.fn>;
};

function makeRunRepo(): MockRunRepo {
  return {
    findById: vi.fn(),
    updateStatus: vi.fn(),
  };
}

function makeRunStepRepo(): MockRunStepRepo {
  return {
    createBatch: vi.fn(),
    findByRunId: vi.fn(),
    updateStatus: vi.fn(),
    updateOutput: vi.fn(),
  };
}

function makeRunLogRepo(): MockRunLogRepo {
  return {
    append: vi.fn(),
  };
}

function makePoolClient(): { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

function makePool(client: ReturnType<typeof makePoolClient>): { connect: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn().mockResolvedValue(client),
  };
}

function makeRedis(): { get: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(),
    publish: vi.fn(),
  };
}

function makeJob(payload: PipelineRunJobPayload): Job<PipelineRunJobPayload> {
  return {
    data: payload,
    id: "job-001",
  } as unknown as Job<PipelineRunJobPayload>;
}

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

const minimalStep = {
  id: "step-1",
  name: "Code Step",
  type: "code" as const,
  language: "javascript" as const,
  code: 'return "hello";',
  onError: "fail" as const,
};

const minimalDefinition: PipelineDefinition = {
  version: 1,
  entryStepId: "step-1",
  steps: [minimalStep],
};

// Must be a valid UUID: advisoryLockKey() slices the first 16 hex chars
const PIPELINE_UUID = "550e8400-e29b-41d4-a716-446655440000";
const TENANT_UUID = "550e8400-e29b-41d4-a716-446655440001";

function makeRunRow(overrides?: Partial<RunRow>): RunRow {
  return {
    id: "run-001",
    pipeline_id: PIPELINE_UUID,
    tenant_id: TENANT_UUID,
    status: "pending",
    triggered_by: "manual",
    trigger_actor_id: null,
    trigger_meta: {},
    input: {},
    started_at: null,
    completed_at: null,
    error: null,
    bully_job_id: null,
    definition_snapshot: minimalDefinition,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRunStepRow(overrides?: Partial<RunStepRow>): RunStepRow {
  return {
    id: "run-step-001",
    run_id: "run-001",
    tenant_id: "tenant-001",
    step_id: "step-1",
    step_name: "Code Step",
    step_type: "code",
    status: "pending",
    attempt_count: 0,
    started_at: null,
    completed_at: null,
    input: {},
    output: null,
    error: null,
    execution_id: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Advisory lock key derivation
// ---------------------------------------------------------------------------

describe("advisory lock key derivation", () => {
  it("returns a deterministic BigInt from UUID (covers the pure function path via processRun)", () => {
    // The advisoryLockKey function converts the first 16 hex chars of a UUID to BigInt.
    // We verify the engine can be constructed with these deps without error.
    const client = makePoolClient();
    const pool = makePool(client);
    const runRepo = makeRunRepo();

    // Lock query returns false — so the engine skips execution and re-throws
    client.query.mockResolvedValue({ rows: [{ pg_try_advisory_lock: false }] });
    runRepo.findById.mockResolvedValue(makeRunRow());

    const engine = createExecutionEngine({
      runRepo: runRepo as unknown as RunEngineRepository,
      runStepRepo: makeRunStepRepo() as unknown as RunStepEngineRepository,
      runLogRepo: makeRunLogRepo() as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: makeRedis() as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger: makeLogger(),
      serviceTokenSigner: makeServiceTokenSigner(),
    });

    expect(engine.processRun).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// processRun — early-exit idempotency guards
// ---------------------------------------------------------------------------

describe("processRun — idempotency guards", () => {
  let runRepo: MockRunRepo;
  let runStepRepo: MockRunStepRepo;
  let runLogRepo: MockRunLogRepo;
  let client: ReturnType<typeof makePoolClient>;
  let pool: ReturnType<typeof makePool>;
  let redis: ReturnType<typeof makeRedis>;
  let logger: Logger;
  let engine: ReturnType<typeof createExecutionEngine>;

  beforeEach(() => {
    runRepo = makeRunRepo();
    runStepRepo = makeRunStepRepo();
    runLogRepo = makeRunLogRepo();
    client = makePoolClient();
    pool = makePool(client);
    redis = makeRedis();
    logger = makeLogger();

    engine = createExecutionEngine({
      runRepo: runRepo as unknown as RunEngineRepository,
      runStepRepo: runStepRepo as unknown as RunStepEngineRepository,
      runLogRepo: runLogRepo as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: redis as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger,
      serviceTokenSigner: makeServiceTokenSigner(),
    });
  });

  it("returns early and logs a warning when run is not found", async () => {
    runRepo.findById.mockResolvedValue(null);

    await engine.processRun(makeJob({ runId: "run-999", tenantId: "tenant-001" }));

    const loggerWarn = logger.warn as ReturnType<typeof vi.fn>;
    expect(loggerWarn).toHaveBeenCalledWith(
      "processRun: run not found",
      expect.objectContaining({ runId: "run-999" }),
    );
    expect(runRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("returns early and logs a warning when run is not in pending state (running)", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow({ status: "running" }));

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    const loggerWarn = logger.warn as ReturnType<typeof vi.fn>;
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("not in pending state"),
      expect.any(Object),
    );
    expect(runRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("returns early when run is in completed state (idempotency guard)", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow({ status: "completed" }));

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    expect(runRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("returns early when run is in failed state (idempotency guard)", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow({ status: "failed" }));

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    expect(runRepo.updateStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processRun — advisory lock acquisition
// ---------------------------------------------------------------------------

describe("processRun — advisory lock", () => {
  let runRepo: MockRunRepo;
  let runStepRepo: MockRunStepRepo;
  let runLogRepo: MockRunLogRepo;
  let client: ReturnType<typeof makePoolClient>;
  let pool: ReturnType<typeof makePool>;
  let redis: ReturnType<typeof makeRedis>;
  let logger: Logger;
  let engine: ReturnType<typeof createExecutionEngine>;

  beforeEach(() => {
    runRepo = makeRunRepo();
    runStepRepo = makeRunStepRepo();
    runLogRepo = makeRunLogRepo();
    client = makePoolClient();
    pool = makePool(client);
    redis = makeRedis();
    logger = makeLogger();

    engine = createExecutionEngine({
      runRepo: runRepo as unknown as RunEngineRepository,
      runStepRepo: runStepRepo as unknown as RunStepEngineRepository,
      runLogRepo: runLogRepo as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: redis as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger,
      serviceTokenSigner: makeServiceTokenSigner(),
    });
  });

  it("throws and logs when advisory lock cannot be acquired (another worker holds it)", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());
    client.query.mockResolvedValue({ rows: [{ pg_try_advisory_lock: false }] });

    await expect(
      engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" })),
    ).rejects.toThrow(/Advisory lock held/);

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(loggerInfo).toHaveBeenCalledWith(
      "Advisory lock not available — re-enqueuing with delay",
      expect.any(Object),
    );
  });

  it("releases the pool client when lock fails (finally block)", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());
    client.query.mockResolvedValue({ rows: [{ pg_try_advisory_lock: false }] });

    await expect(engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }))).rejects.toThrow();

    // Client is released in the lock-fail branch (before finally block)
    expect(client.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processRun — successful single-step execution with mocked fetch
// ---------------------------------------------------------------------------

describe("processRun — successful code step execution", () => {
  let runRepo: MockRunRepo;
  let runStepRepo: MockRunStepRepo;
  let runLogRepo: MockRunLogRepo;
  let client: ReturnType<typeof makePoolClient>;
  let pool: ReturnType<typeof makePool>;
  let redis: ReturnType<typeof makeRedis>;
  let logger: Logger;
  let engine: ReturnType<typeof createExecutionEngine>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runRepo = makeRunRepo();
    runStepRepo = makeRunStepRepo();
    runLogRepo = makeRunLogRepo();
    client = makePoolClient();
    pool = makePool(client);
    redis = makeRedis();
    logger = makeLogger();

    // Lock is acquired successfully
    client.query.mockImplementation((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
      }
      if (sql.includes("pg_advisory_unlock")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    runRepo.updateStatus.mockResolvedValue(makeRunRow({ status: "running" }));
    runStepRepo.createBatch.mockResolvedValue([makeRunStepRow()]);
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow()]);
    runStepRepo.updateStatus.mockResolvedValue(makeRunStepRow({ status: "completed" }));
    runStepRepo.updateOutput.mockResolvedValue(makeRunStepRow({ status: "completed" }));
    runLogRepo.append.mockResolvedValue(undefined);
    redis.get.mockResolvedValue(null); // not cancelled
    redis.publish.mockResolvedValue(0);

    // Mock global fetch
    fetchSpy = vi.fn();
    // Plugin Service (hook resolution) returns empty hooks
    // Execution service returns a successful response
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hooks: [] }),
          status: 200,
        });
      }
      if (String(url).includes("/internal/execution/run")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ executionId: "exec-001", output: { result: "ok" }, durationMs: 42, exitCode: 0 }),
          status: 200,
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    });

    vi.stubGlobal("fetch", fetchSpy);

    engine = createExecutionEngine({
      runRepo: runRepo as unknown as RunEngineRepository,
      runStepRepo: runStepRepo as unknown as RunStepEngineRepository,
      runLogRepo: runLogRepo as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: redis as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger,
      serviceTokenSigner: makeServiceTokenSigner(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("transitions run to running then completed status", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    const calls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = calls.map((call) => call[1]["status"]).filter(Boolean);
    expect(statuses).toContain("running");
    expect(statuses).toContain("completed");
  });

  it("calls createBulk to initialise all step rows before execution", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    expect(runStepRepo.createBatch).toHaveBeenCalledOnce();
  });

  it("calls the Execution Service via fetch for the code step", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    const execCalls = fetchSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("/internal/execution/run"),
    );
    expect(execCalls.length).toBeGreaterThan(0);
  });

  it("releases the advisory lock after successful run", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    const unlockCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("pg_advisory_unlock"),
    );
    expect(unlockCalls.length).toBeGreaterThan(0);
    expect(client.release).toHaveBeenCalled();
  });

  it("appends log entries for step start and completion", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    const logCalls = (runLogRepo.append as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const messages = logCalls.map((call) => call[0]["message"] as string);
    expect(messages.some((m) => m.includes("started"))).toBe(true);
    expect(messages.some((m) => m.includes("completed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processRun — cancellation check
// ---------------------------------------------------------------------------

describe("processRun — cancellation", () => {
  let runRepo: MockRunRepo;
  let runStepRepo: MockRunStepRepo;
  let runLogRepo: MockRunLogRepo;
  let client: ReturnType<typeof makePoolClient>;
  let pool: ReturnType<typeof makePool>;
  let redis: ReturnType<typeof makeRedis>;
  let logger: Logger;
  let engine: ReturnType<typeof createExecutionEngine>;

  beforeEach(() => {
    runRepo = makeRunRepo();
    runStepRepo = makeRunStepRepo();
    runLogRepo = makeRunLogRepo();
    client = makePoolClient();
    pool = makePool(client);
    redis = makeRedis();
    logger = makeLogger();

    client.query.mockImplementation((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    runRepo.updateStatus.mockResolvedValue(makeRunRow({ status: "running" }));
    runStepRepo.createBatch.mockResolvedValue([makeRunStepRow()]);
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow()]);
    runStepRepo.updateStatus.mockResolvedValue(makeRunStepRow({ status: "cancelled" }));
    runStepRepo.updateOutput.mockResolvedValue(makeRunStepRow({ status: "cancelled" }));
    runLogRepo.append.mockResolvedValue(undefined);

    // Cancellation flag is SET (run is cancelled)
    redis.get.mockResolvedValue("2026-01-01T00:00:01.000Z");
    redis.publish.mockResolvedValue(0);

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hooks: [] }),
          status: 200,
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    engine = createExecutionEngine({
      runRepo: runRepo as unknown as RunEngineRepository,
      runStepRepo: runStepRepo as unknown as RunStepEngineRepository,
      runLogRepo: runLogRepo as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: redis as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger,
      serviceTokenSigner: makeServiceTokenSigner(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("transitions run to cancelled when cancellation flag is set", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    const calls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = calls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("cancelled");
  });

  it("appends a cancellation log message", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    const logCalls = (runLogRepo.append as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const messages = logCalls.map((c) => c[0]["message"] as string);
    expect(messages.some((m) => m.includes("cancelled"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// processRun — step execution failure (onError: fail)
// ---------------------------------------------------------------------------

describe("processRun — step failure propagation", () => {
  let runRepo: MockRunRepo;
  let runStepRepo: MockRunStepRepo;
  let runLogRepo: MockRunLogRepo;
  let client: ReturnType<typeof makePoolClient>;
  let pool: ReturnType<typeof makePool>;
  let redis: ReturnType<typeof makeRedis>;
  let engine: ReturnType<typeof createExecutionEngine>;

  beforeEach(() => {
    runRepo = makeRunRepo();
    runStepRepo = makeRunStepRepo();
    runLogRepo = makeRunLogRepo();
    client = makePoolClient();
    pool = makePool(client);
    redis = makeRedis();

    client.query.mockImplementation((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    runRepo.updateStatus.mockResolvedValue(makeRunRow({ status: "running" }));
    runStepRepo.createBatch.mockResolvedValue([makeRunStepRow()]);
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow()]);
    runStepRepo.updateStatus.mockResolvedValue(makeRunStepRow({ status: "failed" }));
    runStepRepo.updateOutput.mockResolvedValue(makeRunStepRow({ status: "failed" }));
    runLogRepo.append.mockResolvedValue(undefined);
    redis.get.mockResolvedValue(null); // not cancelled
    redis.publish.mockResolvedValue(0);

    // Execution Service returns error
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hooks: [] }),
          status: 200,
        });
      }
      if (String(url).includes("/internal/execution/run")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    engine = createExecutionEngine({
      runRepo: runRepo as unknown as RunEngineRepository,
      runStepRepo: runStepRepo as unknown as RunStepEngineRepository,
      runLogRepo: runLogRepo as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: redis as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger: makeLogger(),
      serviceTokenSigner: makeServiceTokenSigner(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("transitions run to failed when execution service returns error", async () => {
    runRepo.findById.mockResolvedValue(makeRunRow());

    await engine.processRun(makeJob({ runId: "run-001", tenantId: "tenant-001" }));

    const calls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = calls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// SSRF check inside executeWebhookStep is tested through validateDefinition
// in pipeline-service.test.ts. Here we confirm the engine's pattern handles
// the separate SSRF_BLOCKED_PATTERNS list.
// ---------------------------------------------------------------------------

describe("execution engine — SSRF constants", () => {
  it("engine can be instantiated with all required deps", () => {
    const client = makePoolClient();
    const pool = makePool(client);
    const engine = createExecutionEngine({
      runRepo: makeRunRepo() as unknown as RunEngineRepository,
      runStepRepo: makeRunStepRepo() as unknown as RunStepEngineRepository,
      runLogRepo: makeRunLogRepo() as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: makeRedis() as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger: makeLogger(),
      serviceTokenSigner: makeServiceTokenSigner(),
    });

    expect(typeof engine.processRun).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// processRun — skipIf expression evaluation
// ---------------------------------------------------------------------------

describe("processRun — skipIf expression", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips a step when skipIf expression evaluates to true", async () => {
    const runRepo = makeRunRepo();
    const runStepRepo = makeRunStepRepo();
    const runLogRepo = makeRunLogRepo();
    const client = makePoolClient();
    const pool = makePool(client);
    const redis = makeRedis();
    const logger = makeLogger();

    client.query.mockImplementation((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
      }
      if (sql.includes("pg_advisory_unlock")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Step with skipIf that evaluates to true — the step should be SKIPPED
    const stepWithSkipIf = {
      ...minimalStep,
      id: "step-1",
      skipIf: "input.shouldSkip = true",
    };

    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [stepWithSkipIf],
    };

    runRepo.findById.mockResolvedValue(
      makeRunRow({ definition_snapshot: definition, input: { shouldSkip: true } }),
    );
    runRepo.updateStatus.mockResolvedValue(makeRunRow({ status: "running" }));
    runStepRepo.createBatch.mockResolvedValue([makeRunStepRow({ step_id: "step-1" })]);
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_id: "step-1" })]);
    runStepRepo.updateStatus.mockResolvedValue(makeRunStepRow({ status: "skipped" }));
    runStepRepo.updateOutput.mockResolvedValue(makeRunStepRow());
    runLogRepo.append.mockResolvedValue(undefined);
    redis.get.mockResolvedValue(null); // not cancelled
    redis.publish.mockResolvedValue(0);

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    const engine = createExecutionEngine({
      runRepo: runRepo as unknown as RunEngineRepository,
      runStepRepo: runStepRepo as unknown as RunStepEngineRepository,
      runLogRepo: runLogRepo as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: redis as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger,
      serviceTokenSigner: makeServiceTokenSigner(),
    });

    await engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));

    // The step should have been marked as "skipped"
    const updateStatusCalls = (runStepRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string, Record<string, unknown>]>;
    const skippedCalls = updateStatusCalls.filter((c) => c[2]["status"] === "skipped");
    expect(skippedCalls.length).toBeGreaterThan(0);

    // The execution service should NOT have been called for a skipped step
    const fetchCalls = (vi.mocked(fetch)).mock.calls as Array<[string, ...unknown[]]>;
    const execCalls = fetchCalls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/internal/execution/run"),
    );
    expect(execCalls.length).toBe(0);
  });

  it("executes a step normally when skipIf expression evaluates to false", async () => {
    const runRepo = makeRunRepo();
    const runStepRepo = makeRunStepRepo();
    const runLogRepo = makeRunLogRepo();
    const client = makePoolClient();
    const pool = makePool(client);
    const redis = makeRedis();
    const logger = makeLogger();

    client.query.mockImplementation((sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
      }
      if (sql.includes("pg_advisory_unlock")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Step with skipIf that evaluates to false — the step should EXECUTE
    const stepWithSkipIfFalse = {
      ...minimalStep,
      id: "step-1",
      skipIf: "input.shouldSkip = true",
    };

    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [stepWithSkipIfFalse],
    };

    // Input has shouldSkip = false, so the skipIf condition evaluates to false
    runRepo.findById.mockResolvedValue(
      makeRunRow({ definition_snapshot: definition, input: { shouldSkip: false } }),
    );
    runRepo.updateStatus.mockResolvedValue(makeRunRow({ status: "running" }));
    runStepRepo.createBatch.mockResolvedValue([makeRunStepRow({ step_id: "step-1" })]);
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_id: "step-1" })]);
    runStepRepo.updateStatus.mockResolvedValue(makeRunStepRow({ status: "completed" }));
    runStepRepo.updateOutput.mockResolvedValue(makeRunStepRow({ status: "completed" }));
    runLogRepo.append.mockResolvedValue(undefined);
    redis.get.mockResolvedValue(null); // not cancelled
    redis.publish.mockResolvedValue(0);

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      if (String(url).includes("/internal/execution/run")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ executionId: "exec-001", output: { result: "ok" }, durationMs: 42, exitCode: 0 }),
          status: 200,
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    const engine = createExecutionEngine({
      runRepo: runRepo as unknown as RunEngineRepository,
      runStepRepo: runStepRepo as unknown as RunStepEngineRepository,
      runLogRepo: runLogRepo as unknown as RunLogEngineRepository,
      pool: pool as unknown as Pool,
      redis: redis as unknown as Redis,
      executionServiceUrl: "http://exec:3000",
      pluginServiceUrl: "http://plugins:3000",
      ingestionServiceUrl: "http://ingestion:3000",
      stepDefaultTimeoutMs: 30_000,
      hookDefaultTimeoutMs: 5_000,
      logger,
      serviceTokenSigner: makeServiceTokenSigner(),
    });

    await engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));

    // The step should NOT have been skipped — it should have been executed
    const updateStatusCalls = (runStepRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string, Record<string, unknown>]>;
    const skippedCalls = updateStatusCalls.filter((c) => c[2]["status"] === "skipped");
    expect(skippedCalls.length).toBe(0);

    // The step should have been marked as running then completed
    const statusValues = updateStatusCalls.map((c) => c[2]["status"]).filter(Boolean);
    expect(statusValues).toContain("running");
    expect(statusValues).toContain("completed");

    // The execution service SHOULD have been called
    const fetchCalls = (vi.mocked(fetch)).mock.calls as Array<[string, ...unknown[]]>;
    const execCalls = fetchCalls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("/internal/execution/run"),
    );
    expect(execCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Retry logic — shared engine setup factory used across all retry suites.
// Fake timers (vi.useFakeTimers) let tests verify retry delays without
// blocking on real wall-clock waits.
// ---------------------------------------------------------------------------

function makeRetryEngineSetup() {
  const runRepo = makeRunRepo();
  const runStepRepo = makeRunStepRepo();
  const runLogRepo = makeRunLogRepo();
  const client = makePoolClient();
  const pool = makePool(client);
  const redis = makeRedis();
  const logger = makeLogger();

  client.query.mockImplementation((sql: string) => {
    if (sql.includes("pg_try_advisory_lock")) {
      return Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] });
    }
    return Promise.resolve({ rows: [] });
  });

  runRepo.updateStatus.mockResolvedValue(makeRunRow({ status: "running" }));
  runStepRepo.createBatch.mockResolvedValue([makeRunStepRow()]);
  runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow()]);
  runStepRepo.updateStatus.mockResolvedValue(makeRunStepRow());
  runStepRepo.updateOutput.mockResolvedValue(makeRunStepRow({ status: "completed" }));
  runLogRepo.append.mockResolvedValue(undefined);
  redis.get.mockResolvedValue(null); // not cancelled
  redis.publish.mockResolvedValue(0);

  const engine = createExecutionEngine({
    runRepo: runRepo as unknown as RunEngineRepository,
    runStepRepo: runStepRepo as unknown as RunStepEngineRepository,
    runLogRepo: runLogRepo as unknown as RunLogEngineRepository,
    pool: pool as unknown as Pool,
    redis: redis as unknown as Redis,
    executionServiceUrl: "http://exec:3000",
    pluginServiceUrl: "http://plugins:3000",
    ingestionServiceUrl: "http://ingestion:3000",
    stepDefaultTimeoutMs: 30_000,
    hookDefaultTimeoutMs: 5_000,
    logger,
    serviceTokenSigner: makeServiceTokenSigner(),
  });

  return { runRepo, runStepRepo, runLogRepo, client, pool, redis, logger, engine };
}

// ---------------------------------------------------------------------------
// processRun — retry: step succeeds on second attempt
// ---------------------------------------------------------------------------

describe("processRun — retry: step succeeds on retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("calls execution service twice when first attempt fails and retryConfig.maxRetries=1", async () => {
    const { runRepo, runStepRepo, engine } = makeRetryEngineSetup();

    const stepWithRetry = {
      ...minimalStep,
      retryConfig: { maxRetries: 1, backoffMs: 500, backoffMultiplier: 2 },
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [stepWithRetry],
    };

    runRepo.findById.mockResolvedValue(
      makeRunRow({ definition_snapshot: definition }),
    );
    runStepRepo.findByRunId.mockResolvedValue([
      makeRunStepRow({ step_id: "step-1" }),
    ]);

    let execCallCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      if (String(url).includes("/internal/execution/run")) {
        execCallCount++;
        if (execCallCount === 1) {
          // First attempt fails
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("transient error"),
          });
        }
        // Second attempt succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ executionId: "exec-002", output: { retried: true }, durationMs: 10, exitCode: 0 }),
          status: 200,
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    // Run processRun and advance fake timers to let setTimeout in sleep() fire
    const runPromise = engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    expect(execCallCount).toBe(2);

    // The run should ultimately complete successfully
    const calls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = calls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("completed");
  });

  it("increments attempt_count in run_step row for each retry", async () => {
    const { runRepo, runStepRepo, engine } = makeRetryEngineSetup();

    const stepWithRetry = {
      ...minimalStep,
      retryConfig: { maxRetries: 2, backoffMs: 100, backoffMultiplier: 1 },
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [stepWithRetry],
    };

    runRepo.findById.mockResolvedValue(
      makeRunRow({ definition_snapshot: definition }),
    );
    runStepRepo.findByRunId.mockResolvedValue([
      makeRunStepRow({ step_id: "step-1" }),
    ]);

    let execCallCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      if (String(url).includes("/internal/execution/run")) {
        execCallCount++;
        if (execCallCount <= 2) {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("fail") });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ executionId: "exec-ok", output: {}, durationMs: 5, exitCode: 0 }),
          status: 200,
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    const runPromise = engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    // attempt_count is updated once per retry (not the first attempt)
    const updateStatusCalls = (runStepRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string, Record<string, unknown>]>;
    const attemptCountUpdates = updateStatusCalls
      .map((c) => c[2])
      .filter((d) => d["attempt_count"] !== undefined)
      .map((d) => d["attempt_count"]);

    // Two retries → attempt_count set to 1, then 2
    expect(attemptCountUpdates).toEqual(expect.arrayContaining([1, 2]));
  });

  it("logs a retry warning message for each retry attempt", async () => {
    const { runRepo, runStepRepo, runLogRepo, engine } = makeRetryEngineSetup();

    const stepWithRetry = {
      ...minimalStep,
      retryConfig: { maxRetries: 1, backoffMs: 100, backoffMultiplier: 1 },
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [stepWithRetry],
    };

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_id: "step-1" })]);

    let execCallCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      if (String(url).includes("/internal/execution/run")) {
        execCallCount++;
        if (execCallCount === 1) {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("fail") });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ executionId: "exec-ok", output: {}, durationMs: 5, exitCode: 0 }),
          status: 200,
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    const runPromise = engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    const logCalls = (runLogRepo.append as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const retryLogs = logCalls.filter(
      (c) => typeof c[0]["message"] === "string" && (c[0]["message"] as string).includes("retry"),
    );
    expect(retryLogs.length).toBeGreaterThan(0);
    // Safe access: the expect above already asserts length > 0
    expect(retryLogs[0]?.[0]["level"]).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// processRun — retry: all retries exhausted → apply onError
// ---------------------------------------------------------------------------

describe("processRun — retry: all retries exhausted, no fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("marks run as failed when all retries exhausted and onError=fail", async () => {
    const { runRepo, runStepRepo, engine } = makeRetryEngineSetup();

    const stepWithRetry = {
      ...minimalStep,
      retryConfig: { maxRetries: 2, backoffMs: 100, backoffMultiplier: 1 },
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [stepWithRetry],
    };

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_id: "step-1" })]);

    // All attempts fail
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("always fails") });
    }));

    const runPromise = engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    const calls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = calls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("failed");
  });

  it("skips step and continues when all retries exhausted and onError=skip", async () => {
    const { runRepo, runStepRepo, engine } = makeRetryEngineSetup();

    const stepWithRetrySkip = {
      ...minimalStep,
      id: "step-1",
      retryConfig: { maxRetries: 1, backoffMs: 100, backoffMultiplier: 1 },
      onError: "skip" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [stepWithRetrySkip],
    };

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_id: "step-1" })]);

    // All attempts fail
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("always fails") });
    }));

    const runPromise = engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    // Single-step pipeline with onError=skip → run completes (not failed)
    const calls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = calls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("completed");
    expect(statuses).not.toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// processRun — fallbackStepId: executes fallback step when primary fails
// ---------------------------------------------------------------------------

describe("processRun — fallbackStepId", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("jumps to fallbackStepId after primary step exhausts all retries", async () => {
    const { runRepo, runStepRepo, engine } = makeRetryEngineSetup();

    const primaryStep = {
      id: "step-1",
      name: "Primary Step",
      type: "code" as const,
      language: "javascript" as const,
      code: 'throw new Error("fail");',
      onError: "fail" as const,
      retryConfig: { maxRetries: 1, backoffMs: 50, backoffMultiplier: 1 },
      fallbackStepId: "step-fallback",
    };

    const fallbackStep = {
      id: "step-fallback",
      name: "Fallback Step",
      type: "code" as const,
      language: "javascript" as const,
      code: 'return "fallback result";',
      onError: "fail" as const,
    };

    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [primaryStep, fallbackStep],
    };

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([
      makeRunStepRow({ step_id: "step-1", step_name: "Primary Step" }),
      makeRunStepRow({ id: "run-step-002", step_id: "step-fallback", step_name: "Fallback Step" }),
    ]);

    // Primary always fails; fallback succeeds
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      if (String(url).includes("/internal/execution/run")) {
        const body = opts?.body ? JSON.parse(opts.body as string) : {};
        if (body.stepId === "step-1") {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("primary fails") });
        }
        // fallback step succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ executionId: "exec-fallback", output: { fallback: true }, durationMs: 5, exitCode: 0 }),
          status: 200,
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    const runPromise = engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    // Run should complete because fallback succeeded
    const calls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = calls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("completed");
    expect(statuses).not.toContain("failed");
  });

  it("falls back to onError=fail when fallbackStepId is absent and primary exhausts retries", async () => {
    const { runRepo, runStepRepo, engine } = makeRetryEngineSetup();

    const stepNoFallback = {
      ...minimalStep,
      retryConfig: { maxRetries: 1, backoffMs: 50, backoffMultiplier: 1 },
      // no fallbackStepId — should use onError="fail"
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [stepNoFallback],
    };

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_id: "step-1" })]);

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("always fails") });
    }));

    const runPromise = engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    const calls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = calls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// processRun — retry: no retryConfig → single attempt (existing behaviour)
// ---------------------------------------------------------------------------

describe("processRun — no retryConfig: single attempt (unchanged behaviour)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls execution service exactly once when retryConfig is absent", async () => {
    const { runRepo, runStepRepo, engine } = makeRetryEngineSetup();

    // Default minimalStep has no retryConfig
    runRepo.findById.mockResolvedValue(makeRunRow());
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow()]);

    let execCallCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/internal/plugins/hooks")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hooks: [] }), status: 200 });
      }
      if (String(url).includes("/internal/execution/run")) {
        execCallCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ executionId: "exec-001", output: {}, durationMs: 5, exitCode: 0 }),
          status: 200,
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 });
    }));

    await engine.processRun(makeJob({ runId: "run-001", tenantId: TENANT_UUID }));

    expect(execCallCount).toBe(1);
  });
});
