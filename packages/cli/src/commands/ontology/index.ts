/**
 * ontology command group — schema management.
 * Read scope: ontology:read | Write scope: ontology:write
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive } from "../../lib/prompts.js";
import { readFileSync, writeFileSync } from "node:fs";

const ONTOLOGY_COLUMNS = [
  { header: "Entity Type", key: "entityType" },
  { header: "Version", key: "version" },
  { header: "Fields", key: "fieldCount" },
  { header: "Last Updated", key: "updatedAt" },
];

interface ExportOpts { format?: string; out?: string }
interface ImportOpts { file: string; onConflict?: string }
interface MigrateOpts { wait?: boolean; timeout?: string }
interface DiffOpts { file: string }

async function listAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const entities = await ctx.http.get<unknown[]>("/api/v1/ontology/entities");
  ctx.renderer.render(entities, ONTOLOGY_COLUMNS);
}

async function getAction(entityType: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const entity = await ctx.http.get<unknown>(`/api/v1/ontology/entities/${encodeURIComponent(entityType)}`);
  ctx.renderer.json(entity);
}

async function createAction(opts: { file: string }, ctx: CommandContext): Promise<void> {
  const schema = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
  const resp = await ctx.http.post<{ entityType: string }>("/api/v1/ontology/entities", schema);
  ctx.renderer.success(`Entity type '${resp.entityType}' created.`);
}

async function updateAction(entityType: string, opts: { file: string }, ctx: CommandContext): Promise<void> {
  const schema = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
  await ctx.http.put(`/api/v1/ontology/entities/${encodeURIComponent(entityType)}`, schema);
  ctx.renderer.success(`Entity type '${entityType}' updated.`);
}

async function deleteAction(entityType: string, opts: { confirm?: boolean }, ctx: CommandContext): Promise<void> {
  const yes = ctx.yes || opts.confirm === true;
  await confirmDestructive(`Delete entity type '${entityType}'? This cannot be undone.`, yes);
  await ctx.http.delete(`/api/v1/ontology/entities/${encodeURIComponent(entityType)}`);
  ctx.renderer.success(`Entity type '${entityType}' deleted.`);
}

async function validateAction(opts: { file: string }, ctx: CommandContext): Promise<void> {
  const schema = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
  const resp = await ctx.http.post<{ valid: boolean; errors: string[] }>("/api/v1/ontology/validate", schema);
  if (!resp.valid) {
    for (const err of resp.errors) {
      ctx.renderer.error(err);
    }
    throw new CliError("Schema validation failed.", EXIT.GENERAL);
  }
  ctx.renderer.success("Schema is valid.");
}

async function diffAction(entityType: string, opts: DiffOpts, ctx: CommandContext): Promise<void> {
  const schema = JSON.parse(readFileSync(opts.file, "utf8")) as unknown;
  const resp = await ctx.http.post<{ diff: Array<{ op: string; path: string; value?: unknown }> }>(
    `/api/v1/ontology/entities/${encodeURIComponent(entityType)}/diff`,
    schema,
  );
  for (const change of resp.diff) {
    const prefix = change.op === "add" ? "+" : change.op === "remove" ? "-" : "~";
    ctx.renderer.info(`${prefix} ${change.path}`);
  }
}

async function migrateAction(entityType: string, opts: MigrateOpts, ctx: CommandContext): Promise<void> {
  const resp = await ctx.http.post<{ migrationId: string; rowCount: number }>(
    `/api/v1/ontology/entities/${encodeURIComponent(entityType)}/migrate`,
  );
  ctx.renderer.info(`Migration ${resp.migrationId} started (${resp.rowCount} rows to migrate)`);

  if (!opts.wait) return;

  const timeoutMs = opts.timeout ? parseInt(opts.timeout, 10) * 1000 : 300_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await ctx.http.get<{ status: string; progress: number; total: number; durationMs?: number }>(
      `/api/v1/ontology/migrations/${resp.migrationId}`,
    );
    ctx.renderer.info(`Progress: ${status.progress} / ${status.total} (${Math.round(status.progress / status.total * 100)}%)`);
    if (status.status === "completed") {
      ctx.renderer.success(`Migration complete in ${((status.durationMs ?? 0) / 1000).toFixed(1)}s`);
      return;
    }
    if (status.status === "failed") {
      throw new CliError("Migration failed.", EXIT.SERVER);
    }
  }
  throw new CliError(`Migration timed out after ${opts.timeout ?? 300}s.`, EXIT.NETWORK);
}

async function migrationStatusAction(migrationId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const status = await ctx.http.get<unknown>(`/api/v1/ontology/migrations/${encodeURIComponent(migrationId)}`);
  ctx.renderer.json(status);
}

async function migrationRollbackAction(migrationId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Roll back migration '${migrationId}'?`, ctx.yes);
  await ctx.http.post(`/api/v1/ontology/migrations/${encodeURIComponent(migrationId)}/rollback`);
  ctx.renderer.success(`Migration ${migrationId} rolled back.`);
}

async function exportAction(opts: ExportOpts, ctx: CommandContext): Promise<void> {
  const format = opts.format ?? "yaml";
  const data = await ctx.http.get<unknown>("/api/v1/ontology/export", { format });
  const output = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (opts.out) {
    writeFileSync(opts.out, output, "utf8");
    ctx.renderer.success(`Exported to ${opts.out}`);
  } else {
    process.stdout.write(output + "\n");
  }
}

async function importAction(opts: ImportOpts, ctx: CommandContext): Promise<void> {
  const content = readFileSync(opts.file, "utf8");
  const resp = await ctx.http.post<{ imported: number; skipped: number }>(
    "/api/v1/ontology/import",
    { content, onConflict: opts.onConflict ?? "fail" },
  );
  ctx.renderer.success(`Imported ${resp.imported} entities, ${resp.skipped} skipped.`);
}

export function registerOntology(program: Command): void {
  const ont = program.command("ontology").description("Schema management");

  ont.command("list").description("List all entity types")
    .action(withContext<[Record<string, never>]>(listAction));

  ont.command("get").description("Get a specific entity type schema")
    .argument("<entity-type>", "Entity type name")
    .action(withContext<[string, Record<string, never>]>(getAction));

  ont.command("create").description("Create a new entity type from schema file")
    .requiredOption("--file <schema.json>", "Path to JSON schema file")
    .action(withContext<[{ file: string }]>(createAction));

  ont.command("update").description("Update an entity type schema")
    .argument("<entity-type>", "Entity type name")
    .requiredOption("--file <schema.json>", "Path to JSON schema file")
    .action(withContext<[string, { file: string }]>(updateAction));

  ont.command("delete").description("Delete an entity type")
    .argument("<entity-type>", "Entity type name")
    .option("--confirm", "Alias for --yes on this subcommand")
    .action(withContext<[string, { confirm?: boolean }]>(deleteAction));

  ont.command("validate").description("Validate a schema file")
    .requiredOption("--file <schema.json>", "Path to JSON schema file")
    .action(withContext<[{ file: string }]>(validateAction));

  ont.command("diff").description("Show diff between proposed and current schema")
    .argument("<entity-type>", "Entity type name")
    .requiredOption("--file <schema.json>", "Path to JSON schema file")
    .action(withContext<[string, DiffOpts]>(diffAction));

  ont.command("migrate").description("Trigger a schema migration")
    .argument("<entity-type>", "Entity type name")
    .option("--wait", "Poll until migration completes")
    .option("--timeout <seconds>", "Max wait duration in seconds")
    .action(withContext<[string, MigrateOpts]>(migrateAction));

  ont.command("migration-status").description("Get migration status")
    .argument("<migration-id>", "Migration ID")
    .action(withContext<[string, Record<string, never>]>(migrationStatusAction));

  ont.command("migration-rollback").description("Roll back a migration")
    .argument("<migration-id>", "Migration ID")
    .action(withContext<[string, Record<string, never>]>(migrationRollbackAction));

  ont.command("export").description("Export all entity schemas")
    .option("--format <fmt>", "Output format: yaml|json", "yaml")
    .option("--out <path>", "Write to file instead of stdout")
    .action(withContext<[ExportOpts]>(exportAction));

  ont.command("import").description("Import entity schemas from file")
    .requiredOption("--file <path>", "Path to schema export file")
    .option("--on-conflict <mode>", "Conflict mode: fail|skip|overwrite", "fail")
    .action(withContext<[ImportOpts]>(importAction));
}
