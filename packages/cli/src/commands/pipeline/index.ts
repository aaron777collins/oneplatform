/**
 * pipeline command group — pipeline management.
 * Read scope: pipelines:read | Write scope: pipelines:manage
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive } from "../../lib/prompts.js";
import { readFileSync } from "node:fs";
import { streamSse } from "../../lib/streaming.js";
import { colorizeLogLevel } from "../../lib/output.js";

const PIPELINE_COLUMNS = [
  { header: "ID", key: "id" },
  { header: "Name", key: "name" },
  { header: "Status", key: "status" },
  { header: "Last Run", key: "lastRunAt" },
  { header: "Last Run Status", key: "lastRunStatus" },
];

const RUN_COLUMNS = [
  { header: "Run ID", key: "id" },
  { header: "Status", key: "status" },
  { header: "Triggered By", key: "triggeredBy" },
  { header: "Started", key: "startedAt" },
  { header: "Duration", key: "durationMs" },
  { header: "Steps", key: "stepCount" },
];

interface ListOpts { status?: string }
interface TriggerOpts { input?: string; wait?: boolean; pollTimeout?: string }
interface RunsOpts { limit?: string; status?: string }
interface RunLogsOpts { follow?: boolean; step?: string; level?: string }

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.status) query["status"] = opts.status;
  const pipelines = await ctx.http.get<unknown[]>("/api/v1/pipelines", query);
  ctx.renderer.render(pipelines, PIPELINE_COLUMNS);
}

async function getAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const pipeline = await ctx.http.get<unknown>(`/api/v1/pipelines/${encodeURIComponent(id)}`);
  ctx.renderer.json(pipeline);
}

async function createAction(opts: { file: string }, ctx: CommandContext): Promise<void> {
  const { load } = await import("js-yaml");
  const content = readFileSync(opts.file, "utf8");
  const definition = load(content) as unknown;
  const resp = await ctx.http.post<{ id: string; name: string }>("/api/v1/pipelines", definition);
  ctx.renderer.success(`Pipeline '${resp.name}' created (ID: ${resp.id}).`);
}

async function updateAction(id: string, opts: { file: string }, ctx: CommandContext): Promise<void> {
  const { load } = await import("js-yaml");
  const content = readFileSync(opts.file, "utf8");
  const definition = load(content) as unknown;
  await ctx.http.patch(`/api/v1/pipelines/${encodeURIComponent(id)}`, definition);
  ctx.renderer.success(`Pipeline ${id} updated.`);
}

async function deleteAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Delete pipeline '${id}'?`, ctx.yes);
  await ctx.http.delete(`/api/v1/pipelines/${encodeURIComponent(id)}`);
  ctx.renderer.success(`Pipeline ${id} deleted.`);
}

async function triggerAction(id: string, opts: TriggerOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.input) {
    try {
      body["input"] = JSON.parse(opts.input) as unknown;
    } catch {
      throw new CliError("--input must be valid JSON.", EXIT.GENERAL);
    }
  }

  const resp = await ctx.http.post<{ runId: string }>(`/api/v1/pipelines/${encodeURIComponent(id)}/trigger`, body);
  // Run ID to stdout — allows `RUN_ID=$(op pipeline trigger ... --wait)` to work correctly
  process.stdout.write(resp.runId + "\n");

  if (!opts.wait) return;

  // Poll status and stream logs to stderr while waiting
  const pollTimeoutSec = parseInt(opts.pollTimeout ?? "600", 10);
  const deadline = Date.now() + pollTimeoutSec * 1000;
  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    if (Date.now() > deadline) {
      throw new CliError(
        `Poll timeout: pipeline run did not complete within ${pollTimeoutSec}s.`,
        EXIT.GENERAL,
      );
    }
    const status = await ctx.http.get<{ status: string }>(
      `/api/v1/pipeline-runs/${resp.runId}`,
    );
    process.stderr.write(`Run status: ${status.status}\n`);
    if (status.status === "completed") return;
    if (status.status === "failed" || status.status === "cancelled") {
      throw new CliError(`Pipeline run ${status.status}.`, EXIT.GENERAL);
    }
  }
}

async function runsAction(id: string, opts: RunsOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.limit) query["limit"] = opts.limit;
  if (opts.status) query["status"] = opts.status;
  const runs = await ctx.http.get<unknown[]>(`/api/v1/pipelines/${encodeURIComponent(id)}/runs`, query);
  ctx.renderer.render(runs, RUN_COLUMNS);
}

async function runStatusAction(runId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const status = await ctx.http.get<unknown>(`/api/v1/pipeline-runs/${encodeURIComponent(runId)}`);
  ctx.renderer.json(status);
}

async function runCancelAction(runId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Cancel pipeline run '${runId}'?`, ctx.yes);
  await ctx.http.post(`/api/v1/pipeline-runs/${encodeURIComponent(runId)}/cancel`);
  ctx.renderer.success(`Run ${runId} cancellation requested.`);
}

async function runLogsAction(runId: string, opts: RunLogsOpts, ctx: CommandContext): Promise<void> {
  if (opts.follow) {
    const query: Record<string, unknown> = {};
    if (opts.step) query["stepId"] = opts.step;
    if (opts.level) query["level"] = opts.level;

    process.stderr.write(`Streaming logs for run ${runId}... (Ctrl+C to stop)\n`);
    for await (const event of streamSse(ctx.http, `/api/v1/pipeline-runs/${encodeURIComponent(runId)}/logs/stream`, query)) {
      try {
        const logEntry = JSON.parse(event.data) as { level?: string; message?: string; timestamp?: string };
        const level = colorizeLogLevel(logEntry.level ?? "info", ctx.noColor);
        process.stdout.write(`[${logEntry.timestamp ?? ""}] ${level}: ${logEntry.message ?? event.data}\n`);
      } catch {
        process.stdout.write(event.data + "\n");
      }
    }
    return;
  }

  const query: Record<string, unknown> = {};
  if (opts.step) query["stepId"] = opts.step;
  if (opts.level) query["level"] = opts.level;
  const logs = await ctx.http.get<unknown>(`/api/v1/pipeline-runs/${encodeURIComponent(runId)}/logs`, query);
  ctx.renderer.json(logs);
}

export function registerPipeline(program: Command): void {
  const pipeline = program.command("pipeline").description("Pipeline management");

  pipeline.command("list").description("List all pipelines")
    .option("--status <status>", "Filter by status: active|paused|draft")
    .action(withContext<[ListOpts]>(listAction));

  pipeline.command("get").description("Get pipeline details")
    .argument("<id>", "Pipeline ID")
    .action(withContext<[string, Record<string, never>]>(getAction));

  pipeline.command("create").description("Create a pipeline from YAML file")
    .requiredOption("--file <pipeline.yaml>", "Path to pipeline YAML definition")
    .action(withContext<[{ file: string }]>(createAction));

  pipeline.command("update").description("Update a pipeline from YAML file")
    .argument("<id>", "Pipeline ID")
    .requiredOption("--file <pipeline.yaml>", "Path to pipeline YAML definition")
    .action(withContext<[string, { file: string }]>(updateAction));

  pipeline.command("delete").description("Delete a pipeline")
    .argument("<id>", "Pipeline ID")
    .action(withContext<[string, Record<string, never>]>(deleteAction));

  pipeline.command("trigger").description("Manually trigger a pipeline run")
    .argument("<id>", "Pipeline ID")
    .option("--input <json>", "JSON string of runtime input parameters")
    .option("--wait", "Block until the run reaches a terminal state (completed/failed/cancelled). The run ID is printed to stdout immediately so it can be captured with RUN_ID=$(op pipeline trigger <id> --wait). Status updates stream to stderr. Combine with --poll-timeout to cap wait duration.")
    .option("--poll-timeout <seconds>", "Maximum seconds to wait when --wait is set (default: 600). If the run has not finished by this deadline the command exits with an error.")
    .action(withContext<[string, TriggerOpts]>(triggerAction));

  pipeline.command("runs").description("List runs for a pipeline")
    .argument("<id>", "Pipeline ID")
    .option("--limit <n>", "Maximum runs to return")
    .option("--status <status>", "Filter: running|completed|failed|cancelled")
    .action(withContext<[string, RunsOpts]>(runsAction));

  pipeline.command("run-status").description("Get status of a specific run")
    .argument("<run-id>", "Pipeline run ID")
    .action(withContext<[string, Record<string, never>]>(runStatusAction));

  pipeline.command("run-cancel").description("Cancel a running pipeline run")
    .argument("<run-id>", "Pipeline run ID")
    .action(withContext<[string, Record<string, never>]>(runCancelAction));

  pipeline.command("run-logs").description("Get or stream logs for a pipeline run")
    .argument("<run-id>", "Pipeline run ID")
    .option("-f, --follow", "Stream live logs via SSE until run completes or Ctrl+C")
    .option("--step <step-id>", "Filter to a specific step ID")
    .option("--level <level>", "Minimum log level: debug|info|warn|error")
    .action(withContext<[string, RunLogsOpts]>(runLogsAction));
}
