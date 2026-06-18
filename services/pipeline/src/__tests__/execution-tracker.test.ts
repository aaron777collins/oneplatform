// Unit tests for services/execution-tracker.ts
//
// Covers:
//   - Full execution lifecycle (start → step transitions → complete/fail)
//   - Step status transition rules
//   - Progress calculation accuracy at each step boundary
//   - SSE event emission: step:start, step:complete, step:error, execution:complete
//   - In-memory history ring buffer (eviction, ordering, limit)
//   - Input validation guards
//   - getExecutionStatus fallback from active map to history
//   - Subscribe / unsubscribe lifecycle

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createExecutionTracker,
  type ExecutionTracker,
  type StepDefinition,
  type ExecutionEvent,
} from "../services/execution-tracker.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const PIPELINE_ID = "pipeline-aaa";
const EXEC_ID = "run-001";

const THREE_STEPS: StepDefinition[] = [
  { stepId: "step-1", name: "Fetch data", type: "connector" },
  { stepId: "step-2", name: "Transform", type: "code" },
  { stepId: "step-3", name: "Push result", type: "webhook" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTracker(): ExecutionTracker {
  return createExecutionTracker();
}

function collectEvents(
  tracker: ExecutionTracker,
  executionId: string,
): { events: ExecutionEvent[]; unsubscribe: () => void } {
  const events: ExecutionEvent[] = [];
  const unsubscribe = tracker.subscribe(executionId, (e) => events.push(e));
  return { events, unsubscribe };
}

// ---------------------------------------------------------------------------
// startExecution
// ---------------------------------------------------------------------------

describe("startExecution", () => {
  it("creates an execution record with all steps in pending state", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status).not.toBeNull();
    expect(status?.executionId).toBe(EXEC_ID);
    expect(status?.pipelineId).toBe(PIPELINE_ID);
    expect(status?.status).toBe("running");
    expect(status?.steps).toHaveLength(3);
    expect(status?.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("sets startedAt as an ISO timestamp", () => {
    const before = new Date().toISOString();
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const after = new Date().toISOString();

    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status?.startedAt).toBeDefined();
    // Non-null assertion justified: toBeDefined() above proves startedAt is set.
    expect(status!.startedAt >= before).toBe(true);
    expect(status!.startedAt <= after).toBe(true);
  });

  it("initializes progress at 0/N/0%", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    const { progress } = tracker.getExecutionStatus(EXEC_ID)!;
    expect(progress.totalSteps).toBe(3);
    expect(progress.completedSteps).toBe(0);
    expect(progress.percentage).toBe(0);
  });

  it("throws when executionId is empty", () => {
    const tracker = makeTracker();
    expect(() =>
      tracker.startExecution("", PIPELINE_ID, THREE_STEPS),
    ).toThrow("executionId must not be empty");
  });

  it("throws when pipelineId is empty", () => {
    const tracker = makeTracker();
    expect(() =>
      tracker.startExecution(EXEC_ID, "", THREE_STEPS),
    ).toThrow("pipelineId must not be empty");
  });

  it("throws when steps array is empty", () => {
    const tracker = makeTracker();
    expect(() =>
      tracker.startExecution(EXEC_ID, PIPELINE_ID, []),
    ).toThrow("steps must contain at least one step definition");
  });
});

// ---------------------------------------------------------------------------
// updateStepStatus
// ---------------------------------------------------------------------------

describe("updateStepStatus — step:start", () => {
  it("transitions step to running and sets startedAt", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");

    const status = tracker.getExecutionStatus(EXEC_ID)!;
    const step = status.steps.find((s) => s.stepId === "step-1");
    expect(step?.status).toBe("running");
    expect(step?.startedAt).toBeDefined();
  });

  it("emits step:start event on running transition", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const { events } = collectEvents(tracker, EXEC_ID);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("step:start");
    if (events[0]?.type === "step:start") {
      expect(events[0].step.stepId).toBe("step-1");
      expect(events[0].step.status).toBe("running");
    }
  });

  it("does not increment progress — running is not a terminal status", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");

    const { progress } = tracker.getExecutionStatus(EXEC_ID)!;
    expect(progress.completedSteps).toBe(0);
    expect(progress.percentage).toBe(0);
  });
});

describe("updateStepStatus — step:complete", () => {
  it("transitions step to completed, sets completedAt and durationMs", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");
    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");

    const status = tracker.getExecutionStatus(EXEC_ID)!;
    const step = status.steps.find((s) => s.stepId === "step-1");
    expect(step?.status).toBe("completed");
    expect(step?.completedAt).toBeDefined();
    expect(step?.durationMs).toBeTypeOf("number");
    expect(step?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits step:complete event on completed transition", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const { events } = collectEvents(tracker, EXEC_ID);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");
    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");

    const completeEvent = events.find((e) => e.type === "step:complete");
    expect(completeEvent).toBeDefined();
  });

  it("increments progress by one when step completes", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");
    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");

    const { progress } = tracker.getExecutionStatus(EXEC_ID)!;
    expect(progress.completedSteps).toBe(1);
    expect(progress.percentage).toBe(33);
  });

  it("skipped steps count toward completed progress", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-2", "skipped");

    const { progress } = tracker.getExecutionStatus(EXEC_ID)!;
    expect(progress.completedSteps).toBe(1);
    expect(progress.percentage).toBe(33);
  });

  it("cancelled steps count toward completed progress", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-3", "cancelled");

    const { progress } = tracker.getExecutionStatus(EXEC_ID)!;
    expect(progress.completedSteps).toBe(1);
  });
});

describe("updateStepStatus — step:error", () => {
  it("transitions step to failed and sets error message", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-2", "running");
    tracker.updateStepStatus(EXEC_ID, "step-2", "failed", {
      error: "Connection timeout",
    });

    const status = tracker.getExecutionStatus(EXEC_ID)!;
    const step = status.steps.find((s) => s.stepId === "step-2");
    expect(step?.status).toBe("failed");
    expect(step?.error).toBe("Connection timeout");
    expect(step?.completedAt).toBeDefined();
  });

  it("emits step:error event on failed transition", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const { events } = collectEvents(tracker, EXEC_ID);

    tracker.updateStepStatus(EXEC_ID, "step-2", "running");
    tracker.updateStepStatus(EXEC_ID, "step-2", "failed", { error: "Timeout" });

    const errorEvent = events.find((e) => e.type === "step:error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "step:error") {
      expect(errorEvent.step.error).toBe("Timeout");
    }
  });

  it("stores inputRecordCount and outputRecordCount when provided", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-1", "completed", {
      inputRecordCount: 1000,
      outputRecordCount: 950,
    });

    const step = tracker.getExecutionStatus(EXEC_ID)!.steps.find(
      (s) => s.stepId === "step-1",
    );
    expect(step?.inputRecordCount).toBe(1000);
    expect(step?.outputRecordCount).toBe(950);
  });
});

describe("updateStepStatus — unknown execution / step", () => {
  it("silently ignores update for a non-existent executionId", () => {
    const tracker = makeTracker();
    // Should not throw — the engine must never be blocked by tracker failures.
    expect(() =>
      tracker.updateStepStatus("nonexistent", "step-1", "running"),
    ).not.toThrow();
  });

  it("silently ignores update for a step not in the definition", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    expect(() =>
      tracker.updateStepStatus(EXEC_ID, "step-unknown", "running"),
    ).not.toThrow();

    // Other steps should be unaffected.
    const status = tracker.getExecutionStatus(EXEC_ID)!;
    expect(status.steps.every((s) => s.status === "pending")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Progress calculation
// ---------------------------------------------------------------------------

describe("progress calculation", () => {
  it("reaches 100% when all steps are in terminal states", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");
    tracker.updateStepStatus(EXEC_ID, "step-2", "skipped");
    tracker.updateStepStatus(EXEC_ID, "step-3", "cancelled");

    const { progress } = tracker.getExecutionStatus(EXEC_ID)!;
    expect(progress.completedSteps).toBe(3);
    expect(progress.totalSteps).toBe(3);
    expect(progress.percentage).toBe(100);
  });

  it("handles single-step pipeline progress correctly", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, [
      { stepId: "only-step", name: "Only Step", type: "code" },
    ]);

    expect(tracker.getExecutionStatus(EXEC_ID)!.progress.percentage).toBe(0);

    tracker.updateStepStatus(EXEC_ID, "only-step", "completed");
    expect(tracker.getExecutionStatus(EXEC_ID)!.progress.percentage).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// completeExecution
// ---------------------------------------------------------------------------

describe("completeExecution", () => {
  it("marks execution as completed and sets completedAt", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.completeExecution(EXEC_ID, "completed");

    // After completeExecution, the status is moved to history.
    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status?.status).toBe("completed");
    expect(status?.completedAt).toBeDefined();
  });

  it("marks execution as failed and sets completedAt", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    tracker.completeExecution(EXEC_ID, "failed");

    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status?.status).toBe("failed");
    expect(status?.completedAt).toBeDefined();
  });

  it("emits execution:complete event with full status snapshot", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const { events } = collectEvents(tracker, EXEC_ID);

    tracker.completeExecution(EXEC_ID, "completed");

    const completeEvent = events.find((e) => e.type === "execution:complete");
    expect(completeEvent).toBeDefined();
    if (completeEvent?.type === "execution:complete") {
      expect(completeEvent.status.executionId).toBe(EXEC_ID);
      expect(completeEvent.status.status).toBe("completed");
    }
  });

  it("silently ignores completeExecution for unknown executionId", () => {
    const tracker = makeTracker();
    expect(() =>
      tracker.completeExecution("nonexistent", "completed"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getExecutionHistory
// ---------------------------------------------------------------------------

describe("getExecutionHistory", () => {
  it("returns empty array when no executions have completed for pipeline", () => {
    const tracker = makeTracker();
    expect(tracker.getExecutionHistory(PIPELINE_ID)).toEqual([]);
  });

  it("returns completed executions in most-recent-first order", () => {
    const tracker = makeTracker();

    tracker.startExecution("run-a", PIPELINE_ID, THREE_STEPS);
    tracker.completeExecution("run-a", "completed");

    tracker.startExecution("run-b", PIPELINE_ID, THREE_STEPS);
    tracker.completeExecution("run-b", "failed");

    const history = tracker.getExecutionHistory(PIPELINE_ID);
    // Most recent completion is "run-b" (prepended).
    expect(history[0]?.executionId).toBe("run-b");
    expect(history[1]?.executionId).toBe("run-a");
  });

  it("respects the limit parameter", () => {
    const tracker = makeTracker();
    for (let i = 1; i <= 5; i++) {
      tracker.startExecution(`run-${i}`, PIPELINE_ID, THREE_STEPS);
      tracker.completeExecution(`run-${i}`, "completed");
    }

    const history = tracker.getExecutionHistory(PIPELINE_ID, 3);
    expect(history).toHaveLength(3);
  });

  it("throws when limit is not positive", () => {
    const tracker = makeTracker();
    expect(() => tracker.getExecutionHistory(PIPELINE_ID, 0)).toThrow(
      "limit must be a positive integer",
    );
    expect(() => tracker.getExecutionHistory(PIPELINE_ID, -1)).toThrow(
      "limit must be a positive integer",
    );
  });

  it("evicts oldest entries when history cap is exceeded", () => {
    const tracker = makeTracker();
    // Fill beyond the DEFAULT_HISTORY_LIMIT (50).
    for (let i = 1; i <= 55; i++) {
      tracker.startExecution(`run-overflow-${i}`, PIPELINE_ID, THREE_STEPS);
      tracker.completeExecution(`run-overflow-${i}`, "completed");
    }

    const history = tracker.getExecutionHistory(PIPELINE_ID, 100);
    // The ring buffer caps at 50.
    expect(history).toHaveLength(50);
    // The oldest entry (run-overflow-1) should have been evicted.
    expect(history.find((e) => e.executionId === "run-overflow-1")).toBeUndefined();
    // The most recent (run-overflow-55) should be first.
    expect(history[0]?.executionId).toBe("run-overflow-55");
  });

  it("does not mix executions from different pipelines", () => {
    const tracker = makeTracker();

    tracker.startExecution("run-p1", "pipeline-1", THREE_STEPS);
    tracker.completeExecution("run-p1", "completed");

    tracker.startExecution("run-p2", "pipeline-2", THREE_STEPS);
    tracker.completeExecution("run-p2", "completed");

    expect(tracker.getExecutionHistory("pipeline-1")).toHaveLength(1);
    expect(tracker.getExecutionHistory("pipeline-2")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getExecutionStatus
// ---------------------------------------------------------------------------

describe("getExecutionStatus", () => {
  it("returns null for a completely unknown executionId", () => {
    const tracker = makeTracker();
    expect(tracker.getExecutionStatus("unknown")).toBeNull();
  });

  it("returns status for an active (in-flight) execution", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status).not.toBeNull();
    expect(status?.status).toBe("running");
  });

  it("returns status from history after execution completes", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    tracker.completeExecution(EXEC_ID, "completed");

    // Active map no longer has the entry; should fall back to history.
    const status = tracker.getExecutionStatus(EXEC_ID);
    expect(status).not.toBeNull();
    expect(status?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe("subscribe", () => {
  it("delivers all events to the subscriber in order", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const { events } = collectEvents(tracker, EXEC_ID);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");
    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");
    tracker.updateStepStatus(EXEC_ID, "step-2", "running");
    tracker.updateStepStatus(EXEC_ID, "step-2", "failed", { error: "Crash" });
    tracker.completeExecution(EXEC_ID, "failed");

    expect(events.map((e) => e.type)).toEqual([
      "step:start",
      "step:complete",
      "step:start",
      "step:error",
      "execution:complete",
    ]);
  });

  it("stops delivering events after unsubscribe is called", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const { events, unsubscribe } = collectEvents(tracker, EXEC_ID);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");
    unsubscribe();
    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("step:start");
  });

  it("returns a no-op unsubscribe for non-existent executionId", () => {
    const tracker = makeTracker();
    const unsubscribe = tracker.subscribe("nonexistent", vi.fn());
    // Should not throw.
    expect(() => unsubscribe()).not.toThrow();
  });

  it("supports multiple concurrent subscribers receiving the same events", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);

    const eventsA: ExecutionEvent[] = [];
    const eventsB: ExecutionEvent[] = [];
    tracker.subscribe(EXEC_ID, (e) => eventsA.push(e));
    tracker.subscribe(EXEC_ID, (e) => eventsB.push(e));

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");
    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");

    expect(eventsA).toHaveLength(2);
    expect(eventsB).toHaveLength(2);
    expect(eventsA.map((e) => e.type)).toEqual(eventsB.map((e) => e.type));
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle integration
// ---------------------------------------------------------------------------

describe("full execution lifecycle", () => {
  it("tracks a three-step pipeline from start to successful completion", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const { events } = collectEvents(tracker, EXEC_ID);

    // Step 1: runs and completes
    tracker.updateStepStatus(EXEC_ID, "step-1", "running");
    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");

    // Step 2: skipped by condition
    tracker.updateStepStatus(EXEC_ID, "step-2", "skipped");

    // Step 3: runs and completes
    tracker.updateStepStatus(EXEC_ID, "step-3", "running");
    tracker.updateStepStatus(EXEC_ID, "step-3", "completed");

    tracker.completeExecution(EXEC_ID, "completed");

    // Progress should be 3/3 = 100%
    const finalStatus = tracker.getExecutionStatus(EXEC_ID)!;
    expect(finalStatus.progress.percentage).toBe(100);
    expect(finalStatus.status).toBe("completed");

    // Verify the event sequence
    expect(events.map((e) => e.type)).toEqual([
      "step:start",    // step-1 running
      "step:complete", // step-1 completed
      "step:complete", // step-2 skipped → step:complete
      "step:start",    // step-3 running
      "step:complete", // step-3 completed
      "execution:complete",
    ]);
  });

  it("tracks a pipeline that fails at the second step", () => {
    const tracker = makeTracker();
    tracker.startExecution(EXEC_ID, PIPELINE_ID, THREE_STEPS);
    const { events } = collectEvents(tracker, EXEC_ID);

    tracker.updateStepStatus(EXEC_ID, "step-1", "running");
    tracker.updateStepStatus(EXEC_ID, "step-1", "completed");
    tracker.updateStepStatus(EXEC_ID, "step-2", "running");
    tracker.updateStepStatus(EXEC_ID, "step-2", "failed", { error: "Out of memory" });
    // Remaining step cancelled by the engine
    tracker.updateStepStatus(EXEC_ID, "step-3", "cancelled");
    tracker.completeExecution(EXEC_ID, "failed");

    const finalStatus = tracker.getExecutionStatus(EXEC_ID)!;
    expect(finalStatus.status).toBe("failed");
    // completed: step-1 (1) + failed: step-2 (1) + cancelled: step-3 (1) = 3/3
    expect(finalStatus.progress.percentage).toBe(100);

    expect(events.map((e) => e.type)).toEqual([
      "step:start",
      "step:complete",
      "step:start",
      "step:error",
      "step:complete",    // cancelled → step:complete
      "execution:complete",
    ]);

    // Verify it appears in history
    const history = tracker.getExecutionHistory(PIPELINE_ID);
    expect(history[0]?.executionId).toBe(EXEC_ID);
    expect(history[0]?.status).toBe("failed");
  });
});
