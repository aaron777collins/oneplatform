/**
 * schedule command group — cron schedule management. Required scope: pipelines:manage
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive } from "../../lib/prompts.js";

const SCHEDULE_COLUMNS = [
  { header: "ID", key: "id" },
  { header: "Name", key: "name" },
  { header: "Pipeline", key: "pipelineId" },
  { header: "Cron", key: "cron" },
  { header: "Status", key: "status" },
  { header: "Next Run", key: "nextRunAt" },
  { header: "Last Run", key: "lastRunAt" },
];

// Validates a standard 5-field cron expression before sending to API
function validateCron(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CliError(
      `Invalid cron expression '${expr}'. Expected 5 fields (minute hour day-of-month month day-of-week).`,
      EXIT.GENERAL,
    );
  }
}

interface ListOpts { pipeline?: string; status?: string }
interface CreateOpts { pipeline: string; cron: string; name?: string; timezone?: string; inputTemplate?: string; disabled?: boolean }
interface UpdateOpts { name?: string; cron?: string; timezone?: string; inputTemplate?: string; enabled?: boolean }

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.pipeline) query["pipelineId"] = opts.pipeline;
  if (opts.status) query["status"] = opts.status;
  const schedules = await ctx.http.get<unknown[]>("/api/v1/schedules", query);
  ctx.renderer.render(schedules, SCHEDULE_COLUMNS);
}

async function createAction(opts: CreateOpts, ctx: CommandContext): Promise<void> {
  validateCron(opts.cron);
  const body: Record<string, unknown> = {
    pipelineId: opts.pipeline,
    // Service expects 'cronExpr', not 'cron' (M-11 fix)
    cronExpr: opts.cron,
  };
  if (opts.name) body["name"] = opts.name;
  body["timezone"] = opts.timezone ?? "UTC";
  if (opts.inputTemplate) {
    try {
      body["inputTemplate"] = JSON.parse(opts.inputTemplate) as unknown;
    } catch {
      throw new CliError("--input-template must be valid JSON.", EXIT.GENERAL);
    }
  }
  if (opts.disabled) body["enabled"] = false;

  const resp = await ctx.http.post<{ id: string; name: string }>("/api/v1/schedules", body);
  ctx.renderer.success(`Schedule '${resp.name}' created (ID: ${resp.id}).`);
}

async function getAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const schedule = await ctx.http.get<unknown>(`/api/v1/schedules/${encodeURIComponent(id)}`);
  ctx.renderer.json(schedule);
}

async function updateAction(id: string, opts: UpdateOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body["name"] = opts.name;
  if (opts.cron !== undefined) {
    validateCron(opts.cron);
    body["cronExpr"] = opts.cron;
  }
  if (opts.timezone !== undefined) body["timezone"] = opts.timezone;
  if (opts.inputTemplate !== undefined) {
    try {
      body["inputTemplate"] = JSON.parse(opts.inputTemplate) as unknown;
    } catch {
      throw new CliError("--input-template must be valid JSON.", EXIT.GENERAL);
    }
  }
  if (opts.enabled !== undefined) body["enabled"] = opts.enabled;

  const resp = await ctx.http.patch<{ id: string; name: string }>(
    `/api/v1/schedules/${encodeURIComponent(id)}`,
    body,
  );
  ctx.renderer.success(`Schedule '${resp.name}' updated (ID: ${resp.id}).`);
}

async function pauseAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await ctx.http.patch(`/api/v1/schedules/${encodeURIComponent(id)}`, { enabled: false });
  ctx.renderer.success(`Schedule ${id} paused.`);
}

async function resumeAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await ctx.http.patch(`/api/v1/schedules/${encodeURIComponent(id)}`, { enabled: true });
  ctx.renderer.success(`Schedule ${id} resumed.`);
}

async function deleteAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Delete schedule '${id}'?`, ctx.yes);
  await ctx.http.delete(`/api/v1/schedules/${encodeURIComponent(id)}`);
  ctx.renderer.success(`Schedule ${id} deleted.`);
}

export function registerSchedule(program: Command): void {
  const schedule = program.command("schedule").description("Cron schedule management (scope: pipelines:manage)");

  schedule.command("list").description("List all schedules")
    .option("--pipeline <id>", "Filter by pipeline ID")
    .option("--status <status>", "Filter by status: active|paused")
    .action(withContext<[ListOpts]>(listAction));

  schedule.command("get").description("Get details of a schedule")
    .argument("<id>", "Schedule ID")
    .action(withContext<[string, Record<string, never>]>(getAction));

  schedule.command("update").description("Update an existing schedule")
    .argument("<id>", "Schedule ID")
    .option("--name <name>", "New display name")
    .option("--cron <expr>", "New cron expression")
    .option("--timezone <tz>", "New IANA timezone string")
    .option("--input-template <json>", "New JSON input template")
    .option("--enabled", "Enable the schedule")
    .option("--no-enabled", "Disable the schedule")
    .action(withContext<[string, UpdateOpts]>(updateAction));

  schedule.command("create").description("Create a cron schedule for a pipeline")
    .requiredOption("--pipeline <id>", "Pipeline ID")
    .requiredOption("--cron <expr>", 'Standard 5-field cron expression (minute hour day month weekday). Examples: "0 */6 * * *" (every 6 hours), "30 9 * * 1-5" (weekdays at 09:30)')
    .option("--name <name>", "Display name")
    .option("--timezone <tz>", "IANA timezone string (default: UTC)")
    .option("--input-template <json>", "JSON string of input template parameters passed to each triggered run")
    .option("--disabled", "Create the schedule in a disabled state")
    .action(withContext<[CreateOpts]>(createAction));

  schedule.command("pause").description("Pause a schedule")
    .argument("<id>", "Schedule ID")
    .action(withContext<[string, Record<string, never>]>(pauseAction));

  schedule.command("resume").description("Resume a paused schedule")
    .argument("<id>", "Schedule ID")
    .action(withContext<[string, Record<string, never>]>(resumeAction));

  schedule.command("delete").description("Delete a schedule")
    .argument("<id>", "Schedule ID")
    .action(withContext<[string, Record<string, never>]>(deleteAction));
}
