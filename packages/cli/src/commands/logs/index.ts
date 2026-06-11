/**
 * logs command group — platform log management. Required scope: admin
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { streamSse } from "../../lib/streaming.js";
import { colorizeLogLevel } from "../../lib/output.js";
import { writeFileSync } from "node:fs";

const AUDIT_COLUMNS = [
  { header: "Timestamp", key: "timestamp" },
  { header: "Actor", key: "actorEmail" },
  { header: "Action", key: "action" },
  { header: "Resource", key: "resource" },
  { header: "IP", key: "ip" },
  { header: "Result", key: "result" },
];

interface QueryOpts {
  service?: string; level?: string; from?: string; to?: string;
  traceId?: string; limit?: string
}
interface TailOpts { service?: string; level?: string; traceId?: string }
interface AuditOpts { from?: string; to?: string; actor?: string; action?: string; resource?: string }
interface ExportOpts { from: string; to: string; service?: string; format?: string; out?: string }

async function queryAction(opts: QueryOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.service) query["service"] = opts.service;
  if (opts.level) query["level"] = opts.level;
  if (opts.from) query["from"] = opts.from;
  if (opts.to) query["to"] = opts.to;
  if (opts.traceId) query["traceId"] = opts.traceId;
  if (opts.limit) query["limit"] = opts.limit;
  const logs = await ctx.http.get<unknown[]>("/api/v1/logs", query);
  ctx.renderer.render(logs);
}

async function tailAction(opts: TailOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.service) query["service"] = opts.service;
  if (opts.level) query["level"] = opts.level;
  if (opts.traceId) query["traceId"] = opts.traceId;

  process.stderr.write("Streaming logs... (Ctrl+C to stop)\n");
  for await (const event of streamSse(ctx.http, "/api/v1/logs/stream", query)) {
    try {
      const entry = JSON.parse(event.data) as {
        level?: string; message?: string; timestamp?: string; service?: string
      };
      const level = colorizeLogLevel(entry.level ?? "info", ctx.noColor);
      const svc = entry.service ? `[${entry.service}] ` : "";
      process.stdout.write(`[${entry.timestamp ?? ""}] ${svc}${level}: ${entry.message ?? event.data}\n`);
    } catch {
      process.stdout.write(event.data + "\n");
    }
  }
}

async function auditAction(opts: AuditOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.from) query["from"] = opts.from;
  if (opts.to) query["to"] = opts.to;
  if (opts.actor) query["actorId"] = opts.actor;
  if (opts.action) query["action"] = opts.action;
  if (opts.resource) query["resourceType"] = opts.resource;
  const entries = await ctx.http.get<unknown[]>("/api/v1/logs/audit", query);
  ctx.renderer.render(entries, AUDIT_COLUMNS);
}

async function exportAction(opts: ExportOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = { from: opts.from, to: opts.to };
  if (opts.service) query["service"] = opts.service;
  if (opts.format) query["format"] = opts.format;
  const data = await ctx.http.get<unknown>("/api/v1/logs/export", query);
  const output = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (opts.out) {
    writeFileSync(opts.out, output, "utf8");
    ctx.renderer.success(`Logs exported to ${opts.out}`);
  } else {
    process.stdout.write(output + "\n");
  }
}

export function registerLogs(program: Command): void {
  const logs = program.command("logs").description("Log management (scope: admin)");

  logs.command("query").description("Query log entries")
    .option("--service <name>", "Filter by service name")
    .option("--level <level>", "Minimum log level: debug|info|warn|error")
    .option("--from <date>", "Start date filter (ISO 8601)")
    .option("--to <date>", "End date filter (ISO 8601)")
    .option("--trace-id <id>", "Filter by trace ID")
    .option("--limit <n>", "Maximum records to return")
    .action(withContext<[QueryOpts]>(queryAction));

  logs.command("tail").description("Stream live logs via SSE")
    .option("--service <name>", "Filter by service name")
    .option("--level <level>", "Minimum log level")
    .option("--trace-id <id>", "Filter by trace ID")
    .action(withContext<[TailOpts]>(tailAction));

  logs.command("audit").description("Query audit log entries")
    .option("--from <date>", "Start date filter (ISO 8601)")
    .option("--to <date>", "End date filter (ISO 8601)")
    .option("--actor <user-id>", "Filter by actor user ID")
    .option("--action <action>", "Filter by action type")
    .option("--resource <resource>", "Filter by resource type")
    .action(withContext<[AuditOpts]>(auditAction));

  logs.command("export").description("Export logs to file")
    .requiredOption("--from <date>", "Start date filter (ISO 8601)")
    .requiredOption("--to <date>", "End date filter (ISO 8601)")
    .option("--service <name>", "Filter by service name")
    .option("--format <fmt>", "Output format: jsonl|csv")
    .option("--out <path>", "Write to file instead of stdout")
    .action(withContext<[ExportOpts]>(exportAction));
}
