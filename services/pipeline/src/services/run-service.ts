import type { Logger } from "@oneplatform/core";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { PipelineRow, PipelineDefinition } from "./pipeline-service.js";
import type {
  RunRow as RepoRunRow,
  RunStepRow as RepoRunStepRow,
  RunLogRow,
  CreateRunData,
  UpdateRunData,
} from "../repositories/types.js";
import {
  PipelineNotFoundError,
  PipelineInactiveError,
  PipelineConcurrentRunError,
  PipelineRunNotFoundError,
  PipelineRunTerminalError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Domain types — use the concrete repo row types directly.
// definition_snapshot is JSONB stored as Record<string,unknown>; callers cast
// it to PipelineDefinition (which was validated at write time).
// ---------------------------------------------------------------------------

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RunStepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";
export type TriggeredBy = "manual" | "schedule" | "event" | "webhook" | "service";

export type RunRow = RepoRunRow;
export type RunStepRow = RepoRunStepRow;
export type RunLogEntry = RunLogRow;

// ---------------------------------------------------------------------------
// Repository interfaces — use the concrete repo input types directly.
// ---------------------------------------------------------------------------

export type RunCreateInput = CreateRunData;
export type RunUpdateInput = UpdateRunData;

export interface RunListQuery {
  cursor?: string;
  limit: number;
  filterStatus?: RunStatus;
  pipelineId?: string;
}

export interface RunListResult {
  data: RunRow[];
  pagination: { nextCursor: string | null; total: number | null };
}

export interface RunRepository {
  create(data: RunCreateInput): Promise<RunRow>;
  findById(id: string): Promise<RunRow | null>;
  findByTenantAndId(tenantId: string, id: string): Promise<RunRow | null>;
  findByTenantId(tenantId: string, options?: { cursor?: string; limit?: number; filterStatus?: RunRow["status"]; pipelineId?: string }): Promise<RunRow[]>;
  updateStatus(id: string, data: RunUpdateInput): Promise<RunRow | null>;
  countActiveByPipelineId(pipelineId: string): Promise<number>;
}

export interface RunStepRepository {
  findByRunId(runId: string): Promise<RunStepRow[]>;
  createBatch(steps: Array<{
    run_id: string;
    tenant_id: string;
    step_id: string;
    step_name: string;
    step_type: string;
    input?: Record<string, unknown>;
  }>): Promise<RunStepRow[]>;
  updateStatus(runId: string, stepId: string, data: {
    status?: RunStepRow["status"];
    started_at?: Date;
    completed_at?: Date;
    error?: Record<string, unknown> | null;
    execution_id?: string;
    attempt_count?: number;
  }): Promise<RunStepRow | null>;
  updateOutput(runId: string, stepId: string, output: Record<string, unknown>): Promise<RunStepRow | null>;
}

export interface RunLogRepository {
  findByRunId(runId: string, options?: { limit?: number; afterId?: number }): Promise<RunLogEntry[]>;
  append(data: {
    run_id: string;
    tenant_id: string;
    step_id?: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    details?: Record<string, unknown>;
  }): Promise<RunLogRow>;
}

// ---------------------------------------------------------------------------
// BullMQ job payload for the pipeline:run queue
// ---------------------------------------------------------------------------

export interface PipelineRunJobPayload {
  runId: string;
  tenantId: string;
  // Ordered list of ancestor pipelineIds from the root call down to (but not
  // including) the current pipeline. Forwarded from the parent job so the worker
  // can detect cross-job circular sub-workflow chains (A → B → A across BullMQ
  // job boundaries). Omitted for top-level runs (equivalent to an empty array).
  subWorkflowCallStack?: string[];
}

// ---------------------------------------------------------------------------
// Inline PipelineRepository interface (only fields needed by RunService)
// ---------------------------------------------------------------------------

interface PipelineRepo {
  findById(id: string): Promise<PipelineRow | null>;
}

// ---------------------------------------------------------------------------
// Service output types
// ---------------------------------------------------------------------------

export interface RunWithSteps {
  run: RunRow;
  steps: RunStepRow[];
  durationMs: number | null;
}

export interface TriggerRunResult {
  runId: string;
  status: "pending";
}

export interface ReplayRunResult {
  runId: string;
  status: "pending";
  /** The execution ID that was replayed to produce this run. */
  replayOf: string;
}

export interface RunService {
  triggerRun(
    pipelineId: string,
    tenantId: string,
    triggeredBy: TriggeredBy,
    input: Record<string, unknown>,
    triggerMeta: Record<string, unknown>,
    triggerActorId?: string,
  ): Promise<TriggerRunResult>;
  getRun(tenantId: string, runId: string): Promise<RunWithSteps>;
  listRuns(tenantId: string, query: RunListQuery): Promise<RunListResult>;
  cancelRun(tenantId: string, runId: string): Promise<void>;
  getRunLogs(runId: string, lastSeenId?: number): Promise<RunLogEntry[]>;
  /**
   * Replay an existing execution using the same input that was captured when it
   * originally ran. The new run is linked to the original via trigger_meta.replayOf.
   */
  replayRun(
    pipelineId: string,
    tenantId: string,
    executionId: string,
    triggerActorId?: string,
  ): Promise<ReplayRunResult>;
}

export interface RunServiceDeps {
  runRepo: RunRepository;
  runStepRepo: RunStepRepository;
  runLogRepo: RunLogRepository;
  pipelineRepo: PipelineRepo;
  runQueue: Queue<PipelineRunJobPayload>;
  redis: Redis;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Redis key for run cancellation flag (design spec §5.3)
// TTL: 1 hour — the worker checks this flag between steps.
// ---------------------------------------------------------------------------

function cancellationKey(runId: string): string {
  return `queue:pipeline:run:${runId}:cancel`;
}

const CANCEL_FLAG_TTL_SECONDS = 3600;

const TERMINAL_STATUSES: RunStatus[] = ["completed", "failed", "cancelled"];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRunService(deps: RunServiceDeps): RunService {
  const { runRepo, runStepRepo, runLogRepo, pipelineRepo, runQueue, redis, logger } = deps;

  // -------------------------------------------------------------------------
  // triggerRun — creates a run row and enqueues the BullMQ job synchronously.
  // Hook execution (before:pipeline.trigger) is the caller's responsibility
  // and must happen BEFORE calling triggerRun.
  // -------------------------------------------------------------------------

  async function triggerRun(
    pipelineId: string,
    tenantId: string,
    triggeredBy: TriggeredBy,
    input: Record<string, unknown>,
    triggerMeta: Record<string, unknown>,
    triggerActorId?: string,
  ): Promise<TriggerRunResult> {
    const pipeline = await pipelineRepo.findById(pipelineId);
    if (pipeline === null || pipeline.tenant_id !== tenantId) {
      throw new PipelineNotFoundError(
        `Pipeline "${pipelineId}" not found.`,
        { pipelineId, tenantId },
      );
    }

    if (!pipeline.is_active) {
      throw new PipelineInactiveError(
        `Pipeline "${pipelineId}" is not active.`,
        { pipelineId },
      );
    }

    // Enforce allowConcurrentRuns=false: check for any pending/running runs.
    // definition is stored as JSONB Record<string,unknown>; cast to PipelineDefinition
    // which was validated at write time.
    const definition = pipeline.definition as unknown as PipelineDefinition;
    if (definition.options?.allowConcurrentRuns === false) {
      const activeCount = await runRepo.countActiveByPipelineId(pipelineId);
      if (activeCount > 0) {
        throw new PipelineConcurrentRunError(
          `Pipeline "${pipelineId}" does not allow concurrent runs.`,
          { pipelineId, activeRunCount: activeCount },
        );
      }
    }

    // Create the run row with a snapshot of the definition at trigger time
    const run = await runRepo.create({
      pipeline_id: pipelineId,
      tenant_id: tenantId,
      triggered_by: triggeredBy,
      ...(triggerActorId !== undefined ? { trigger_actor_id: triggerActorId } : {}),
      trigger_meta: triggerMeta,
      input,
      definition_snapshot: pipeline.definition,
    });

    // Enqueue the BullMQ job; the worker picks it up and drives execution
    const job = await runQueue.add("run", { runId: run.id, tenantId });

    // Record the BullMQ job ID on the run row for cancellation reference
    if (job.id !== undefined) {
      await runRepo.updateStatus(run.id, { bully_job_id: job.id });
    }

    logger.info("Pipeline run triggered", {
      tenantId,
      pipelineId,
      runId: run.id,
      triggeredBy,
    });

    return { runId: run.id, status: "pending" };
  }

  // -------------------------------------------------------------------------
  // getRun — fetches run details including all step rows for UI rendering
  // -------------------------------------------------------------------------

  async function getRun(tenantId: string, runId: string): Promise<RunWithSteps> {
    const run = await runRepo.findByTenantAndId(tenantId, runId);
    if (run === null) {
      throw new PipelineRunNotFoundError(
        `Pipeline run "${runId}" not found.`,
        { runId, tenantId },
      );
    }

    const steps = await runStepRepo.findByRunId(runId);

    const durationMs =
      run.started_at !== null && run.completed_at !== null
        ? run.completed_at.getTime() - run.started_at.getTime()
        : null;

    return { run, steps, durationMs };
  }

  // -------------------------------------------------------------------------
  // listRuns
  // -------------------------------------------------------------------------

  async function listRuns(tenantId: string, query: RunListQuery): Promise<RunListResult> {
    const rows = await runRepo.findByTenantId(tenantId, {
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
      ...(query.filterStatus !== undefined ? { filterStatus: query.filterStatus } : {}),
      ...(query.pipelineId !== undefined ? { pipelineId: query.pipelineId } : {}),
    });

    const nextCursor = rows.length === query.limit
      ? (rows[rows.length - 1]?.id ?? null)
      : null;

    return {
      data: rows,
      pagination: { nextCursor, total: null },
    };
  }

  // -------------------------------------------------------------------------
  // cancelRun — sets the Redis cancellation flag; the worker checks this flag
  // between steps and transitions the run to 'cancelled' state.
  // -------------------------------------------------------------------------

  async function cancelRun(tenantId: string, runId: string): Promise<void> {
    const run = await runRepo.findByTenantAndId(tenantId, runId);
    if (run === null) {
      throw new PipelineRunNotFoundError(
        `Pipeline run "${runId}" not found.`,
        { runId, tenantId },
      );
    }

    if (TERMINAL_STATUSES.includes(run.status)) {
      throw new PipelineRunTerminalError(
        `Pipeline run "${runId}" is already in terminal state "${run.status}".`,
        { runId, status: run.status },
      );
    }

    // The flag value is the ISO timestamp so we can log when cancellation was requested
    await redis.set(
      cancellationKey(runId),
      new Date().toISOString(),
      "EX",
      CANCEL_FLAG_TTL_SECONDS,
    );

    logger.info("Cancellation flag set for run", { tenantId, runId });
  }

  // -------------------------------------------------------------------------
  // getRunLogs — cursor-paginated log fetch for SSE and API
  // -------------------------------------------------------------------------

  async function getRunLogs(runId: string, lastSeenId?: number): Promise<RunLogEntry[]> {
    return runLogRepo.findByRunId(runId, lastSeenId !== undefined ? { afterId: lastSeenId } : undefined);
  }

  // -------------------------------------------------------------------------
  // replayRun — triggers a new run using the persisted input of an existing run.
  //
  // The authoritative input source is RunRow.input (stored in the DB at trigger
  // time), not the in-memory execution tracker. This ensures replay works even
  // after a service restart that cleared the tracker's in-memory history.
  // -------------------------------------------------------------------------

  async function replayRun(
    pipelineId: string,
    tenantId: string,
    executionId: string,
    triggerActorId?: string,
  ): Promise<ReplayRunResult> {
    // Verify the original run exists and belongs to this tenant + pipeline.
    const originalRun = await runRepo.findByTenantAndId(tenantId, executionId);
    if (originalRun === null) {
      throw new PipelineRunNotFoundError(
        `Pipeline run "${executionId}" not found.`,
        { runId: executionId, tenantId },
      );
    }
    if (originalRun.pipeline_id !== pipelineId) {
      // Treat pipeline mismatch as not-found to avoid leaking run IDs across pipelines.
      throw new PipelineRunNotFoundError(
        `Pipeline run "${executionId}" does not belong to pipeline "${pipelineId}".`,
        { runId: executionId, pipelineId, tenantId },
      );
    }

    // Carry the original input forward verbatim — the point of replay is
    // deterministic re-execution with identical inputs.
    const result = await triggerRun(
      pipelineId,
      tenantId,
      "manual",
      originalRun.input,
      // replayOf is threaded through trigger_meta so the execution engine can
      // surface it on the tracker's ExecutionStatus without a schema migration.
      { replayOf: executionId },
      triggerActorId,
    );

    logger.info("Pipeline run replay triggered", {
      tenantId,
      pipelineId,
      newRunId: result.runId,
      replayOf: executionId,
    });

    return { runId: result.runId, status: "pending", replayOf: executionId };
  }

  return {
    triggerRun,
    getRun,
    listRuns,
    cancelRun,
    getRunLogs,
    replayRun,
  };
}
