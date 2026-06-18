// Execution Tracker — in-memory store for real-time pipeline execution status.
//
// Why in-memory: execution status is ephemeral visualization data. The authoritative
// record of what happened lives in the run_steps and runs DB tables. The tracker
// exists solely so SSE clients get low-latency step-level progress without polling
// the database on every event. State is keyed by executionId (= runId) and is
// discarded once the execution reaches a terminal state.
//
// Why event emitters instead of polling: the SSE endpoint needs push semantics.
// Polling the DB at 500ms intervals (like the log stream) would work but creates
// unnecessary DB load. Emitters let the execution engine push updates directly.

import { EventEmitter } from "node:events";
import type { RunStepStatus } from "./run-service.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ExecutionOverallStatus = "pending" | "running" | "completed" | "failed";

export interface StepStatus {
  stepId: string;
  name: string;
  type: string;
  status: RunStepStatus;
  startedAt?: string;
  completedAt?: string;
  inputRecordCount?: number;
  outputRecordCount?: number;
  error?: string;
  durationMs?: number;
}

export interface ExecutionProgress {
  completedSteps: number;
  totalSteps: number;
  percentage: number;
}

export interface ExecutionStatus {
  executionId: string;
  pipelineId: string;
  status: ExecutionOverallStatus;
  startedAt: string;
  completedAt?: string;
  steps: StepStatus[];
  progress: ExecutionProgress;
  /** The pipeline-level input captured at the moment this run was enqueued. */
  inputSnapshot?: Record<string, unknown>;
  /** Set when this execution was created by replaying another execution. */
  replayOf?: string;
}

// Step definition used when initializing a tracking record.
export interface StepDefinition {
  stepId: string;
  name: string;
  type: string;
}

// Payload shapes for the SSE events emitted on the per-execution EventEmitter.
export interface StepStartEvent {
  type: "step:start";
  executionId: string;
  step: StepStatus;
}

export interface StepCompleteEvent {
  type: "step:complete";
  executionId: string;
  step: StepStatus;
}

export interface StepErrorEvent {
  type: "step:error";
  executionId: string;
  step: StepStatus;
}

export interface ExecutionCompleteEvent {
  type: "execution:complete";
  executionId: string;
  status: ExecutionStatus;
}

export type ExecutionEvent =
  | StepStartEvent
  | StepCompleteEvent
  | StepErrorEvent
  | ExecutionCompleteEvent;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExecutionTracker {
  /** Initialize a new tracking record before the run starts. */
  startExecution(
    executionId: string,
    pipelineId: string,
    steps: StepDefinition[],
    opts?: { inputSnapshot?: Record<string, unknown>; replayOf?: string },
  ): void;

  /** Update an individual step's status and emit the corresponding SSE event. */
  updateStepStatus(
    executionId: string,
    stepId: string,
    status: RunStepStatus,
    result?: {
      error?: string;
      inputRecordCount?: number;
      outputRecordCount?: number;
    },
  ): void;

  /** Mark the overall execution as complete (or failed) and emit execution:complete. */
  completeExecution(executionId: string, status: "completed" | "failed"): void;

  /** Retrieve the current snapshot of an execution's status. Returns null if not found. */
  getExecutionStatus(executionId: string): ExecutionStatus | null;

  /** Retrieve recent executions for a pipeline (most recent first). */
  getExecutionHistory(pipelineId: string, limit?: number): ExecutionStatus[];

  /**
   * Subscribe to SSE events for a specific execution.
   * Returns an unsubscribe function. The listener is automatically removed after
   * execution:complete fires.
   */
  subscribe(
    executionId: string,
    listener: (event: ExecutionEvent) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

interface TrackedExecution {
  status: ExecutionStatus;
  // Per-execution emitter so subscriber fan-out is isolated to one execution.
  emitter: EventEmitter;
  // ISO timestamp of last update — used to evict stale entries from history.
  lastUpdatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Maximum number of completed/failed executions retained in history per pipeline.
// Eviction is LRU by insertion order (oldest entries removed first).
const DEFAULT_HISTORY_LIMIT = 50;

// Maximum number of concurrent in-flight executions tracked.
// After this limit, the oldest entry is evicted to prevent unbounded memory growth
// on high-throughput deployments.
const MAX_ACTIVE_EXECUTIONS = 5_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExecutionTracker(): ExecutionTracker {
  // executionId → tracked state
  const activeExecutions = new Map<string, TrackedExecution>();

  // pipelineId → recent terminal executions (most recent first)
  const historyByPipeline = new Map<string, ExecutionStatus[]>();

  // -------------------------------------------------------------------------
  // computeProgress — derived from step statuses; never stored separately to
  // avoid inconsistency. The TERMINAL_STEP set matches RunStepStatus values
  // that count as "done" for progress purposes — skipped and cancelled steps
  // count as completed because no further work will happen for them.
  // -------------------------------------------------------------------------

  const TERMINAL_STEP_STATUSES = new Set<RunStepStatus>([
    "completed",
    "failed",
    "skipped",
    "cancelled",
  ]);

  function computeProgress(steps: StepStatus[]): ExecutionProgress {
    const total = steps.length;
    if (total === 0) {
      return { completedSteps: 0, totalSteps: 0, percentage: 0 };
    }
    const completed = steps.filter((s) =>
      TERMINAL_STEP_STATUSES.has(s.status),
    ).length;
    return {
      completedSteps: completed,
      totalSteps: total,
      percentage: Math.round((completed / total) * 100),
    };
  }

  // -------------------------------------------------------------------------
  // evictOldestActiveIfNeeded — enforces the MAX_ACTIVE_EXECUTIONS cap.
  // Iterates the Map in insertion order; the first entry is the oldest.
  // -------------------------------------------------------------------------

  function evictOldestActiveIfNeeded(): void {
    if (activeExecutions.size < MAX_ACTIVE_EXECUTIONS) return;
    const oldestId = activeExecutions.keys().next().value;
    if (oldestId !== undefined) {
      activeExecutions.delete(oldestId);
    }
  }

  // -------------------------------------------------------------------------
  // archiveToHistory — moves a terminal execution into the history ring buffer.
  // -------------------------------------------------------------------------

  function archiveToHistory(tracked: TrackedExecution): void {
    const { pipelineId } = tracked.status;
    let history = historyByPipeline.get(pipelineId);
    if (history === undefined) {
      history = [];
      historyByPipeline.set(pipelineId, history);
    }
    // Most recent first — prepend.
    history.unshift(tracked.status);
    if (history.length > DEFAULT_HISTORY_LIMIT) {
      // Discard the oldest entry beyond the cap.
      history.splice(DEFAULT_HISTORY_LIMIT);
    }
  }

  // -------------------------------------------------------------------------
  // startExecution
  // -------------------------------------------------------------------------

  // Maximum byte size for a captured input snapshot. Snapshots larger than this
  // are dropped entirely rather than silently truncated, so callers always get
  // the full picture or nothing at all.
  const INPUT_SNAPSHOT_MAX_BYTES = 1_048_576; // 1 MiB

  function startExecution(
    executionId: string,
    pipelineId: string,
    steps: StepDefinition[],
    opts?: { inputSnapshot?: Record<string, unknown>; replayOf?: string },
  ): void {
    if (executionId.length === 0) {
      throw new Error("executionId must not be empty.");
    }
    if (pipelineId.length === 0) {
      throw new Error("pipelineId must not be empty.");
    }
    if (steps.length === 0) {
      throw new Error("steps must contain at least one step definition.");
    }

    evictOldestActiveIfNeeded();

    const stepStatuses: StepStatus[] = steps.map((s) => ({
      stepId: s.stepId,
      name: s.name,
      type: s.type,
      status: "pending" as RunStepStatus,
    }));

    const now = new Date().toISOString();

    // Guard the snapshot size before storing. JSON.stringify is the simplest
    // way to measure the byte footprint of the input object; it overestimates
    // slightly for multi-byte characters but is accurate enough for the cap.
    let inputSnapshot: Record<string, unknown> | undefined;
    if (opts?.inputSnapshot !== undefined) {
      const serialised = JSON.stringify(opts.inputSnapshot);
      if (serialised.length <= INPUT_SNAPSHOT_MAX_BYTES) {
        inputSnapshot = opts.inputSnapshot;
      }
      // Silently drop oversized snapshots — the engine has already logged a
      // warning before calling startExecution in this case.
    }

    const executionStatus: ExecutionStatus = {
      executionId,
      pipelineId,
      status: "running",
      startedAt: now,
      steps: stepStatuses,
      progress: computeProgress(stepStatuses),
      ...(inputSnapshot !== undefined ? { inputSnapshot } : {}),
      ...(opts?.replayOf !== undefined ? { replayOf: opts.replayOf } : {}),
    };

    activeExecutions.set(executionId, {
      status: executionStatus,
      emitter: new EventEmitter(),
      lastUpdatedAt: now,
    });
  }

  // -------------------------------------------------------------------------
  // updateStepStatus
  // -------------------------------------------------------------------------

  function updateStepStatus(
    executionId: string,
    stepId: string,
    status: RunStepStatus,
    result?: {
      error?: string;
      inputRecordCount?: number;
      outputRecordCount?: number;
    },
  ): void {
    const tracked = activeExecutions.get(executionId);
    if (tracked === undefined) {
      // Silently ignore updates for executions that are not tracked (e.g.,
      // service restart mid-run). We do not throw because the engine should
      // never be blocked by a non-critical tracking failure.
      return;
    }

    const stepIndex = tracked.status.steps.findIndex((s) => s.stepId === stepId);
    if (stepIndex === -1) {
      // Unknown step — ignore.
      return;
    }

    const now = new Date().toISOString();
    const existing = tracked.status.steps[stepIndex];
    // noUncheckedIndexedAccess: stepIndex came from findIndex so it is guaranteed
    // to be in bounds. The non-null assertion is justified.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const step = existing!;

    const updated: StepStatus = {
      ...step,
      status,
    };

    if (status === "running") {
      updated.startedAt = now;
    }

    if (status === "completed" || status === "failed" || status === "skipped" || status === "cancelled") {
      updated.completedAt = now;
      if (updated.startedAt !== undefined) {
        const startMs = new Date(updated.startedAt).getTime();
        const endMs = new Date(now).getTime();
        updated.durationMs = endMs - startMs;
      }
    }

    if (result?.error !== undefined) {
      updated.error = result.error;
    }
    if (result?.inputRecordCount !== undefined) {
      updated.inputRecordCount = result.inputRecordCount;
    }
    if (result?.outputRecordCount !== undefined) {
      updated.outputRecordCount = result.outputRecordCount;
    }

    // Immutably replace the step in the array so snapshot reads get a consistent view.
    tracked.status.steps = [
      ...tracked.status.steps.slice(0, stepIndex),
      updated,
      ...tracked.status.steps.slice(stepIndex + 1),
    ];
    tracked.status.progress = computeProgress(tracked.status.steps);
    tracked.lastUpdatedAt = now;

    // Emit the appropriate SSE event.
    let event: ExecutionEvent;
    if (status === "running") {
      event = { type: "step:start", executionId, step: updated };
    } else if (status === "failed") {
      event = { type: "step:error", executionId, step: updated };
    } else {
      // completed, skipped, cancelled all map to step:complete
      event = { type: "step:complete", executionId, step: updated };
    }

    tracked.emitter.emit("event", event);
  }

  // -------------------------------------------------------------------------
  // completeExecution
  // -------------------------------------------------------------------------

  function completeExecution(
    executionId: string,
    status: "completed" | "failed",
  ): void {
    const tracked = activeExecutions.get(executionId);
    if (tracked === undefined) return;

    const now = new Date().toISOString();
    tracked.status.status = status;
    tracked.status.completedAt = now;
    tracked.status.progress = computeProgress(tracked.status.steps);
    tracked.lastUpdatedAt = now;

    const event: ExecutionCompleteEvent = {
      type: "execution:complete",
      executionId,
      status: tracked.status,
    };
    tracked.emitter.emit("event", event);

    // Remove the max-listener warning from Node.js: after execution:complete
    // all subscribers will unsubscribe. Removing the execution from active map
    // lets the GC reclaim the emitter.
    archiveToHistory(tracked);
    activeExecutions.delete(executionId);
  }

  // -------------------------------------------------------------------------
  // getExecutionStatus
  // -------------------------------------------------------------------------

  function getExecutionStatus(executionId: string): ExecutionStatus | null {
    const tracked = activeExecutions.get(executionId);
    if (tracked !== undefined) {
      return tracked.status;
    }
    // Fall back to history — the execution may have already completed.
    for (const history of historyByPipeline.values()) {
      const found = history.find((e) => e.executionId === executionId);
      if (found !== undefined) return found;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // getExecutionHistory
  // -------------------------------------------------------------------------

  function getExecutionHistory(
    pipelineId: string,
    limit = DEFAULT_HISTORY_LIMIT,
  ): ExecutionStatus[] {
    if (limit <= 0) {
      throw new Error("limit must be a positive integer.");
    }
    const history = historyByPipeline.get(pipelineId) ?? [];
    return history.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------

  function subscribe(
    executionId: string,
    listener: (event: ExecutionEvent) => void,
  ): () => void {
    const tracked = activeExecutions.get(executionId);
    if (tracked === undefined) {
      // Execution not active — return a no-op unsubscribe. The caller will
      // receive the current snapshot via getExecutionStatus and can decide
      // whether to proceed.
      return () => undefined;
    }

    const wrappedListener = (event: ExecutionEvent): void => {
      listener(event);
    };

    tracked.emitter.on("event", wrappedListener);

    // Return unsubscribe handle.
    return () => {
      tracked.emitter.off("event", wrappedListener);
    };
  }

  return {
    startExecution,
    updateStepStatus,
    completeExecution,
    getExecutionStatus,
    getExecutionHistory,
    subscribe,
  };
}
