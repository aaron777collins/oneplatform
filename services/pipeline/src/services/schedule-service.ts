import type { Logger } from "@oneplatform/core";
import { parseExpression } from "cron-parser";
import type { PipelineRow } from "./pipeline-service.js";
import type { TriggeredBy, TriggerRunResult, RunService, RunStatus } from "./run-service.js";
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
  /**
   * Pipeline IDs that must have a 'completed' latest run before this schedule
   * fires. If any dependency's latest run is not 'completed', this tick is
   * skipped and the reason is logged. Empty array (default) means no dependencies.
   */
  depends_on: string[];
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

// Matches CreateScheduleData from the concrete repository (snake_case).
export interface ScheduleCreateInput {
  pipeline_id: string;
  tenant_id: string;
  cron_expr: string;
  timezone?: string;
  enabled?: boolean;
  input_template?: Record<string, unknown>;
  depends_on?: string[];
  next_run_at?: Date;
}

// Matches UpdateScheduleData from the concrete repository (snake_case).
export interface ScheduleUpdateInput {
  cron_expr?: string;
  timezone?: string;
  enabled?: boolean;
  input_template?: Record<string, unknown>;
  depends_on?: string[];
  next_run_at?: Date;
  last_run_at?: Date;
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
  findByTenantAndId(tenantId: string, id: string): Promise<ScheduleRow | null>;
  findByTenantId(tenantId: string, options?: { cursor?: string; limit?: number }): Promise<ScheduleRow[]>;
  update(id: string, data: ScheduleUpdateInput): Promise<ScheduleRow | null>;
  delete(id: string): Promise<boolean>;
  findAllEnabled(): Promise<ScheduleRow[]>;
  findDueSchedules(asOf: Date): Promise<ScheduleRow[]>;
  // Optimistic-lock update: only succeeds if the row still has the expected next_run_at.
  // Used to prevent duplicate cron triggers across replicas (design spec §19.3).
  updateNextRunAt(id: string, lastRunAt: Date, nextRunAt: Date, currentNextRunAt: Date): Promise<boolean>;
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
  /**
   * Pipeline IDs that must complete before this schedule runs.
   * Evaluated on every cron tick; the tick is skipped if any dependency has
   * not completed its latest run. Defaults to [] (no dependencies).
   */
  dependsOn?: string[];
}

export interface UpdateScheduleInput {
  cronExpr?: string;
  timezone?: string;
  enabled?: boolean;
  inputTemplate?: Record<string, unknown>;
  /** Replace the dependency list. Pass [] to clear all dependencies. */
  dependsOn?: string[];
}

// ---------------------------------------------------------------------------
// Dependency management types
// ---------------------------------------------------------------------------

export interface DependencyCheckResult {
  /** true when all dependencies' latest runs are 'completed' (or there are none). */
  satisfied: boolean;
  /** Pipeline IDs whose latest run is not in 'completed' state. */
  blocking: string[];
}

// ---------------------------------------------------------------------------
// Inline RunRepository interface — only the methods needed by dependency checks
// ---------------------------------------------------------------------------

interface RunRepoForDeps {
  findByTenantId(
    tenantId: string,
    options: { limit: number; pipelineId: string; filterStatus?: RunStatus },
  ): Promise<Array<{ pipeline_id: string; status: RunStatus }>>;
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
  /**
   * Checks whether all pipelines in dependsOn have a latest run in 'completed'
   * state. The cron tick calls this before triggering a scheduled run; it is
   * also exposed here for manual inspection and testing.
   *
   * This is a basic DAG guard, not a full orchestration engine. It reads the
   * most recent run for each dependency pipeline and checks its status.
   */
  checkDependencies(tenantId: string, dependsOn: string[]): Promise<DependencyCheckResult>;
  startCronLoop(): void;
  stop(): void;
}

export interface ScheduleServiceDeps {
  scheduleRepo: ScheduleRepository;
  pipelineRepo: PipelineRepo;
  runService: RunService;
  /**
   * Run repository used by checkDependencies to look up the latest run for
   * each dependency pipeline. Injected separately from RunService because
   * the service-layer interface does not expose a latest-run-by-pipeline query.
   */
  runRepo: RunRepoForDeps;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Cron expression validation and next-run computation (design spec §8.1)
// ---------------------------------------------------------------------------

// DE-008: Common @-shorthand aliases mapped to their 5-field equivalents.
// Supporting these reduces friction for users who are familiar with
// the Unix/systemd convention. All map to minute-granularity expressions
// since sub-minute scheduling is not supported (see field-count check below).
const CRON_ALIAS_MAP: Record<string, string> = {
  "@yearly":   "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly":  "0 0 1 * *",
  "@weekly":   "0 0 * * 0",
  "@daily":    "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly":   "0 * * * *",
};

function validateCronExpression(cronExpr: string): void {
  // Expand @-shorthand aliases before validation so they pass the field-count check.
  const expanded = CRON_ALIAS_MAP[cronExpr.trim()] ?? cronExpr;

  // Reject 6-field (second-level) expressions — minimum granularity is 1 minute
  const fields = expanded.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleInvalidCronError(
      `Invalid cron expression: expected 5 fields (got ${fields.length}). ` +
        "Minimum granularity is 1 minute (second-level cron is not supported).",
      { cronExpr },
    );
  }

  // Validate via cron-parser — throws if expression is syntactically invalid
  try {
    parseExpression(expanded, { tz: "UTC" });
  } catch (err) {
    throw new ScheduleInvalidCronError(
      `Invalid cron expression "${cronExpr}": ${err instanceof Error ? err.message : String(err)}`,
      { cronExpr },
    );
  }
}

function validateTimezone(timezone: string): void {
  // Validate against the IANA time zone database using the built-in Intl API.
  // This prevents creation of schedules with typos like "US/Eastrn" that would
  // silently fail at cron-tick time.
  const supported = Intl.supportedValuesOf("timeZone");
  if (timezone !== "UTC" && !supported.includes(timezone)) {
    throw new ScheduleInvalidCronError(
      `Invalid timezone "${timezone}". Must be a valid IANA timezone, e.g. "America/New_York" or "UTC".`,
      { timezone },
    );
  }
}

function computeNextRunAt(cronExpr: string, timezone: string): Date {
  // Expand @-shorthands so the parser receives a valid 5-field expression.
  const expanded = CRON_ALIAS_MAP[cronExpr.trim()] ?? cronExpr;
  const interval = parseExpression(expanded, {
    tz: timezone,
    currentDate: new Date(),
  });
  return interval.next().toDate();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScheduleService(deps: ScheduleServiceDeps): ScheduleService {
  const { scheduleRepo, pipelineRepo, runService, runRepo, logger } = deps;

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

    // Validate timezone against the IANA time zone database
    validateTimezone(input.timezone);

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
      pipeline_id: input.pipelineId,
      tenant_id: tenantId,
      cron_expr: input.cronExpr,
      timezone: input.timezone,
      enabled: input.enabled,
      input_template: input.inputTemplate,
      depends_on: input.dependsOn ?? [],
      next_run_at: nextRunAt,
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
    const schedule = await scheduleRepo.findByTenantAndId(tenantId, id);
    if (schedule === null) {
      throw new ScheduleNotFoundError(`Schedule "${id}" not found.`, { scheduleId: id, tenantId });
    }
    return schedule;
  }

  // -------------------------------------------------------------------------
  // listSchedules
  // -------------------------------------------------------------------------

  async function listSchedules(tenantId: string, query: ScheduleListQuery): Promise<ScheduleListResult> {
    const rows = await scheduleRepo.findByTenantId(tenantId, {
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
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
  // updateSchedule
  // -------------------------------------------------------------------------

  async function updateSchedule(
    tenantId: string,
    id: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleRow> {
    const existing = await getSchedule(tenantId, id);

    const updateData: ScheduleUpdateInput = {};

    if (input.cronExpr !== undefined) {
      validateCronExpression(input.cronExpr);
      updateData.cron_expr = input.cronExpr;
    }
    if (input.timezone !== undefined) {
      validateTimezone(input.timezone);
      updateData.timezone = input.timezone;
    }
    if (input.enabled !== undefined) {
      updateData.enabled = input.enabled;
    }
    if (input.inputTemplate !== undefined) {
      updateData.input_template = input.inputTemplate;
    }
    if (input.dependsOn !== undefined) {
      updateData.depends_on = input.dependsOn;
    }

    // Recompute next_run_at if cron or timezone changed
    const newCronExpr = input.cronExpr ?? existing.cron_expr;
    const newTimezone = input.timezone ?? existing.timezone;

    if (input.cronExpr !== undefined || input.timezone !== undefined) {
      updateData.next_run_at = computeNextRunAt(newCronExpr, newTimezone);
    }

    const updated = await scheduleRepo.update(id, updateData);
    if (updated === null) {
      throw new ScheduleNotFoundError(`Schedule "${id}" not found.`, { scheduleId: id, tenantId });
    }

    const schedule = updated;

    logger.info("Schedule updated", { tenantId, scheduleId: id });

    return schedule;
  }

  // -------------------------------------------------------------------------
  // deleteSchedule
  // -------------------------------------------------------------------------

  async function deleteSchedule(tenantId: string, id: string): Promise<void> {
    await getSchedule(tenantId, id);
    await scheduleRepo.delete(id);
    logger.info("Schedule deleted", { tenantId, scheduleId: id });
  }

  // -------------------------------------------------------------------------
  // checkDependencies — basic DAG guard for pipeline dependency management
  //
  // WHY: The scheduler must not trigger pipeline B if pipeline A (a declared
  // dependency) has not completed its latest run. This prevents running
  // downstream pipelines on stale data. It is a best-effort check, not a
  // transactional lock — a dependency run could start after this check and
  // before the trigger, but that race is acceptable for scheduled workflows.
  // -------------------------------------------------------------------------

  async function checkDependencies(
    tenantId: string,
    dependsOn: string[],
  ): Promise<DependencyCheckResult> {
    if (dependsOn.length === 0) {
      return { satisfied: true, blocking: [] };
    }

    const blocking: string[] = [];

    for (const depPipelineId of dependsOn) {
      // Fetch the single most recent run for this dependency pipeline.
      // The repo sorts by created_at DESC so the first row is the latest run.
      let latestRuns: Array<{ pipeline_id: string; status: RunStatus }>;
      try {
        latestRuns = await runRepo.findByTenantId(tenantId, {
          limit: 1,
          pipelineId: depPipelineId,
        });
      } catch (err) {
        // If we cannot determine the dependency status, treat it as blocking
        // to prevent accidental runs on unknown dependency state.
        logger.warn("checkDependencies: failed to query latest run for dependency", {
          depPipelineId,
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        blocking.push(depPipelineId);
        continue;
      }

      const latestRun = latestRuns[0];
      if (latestRun === undefined || latestRun.status !== "completed") {
        blocking.push(depPipelineId);
      }
    }

    return { satisfied: blocking.length === 0, blocking };
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

        // Optimistic lock: only the first replica to claim this tick wins.
        // The UPDATE WHERE next_run_at = currentNextRunAt guard (design spec §19.3)
        // prevents duplicate triggers when multiple instances race on the same schedule.
        const claimed = await scheduleRepo.updateNextRunAt(
          schedule.id,
          now,
          nextRunAt,
          schedule.next_run_at ?? now,
        );

        if (!claimed) {
          // Another instance claimed this tick first
          continue;
        }

        // Check pipeline dependencies before triggering. If any dependency's
        // latest run is not 'completed', skip this tick and log why. The
        // schedule's next_run_at has already been advanced above so the next
        // cron tick will re-evaluate the dependencies at the next scheduled
        // time rather than re-checking on every 30s poll.
        const dependsOn = schedule.depends_on ?? [];
        if (dependsOn.length > 0) {
          const depCheck = await checkDependencies(schedule.tenant_id, dependsOn);
          if (!depCheck.satisfied) {
            logger.info("Cron schedule skipped: dependencies not completed", {
              scheduleId: schedule.id,
              pipelineId: schedule.pipeline_id,
              tenantId: schedule.tenant_id,
              blockingPipelines: depCheck.blocking,
            });
            continue;
          }
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
    checkDependencies,
    startCronLoop,
    stop,
  };
}
