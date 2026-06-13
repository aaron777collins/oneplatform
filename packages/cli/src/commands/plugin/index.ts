/**
 * plugin command group — plugin management.
 * Read scope: plugins:read | Manage scope: plugins:manage
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive, promptText, promptSelect } from "../../lib/prompts.js";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { generateScaffold, packPlugin, runSimulateHook } from "@oneplatform/plugin-sdk/dev";
import type { PluginType } from "@oneplatform/plugin-sdk/dev";

const PLUGIN_COLUMNS = [
  { header: "ID", key: "id" },
  { header: "Name", key: "name" },
  { header: "Type", key: "type" },
  { header: "Version", key: "version" },
  { header: "Status", key: "status" },
  { header: "Publisher", key: "publisher" },
  { header: "Installed", key: "installedAt" },
];

interface ListOpts { type?: string; status?: string }
interface InstallOpts { tenant?: string; yes?: boolean }
interface PluginTenantOpts { tenant?: string }
interface PackOpts { out?: string; sign?: string }
interface SimulateOpts {
  /** Plugin bundle path (local) or Plugin ID (remote). */
  plugin: string;
  input: string;
  timeout?: string;
  /** Named export to invoke as the hook function (local mode only). */
  entrypoint?: string;
  /** Tenant ID to inject into the mock context (local mode only). */
  tenantId?: string;
  /** Path to credentials JSON file (local mode only). */
  credentials?: string;
  /** Path to config JSON file (local mode only). */
  config?: string;
  /** Force server-side execution instead of local vm.Script sandbox. */
  remote?: boolean;
  /** Use isolated-vm for production-accurate sandboxing (local mode only). */
  sandbox?: boolean;
}

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.type) query["type"] = opts.type;
  if (opts.status) query["status"] = opts.status;
  const plugins = await ctx.http.get<unknown[]>("/api/v1/plugins", query);
  ctx.renderer.render(plugins, PLUGIN_COLUMNS);
}

async function installAction(source: string, opts: InstallOpts, ctx: CommandContext): Promise<void> {
  let filePath = source;
  let tempFileToClean: string | null = null;

  // Plain HTTP is rejected — plugin downloads must use HTTPS to prevent MITM attacks.
  if (source.startsWith("http://")) {
    throw new CliError(
      "Insecure URL rejected. Plugin sources must use HTTPS (https://). Plain HTTP is not allowed.",
      EXIT.GENERAL,
    );
  }

  // Download from URL if needed
  if (source.startsWith("https://")) {
    ctx.renderer.info(`Downloading ${source}...`);
    const resp = await fetch(source);
    if (!resp.ok) {
      throw new CliError(`Failed to download plugin: HTTP ${resp.status}`, EXIT.NETWORK);
    }
    const arrayBuffer = await resp.arrayBuffer();
    const { tmpdir } = await import("node:os");
    const { randomBytes } = await import("node:crypto");
    filePath = join(tmpdir(), `op-plugin-${randomBytes(8).toString("hex")}.oppkg`);
    tempFileToClean = filePath;
    writeFileSync(filePath, Buffer.from(arrayBuffer));
    ctx.renderer.info("Download complete.");
  }

  // Ensure the temp download file is removed even when upload or approval throws.
  try {
    const content = readFileSync(filePath);
    const form = new FormData();
    // API expects the field name "bundle", not "file"
    form.append("bundle", new Blob([content]), "plugin.oppkg");
    if (opts.tenant) form.append("tenantId", opts.tenant);

    const resp = await ctx.http.postMultipart<{
      id: string; name: string; version: string;
      permissions: string[]; externalUrls: string[]
    }>("/api/v1/plugins", form);

    // Show approval prompt
    ctx.renderer.info(`Plugin: ${resp.name} v${resp.version}`);
    if (resp.permissions.length > 0) {
      ctx.renderer.info(`Permissions requested:\n  ${resp.permissions.join("\n  ")}`);
    }
    if (resp.externalUrls.length > 0) {
      ctx.renderer.info(`External URLs:\n  ${resp.externalUrls.join("\n  ")}`);
    }

    if (ctx.yes) {
      ctx.renderer.warn("Auto-approving plugin installation (--yes). This is logged to audit.");
    } else {
      await confirmDestructive(`Install plugin '${resp.name}'?`, false);
    }

    ctx.renderer.success(`Plugin '${resp.name}' v${resp.version} installed (ID: ${resp.id}).`);
  } finally {
    // Clean up the temp file regardless of success or failure.
    // Only a temp file we created should be cleaned; local file paths are left alone.
    if (tempFileToClean !== null) {
      try { unlinkSync(tempFileToClean); } catch { /* best-effort */ }
    }
  }
}

async function enableAction(pluginId: string, opts: PluginTenantOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.tenant) body["tenantId"] = opts.tenant;
  await ctx.http.post(`/api/v1/plugins/${encodeURIComponent(pluginId)}/enable`, body);
  ctx.renderer.success(`Plugin ${pluginId} enabled.`);
}

async function disableAction(pluginId: string, opts: PluginTenantOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.tenant) body["tenantId"] = opts.tenant;
  await ctx.http.post(`/api/v1/plugins/${encodeURIComponent(pluginId)}/disable`, body);
  ctx.renderer.success(`Plugin ${pluginId} disabled.`);
}

async function uninstallAction(pluginId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  // Pre-uninstall dependency check
  const deps = await ctx.http.get<{ connectors: number; pipelines: number; apps: number }>(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/dependents`,
  );
  if (deps.connectors > 0 || deps.pipelines > 0 || deps.apps > 0) {
    ctx.renderer.warn(
      `Plugin has active dependents: ${deps.connectors} connectors, ${deps.pipelines} pipelines, ${deps.apps} apps.`,
    );
    if (!ctx.yes) {
      throw new CliError(
        "Use --yes to force uninstall despite active dependents.",
        EXIT.GENERAL,
      );
    }
  }

  await confirmDestructive(`Uninstall plugin '${pluginId}'?`, ctx.yes);
  await ctx.http.delete(`/api/v1/plugins/${encodeURIComponent(pluginId)}`);
  ctx.renderer.success(`Plugin ${pluginId} uninstalled.`);
}

async function infoAction(pluginId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const plugin = await ctx.http.get<unknown>(`/api/v1/plugins/${encodeURIComponent(pluginId)}`);
  ctx.renderer.json(plugin);
}

// The plugin types accepted by the manifest schema and the SDK's scaffold generator.
const PLUGIN_TYPES: PluginType[] = [
  "connector",
  "transformer",
  "destination",
  "auth-provider",
  "widget",
];

async function createAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  // Validate name as a kebab-case identifier usable in reverse-domain plugin IDs.
  const name = await promptText("Plugin name (kebab-case):");
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new CliError("Plugin name must be lowercase kebab-case (e.g. my-connector).", EXIT.GENERAL);
  }

  // Publisher forms the first two segments of the reverse-domain plugin ID
  // (e.g. "com.example" + "my-plugin" → "com.example.my-plugin").
  const publisher = await promptText("Publisher (reverse-domain, e.g. com.example):");
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(publisher)) {
    throw new CliError(
      "Publisher must be reverse-domain format with at least two segments (e.g. com.example).",
      EXIT.GENERAL,
    );
  }

  const typeRaw = await promptSelect("Plugin type:", PLUGIN_TYPES);
  // promptSelect returns the chosen string — assert it is a PluginType since the
  // choices array is typed as PluginType[].
  const type = typeRaw as PluginType;

  const outDir = await promptText("Output directory:", `./${name}`);

  // Compose the canonical reverse-domain ID required by the manifest schema.
  // The schema requires at least three dot-separated segments (e.g. com.example.my-plugin).
  const pluginId = `${publisher}.${name}`;

  // Delegate all file generation to the SDK's scaffold generator.
  // This is the single source of truth for manifest format, source templates,
  // tsconfig, and package.json — keeping CLI output in sync with the SDK.
  const result = generateScaffold({ type, id: pluginId, name, author: publisher, outputDir: outDir });

  // Write the generated files to disk. The generator returns content without
  // performing I/O so it remains testable without filesystem access.
  for (const file of result.files) {
    const fullPath = join(outDir, file.relativePath);
    const dir = join(outDir, file.relativePath.split("/").slice(0, -1).join("/"));
    if (dir !== outDir) {
      mkdirSync(dir, { recursive: true });
    } else {
      mkdirSync(outDir, { recursive: true });
    }
    writeFileSync(fullPath, file.content, { encoding: "utf-8" });
  }

  ctx.renderer.success(`Plugin scaffold created in ${outDir}`);
  ctx.renderer.info(`Next steps:\n  cd ${outDir}\n  npm install\n  npm run build\n  op plugin pack`);
}

async function packAction(opts: PackOpts, _ctx: CommandContext): Promise<void> {
  // Delegate to the SDK's packPlugin() which:
  //  1. Reads plugin.manifest.json (not manifest.json — the correct filename)
  //  2. Validates the manifest schema
  //  3. Compiles src/index.ts with esbuild → dist/bundle.js
  //  4. Computes and writes the SHA-256 checksum
  //  5. Updates bundleChecksum in plugin.manifest.json
  //  6. Optionally signs with GPG
  //  7. Creates the .oppkg tar.gz archive
  //
  // packPlugin() writes its own progress lines to stdout — no need to call
  // ctx.renderer here. We only forward the CLI options it accepts.
  await packPlugin({
    ...(opts.out !== undefined ? { out: opts.out } : {}),
    ...(opts.sign !== undefined ? { sign: opts.sign } : {}),
  });
}

async function validateAction(path: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const content = readFileSync(path);
  const form = new FormData();
  form.append("file", new Blob([content]), "plugin.oppkg");
  const resp = await ctx.http.postMultipart<{ valid: boolean; errors: string[] }>(
    "/api/v1/plugins/validate",
    form,
  );
  if (!resp.valid) {
    for (const err of resp.errors) ctx.renderer.error(err);
    throw new CliError("Plugin validation failed.", EXIT.GENERAL);
  }
  ctx.renderer.success("Plugin is valid.");
}

async function simulateHookAction(stage: string, opts: SimulateOpts, ctx: CommandContext): Promise<void> {
  if (opts.remote) {
    // Server-side execution: delegates to the running OnePlatform instance.
    // Requires the plugin to already be installed and the server to be reachable.
    const input = JSON.parse(readFileSync(opts.input, "utf8")) as unknown;
    const body: Record<string, unknown> = {
      stage,
      input,
      timeout: parseInt(opts.timeout ?? "30000", 10),
    };
    const resp = await ctx.http.post<{ output: unknown; logs: string[] }>(
      `/api/v1/plugins/${encodeURIComponent(opts.plugin)}/simulate`,
      body,
    );
    for (const line of resp.logs) process.stderr.write(line + "\n");
    ctx.renderer.json(resp.output);
    return;
  }

  // Local execution: uses the plugin-sdk's vm.Script sandbox.
  // No server required — ideal for plugin development iteration.
  await runSimulateHook({
    stage,
    plugin: opts.plugin,
    input: opts.input,
    ...(opts.entrypoint !== undefined ? { entrypoint: opts.entrypoint } : {}),
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
    ...(opts.credentials !== undefined ? { credentials: opts.credentials } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
  });
}

export function registerPlugin(program: Command): void {
  const plugin = program.command("plugin").description("Plugin management");

  plugin.command("list").description("List all plugins")
    .option("--type <type>", "Filter by type: connector|transformer|destination|auth-provider|widget")
    .option("--status <status>", "Filter by status: enabled|disabled|installed")
    .action(withContext<[ListOpts]>(listAction));

  plugin.command("install").description("Install a plugin from file, URL, or registry reference")
    .argument("<source>", "Local .oppkg path, HTTPS URL, or registry reference")
    .option("--tenant <id>", "Install for specific tenant")
    .action(withContext<[string, InstallOpts]>(installAction));

  plugin.command("enable").description("Enable an installed plugin")
    .argument("<plugin-id>", "Plugin ID")
    .option("--tenant <id>", "Enable for specific tenant")
    .action(withContext<[string, PluginTenantOpts]>(enableAction));

  plugin.command("disable").description("Disable an installed plugin")
    .argument("<plugin-id>", "Plugin ID")
    .option("--tenant <id>", "Disable for specific tenant")
    .action(withContext<[string, PluginTenantOpts]>(disableAction));

  plugin.command("uninstall").description("Uninstall a plugin")
    .argument("<plugin-id>", "Plugin ID")
    .action(withContext<[string, Record<string, never>]>(uninstallAction));

  plugin.command("info").description("Show plugin manifest and details")
    .argument("<plugin-id>", "Plugin ID")
    .action(withContext<[string, Record<string, never>]>(infoAction));

  plugin.command("create").description("Scaffold a new plugin project interactively")
    .action(withContext<[Record<string, never>]>(createAction));

  plugin.command("pack").description("Package the current directory into a .oppkg file")
    .option("--out <path>", "Output file path")
    .option("--sign <gpg-key-id>", "GPG key ID to sign the package")
    .action(withContext<[PackOpts]>(packAction));

  plugin.command("validate").description("Validate a .oppkg file")
    .argument("<path-to.oppkg>", "Path to the .oppkg file")
    .action(withContext<[string, Record<string, never>]>(validateAction));

  plugin.command("simulate-hook")
    .description("Test a plugin hook locally (no server required) or against a running instance with --remote")
    .argument(
      "<stage>",
      "Hook stage, e.g. before:ingestion.receive | after:ingestion.validate | before:ontology.map | before:pipeline.trigger | before:auth.login | before:app.request",
    )
    .option("--plugin <path-or-id>", "Local bundle path (default: ./dist/bundle.js) or Plugin ID when using --remote")
    .requiredOption("--input <data.json>", "Path to JSON file containing HookPayload.data")
    .option("--entrypoint <export>", "Named export to invoke (overrides plugin.manifest.json entrypoint)")
    .option("--tenant-id <id>", "Tenant ID for the mock context (default: dev-tenant)")
    .option("--credentials <creds.json>", "Path to JSON file with credential name→value mappings")
    .option("--config <config.json>", "Path to JSON file with plugin instance config values")
    .option("--timeout <ms>", "Execution timeout in milliseconds (default: 30000)")
    .option("--sandbox", "Use isolated-vm for production-accurate sandboxing (requires isolated-vm to be installed)")
    .option("--remote", "Execute on the running OnePlatform server instead of locally (requires --plugin <plugin-id>)")
    .action(withContext<[string, SimulateOpts]>(simulateHookAction));
}
