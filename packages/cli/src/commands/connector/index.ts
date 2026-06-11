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
interface CreateOpts { plugin: string; name: string; config?: string; interactive?: boolean }
interface UpdateOpts { name?: string; config?: string }
interface TriggerOpts { wait?: boolean }

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.plugin) query["pluginId"] = opts.plugin;
  if (opts.status) query["status"] = opts.status;
  const connectors = await ctx.http.get<unknown[]>("/api/v1/connectors", query);
  ctx.renderer.render(connectors, CONNECTOR_COLUMNS);
}

async function createAction(opts: CreateOpts, ctx: CommandContext): Promise<void> {
  let config: Record<string, unknown> = {};

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

  const resp = await ctx.http.post<{ id: string; name: string }>("/api/v1/connectors", {
    pluginId: opts.plugin,
    name: opts.name,
    config,
  });
  ctx.renderer.success(`Connector '${resp.name}' created (ID: ${resp.id}).`);
}

async function getAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const connector = await ctx.http.get<unknown>(`/api/v1/connectors/${encodeURIComponent(id)}`);
  ctx.renderer.json(connector);
}

async function updateAction(id: string, opts: UpdateOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.name) body["name"] = opts.name;
  if (opts.config) body["config"] = JSON.parse(readFileSync(opts.config, "utf8")) as unknown;
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
  const resp = await ctx.http.post<{ jobId: string }>(
    `/api/v1/connectors/${encodeURIComponent(id)}/trigger`,
  );
  ctx.renderer.info(`Connector triggered. Job ID: ${resp.jobId}`);

  if (!opts.wait) return;

  while (true) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await ctx.http.get<{ status: string; progress?: number }>(
      `/api/v1/connectors/${encodeURIComponent(id)}/jobs/${resp.jobId}`,
    );
    ctx.renderer.info(`Status: ${status.status}${status.progress !== undefined ? ` (${status.progress}%)` : ""}`);
    if (status.status === "completed") {
      ctx.renderer.success("Connector run completed.");
      return;
    }
    if (status.status === "failed") {
      throw new CliError("Connector run failed.", EXIT.SERVER);
    }
    if (status.status === "cancelled" || status.status === "timeout") {
      throw new CliError(`Connector run ${status.status}.`, EXIT.GENERAL);
    }
  }
}

export function registerConnector(program: Command): void {
  const connector = program.command("connector").description("Data connector management (scope: pipelines:manage)");

  connector.command("list")
    .description("List all connectors")
    .option("--plugin <plugin-id>", "Filter by plugin ID")
    .option("--status <status>", "Filter by status: active|paused|error")
    .action(withContext<[ListOpts]>(listAction));

  connector.command("create")
    .description("Create a new connector")
    .requiredOption("--plugin <plugin-id>", "Plugin ID of the connector plugin")
    .requiredOption("--name <name>", "Connector display name")
    .option("--config <config.json>", "Path to JSON configuration file")
    .option("--interactive", "Use interactive prompts for configuration")
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
    .action(withContext<[string, TriggerOpts]>(triggerAction));
}
