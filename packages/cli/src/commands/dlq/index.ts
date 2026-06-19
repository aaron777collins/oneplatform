/**
 * dlq command group — dead-letter queue management. Required scope: admin
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { confirmDestructive } from "../../lib/prompts.js";

const DLQ_COLUMNS = [
  { header: "Job ID", key: "id" },
  { header: "Queue", key: "queue" },
  { header: "Failure Reason", key: "failureReason" },
  { header: "Attempts", key: "attempts" },
  { header: "Failed At", key: "failedAt" },
  { header: "Payload Preview", key: "payloadPreview" },
];

interface ListOpts { queue?: string; limit?: string; from?: string; to?: string }
interface ReplayOpts { queue?: string }
interface ReplayAllOpts { queue?: string; from?: string; to?: string }

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.queue) query["queue"] = opts.queue;
  if (opts.limit) query["limit"] = opts.limit;
  if (opts.from) query["from"] = opts.from;
  if (opts.to) query["to"] = opts.to;
  const jobs = await ctx.http.get<unknown[]>("/api/v1/admin/dlq", query);
  ctx.renderer.render(jobs, DLQ_COLUMNS);
}

async function replayAction(jobId: string, opts: ReplayOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.queue) body["queue"] = opts.queue;
  const resp = await ctx.http.post<{ newJobId: string }>(
    `/api/v1/admin/dlq/${encodeURIComponent(jobId)}/replay`,
    body,
  );
  ctx.renderer.success(`Job replayed. New job ID: ${resp.newJobId}`);
}

async function replayAllAction(opts: ReplayAllOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.queue) query["queue"] = opts.queue;
  if (opts.from) query["from"] = opts.from;
  if (opts.to) query["to"] = opts.to;

  // Fetch matching DLQ jobs
  const jobs = await ctx.http.get<Array<{ id: string }>>(
    "/api/v1/admin/dlq",
    query,
  );

  if (jobs.length === 0) {
    ctx.renderer.info("No DLQ jobs match the given filters.");
    return;
  }

  await confirmDestructive(`Replay all ${jobs.length} matching DLQ job(s)?`, ctx.yes);

  let replayed = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const job of jobs) {
    try {
      await ctx.http.post(`/api/v1/admin/dlq/${encodeURIComponent(job.id)}/replay`, {});
      replayed++;
    } catch (err) {
      errors.push({ id: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  ctx.renderer.success(`Replayed ${replayed}/${jobs.length} DLQ jobs.`);
  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`  Job ${e.id}: ${e.error}\n`);
    }
  }
}

async function discardAction(jobId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Permanently discard DLQ job '${jobId}'?`, ctx.yes);
  await ctx.http.delete(`/api/v1/admin/dlq/${encodeURIComponent(jobId)}`);
  ctx.renderer.success(`Job ${jobId} discarded.`);
}

export function registerDlq(program: Command): void {
  const dlq = program.command("dlq").description("Dead-letter queue management (scope: admin)");

  dlq.command("list").description("List jobs in the dead-letter queue")
    .option("--queue <queue-name>", "Filter by queue name")
    .option("--limit <n>", "Maximum jobs to return")
    .option("--from <date>", "Start date filter (ISO 8601)")
    .option("--to <date>", "End date filter (ISO 8601)")
    .action(withContext<[ListOpts]>(listAction));

  dlq.command("replay").description("Re-queue a DLQ job for processing")
    .argument("<job-id>", "Job ID")
    .option("--queue <queue-name>", "Override destination queue")
    .action(withContext<[string, ReplayOpts]>(replayAction));

  dlq.command("replay-all").description("Replay all matching DLQ jobs in bulk")
    .option("--queue <queue-name>", "Filter by queue name")
    .option("--from <date>", "Start date filter (ISO 8601)")
    .option("--to <date>", "End date filter (ISO 8601)")
    .action(withContext<[ReplayAllOpts]>(replayAllAction));

  dlq.command("discard").description("Permanently remove a job from the DLQ")
    .argument("<job-id>", "Job ID")
    .action(withContext<[string, Record<string, never>]>(discardAction));
}
