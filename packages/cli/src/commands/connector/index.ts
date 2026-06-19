/**
 * connector command group — data connector management. Required scope: pipelines:manage
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive } from "../../lib/prompts.js";
import { readFileSync } from "node:fs";

const CONNECTOR_COLUMNS = [
  { header: "ID", key: "id" },
  { header: "Name", key: "name" },
  { header: "Plugin", key: "pluginId" },
  { header: "Status", key: "status" },
  { header: "Last Run", key: "lastRunAt" },
  { header: "Next Run", key: "nextRunAt" },
];

interface ListOpts { plugin?: string; status?: string }
interface CreateOpts {
  plugin: string;
  name: string;
  config?: string;
  credentials?: string;
  syncMode?: "full" | "incremental";
  enabled: boolean;
  interactive?: boolean;
  scheduleCron?: string;
}
interface UpdateOpts {
  name?: string;
  config?: string;
  credentials?: string;
  syncMode?: "full" | "incremental";
  enabled?: boolean;
  description?: string;
  scheduleCron?: string;
}
interface TriggerOpts { wait?: boolean; mode?: "full" | "incremental"; force?: boolean; pollTimeout?: string }

// Validates that a cron expression has exactly 5 space-separated fields.
// Full semantic validation is performed server-side; this catches obvious typos
// before sending a round-trip to the API.
function validateCronFieldCount(expr: string): void {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CliError(
      `Invalid --schedule-cron "${expr}": expected 5 space-separated fields ` +
      `(minute hour day-of-month month day-of-week), got ${fields.length}. ` +
      `Example: '0 9 * * 1-5' for weekdays at 9am UTC.`,
      EXIT.GENERAL,
    );
  }
}

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.plugin) query["filter[pluginId][eq]"] = opts.plugin;
  if (opts.status) query["filter[status][eq]"] = opts.status;
  const resp = await ctx.http.get<{ items: unknown[]; nextCursor?: string; total?: number }>(
    "/api/v1/connectors",
    query,
  );
  ctx.renderer.render(resp.items, CONNECTOR_COLUMNS);
}

async function createAction(opts: CreateOpts, ctx: CommandContext): Promise<void> {
  let config: Record<string, unknown> = {};
  let credentials: Record<string, string> = {};

  if (opts.interactive) {
    const schema = await ctx.http.get<{ fields: Array<{ name: string; type: string; secret?: boolean }> }>(
      `/api/v1/plugins/${encodeURIComponent(opts.plugin)}/config-schema`,
    );
    const { promptText, promptPassword } = await import("../../lib/prompts.js");
    for (const field of schema.fields) {
      const value = field.secret
        ? await promptPassword(`${field.name}:`)
        : await promptText(`${field.name}:`);
      config[field.name] = value;
    }
  } else if (opts.config) {
    config = JSON.parse(readFileSync(opts.config, "utf8")) as Record<string, unknown>;
  }

  if (opts.credentials) {
    credentials = JSON.parse(readFileSync(opts.credentials, "utf8")) as Record<string, string>;
  }

  if (opts.scheduleCron !== undefined) {
    validateCronFieldCount(opts.scheduleCron);
  }

  const resp = await ctx.http.post<{ id: string; name: string }>("/api/v1/connectors", {
    pluginId: opts.plugin,
    name: opts.name,
    config,
    credentials,
    ...(opts.syncMode !== undefined ? { syncMode: opts.syncMode } : {}),
    isEnabled: opts.enabled,
    ...(opts.scheduleCron !== undefined ? { scheduleCron: opts.scheduleCron } : {}),
  });
  ctx.renderer.success(`Connector '${resp.name}' created (ID: ${resp.id}).`);
}

async function getAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const connector = await ctx.http.get<Record<string, unknown>>(`/api/v1/connectors/${encodeURIComponent(id)}`);
  ctx.renderer.render([connector], CONNECTOR_COLUMNS);
}

async function updateAction(id: string, opts: UpdateOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.name) body["name"] = opts.name;
  if (opts.config) body["config"] = JSON.parse(readFileSync(opts.config, "utf8")) as unknown;
  if (opts.credentials) {
    body["credentials"] = JSON.parse(readFileSync(opts.credentials, "utf8")) as Record<string, string>;
  }
  if (opts.syncMode) body["syncMode"] = opts.syncMode;
  // Commander's --enabled / --no-enabled pair sets opts.enabled to true/false;
  // undefined means neither flag was passed so we omit the field.
  if (opts.enabled !== undefined) body["isEnabled"] = opts.enabled;
  if (opts.description !== undefined) body["description"] = opts.description;
  if (opts.scheduleCron !== undefined) {
    if (opts.scheduleCron === "") {
      // Empty string explicitly clears the cron schedule on the server.
      body["scheduleCron"] = null;
    } else {
      validateCronFieldCount(opts.scheduleCron);
      body["scheduleCron"] = opts.scheduleCron;
    }
  }
  await ctx.http.patch(`/api/v1/connectors/${encodeURIComponent(id)}`, body);
  ctx.renderer.success(`Connector ${id} updated.`);
}

async function deleteAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Delete connector '${id}'?`, ctx.yes);
  await ctx.http.delete(`/api/v1/connectors/${encodeURIComponent(id)}`);
  ctx.renderer.success(`Connector ${id} deleted.`);
}

async function testAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const start = Date.now();
  const resp = await ctx.http.post<{ success: boolean; message?: string }>(
    `/api/v1/connectors/${encodeURIComponent(id)}/test`,
  );
  const latency = Date.now() - start;
  if (resp.success) {
    ctx.renderer.success(`Connection successful (${latency}ms).`);
  } else {
    throw new CliError(`Connection failed: ${resp.message ?? "unknown error"}`, EXIT.GENERAL);
  }
}

async function triggerAction(id: string, opts: TriggerOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.mode) body["syncMode"] = opts.mode;
  if (opts.force) body["force"] = true;
  const resp = await ctx.http.post<{ syncJobId: string }>(
    `/api/v1/connectors/${encodeURIComponent(id)}/trigger`,
    body,
  );
  ctx.renderer.info(`Connector triggered. Sync Job ID: ${resp.syncJobId}`);

  if (!opts.wait) return;

  const pollTimeoutSec = parseInt(opts.pollTimeout ?? "600", 10);
  const deadline = Date.now() + pollTimeoutSec * 1000;
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    if (Date.now() > deadline) {
      throw new CliError(
        `Poll timeout: connector run did not complete within ${pollTimeoutSec}s.`,
        EXIT.GENERAL,
      );
    }
    const status = await ctx.http.get<{ status: string; progress?: number }>(
      `/api/v1/connectors/${encodeURIComponent(id)}/syncs/${resp.syncJobId}/progress`,
    );
    ctx.renderer.info(`Status: ${status.status}${status.progress !== undefined ? ` (${status.progress}%)` : ""}`);
    if (status.status === "success") {
      ctx.renderer.success("Connector run completed.");
      return;
    }
    if (status.status === "failed") {
      throw new CliError("Connector run failed.", EXIT.SERVER);
    }
    if (status.status === "cancelled") {
      throw new CliError(`Connector run ${status.status}.`, EXIT.GENERAL);
    }
  }
}

export function registerConnector(program: Command): void {
  const connector = program.command("connector").description("Data connector management (scope: pipelines:manage)");

  connector.command("list")
    .description("List all connectors")
    .option("--plugin <plugin-id>", "Filter by plugin ID")
    .option("--status <status>", "Filter by status: enabled|disabled")
    .action(withContext<[ListOpts]>(listAction));

  connector.command("create")
    .description("Create a new connector")
    .requiredOption("--plugin <plugin-id>", "Plugin ID of the connector plugin")
    .requiredOption("--name <name>", "Connector display name")
    .option("--config <config.json>", "Path to JSON configuration file")
    .option("--credentials <credentials.json>", "Path to JSON file containing connector credentials (keep this file secure)")
    .option("--sync-mode <mode>", "Sync mode: full | incremental (default: connector plugin default)")
    .option("--enabled", "Enable the connector immediately (default: true)", true)
    .option("--no-enabled", "Create the connector in a disabled state")
    .option("--interactive", "Use interactive prompts for configuration")
    .option(
      "--schedule-cron <expr>",
      "Cron schedule for automatic syncs, e.g. '0 9 * * 1-5' for weekdays at 9am UTC (5 fields required)",
    )
    .action(withContext<[CreateOpts]>(createAction));

  connector.command("get")
    .description("Get connector details")
    .argument("<id>", "Connector ID")
    .action(withContext<[string, Record<string, never>]>(getAction));

  connector.command("update")
    .description("Update a connector")
    .argument("<id>", "Connector ID")
    .option("--name <name>", "New display name")
    .option("--config <config.json>", "Path to updated JSON configuration")
    .option("--credentials <credentials.json>", "Path to JSON file with updated credentials (keep this file secure)")
    .option("--sync-mode <mode>", "New sync mode: full | incremental", /^(full|incremental)$/)
    .option("--enabled", "Enable the connector")
    .option("--no-enabled", "Disable the connector")
    .option("--description <text>", "Update the connector description (pass empty string to clear)")
    .option(
      "--schedule-cron <expr>",
      "Update cron schedule for automatic syncs, e.g. '0 9 * * 1-5' (5 fields required; pass empty string to clear)",
    )
    .action(withContext<[string, UpdateOpts]>(updateAction));

  connector.command("delete")
    .description("Delete a connector")
    .argument("<id>", "Connector ID")
    .action(withContext<[string, Record<string, never>]>(deleteAction));

  connector.command("test")
    .description("Test a connector connection")
    .argument("<id>", "Connector ID")
    .action(withContext<[string, Record<string, never>]>(testAction));

  connector.command("trigger")
    .description("Manually trigger a connector run")
    .argument("<id>", "Connector ID")
    .option("--wait", "Poll until run completes")
    .option("--mode <mode>", "Sync mode override: full | incremental")
    .option("--force", "Force sync even if one is already running")
    .option("--poll-timeout <seconds>", "Maximum seconds to wait when --wait is set (default: 600)")
    .action(withContext<[string, TriggerOpts]>(triggerAction));
}
