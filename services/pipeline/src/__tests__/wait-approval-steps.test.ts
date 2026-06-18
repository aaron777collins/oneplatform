// Unit tests for wait and approval step execution in the pipeline engine.
//
// Wait and approval steps use setTimeout internally, so these tests use
// vi.useFakeTimers() to avoid real wall-clock delays.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createExecutionEngine,
  type ExecutionEngineDeps,
  type RunEngineRepository,
  type RunStepEngineRepository,
  type RunLogEngineRepository,
} from "../services/execution-engine.js";
import { createApprovalService } from "../services/approval-service.js";
import type { RunRow, RunStepRow, PipelineRunJobPayload } from "../services/run-service.js";
import type { PipelineDefinition } from "../services/pipeline-service.js";
import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import type { Job } from "bullmq";
import type { Logger, ServiceTokenSigner } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Mock helpers — reused from execution-engine.test.ts patterns
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
  return { findById: vi.fn(), updateStatus: vi.fn() };
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
  return { append: vi.fn() };
}

function makePoolClient() {
  return { query: vi.fn(), release: vi.fn() };
}

function makePool(client: ReturnType<typeof makePoolClient>) {
  return { connect: vi.fn().mockResolvedValue(client) };
}

function makeRedis() {
  return { get: vi.fn(), publish: vi.fn() };
}

function makeJob(payload: PipelineRunJobPayload): Job<PipelineRunJobPayload> {
  return { data: payload, id: "job-001" } as unknown as Job<PipelineRunJobPayload>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PIPELINE_UUID = "550e8400-e29b-41d4-a716-446655440000";
const TENANT_UUID = "550e8400-e29b-41d4-a716-446655440001";
const RUN_ID = "run-wait-001";

function makeRunRow(overrides?: Partial<RunRow>): RunRow {
  return {
    id: RUN_ID,
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
    definition_snapshot: { version: 1, entryStepId: "step-1", steps: [] },
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRunStepRow(overrides?: Partial<RunStepRow>): RunStepRow {
  return {
    id: "run-step-001",
    run_id: RUN_ID,
    tenant_id: TENANT_UUID,
    step_id: "step-1",
    step_name: "Step",
    step_type: "wait",
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
// Shared engine setup with lock granted and hooks returning empty
// ---------------------------------------------------------------------------

function makeEngineSetup(deps?: Partial<ExecutionEngineDeps>) {
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
  runStepRepo.updateStatus.mockResolvedValue(makeRunStepRow());
  runStepRepo.updateOutput.mockResolvedValue(makeRunStepRow({ status: "completed" }));
  runLogRepo.append.mockResolvedValue(undefined);
  redis.get.mockResolvedValue(null); // not cancelled
  redis.publish.mockResolvedValue(0);

  // Default fetch: hooks return empty, execution service succeeds
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
    ...deps,
  });

  return { engine, runRepo, runStepRepo, runLogRepo, client, redis, logger };
}

// ===========================================================================
// Wait step tests
// ===========================================================================

describe("wait step — pauses for the configured duration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("run completes successfully after the wait duration elapses", async () => {
    const waitStep = {
      id: "step-1",
      name: "Wait 2s",
      type: "wait" as const,
      durationMs: 2_000,
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [waitStep],
    };

    const { engine, runRepo, runStepRepo } = makeEngineSetup();

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_type: "wait" })]);

    const runPromise = engine.processRun(makeJob({ runId: RUN_ID, tenantId: TENANT_UUID }));

    // Advance fake time past the wait duration
    await vi.runAllTimersAsync();
    await runPromise;

    const statusCalls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = statusCalls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("completed");
    expect(statuses).not.toContain("failed");
  });

  it("appends a log entry when the wait step begins", async () => {
    const waitStep = {
      id: "step-1",
      name: "Pause",
      type: "wait" as const,
      durationMs: 500,
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [waitStep],
    };

    const { engine, runRepo, runStepRepo, runLogRepo } = makeEngineSetup();

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_type: "wait" })]);

    const runPromise = engine.processRun(makeJob({ runId: RUN_ID, tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    const logCalls = (runLogRepo.append as ReturnType<typeof vi.fn>).mock.calls as Array<[Record<string, unknown>]>;
    const messages = logCalls.map((c) => c[0]["message"] as string);
    expect(messages.some((m) => m.includes("pausing for") && m.includes("500ms"))).toBe(true);
  });

  it("writes the wait output (durationMs, actualDurationMs, resumedAt) to the step row", async () => {
    const waitStep = {
      id: "step-1",
      name: "Timed Wait",
      type: "wait" as const,
      durationMs: 1_000,
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [waitStep],
    };

    const { engine, runRepo, runStepRepo } = makeEngineSetup();

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_type: "wait" })]);

    const runPromise = engine.processRun(makeJob({ runId: RUN_ID, tenantId: TENANT_UUID }));
    await vi.runAllTimersAsync();
    await runPromise;

    const outputCalls = (runStepRepo.updateOutput as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string, Record<string, unknown>]>;
    expect(outputCalls.length).toBeGreaterThan(0);
    const output = outputCalls[0]?.[2];
    expect(output).toBeDefined();
    expect(output?.["durationMs"]).toBe(1_000);
    expect(typeof output?.["actualDurationMs"]).toBe("number");
    expect(typeof output?.["resumedAt"]).toBe("string");
  });
});

// ===========================================================================
// Approval step tests
// ===========================================================================

describe("approval step — creates approval request and awaits decision", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates an approval request when the step runs", async () => {
    const approvalSvc = createApprovalService();
    const spy = vi.spyOn(approvalSvc, "requestApproval");

    const approvalStep = {
      id: "step-1",
      name: "Needs Approval",
      type: "approval" as const,
      approvers: ["user-001"],
      message: "Check this",
      // Use a 1-hour timeout so advancing time by a few seconds does not trigger it
      timeoutMs: 3_600_000,
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [approvalStep],
    };

    const { engine, runRepo, runStepRepo } = makeEngineSetup({ approvalService: approvalSvc });

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_type: "approval" })]);

    // Start the run — the approval step will block waiting for a decision
    const runPromise = engine.processRun(makeJob({ runId: RUN_ID, tenantId: TENANT_UUID }));

    // Advance enough for the run startup and the approval request to be registered
    // (but not enough to trigger the 1-hour timeout)
    await vi.advanceTimersByTimeAsync(100);

    // The spy should already have been called by this point
    expect(spy).toHaveBeenCalledWith(
      RUN_ID,
      "step-1",
      ["user-001"],
      "Check this",
      3_600_000,
    );

    // Approve so the run can complete and we can clean up
    approvalSvc.submitDecision(RUN_ID, "step-1", "user-001", "approved");
    await vi.advanceTimersByTimeAsync(6_000);
    await runPromise;
  });

  it("run completes when approval is granted before timeout", async () => {
    const approvalSvc = createApprovalService();

    const approvalStep = {
      id: "step-1",
      name: "Approval Gate",
      type: "approval" as const,
      approvers: ["user-001"],
      timeoutMs: 60_000,
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [approvalStep],
    };

    const { engine, runRepo, runStepRepo } = makeEngineSetup({ approvalService: approvalSvc });

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_type: "approval" })]);

    // Start the run — approval step will block on the first poll sleep
    const runPromise = engine.processRun(makeJob({ runId: RUN_ID, tenantId: TENANT_UUID }));

    // Advance time to let the run start and the approval request be registered
    await vi.advanceTimersByTimeAsync(100);

    // Submit the approval decision
    approvalSvc.submitDecision(RUN_ID, "step-1", "user-001", "approved", "Looks good");

    // Advance past the poll interval so the engine picks up the decision
    await vi.advanceTimersByTimeAsync(6_000);
    await runPromise;

    const statusCalls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = statusCalls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("completed");
  });

  it("marks the step failed when approval is rejected", async () => {
    const approvalSvc = createApprovalService();

    const approvalStep = {
      id: "step-1",
      name: "Approval Gate",
      type: "approval" as const,
      approvers: ["user-001"],
      timeoutMs: 60_000,
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [approvalStep],
    };

    const { engine, runRepo, runStepRepo } = makeEngineSetup({ approvalService: approvalSvc });

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_type: "approval" })]);

    const runPromise = engine.processRun(makeJob({ runId: RUN_ID, tenantId: TENANT_UUID }));

    await vi.advanceTimersByTimeAsync(100);

    // Reject the approval
    approvalSvc.submitDecision(RUN_ID, "step-1", "user-001", "rejected", "Not ready");

    await vi.advanceTimersByTimeAsync(6_000);
    await runPromise;

    const statusCalls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = statusCalls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("failed");
  });

  it("marks the step failed when approval times out", async () => {
    const approvalSvc = createApprovalService();

    const approvalStep = {
      id: "step-1",
      name: "Approval Gate",
      type: "approval" as const,
      approvers: ["user-001"],
      timeoutMs: 5_000, // 5s timeout
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [approvalStep],
    };

    const { engine, runRepo, runStepRepo } = makeEngineSetup({ approvalService: approvalSvc });

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_type: "approval" })]);

    const runPromise = engine.processRun(makeJob({ runId: RUN_ID, tenantId: TENANT_UUID }));

    // Advance past both the timeout and the poll interval without approving
    await vi.advanceTimersByTimeAsync(20_000);
    await runPromise;

    const statusCalls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = statusCalls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("failed");
  });

  it("fails immediately if no approvalService is provided", async () => {
    // No approvalService in deps — the engine should fail the step immediately
    const approvalStep = {
      id: "step-1",
      name: "Approval Gate",
      type: "approval" as const,
      approvers: ["user-001"],
      timeoutMs: 3_600_000,
      onError: "fail" as const,
    };
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "step-1",
      steps: [approvalStep],
    };

    // makeEngineSetup without approvalService — omit the key entirely so
    // exactOptionalPropertyTypes does not reject an explicit `undefined` value.
    const { engine, runRepo, runStepRepo } = makeEngineSetup({});

    runRepo.findById.mockResolvedValue(makeRunRow({ definition_snapshot: definition }));
    runStepRepo.findByRunId.mockResolvedValue([makeRunStepRow({ step_type: "approval" })]);

    await vi.runAllTimersAsync();
    await engine.processRun(makeJob({ runId: RUN_ID, tenantId: TENANT_UUID }));

    const statusCalls = (runRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;
    const statuses = statusCalls.map((c) => c[1]["status"]).filter(Boolean);
    expect(statuses).toContain("failed");
  });
});

// ===========================================================================
// Schema validation tests
// ===========================================================================

describe("wait and approval step schemas", () => {
  it("WaitStepSchema accepts valid durationMs within 24h limit", async () => {
    const { StepSchema } = await import("../schemas/index.js");

    const result = StepSchema.safeParse({
      id: "step-1a",
      name: "Wait Step",
      type: "wait",
      durationMs: 86_400_000, // exactly 24h
    });

    expect(result.success).toBe(true);
  });

  it("WaitStepSchema rejects durationMs exceeding 24 hours", async () => {
    const { StepSchema } = await import("../schemas/index.js");

    const result = StepSchema.safeParse({
      id: "step-1a",
      name: "Wait Step",
      type: "wait",
      durationMs: 86_400_001, // 1ms over limit
    });

    expect(result.success).toBe(false);
  });

  it("WaitStepSchema rejects zero or negative durationMs", async () => {
    const { StepSchema } = await import("../schemas/index.js");

    const result = StepSchema.safeParse({
      id: "step-1a",
      name: "Wait Step",
      type: "wait",
      durationMs: 0,
    });

    expect(result.success).toBe(false);
  });

  it("ApprovalStepSchema accepts valid approvers array with at least one entry", async () => {
    const { StepSchema } = await import("../schemas/index.js");

    const result = StepSchema.safeParse({
      id: "step-1a",
      name: "Approval Step",
      type: "approval",
      approvers: ["user-001"],
      message: "Please approve",
      timeoutMs: 3_600_000,
    });

    expect(result.success).toBe(true);
  });

  it("ApprovalStepSchema rejects empty approvers array", async () => {
    const { StepSchema } = await import("../schemas/index.js");

    const result = StepSchema.safeParse({
      id: "step-1a",
      name: "Approval Step",
      type: "approval",
      approvers: [], // at least one required
      timeoutMs: 3_600_000,
    });

    expect(result.success).toBe(false);
  });

  it("ApprovalStepSchema rejects timeoutMs exceeding 24 hours", async () => {
    const { StepSchema } = await import("../schemas/index.js");

    const result = StepSchema.safeParse({
      id: "step-1a",
      name: "Approval Step",
      type: "approval",
      approvers: ["user-001"],
      timeoutMs: 86_400_001,
    });

    expect(result.success).toBe(false);
  });

  it("ApprovalStepSchema applies 24h default when timeoutMs is omitted", async () => {
    const { StepSchema } = await import("../schemas/index.js");

    const result = StepSchema.safeParse({
      id: "step-1a",
      name: "Approval Step",
      type: "approval",
      approvers: ["user-001"],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeoutMs).toBe(86_400_000);
    }
  });

  it("existing step types (code, connector, webhook) still pass schema validation", async () => {
    const { StepSchema } = await import("../schemas/index.js");

    const codeResult = StepSchema.safeParse({
      id: "step-1a",
      name: "Code Step",
      type: "code",
      language: "javascript",
      code: 'return "hello";',
    });
    expect(codeResult.success).toBe(true);

    const webhookResult = StepSchema.safeParse({
      id: "step-1a",
      name: "Webhook Step",
      type: "webhook",
      url: "https://example.com/hook",
      method: "POST",
    });
    expect(webhookResult.success).toBe(true);
  });
});
