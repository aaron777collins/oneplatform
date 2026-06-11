/**
 * exec command group — direct code execution. Required scope: execution:run
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { readFileSync } from "node:fs";

const EXEC_COLUMNS = [
  { header: "Execution ID", key: "id" },
  { header: "Language", key: "language" },
  { header: "Status", key: "status" },
  { header: "Duration", key: "durationMs" },
  { header: "Started", key: "startedAt" },
  { header: "Exit Code", key: "exitCode" },
];

interface RunOpts { lang: string; file: string; input?: string; timeout?: string; wait?: boolean }
interface HistoryOpts { limit?: string; lang?: string; from?: string; to?: string }

async function runAction(opts: RunOpts, ctx: CommandContext): Promise<void> {
  const code = readFileSync(opts.file, "utf8");
  const body: Record<string, unknown> = {
    language: opts.lang,
    code,
    timeout: parseInt(opts.timeout ?? "30000", 10),
  };
  if (opts.input) {
    try {
      body["input"] = JSON.parse(opts.input) as unknown;
    } catch {
      throw new CliError("--input must be valid JSON.", EXIT.GENERAL);
    }
  }

  const resp = await ctx.http.post<{ executionId: string; output?: string; durationMs?: number }>(
    "/api/v1/exec",
    body,
  );
  process.stderr.write(`Execution ID: ${resp.executionId}\n`);
  if (resp.durationMs !== undefined) {
    process.stderr.write(`Duration: ${resp.durationMs}ms\n`);
  }
  if (resp.output) {
    process.stdout.write(resp.output);
  }
}

async function historyAction(opts: HistoryOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.limit) query["limit"] = opts.limit;
  if (opts.lang) query["language"] = opts.lang;
  if (opts.from) query["from"] = opts.from;
  if (opts.to) query["to"] = opts.to;
  const history = await ctx.http.get<unknown[]>("/api/v1/exec/history", query);
  ctx.renderer.render(history, EXEC_COLUMNS);
}

async function logsAction(executionId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const logs = await ctx.http.get<unknown>(`/api/v1/exec/${encodeURIComponent(executionId)}/logs`);
  ctx.renderer.json(logs);
}

export function registerExec(program: Command): void {
  const exec = program.command("exec").description("Direct code execution (scope: execution:run)");

  exec.command("run").description("Execute a code file")
    .requiredOption("--lang <lang>", "Execution language: js|ts|python")
    .requiredOption("--file <code-file>", "Path to source file")
    .option("--input <json>", "JSON string passed as execution input")
    .option("--timeout <ms>", "Execution timeout in milliseconds", "30000")
    .option("--wait", "Wait for completion and stream output (default: true)", true)
    .action(withContext<[RunOpts]>(runAction));

  exec.command("history").description("List past executions")
    .option("--limit <n>", "Maximum records to return")
    .option("--lang <lang>", "Filter by language")
    .option("--from <date>", "Start date filter (ISO 8601)")
    .option("--to <date>", "End date filter (ISO 8601)")
    .action(withContext<[HistoryOpts]>(historyAction));

  exec.command("logs").description("Get logs for a specific execution")
    .argument("<execution-id>", "Execution ID")
    .action(withContext<[string, Record<string, never>]>(logsAction));
}
