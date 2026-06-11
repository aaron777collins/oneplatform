/**
 * data command group — data CRUD operations.
 * Read scope: data:read | Write scope: data:write
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive } from "../../lib/prompts.js";
import { readFileSync, writeFileSync, createReadStream } from "node:fs";

interface QueryOpts {
  filter?: string; sort?: string; sortDir?: string;
  limit?: string; offset?: string
}
interface ImportOpts { file: string; format?: string; batchSize?: string; dryRun?: boolean }
interface ExportOpts { filter?: string; format?: string; out?: string }

async function queryAction(entityType: string, opts: QueryOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.filter) query["filter"] = opts.filter;
  if (opts.sort) query["sort"] = opts.sort;
  if (opts.sortDir) query["sortDir"] = opts.sortDir;
  if (opts.limit) query["limit"] = opts.limit;
  if (opts.offset) query["offset"] = opts.offset;

  const results = await ctx.http.get<unknown[]>(
    `/api/v1/data/${encodeURIComponent(entityType)}`,
    query,
  );
  ctx.renderer.render(results);
}

async function getAction(entityType: string, id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const record = await ctx.http.get<unknown>(
    `/api/v1/data/${encodeURIComponent(entityType)}/${encodeURIComponent(id)}`,
  );
  ctx.renderer.render(record);
}

async function createAction(entityType: string, opts: { file: string }, ctx: CommandContext): Promise<void> {
  let data: unknown;
  if (opts.file === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } else {
    data = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
  }
  const resp = await ctx.http.post<{ id: string }>(
    `/api/v1/data/${encodeURIComponent(entityType)}`,
    data,
  );
  ctx.renderer.success(`Created record ${resp.id}.`);
}

async function updateAction(entityType: string, id: string, opts: { file: string }, ctx: CommandContext): Promise<void> {
  const data = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
  await ctx.http.patch(
    `/api/v1/data/${encodeURIComponent(entityType)}/${encodeURIComponent(id)}`,
    data,
  );
  ctx.renderer.success(`Record ${id} updated.`);
}

async function deleteAction(entityType: string, id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Delete ${entityType} record '${id}'?`, ctx.yes);
  await ctx.http.delete(
    `/api/v1/data/${encodeURIComponent(entityType)}/${encodeURIComponent(id)}`,
  );
  ctx.renderer.success(`Record ${id} deleted.`);
}

async function importAction(entityType: string, opts: ImportOpts, ctx: CommandContext): Promise<void> {
  const batchSize = parseInt(opts.batchSize ?? "500", 10);
  const content = readFileSync(opts.file, "utf8");
  const format = opts.format ?? opts.file.split(".").pop() ?? "json";

  const form = new FormData();
  form.append("file", new Blob([content]), opts.file.split("/").pop() ?? "data");
  form.append("format", format);
  form.append("batchSize", String(batchSize));
  if (opts.dryRun) form.append("dryRun", "true");

  const resp = await ctx.http.postMultipart<{ created: number; skipped: number; failed: number }>(
    `/api/v1/data/${encodeURIComponent(entityType)}/import`,
    form,
  );
  ctx.renderer.success(
    `Import complete: ${resp.created} created, ${resp.skipped} skipped, ${resp.failed} errors.`,
  );
}

async function exportAction(entityType: string, opts: ExportOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.filter) query["filter"] = opts.filter;
  if (opts.format) query["format"] = opts.format;

  const data = await ctx.http.get<unknown>(
    `/api/v1/data/${encodeURIComponent(entityType)}/export`,
    query,
  );
  const output = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (opts.out) {
    writeFileSync(opts.out, output, "utf8");
    ctx.renderer.success(`Exported to ${opts.out}`);
  } else {
    process.stdout.write(output + "\n");
  }
}

export function registerData(program: Command): void {
  const data = program.command("data").description("Data CRUD operations");

  data.command("query")
    .description("Query records of an entity type")
    .argument("<entity-type>", "Entity type name")
    .option("--filter <json>", "JSON filter object")
    .option("--sort <field>", "Sort field")
    .option("--sort-dir <dir>", "Sort direction: asc|desc")
    .option("--limit <n>", "Maximum records to return")
    .option("--offset <n>", "Pagination offset")
    .action(withContext<[string, QueryOpts]>(queryAction));

  data.command("get")
    .description("Get a single record")
    .argument("<entity-type>", "Entity type name")
    .argument("<id>", "Record ID")
    .action(withContext<[string, string, Record<string, never>]>(getAction));

  data.command("create")
    .description("Create a new record")
    .argument("<entity-type>", "Entity type name")
    .requiredOption("--file <data.json>", "JSON file (use '-' for stdin)")
    .action(withContext<[string, { file: string }]>(createAction));

  data.command("update")
    .description("Partially update a record")
    .argument("<entity-type>", "Entity type name")
    .argument("<id>", "Record ID")
    .requiredOption("--file <data.json>", "JSON file with fields to update")
    .action(withContext<[string, string, { file: string }]>(updateAction));

  data.command("delete")
    .description("Delete a record")
    .argument("<entity-type>", "Entity type name")
    .argument("<id>", "Record ID")
    .action(withContext<[string, string, Record<string, never>]>(deleteAction));

  data.command("import")
    .description("Bulk import records from file")
    .argument("<entity-type>", "Entity type name")
    .requiredOption("--file <path>", "Path to CSV, JSON, or JSONL file")
    .option("--format <fmt>", "Format: csv|json|jsonl (auto-detected from extension)")
    .option("--batch-size <n>", "Records per batch call", "500")
    .option("--dry-run", "Validate and report counts without writing")
    .action(withContext<[string, ImportOpts]>(importAction));

  data.command("export")
    .description("Export records to file or stdout")
    .argument("<entity-type>", "Entity type name")
    .option("--filter <json>", "JSON filter object")
    .option("--format <fmt>", "Format: csv|json|jsonl")
    .option("--out <path>", "Write to file instead of stdout")
    .action(withContext<[string, ExportOpts]>(exportAction));
}
