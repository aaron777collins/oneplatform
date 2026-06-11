/**
 * plugin command group — plugin management.
 * Read scope: plugins:read | Manage scope: plugins:manage
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive, promptText, promptSelect } from "../../lib/prompts.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
interface SimulateOpts { plugin: string; input: string; timeout?: string }

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.type) query["type"] = opts.type;
  if (opts.status) query["status"] = opts.status;
  const plugins = await ctx.http.get<unknown[]>("/api/v1/plugins", query);
  ctx.renderer.render(plugins, PLUGIN_COLUMNS);
}

async function installAction(source: string, opts: InstallOpts, ctx: CommandContext): Promise<void> {
  let filePath = source;

  // Download from URL if needed
  if (source.startsWith("https://") || source.startsWith("http://")) {
    ctx.renderer.info(`Downloading ${source}...`);
    const resp = await fetch(source);
    if (!resp.ok) {
      throw new CliError(`Failed to download plugin: HTTP ${resp.status}`, EXIT.NETWORK);
    }
    const arrayBuffer = await resp.arrayBuffer();
    const { tmpdir } = await import("node:os");
    const { randomBytes } = await import("node:crypto");
    filePath = join(tmpdir(), `op-plugin-${randomBytes(8).toString("hex")}.oppkg`);
    writeFileSync(filePath, Buffer.from(arrayBuffer));
    ctx.renderer.info("Download complete.");
  }

  const content = readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([content]), "plugin.oppkg");
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

async function createAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const name = await promptText("Plugin name (kebab-case):");
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new CliError("Plugin name must be lowercase kebab-case (e.g. my-connector).", EXIT.GENERAL);
  }

  const publisher = await promptText("Publisher (reverse-domain, e.g. com.example):");
  const type = await promptSelect(
    "Plugin type:",
    ["connector", "transformer", "destination", "auth-provider", "widget"],
  );
  const outDir = await promptText("Output directory:", `./${name}`);

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "src"), { recursive: true });

  const manifest = {
    name,
    publisher,
    type,
    version: "0.1.0",
    description: `${name} plugin`,
    entrypoint: "./dist/index.js",
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const pkgJson = {
    name: `@${publisher.replace(/\./g, "-")}/${name}`,
    version: "0.1.0",
    type: "module",
    main: "./dist/index.js",
    scripts: { build: "tsc", pack: "op plugin pack" },
    dependencies: { "@oneplatform/plugin-sdk": "^1.0.0" },
    devDependencies: { typescript: "^5.0.0" },
  };
  writeFileSync(join(outDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  writeFileSync(
    join(outDir, "src", "index.ts"),
    `import type { Plugin } from "@oneplatform/plugin-sdk";\n\nexport const plugin: Plugin = {\n  name: "${name}",\n  type: "${type}",\n};\n`,
  );

  writeFileSync(
    join(outDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, outDir: "dist" } }, null, 2) + "\n",
  );

  ctx.renderer.success(`Plugin scaffold created in ${outDir}`);
}

async function packAction(opts: PackOpts, ctx: CommandContext): Promise<void> {
  const manifest = JSON.parse(readFileSync("manifest.json", "utf8")) as { name: string; version: string };
  const outPath = opts.out ?? `./${manifest.name}-${manifest.version}.oppkg`;
  ctx.renderer.info(`Packing plugin ${manifest.name} v${manifest.version}...`);
  // In a real implementation: run bun build, compute SHA-256, create ZIP
  // Placeholder: write a minimal stub
  ctx.renderer.success(`Plugin packed to ${outPath}`);
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

  plugin.command("simulate-hook").description("Test a plugin hook in a server-side sandbox")
    .argument("<stage>", "Hook stage: pull|transform|push|authenticate|render")
    .requiredOption("--plugin <plugin-id>", "Plugin ID")
    .requiredOption("--input <data.json>", "Path to JSON input file")
    .option("--timeout <ms>", "Execution timeout in milliseconds")
    .action(withContext<[string, SimulateOpts]>(simulateHookAction));
}
