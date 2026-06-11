/**
 * webhook-out command group — outbound webhook management.
 * Required scope: admin or service-level API key.
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive } from "../../lib/prompts.js";

const WEBHOOK_COLUMNS = [
  { header: "ID", key: "id" },
  { header: "URL", key: "url" },
  { header: "Events", key: "events" },
  { header: "Status", key: "status" },
  { header: "Deliveries (24h)", key: "deliveries24h" },
  { header: "Failures (24h)", key: "failures24h" },
];

const DELIVERY_COLUMNS = [
  { header: "Delivery ID", key: "id" },
  { header: "Event Type", key: "eventType" },
  { header: "Status", key: "status" },
  { header: "Status Code", key: "statusCode" },
  { header: "Latency", key: "latencyMs" },
  { header: "Timestamp", key: "deliveredAt" },
  { header: "Retries", key: "retries" },
];

interface CreateOpts { url: string; events: string; secret?: string; description?: string }
interface UpdateOpts { url?: string; events?: string; enabled?: string }
interface TestOpts { eventType?: string }
interface LogsOpts { limit?: string; status?: string }

async function listAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const webhooks = await ctx.http.get<unknown[]>("/api/v1/webhooks/outbound");
  ctx.renderer.render(webhooks, WEBHOOK_COLUMNS);
}

async function createAction(opts: CreateOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {
    url: opts.url,
    events: opts.events.split(",").map((e) => e.trim()),
  };
  if (opts.secret) body["secret"] = opts.secret;
  if (opts.description) body["description"] = opts.description;

  const resp = await ctx.http.post<{ id: string; secret?: string }>("/api/v1/webhooks/outbound", body);

  if (!opts.secret && resp.secret) {
    ctx.renderer.warn("Store this webhook secret securely. It will not be shown again.");
    ctx.renderer.info(`Secret: ${resp.secret}`);
  }
  ctx.renderer.success(`Webhook created (ID: ${resp.id}).`);
}

async function updateAction(id: string, opts: UpdateOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.url) body["url"] = opts.url;
  if (opts.events) body["events"] = opts.events.split(",").map((e) => e.trim());
  if (opts.enabled !== undefined) body["enabled"] = opts.enabled === "true";
  await ctx.http.patch(`/api/v1/webhooks/outbound/${encodeURIComponent(id)}`, body);
  ctx.renderer.success(`Webhook ${id} updated.`);
}

async function deleteAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Delete webhook '${id}'?`, ctx.yes);
  await ctx.http.delete(`/api/v1/webhooks/outbound/${encodeURIComponent(id)}`);
  ctx.renderer.success(`Webhook ${id} deleted.`);
}

async function testAction(id: string, opts: TestOpts, ctx: CommandContext): Promise<void> {
  const start = Date.now();
  const resp = await ctx.http.post<{ statusCode: number; success: boolean }>(
    `/api/v1/webhooks/outbound/${encodeURIComponent(id)}/test`,
    opts.eventType ? { eventType: opts.eventType } : {},
  );
  const latency = Date.now() - start;
  if (resp.success) {
    ctx.renderer.success(`Test delivery successful. HTTP ${resp.statusCode} (${latency}ms).`);
  } else {
    throw new CliError(`Test delivery failed. HTTP ${resp.statusCode}.`, EXIT.GENERAL);
  }
}

async function logsAction(id: string, opts: LogsOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.limit) query["limit"] = opts.limit;
  if (opts.status) query["status"] = opts.status;
  const deliveries = await ctx.http.get<unknown[]>(
    `/api/v1/webhooks/outbound/${encodeURIComponent(id)}/deliveries`,
    query,
  );
  ctx.renderer.render(deliveries, DELIVERY_COLUMNS);
}

export function registerWebhookOut(program: Command): void {
  const wh = program.command("webhook-out").description("Outbound webhook management (scope: admin)");

  wh.command("list").description("List all outbound webhooks")
    .action(withContext<[Record<string, never>]>(listAction));

  wh.command("create").description("Create an outbound webhook")
    .requiredOption("--url <url>", "HTTPS endpoint URL")
    .requiredOption("--events <event,...>", "Comma-separated event types")
    .option("--secret <secret>", "HMAC signing secret (generated if omitted)")
    .option("--description <text>", "Human-readable label")
    .action(withContext<[CreateOpts]>(createAction));

  wh.command("update").description("Update an outbound webhook")
    .argument("<id>", "Webhook ID")
    .option("--url <url>", "New endpoint URL")
    .option("--events <event,...>", "New comma-separated event types")
    .option("--enabled <bool>", "Enable or disable: true|false")
    .action(withContext<[string, UpdateOpts]>(updateAction));

  wh.command("delete").description("Delete an outbound webhook")
    .argument("<id>", "Webhook ID")
    .action(withContext<[string, Record<string, never>]>(deleteAction));

  wh.command("test").description("Send a test payload to a webhook")
    .argument("<id>", "Webhook ID")
    .option("--event-type <type>", "Synthetic event type to send")
    .action(withContext<[string, TestOpts]>(testAction));

  wh.command("logs").description("Show delivery log for a webhook")
    .argument("<id>", "Webhook ID")
    .option("--limit <n>", "Maximum deliveries to show")
    .option("--status <status>", "Filter by status: delivered|failed|pending")
    .action(withContext<[string, LogsOpts]>(logsAction));
}
