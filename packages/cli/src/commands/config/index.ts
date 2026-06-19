/**
 * config command group — platform configuration export/import/diff/validate.
 * Required scope: admin
 * See §9 of the design spec for full semantics.
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import {
  loadConfigFile,
  topologicalSort,
  resourceKey,
  type ConfigDocument,
} from "../../lib/config-document.js";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface ExportOpts {
  format?: string; includeCredentials?: boolean; passphrase?: string;
  out?: string; kinds?: string
}
interface ImportOpts {
  file: string; onConflict?: string; dryRun?: boolean; passphrase?: string
}

/**
 * Prompts the user to enter a passphrase interactively (hidden input).
 * Falls back to visible input on non-TTY stdin.
 */
function promptPassphrase(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new CliError("--passphrase is required in non-interactive mode.", EXIT.GENERAL));
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    // Mute output so the passphrase is not echoed to the terminal
    process.stderr.write(prompt);
    const stdin = process.stdin;
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }

    // Restore terminal state and clean up listeners before exiting
    const cleanup = (): void => {
      if (stdin.setRawMode) stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      rl.close();
    };

    const onSigint = (): void => {
      cleanup();
      process.stderr.write("\n");
      process.exit(EXIT.GENERAL);
    };
    process.once("SIGINT", onSigint);

    let passphrase = "";
    const onData = (ch: Buffer): void => {
      const char = ch.toString("utf8");
      if (char === "\n" || char === "\r" || char === "") {
        process.removeListener("SIGINT", onSigint);
        cleanup();
        process.stderr.write("\n");
        resolve(passphrase);
      } else if (char === "") {
        // Ctrl-C
        process.removeListener("SIGINT", onSigint);
        cleanup();
        reject(new CliError("Cancelled.", EXIT.GENERAL));
      } else if (char === "" || char === "\b") {
        // Backspace
        passphrase = passphrase.slice(0, -1);
      } else {
        passphrase += char;
      }
    };
    stdin.on("data", onData);
  });
}
interface DiffOpts { file: string }
interface ValidateOpts { file: string }

async function exportAction(opts: ExportOpts, ctx: CommandContext): Promise<void> {
  const format = opts.format ?? "yaml";

  let data: unknown;

  if (opts.includeCredentials) {
    if (!opts.passphrase) {
      // Interactive fallback: prompt for passphrase if not provided as a flag
      opts.passphrase = await promptPassphrase("Enter passphrase for credential encryption: ");
    }
    // POST is required here because the passphrase must travel in the request body,
    // not in the URL query string where it would be visible in server/proxy access logs.
    const body: Record<string, unknown> = {
      format,
      includeCredentials: true,
      passphrase: opts.passphrase,
      ...(opts.kinds ? { kinds: opts.kinds } : {}),
    };
    data = await ctx.http.post<unknown>("/api/v1/admin/config/export", body);
  } else {
    const query: Record<string, unknown> = { format };
    if (opts.kinds) query["kinds"] = opts.kinds;
    data = await ctx.http.get<unknown>("/api/v1/admin/config/export", query);
  }
  const output = typeof data === "string" ? data : JSON.stringify(data, null, 2);

  if (opts.out) {
    writeFileSync(opts.out, output, "utf8");
    ctx.renderer.success(`Configuration exported to ${opts.out}`);
  } else {
    process.stdout.write(output + "\n");
  }
}

async function importAction(opts: ImportOpts, ctx: CommandContext): Promise<void> {
  // Run the full import pipeline locally before sending to API
  let docs: ConfigDocument[];
  try {
    docs = loadConfigFile(opts.file);
  } catch (err) {
    throw new CliError(
      `Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.GENERAL,
    );
  }

  // Topological sort catches circular deps before any API calls
  let sorted: ConfigDocument[];
  try {
    sorted = topologicalSort(docs);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT.GENERAL);
  }

  if (opts.dryRun) {
    // Dry-run: fetch current state from API and compute diff
    const resp = await ctx.http.post<{
      changes: Array<{ key: string; action: "create" | "update" | "none"; summary?: string }>
    }>("/api/v1/admin/config/validate", {
      documents: sorted,
      onConflict: opts.onConflict ?? "fail",
      dryRun: true,
    });

    let creates = 0, updates = 0, unchanged = 0;
    for (const change of resp.changes) {
      const prefix = change.action === "create" ? "+" : change.action === "update" ? "~" : " ";
      const suffix = change.action === "none"
        ? "(no change)"
        : `(${change.action}${change.summary ? ` — ${change.summary}` : ""})`;
      ctx.renderer.info(`${prefix} ${change.key.padEnd(40)} ${suffix}`);
      if (change.action === "create") creates++;
      else if (change.action === "update") updates++;
      else unchanged++;
    }
    ctx.renderer.info(`\nSummary: ${creates} to create, ${updates} to update, ${unchanged} unchanged.`);
    ctx.renderer.info("Run without --dry-run to apply.");
    return;
  }

  const body: Record<string, unknown> = {
    documents: sorted,
    onConflict: opts.onConflict ?? "fail",
  };
  if (opts.passphrase) body["passphrase"] = opts.passphrase;

  const resp = await ctx.http.post<{ created: number; updated: number; skipped: number }>(
    "/api/v1/admin/config/import",
    body,
  );
  ctx.renderer.success(
    `Import complete: ${resp.created} created, ${resp.updated} updated, ${resp.skipped} skipped.`,
  );
}

async function diffAction(opts: DiffOpts, ctx: CommandContext): Promise<void> {
  // Alias for import --dry-run
  await importAction({ file: opts.file, dryRun: true, onConflict: "fail" }, ctx);
}

async function validateAction(opts: ValidateOpts, ctx: CommandContext): Promise<void> {
  let docs: ConfigDocument[];
  try {
    docs = loadConfigFile(opts.file);
  } catch (err) {
    throw new CliError(
      `Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.GENERAL,
    );
  }

  // Local circular dependency check
  try {
    topologicalSort(docs);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT.GENERAL);
  }

  // Server-side cross-reference validation
  const resp = await ctx.http.post<{ valid: boolean; errors: string[] }>(
    "/api/v1/admin/config/validate",
    { documents: docs },
  );

  if (!resp.valid) {
    for (const err of resp.errors) ctx.renderer.error(err);
    throw new CliError(`Config validation failed with ${resp.errors.length} error(s).`, EXIT.GENERAL);
  }
  ctx.renderer.success("Config file is valid.");
}

export function registerConfig(program: Command): void {
  const config = program.command("config").description("Platform configuration export/import (scope: admin)");

  config.command("export").description("Export platform configuration to YAML/JSON")
    .option("--format <fmt>", "Output format: yaml|json", "yaml")
    .option("--include-credentials", "Include encrypted credential values (requires --passphrase)")
    .option("--passphrase <pass>", "Passphrase for credential encryption")
    .option("--out <path>", "Write to file instead of stdout")
    .option("--kinds <kinds>", "Comma-separated resource kinds to export (default: all)")
    .action(withContext<[ExportOpts]>(exportAction));

  config.command("import").description("Import platform configuration from YAML/JSON file")
    .requiredOption("--file <path>", "Path to config export file")
    .option("--on-conflict <mode>", "Conflict resolution: fail|skip|overwrite|merge", "fail")
    .option("--dry-run", "Perform full validation without any writes")
    .option("--passphrase <pass>", "Required if config contains encrypted credentials")
    .action(withContext<[ImportOpts]>(importAction));

  config.command("diff").description("Preview changes from a config file (alias for import --dry-run)")
    .requiredOption("--file <path>", "Path to config export file")
    .action(withContext<[DiffOpts]>(diffAction));

  config.command("validate").description("Validate a config file structure and cross-references")
    .requiredOption("--file <path>", "Path to config export file")
    .action(withContext<[ValidateOpts]>(validateAction));
}
