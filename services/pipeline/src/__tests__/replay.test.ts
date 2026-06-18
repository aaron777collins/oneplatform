// Tests for pipeline execution replay — G-062.
//
// Covers:
//   - replayRun creates a new execution with the same input as the original
//   - replayRun links the new run back to the original via replayOf
//   - replayRun returns 404 when the original execution does not exist
//   - replayRun returns 404 when the execution belongs to a different pipeline
//   - Input snapshot is captured on every execution (tracker integration)
//   - Oversized input snapshots are rejected by the tracker (1 MiB cap)
//   - replayOf is propagated from trigger_meta through the tracker

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRunService,
  type RunRepository,
  type RunStepRepository,
  type RunLogRepository,
  type RunRow,
} from "../services/run-service.js";
import {
  createExecutionTracker,
  type ExecutionTracker,
} from "../services/execution-tracker.js";
import type { PipelineDefinition } from "../services/pipeline-service.js";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PIPELINE_UUID = "550e8400-e29b-41d4-a716-446655440000";
const TENANT_UUID = "550e8400-e29b-41d4-a716-446655440001";
const OTHER_PIPELINE_UUID = "660e8400-e29b-41d4-a716-446655440002";

const minimalDefinition: PipelineDefinition = {
  version: 1,
  entryStepId: "step-1",
  steps: [
    {
      id: "step-1",
      name: "Code Step",
      type: "code",
      language: "javascript",
      code: 'return "hello";',
      onError: "fail",
    },
  ],
};

function makeRunRow(overrides?: Partial<RunRow>): RunRow {
  return {
    id: "run-001",
    pipeline_id: PIPELINE_UUID,
    tenant_id: TENANT_UUID,
    status: "completed",
    triggered_by: "manual",
    trigger_actor_id: null,
    trigger_meta: {},
    input: { userId: "user-42", region: "us-east-1" },
    started_at: new Date("2026-01-01T00:00:00Z"),
    completed_at: new Date("2026-01-01T00:01:00Z"),
    error: null,
    bully_job_id: null,
    definition_snapshot: minimalDefinition as unknown as Record<string, unknown>,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

// ---------------------------------------------------------------------------
// RunService mock infrastructure
// ---------------------------------------------------------------------------

type MockRunRepo = {
  create: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findByTenantAndId: ReturnType<typeof vi.fn>;
  findByTenantId: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  countActiveByPipelineId: ReturnType<typeof vi.fn>;
};

type MockRunStepRepo = {
  findByRunId: ReturnType<typeof vi.fn>;
  createBatch: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
  updateOutput: ReturnType<typeof vi.fn>;
};

type MockRunLogRepo = {
  findByRunId: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
};

type MockPipelineRepo = {
  findById: ReturnType<typeof vi.fn>;
};

function makeRunRepo(): MockRunRepo {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByTenantAndId: vi.fn(),
    findByTenantId: vi.fn(),
    updateStatus: vi.fn(),
    countActiveByPipelineId: vi.fn(),
  };
}

function makeRunStepRepo(): MockRunStepRepo {
  return {
    findByRunId: vi.fn(),
    createBatch: vi.fn(),
    updateStatus: vi.fn(),
    updateOutput: vi.fn(),
  };
}

function makeRunLogRepo(): MockRunLogRepo {
  return {
    findByRunId: vi.fn(),
    append: vi.fn(),
  };
}

function makePipelineRepo(): MockPipelineRepo {
  return {
    findById: vi.fn(),
  };
}

function makeQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: "job-new-001" }),
  } as unknown as Queue;
}

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// replayRun — RunService integration
// ---------------------------------------------------------------------------

describe("replayRun", () => {
  let runRepo: MockRunRepo;
  let pipelineRepo: MockPipelineRepo;

  beforeEach(() => {
    runRepo = makeRunRepo();
    pipelineRepo = makePipelineRepo();
  });

  function makeService() {
    return createRunService({
      runRepo: runRepo as unknown as RunRepository,
      runStepRepo: makeRunStepRepo() as unknown as RunStepRepository,
      runLogRepo: makeRunLogRepo() as unknown as RunLogRepository,
      pipelineRepo: pipelineRepo as unknown as { findById(id: string): Promise<null> },
      runQueue: makeQueue(),
      redis: makeRedis(),
      logger: makeLogger(),
    });
  }

  it("creates a new run carrying the original run's input verbatim", async () => {
    const originalRun = makeRunRow({ id: "run-original", input: { userId: "user-42", region: "us-east-1" } });
    const newRun = makeRunRow({ id: "run-replay-001", status: "pending" });

    runRepo.findByTenantAndId.mockResolvedValue(originalRun);
    pipelineRepo.findById.mockResolvedValue({
      id: PIPELINE_UUID,
      tenant_id: TENANT_UUID,
      is_active: true,
      definition: minimalDefinition,
    });
    runRepo.countActiveByPipelineId.mockResolvedValue(0);
    runRepo.create.mockResolvedValue(newRun);
    runRepo.updateStatus.mockResolvedValue(newRun);

    const svc = makeService();
    const result = await svc.replayRun(PIPELINE_UUID, TENANT_UUID, "run-original", "user-actor-1");

    expect(result.runId).toBe("run-replay-001");
    expect(result.status).toBe("pending");
    expect(result.replayOf).toBe("run-original");

    // Verify the run was created with the original input and replayOf in trigger_meta.
    const createCall = runRepo.create.mock.calls[0]?.[0];
    expect(createCall?.input).toEqual({ userId: "user-42", region: "us-east-1" });
    expect(createCall?.trigger_meta?.replayOf).toBe("run-original");
  });

  it("links the new run back to the original execution via replayOf", async () => {
    const originalRun = makeRunRow({ id: "run-abc" });
    const newRun = makeRunRow({ id: "run-xyz", status: "pending" });

    runRepo.findByTenantAndId.mockResolvedValue(originalRun);
    pipelineRepo.findById.mockResolvedValue({
      id: PIPELINE_UUID,
      tenant_id: TENANT_UUID,
      is_active: true,
      definition: minimalDefinition,
    });
    runRepo.countActiveByPipelineId.mockResolvedValue(0);
    runRepo.create.mockResolvedValue(newRun);
    runRepo.updateStatus.mockResolvedValue(newRun);

    const svc = makeService();
    const result = await svc.replayRun(PIPELINE_UUID, TENANT_UUID, "run-abc");

    expect(result.replayOf).toBe("run-abc");
    // trigger_meta must carry the replayOf so the execution engine can surface it.
    const triggerMeta = runRepo.create.mock.calls[0]?.[0]?.trigger_meta;
    expect(triggerMeta).toMatchObject({ replayOf: "run-abc" });
  });

  it("throws PipelineRunNotFoundError when the original execution does not exist", async () => {
    runRepo.findByTenantAndId.mockResolvedValue(null);

    const svc = makeService();
    await expect(
      svc.replayRun(PIPELINE_UUID, TENANT_UUID, "run-nonexistent"),
    ).rejects.toMatchObject({
      code: "PIPELINE_RUN_NOT_FOUND",
    });
  });

  it("throws PipelineRunNotFoundError when the execution belongs to a different pipeline", async () => {
    // The run exists but belongs to OTHER_PIPELINE_UUID.
    const alienRun = makeRunRow({ id: "run-alien", pipeline_id: OTHER_PIPELINE_UUID });
    runRepo.findByTenantAndId.mockResolvedValue(alienRun);

    const svc = makeService();
    await expect(
      // Caller requests replay under PIPELINE_UUID but the run belongs to OTHER_PIPELINE_UUID.
      svc.replayRun(PIPELINE_UUID, TENANT_UUID, "run-alien"),
    ).rejects.toMatchObject({
      code: "PIPELINE_RUN_NOT_FOUND",
    });

    // Ensure we never reached the triggerRun path.
    expect(runRepo.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ExecutionTracker — input snapshot capture
// ---------------------------------------------------------------------------

describe("ExecutionTracker — input snapshot capture", () => {
  const PIPELINE_ID = "pipeline-snap-001";
  const EXEC_ID = "exec-snap-001";
  const STEPS = [{ stepId: "step-1", name: "Step One", type: "code" }];

  it("stores inputSnapshot on the execution status when provided", () => {
    const tracker: ExecutionTracker = createExecutionTracker();
    const input = { userId: "u-1", payload: { count: 42 } };

    tracker.startExecution(EXEC_ID, PIPELINE_ID, STEPS, { inputSnapshot: input });

    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status?.inputSnapshot).toEqual(input);
  });

  it("stores inputSnapshot on every execution, not just replays", () => {
    const tracker: ExecutionTracker = createExecutionTracker();
    const input = { source: "api", version: 3 };

    // No replayOf — a normal first-time run.
    tracker.startExecution("exec-normal", PIPELINE_ID, STEPS, { inputSnapshot: input });

    const status = tracker.getExecutionStatus("exec-normal");
    expect(status?.inputSnapshot).toEqual(input);
    expect(status?.replayOf).toBeUndefined();
  });

  it("leaves inputSnapshot undefined when not provided", () => {
    const tracker: ExecutionTracker = createExecutionTracker();

    tracker.startExecution(EXEC_ID, PIPELINE_ID, STEPS);

    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status?.inputSnapshot).toBeUndefined();
  });

  it("rejects snapshots that exceed the 1 MiB byte limit", () => {
    const tracker: ExecutionTracker = createExecutionTracker();

    // Craft a value whose JSON representation is just over 1 MiB.
    // "x".repeat(N) serialises to N+2 bytes (including the surrounding quotes).
    const oversizedInput: Record<string, unknown> = { data: "x".repeat(1_048_577) };

    tracker.startExecution(EXEC_ID, PIPELINE_ID, STEPS, { inputSnapshot: oversizedInput });

    const status = tracker.getExecutionStatus(EXEC_ID);
    // Oversized snapshot must be silently dropped — the run itself still starts.
    expect(status).not.toBeNull();
    expect(status?.inputSnapshot).toBeUndefined();
  });

  it("accepts snapshots exactly at the 1 MiB boundary", () => {
    const tracker: ExecutionTracker = createExecutionTracker();

    // JSON.stringify({ data: "x".repeat(N) }) produces:
    //   '{"data":"' (9 chars) + N + '"}' (2 chars) = N + 11 chars.
    // To hit exactly 1_048_576 bytes: N = 1_048_576 - 11 = 1_048_565.
    const boundaryInput: Record<string, unknown> = { data: "x".repeat(1_048_565) };
    const serialised = JSON.stringify(boundaryInput);
    expect(serialised.length).toBe(1_048_576); // guard: fixture must be exactly at cap

    tracker.startExecution(EXEC_ID, PIPELINE_ID, STEPS, { inputSnapshot: boundaryInput });

    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status?.inputSnapshot).toBeDefined();
  });

  it("stores replayOf on the execution status when provided", () => {
    const tracker: ExecutionTracker = createExecutionTracker();
    const originalId = "exec-original-001";

    tracker.startExecution(EXEC_ID, PIPELINE_ID, STEPS, {
      inputSnapshot: { key: "val" },
      replayOf: originalId,
    });

    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status?.replayOf).toBe(originalId);
  });

  it("preserves inputSnapshot and replayOf in history after execution completes", () => {
    const tracker: ExecutionTracker = createExecutionTracker();
    const input = { batch: "nightly-run" };

    tracker.startExecution(EXEC_ID, PIPELINE_ID, STEPS, {
      inputSnapshot: input,
      replayOf: "exec-parent",
    });
    tracker.completeExecution(EXEC_ID, "completed");

    // After completion the entry moves from activeExecutions to history.
    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status?.inputSnapshot).toEqual(input);
    expect(status?.replayOf).toBe("exec-parent");
  });
});
