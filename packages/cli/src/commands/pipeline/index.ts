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
interface TriggerBatchOpts { input?: string; concurrency?: string }
interface RunsOpts { limit?: string; status?: string }
interface RunLogsOpts { follow?: boolean; step?: string; level?: string }

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.status) query["status"] = opts.status;
  const pipelines = await ctx.http.get<unknown[]>("/api/v1/pipelines", query);
  ctx.renderer.render(pipelines, PIPELINE_COLUMNS);
}

async function getAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const pipeline = await ctx.http.get<Record<string, unknown>>(`/api/v1/pipelines/${encodeURIComponent(id)}`);
  ctx.renderer.render([pipeline], PIPELINE_COLUMNS);
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

  // Poll with exponential backoff so fast pipelines are caught quickly (2s start)
  // while long-running ones don't generate excessive API traffic (30s ceiling).
  // Backoff: 2s → 4s → 8s → 16s → 30s (capped), then 30s for all subsequent polls.
  const POLL_INITIAL_MS = 2_000;
  const POLL_MAX_MS = 30_000;
  const pollTimeoutSec = parseInt(opts.pollTimeout ?? "600", 10);
  const deadline = Date.now() + pollTimeoutSec * 1000;
  let pollIntervalMs = POLL_INITIAL_MS;

  while (true) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    // Double the interval after each poll, capped at POLL_MAX_MS.
    pollIntervalMs = Math.min(pollIntervalMs * 2, POLL_MAX_MS);

    if (Date.now() > deadline) {
      throw new CliError(
        `Poll timeout: pipeline run did not complete within ${pollTimeoutSec}s.`,
        EXIT.GENERAL,
      );
    }
    const status = await ctx.http.get<{ status: string }>(
      `/api/v1/pipeline-runs/${resp.runId}`,
    );
    process.stderr.write(`Run status: ${status.status} (next poll in ${Math.round(pollIntervalMs / 1000)}s)\n`);
    if (status.status === "completed") return;
    if (status.status === "failed" || status.status === "cancelled") {
      throw new CliError(`Pipeline run ${status.status}.`, EXIT.GENERAL);
    }
  }
}

async function triggerBatchAction(ids: string[], opts: TriggerBatchOpts, ctx: CommandContext): Promise<void> {
  if (ids.length === 0) {
    throw new CliError("At least one pipeline ID is required.", EXIT.GENERAL);
  }

  let sharedInput: unknown = undefined;
  if (opts.input) {
    try {
      sharedInput = JSON.parse(opts.input) as unknown;
    } catch {
      throw new CliError("--input must be valid JSON.", EXIT.GENERAL);
    }
  }

  const body: Record<string, unknown> = {};
  if (sharedInput !== undefined) body["input"] = sharedInput;

  // All triggers fire concurrently. Promise.allSettled guarantees every result
  // is collected regardless of individual failures — a single bad pipeline ID
  // does not abort the others.
  const results = await Promise.allSettled(
    ids.map((id) =>
      ctx.http.post<{ runId: string }>(
        `/api/v1/pipelines/${encodeURIComponent(id)}/trigger`,
        body,
      ).then((resp) => ({ id, runId: resp.runId, success: true as const }))
       .catch((err: unknown) => ({
         id,
         runId: null,
         success: false as const,
         error: err instanceof Error ? err.message : String(err),
       })),
    ),
  );

  let successCount = 0;
  let failCount = 0;

  for (const result of results) {
    // Promise.allSettled fulfils all items; the inner .catch converts
    // individual failures to { success: false } so outer status is always
    // "fulfilled". We still handle "rejected" defensively.
    if (result.status === "rejected") {
      ctx.renderer.error(`[UNKNOWN] Unexpected rejection: ${String(result.reason)}`);
      failCount++;
      continue;
    }

    const { id, runId, success } = result.value;
    if (success && runId !== null) {
      ctx.renderer.success(`[${id}] Triggered — run ID: ${runId}`);
      successCount++;
    } else {
      const errorMsg = "error" in result.value ? result.value.error : "unknown error";
      ctx.renderer.error(`[${id}] Failed — ${errorMsg}`);
      failCount++;
    }
  }

  ctx.renderer.info(`Batch complete: ${successCount} triggered, ${failCount} failed.`);
  if (failCount > 0) {
    process.exitCode = EXIT.GENERAL;
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
  const status = await ctx.http.get<Record<string, unknown>>(`/api/v1/pipeline-runs/${encodeURIComponent(runId)}`);
  ctx.renderer.render([status], RUN_COLUMNS);
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
  const LOG_COLUMNS = [
    { header: "Timestamp", key: "timestamp" },
    { header: "Level", key: "level" },
    { header: "Step", key: "stepId" },
    { header: "Message", key: "message" },
  ];
  const logs = await ctx.http.get<unknown>(`/api/v1/pipeline-runs/${encodeURIComponent(runId)}/logs`, query);
  const logArray = Array.isArray(logs) ? logs : [logs];
  ctx.renderer.render(logArray, LOG_COLUMNS);
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

  pipeline.command("trigger-batch").description("Trigger multiple pipelines concurrently and report per-pipeline results")
    .argument("<ids...>", "One or more pipeline IDs (space-separated). Alternatively pass a single comma-separated string: 'id1,id2,id3'.")
    .option("--input <json>", "JSON object passed as runtime input to every triggered pipeline")
    .action(withContext<[string[], TriggerBatchOpts]>((rawIds, opts, ctx) => {
      // Support both "id1 id2" (multiple Commander args) and "id1,id2" (single comma-separated arg)
      const ids = rawIds.flatMap((id) => id.split(",").map((s) => s.trim()).filter(Boolean));
      return triggerBatchAction(ids, opts, ctx);
    }));

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
