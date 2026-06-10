import type { Logger } from "@oneplatform/core";
import { parseExpression } from "cron-parser";
import type { PipelineRow } from "./pipeline-service.js";
import type { TriggeredBy, TriggerRunResult, RunService } from "./run-service.js";
import { ScheduleNotFoundError, ScheduleInvalidCronError } from "./errors.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  id: string;
  pipeline_id: string;
  tenant_id: string;
  cron_expr: string;
  timezone: string;
  enabled: boolean;
  input_template: Record<string, unknown>;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface ScheduleCreateInput {
  pipelineId: string;
  tenantId: string;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  inputTemplate: Record<string, unknown>;
  nextRunAt: Date;
}

export interface ScheduleUpdateInput {
  cronExpr?: string;
  timezone?: string;
  enabled?: boolean;
  inputTemplate?: Record<string, unknown>;
  nextRunAt?: Date;
  lastRunAt?: Date;
}

export interface ScheduleListQuery {
  cursor?: string;
  limit: number;
}

export interface ScheduleListResult {
  data: ScheduleRow[];
  pagination: { nextCursor: string | null; total: number | null };
}

export interface ScheduleRepository {
  create(input: ScheduleCreateInput): Promise<ScheduleRow>;
  findById(id: string): Promise<ScheduleRow | null>;
  findByIdWithTenant(tenantId: string, id: string): Promise<ScheduleRow | null>;
  list(tenantId: string, query: ScheduleListQuery): Promise<ScheduleListResult>;
  update(tenantId: string, id: string, input: ScheduleUpdateInput): Promise<ScheduleRow>;
  delete(tenantId: string, id: string): Promise<void>;
  findAllEnabled(): Promise<ScheduleRow[]>;
  findDueSchedules(asOf: Date): Promise<ScheduleRow[]>;
  // Optimistic-lock update: only succeeds if the row still has the expected next_run_at
  // Used to prevent duplicate cron triggers across replicas (design spec §19.3)
  claimScheduleRun(scheduleId: string, expectedNextRunAt: Date, newNextRunAt: Date, lastRunAt: Date): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Inline PipelineRepository interface (only fields needed by ScheduleService)
// ---------------------------------------------------------------------------

interface PipelineRepo {
  findById(id: string): Promise<PipelineRow | null>;
}

// ---------------------------------------------------------------------------
// Service input shapes
// ---------------------------------------------------------------------------

export interface CreateScheduleInput {
  pipelineId: string;
  cronExpr: string;
  timezone: string;
  enabled: boolean;
  inputTemplate: Record<string, unknown>;
}

export interface UpdateScheduleInput {
  cronExpr?: string;
  timezone?: string;
  enabled?: boolean;
  inputTemplate?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ScheduleService {
  createSchedule(tenantId: string, input: CreateScheduleInput): Promise<ScheduleRow>;
  getSchedule(tenantId: string, id: string): Promise<ScheduleRow>;
  listSchedules(tenantId: string, query: ScheduleListQuery): Promise<ScheduleListResult>;
  updateSchedule(tenantId: string, id: string, input: UpdateScheduleInput): Promise<ScheduleRow>;
  deleteSchedule(tenantId: string, id: string): Promise<void>;
  startCronLoop(): void;
  stop(): void;
}

export interface ScheduleServiceDeps {
  scheduleRepo: ScheduleRepository;
  pipelineRepo: PipelineRepo;
  runService: RunService;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Cron expression validation and next-run computation (design spec §8.1)
// ---------------------------------------------------------------------------

function validateCronExpression(cronExpr: string): void {
  // Reject 6-field (second-level) expressions — minimum granularity is 1 minute
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleInvalidCronError(
      `Invalid cron expression: expected 5 fields (got ${fields.length}). ` +
        "Minimum granularity is 1 minute (second-level cron is not supported).",
      { cronExpr },
    );
  }

  // Validate via cron-parser — throws if expression is syntactically invalid
  try {
    parseExpression(cronExpr, { tz: "UTC" });
  } catch (err) {
    throw new ScheduleInvalidCronError(
      `Invalid cron expression "${cronExpr}": ${err instanceof Error ? err.message : String(err)}`,
      { cronExpr },
    );
  }
}

function computeNextRunAt(cronExpr: string, timezone: string): Date {
  const interval = parseExpression(cronExpr, {
    tz: timezone,
    currentDate: new Date(),
  });
  return interval.next().toDate();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScheduleService(deps: ScheduleServiceDeps): ScheduleService {
  const { scheduleRepo, pipelineRepo, runService, logger } = deps;

  let cronLoopTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  // -------------------------------------------------------------------------
  // createSchedule
  // -------------------------------------------------------------------------

  async function createSchedule(
    tenantId: string,
    input: CreateScheduleInput,
  ): Promise<ScheduleRow> {
    // Validate cron expression before any I/O
    validateCronExpression(input.cronExpr);

    // Verify the target pipeline exists and belongs to this tenant
    const pipeline = await pipelineRepo.findById(input.pipelineId);
    if (pipeline === null || pipeline.tenant_id !== tenantId) {
      throw new ScheduleNotFoundError(
        `Pipeline "${input.pipelineId}" not found.`,
        { pipelineId: input.pipelineId, tenantId },
      );
    }

    const nextRunAt = computeNextRunAt(input.cronExpr, input.timezone);

    const schedule = await scheduleRepo.create({
      pipelineId: input.pipelineId,
      tenantId,
      cronExpr: input.cronExpr,
      timezone: input.timezone,
      enabled: input.enabled,
      inputTemplate: input.inputTemplate,
      nextRunAt,
    });

    logger.info("Schedule created", {
      tenantId,
      scheduleId: schedule.id,
      pipelineId: input.pipelineId,
      nextRunAt: nextRunAt.toISOString(),
    });

    return schedule;
  }

  // -------------------------------------------------------------------------
  // getSchedule
  // -------------------------------------------------------------------------

  async function getSchedule(tenantId: string, id: string): Promise<ScheduleRow> {
    const schedule = await scheduleRepo.findByIdWithTenant(tenantId, id);
    if (schedule === null) {
      throw new ScheduleNotFoundError(`Schedule "${id}" not found.`, { scheduleId: id, tenantId });
    }
    return schedule;
  }

  // -------------------------------------------------------------------------
  // listSchedules
  // -------------------------------------------------------------------------

  async function listSchedules(tenantId: string, query: ScheduleListQuery): Promise<ScheduleListResult> {
    return scheduleRepo.list(tenantId, query);
  }

  // -------------------------------------------------------------------------
  // updateSchedule
  // -------------------------------------------------------------------------

  async function updateSchedule(
    tenantId: string,
    id: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleRow> {
    const existing = await getSchedule(tenantId, id);

    const updateInput: ScheduleUpdateInput = {};

    if (input.cronExpr !== undefined) {
      validateCronExpression(input.cronExpr);
      updateInput.cronExpr = input.cronExpr;
    }
    if (input.timezone !== undefined) {
      updateInput.timezone = input.timezone;
    }
    if (input.enabled !== undefined) {
      updateInput.enabled = input.enabled;
    }
    if (input.inputTemplate !== undefined) {
      updateInput.inputTemplate = input.inputTemplate;
    }

    // Recompute next_run_at if cron or timezone changed
    const newCronExpr = input.cronExpr ?? existing.cron_expr;
    const newTimezone = input.timezone ?? existing.timezone;

    if (input.cronExpr !== undefined || input.timezone !== undefined) {
      updateInput.nextRunAt = computeNextRunAt(newCronExpr, newTimezone);
    }

    const schedule = await scheduleRepo.update(tenantId, id, updateInput);

    logger.info("Schedule updated", { tenantId, scheduleId: id });

    return schedule;
  }

  // -------------------------------------------------------------------------
  // deleteSchedule
  // -------------------------------------------------------------------------

  async function deleteSchedule(tenantId: string, id: string): Promise<void> {
    await getSchedule(tenantId, id);
    await scheduleRepo.delete(tenantId, id);
    logger.info("Schedule deleted", { tenantId, scheduleId: id });
  }

  // -------------------------------------------------------------------------
  // cronTick — called every 30 seconds to find and trigger due schedules
  // -------------------------------------------------------------------------

  async function cronTick(): Promise<void> {
    if (stopped) return;

    const now = new Date();

    let dueSchedules: ScheduleRow[];
    try {
      dueSchedules = await scheduleRepo.findDueSchedules(now);
    } catch (err) {
      logger.error("Cron tick: failed to query due schedules", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const schedule of dueSchedules) {
      if (stopped) break;

      try {
        const nextRunAt = computeNextRunAt(schedule.cron_expr, schedule.timezone);

        // Optimistic lock: only the first replica to claim this tick wins
        // (design spec §19.3 — UPDATE WHERE next_run_at = expected prevents duplicate triggers)
        const claimed = await scheduleRepo.claimScheduleRun(
          schedule.id,
          schedule.next_run_at ?? now,
          nextRunAt,
          now,
        );

        if (!claimed) {
          // Another instance claimed this tick first
          continue;
        }

        await runService.triggerRun(
          schedule.pipeline_id,
          schedule.tenant_id,
          "schedule" as TriggeredBy,
          schedule.input_template,
          { scheduleId: schedule.id, cronExpr: schedule.cron_expr },
          schedule.id,
        );

        logger.info("Cron schedule triggered run", {
          scheduleId: schedule.id,
          pipelineId: schedule.pipeline_id,
          tenantId: schedule.tenant_id,
          nextRunAt: nextRunAt.toISOString(),
        });
      } catch (err) {
        // Log warning but continue — one failed schedule should not block others
        logger.warn("Cron tick: failed to trigger run for schedule", {
          scheduleId: schedule.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // startCronLoop — begins the 30-second polling loop (design spec §8.1)
  // -------------------------------------------------------------------------

  function startCronLoop(): void {
    if (cronLoopTimer !== null) return;

    logger.info("Cron scheduler loop started (30s interval)");

    // Run an initial tick immediately to catch up on missed schedules after restart
    void cronTick().catch((err) => {
      logger.error("Initial cron tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    cronLoopTimer = setInterval(() => {
      void cronTick().catch((err) => {
        logger.error("Cron tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 30_000);
  }

  // -------------------------------------------------------------------------
  // stop — cleanup (called on SIGTERM)
  // -------------------------------------------------------------------------

  function stop(): void {
    stopped = true;
    if (cronLoopTimer !== null) {
      clearInterval(cronLoopTimer);
      cronLoopTimer = null;
    }
    logger.info("Cron scheduler stopped.");
  }

  return {
    createSchedule,
    getSchedule,
    listSchedules,
    updateSchedule,
    deleteSchedule,
    startCronLoop,
    stop,
  };
}
