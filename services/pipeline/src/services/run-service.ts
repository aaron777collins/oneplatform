import type { Logger } from "@oneplatform/core";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { PipelineRow, PipelineDefinition } from "./pipeline-service.js";
import {
  PipelineNotFoundError,
  PipelineInactiveError,
  PipelineConcurrentRunError,
  PipelineRunNotFoundError,
  PipelineRunTerminalError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type RunStepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";
export type TriggeredBy = "manual" | "schedule" | "event" | "webhook" | "service";

export interface RunRow {
  id: string;
  pipeline_id: string;
  tenant_id: string;
  status: RunStatus;
  triggered_by: TriggeredBy;
  trigger_actor_id: string | null;
  trigger_meta: Record<string, unknown>;
  input: Record<string, unknown>;
  started_at: Date | null;
  completed_at: Date | null;
  error: { code: string; message: string; stepId?: string; details?: unknown } | null;
  bully_job_id: string | null;
  definition_snapshot: PipelineDefinition;
  created_at: Date;
}

export interface RunStepRow {
  id: string;
  run_id: string;
  tenant_id: string;
  step_id: string;
  step_name: string;
  step_type: string;
  status: RunStepStatus;
  attempt_count: number;
  started_at: Date | null;
  completed_at: Date | null;
  input: Record<string, unknown>;
  output: unknown | null;
  error: { code: string; message: string; details?: unknown } | null;
  execution_id: string | null;
  created_at: Date;
}

export interface RunLogEntry {
  id: number;
  run_id: string;
  step_id: string | null;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  details: unknown | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Repository interfaces
// ---------------------------------------------------------------------------

export interface RunCreateInput {
  pipelineId: string;
  tenantId: string;
  triggeredBy: TriggeredBy;
  triggerActorId?: string;
  triggerMeta: Record<string, unknown>;
  input: Record<string, unknown>;
  definitionSnapshot: PipelineDefinition;
}

export interface RunUpdateInput {
  status?: RunStatus;
  startedAt?: Date;
  completedAt?: Date;
  bullJobId?: string;
  error?: { code: string; message: string; stepId?: string; details?: unknown } | null;
}

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
  create(input: RunCreateInput): Promise<RunRow>;
  findById(id: string): Promise<RunRow | null>;
  findByIdWithTenant(tenantId: string, id: string): Promise<RunRow | null>;
  list(tenantId: string, query: RunListQuery): Promise<RunListResult>;
  update(id: string, input: RunUpdateInput): Promise<RunRow>;
  countActiveRuns(pipelineId: string): Promise<number>;
}

export interface RunStepRepository {
  findByRunId(runId: string): Promise<RunStepRow[]>;
}

export interface RunLogRepository {
  findByRunId(runId: string, lastSeenId?: number, limit?: number): Promise<RunLogEntry[]>;
}

// ---------------------------------------------------------------------------
// BullMQ job payload for the pipeline:run queue
// ---------------------------------------------------------------------------

export interface PipelineRunJobPayload {
  runId: string;
  tenantId: string;
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

    // Enforce allowConcurrentRuns=false: check for any pending/running runs
    if (pipeline.definition.options?.allowConcurrentRuns === false) {
      const activeCount = await runRepo.countActiveRuns(pipelineId);
      if (activeCount > 0) {
        throw new PipelineConcurrentRunError(
          `Pipeline "${pipelineId}" does not allow concurrent runs.`,
          { pipelineId, activeRunCount: activeCount },
        );
      }
    }

    // Create the run row with a snapshot of the definition at trigger time
    const run = await runRepo.create({
      pipelineId,
      tenantId,
      triggeredBy,
      ...(triggerActorId !== undefined ? { triggerActorId } : {}),
      triggerMeta,
      input,
      definitionSnapshot: pipeline.definition,
    });

    // Enqueue the BullMQ job; the worker picks it up and drives execution
    const job = await runQueue.add("run", { runId: run.id, tenantId });

    // Record the BullMQ job ID on the run row for cancellation reference
    if (job.id !== undefined) {
      await runRepo.update(run.id, { bullJobId: job.id });
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
    const run = await runRepo.findByIdWithTenant(tenantId, runId);
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
    return runRepo.list(tenantId, query);
  }

  // -------------------------------------------------------------------------
  // cancelRun — sets the Redis cancellation flag; the worker checks this flag
  // between steps and transitions the run to 'cancelled' state.
  // -------------------------------------------------------------------------

  async function cancelRun(tenantId: string, runId: string): Promise<void> {
    const run = await runRepo.findByIdWithTenant(tenantId, runId);
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
    return runLogRepo.findByRunId(runId, lastSeenId);
  }

  return {
    triggerRun,
    getRun,
    listRuns,
    cancelRun,
    getRunLogs,
  };
}
