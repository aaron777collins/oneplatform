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
import { join, resolve } from "node:path";
import { generateScaffold, packPlugin, runSimulateHook } from "@oneplatform/plugin-sdk/dev";
import type { PluginType } from "@oneplatform/plugin-sdk/dev";
import { PluginDevServer } from "@oneplatform/plugin-sdk/dev-server";
import type { DevServerOptions } from "@oneplatform/plugin-sdk/dev-server";

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
interface InstallOpts { tenant?: string; yes?: boolean; dev?: boolean }
interface UpgradeOpts { tenant?: string; yes?: boolean }
interface RollbackOpts { yes?: boolean }
interface PluginTenantOpts { tenant?: string }
interface PackOpts { out?: string; sign?: string }
interface PublishOpts {
  category?: string;
  tags?: string;
  dryRun?: boolean;
}
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

    // Dev mode: append query param so the service applies relaxed scope requirements
    // (plugins:manage instead of platform-admin) and enforces tenant scoping + 7-day expiry.
    const installUrl = opts.dev ? "/api/v1/plugins?devMode=true" : "/api/v1/plugins";

    const resp = await ctx.http.postMultipart<{
      id: string; name: string; version: string;
      permissions: string[]; externalUrls: string[]
    }>(installUrl, form);

    // Show approval prompt
    ctx.renderer.info(`Plugin: ${resp.name} v${resp.version}`);
    if (resp.permissions.length > 0) {
      ctx.renderer.info(`Permissions requested:\n  ${resp.permissions.join("\n  ")}`);
    }
    if (resp.externalUrls.length > 0) {
      ctx.renderer.info(`External URLs:\n  ${resp.externalUrls.join("\n  ")}`);
    }

    if (opts.dev) {
      // Dev installs skip the approval prompt — they are scoped to the caller's
      // tenant only and expire automatically after 7 days.
      ctx.renderer.warn(
        "Dev-mode installation active: scoped to your tenant, expires in 7 days. " +
          "Re-run `op plugin install --dev` to renew.",
      );
    } else {
      if (ctx.yes) {
        ctx.renderer.warn("Auto-approving plugin installation (--yes). This is logged to audit.");
      }
      await confirmDestructive(`Install plugin '${resp.name}'?`, ctx.yes);
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

async function upgradeAction(source: string, opts: UpgradeOpts, ctx: CommandContext): Promise<void> {
  let filePath = source;
  let tempFileToClean: string | null = null;

  if (source.startsWith("http://")) {
    throw new CliError(
      "Insecure URL rejected. Plugin sources must use HTTPS (https://). Plain HTTP is not allowed.",
      EXIT.GENERAL,
    );
  }

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

  try {
    const content = readFileSync(filePath);
    const form = new FormData();
    form.append("bundle", new Blob([content]), "plugin.oppkg");
    // Signal to the service that this is an upgrade, not a fresh install.
    form.append("upgrade", "true");
    if (opts.tenant) form.append("tenantId", opts.tenant);

    await confirmDestructive("Upgrade plugin? This will replace the active version.", ctx.yes);

    const resp = await ctx.http.postMultipart<{
      id: string; name: string; version: string;
    }>("/api/v1/plugins", form);

    ctx.renderer.success(`Plugin '${resp.name}' upgraded to v${resp.version} (ID: ${resp.id}).`);
  } finally {
    if (tempFileToClean !== null) {
      try { unlinkSync(tempFileToClean); } catch { /* best-effort */ }
    }
  }
}

async function rollbackAction(pluginId: string, _opts: RollbackOpts, ctx: CommandContext): Promise<void> {
  await confirmDestructive(
    `Roll back plugin '${pluginId}' to the previous version?`,
    ctx.yes,
  );

  const resp = await ctx.http.post<{ manifestId: string; fromVersion: string; toVersion: string }>(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rollback`,
    {},
  );

  ctx.renderer.success(
    `Plugin '${resp.manifestId}' rolled back from v${resp.fromVersion} to v${resp.toVersion}.`,
  );
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

const MARKETPLACE_CATEGORIES = [
  "data-source",
  "data-destination",
  "transformation",
  "authentication",
  "analytics",
  "monitoring",
  "communication",
  "developer-tools",
  "other",
];

async function publishAction(opts: PublishOpts, ctx: CommandContext): Promise<void> {
  // Read plugin.manifest.json from the current working directory.
  const manifestPath = join(process.cwd(), "plugin.manifest.json");
  let manifest: { id?: string; name?: string; version?: string };
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(raw) as { id?: string; name?: string; version?: string };
  } catch {
    throw new CliError(
      `Could not read plugin.manifest.json in ${process.cwd()}. ` +
        "Run this command from a plugin project root, or run 'op plugin create' first.",
      EXIT.GENERAL,
    );
  }

  if (!manifest.id || !manifest.name || !manifest.version) {
    throw new CliError(
      "plugin.manifest.json is missing required fields (id, name, version).",
      EXIT.GENERAL,
    );
  }

  // Resolve category — from flag or interactive prompt.
  const category = opts.category ?? await promptSelect("Marketplace category:", MARKETPLACE_CATEGORIES);

  // Resolve tags — from flag (comma-separated) or interactive prompt (optional).
  let tags: string[] = [];
  if (opts.tags !== undefined) {
    tags = opts.tags.split(",").map((t) => t.trim()).filter(Boolean);
  } else {
    const tagInput = await promptText("Tags (comma-separated, optional):", "");
    if (tagInput.length > 0) {
      tags = tagInput.split(",").map((t) => t.trim()).filter(Boolean);
    }
  }

  ctx.renderer.info(`Plugin:   ${manifest.name} (${manifest.id})`);
  ctx.renderer.info(`Version:  ${manifest.version}`);
  ctx.renderer.info(`Category: ${category}`);
  if (tags.length > 0) {
    ctx.renderer.info(`Tags:     ${tags.join(", ")}`);
  }

  if (opts.dryRun) {
    ctx.renderer.warn("Dry-run mode — nothing will be published.");
    ctx.renderer.success("Dry-run validation passed. Remove --dry-run to publish.");
    return;
  }

  if (!ctx.yes) {
    await confirmDestructive(`Publish '${manifest.name}' v${manifest.version} to the marketplace?`, false);
  }

  // Pack the plugin bundle (reuses the same packPlugin flow).
  const defaultBundlePath = join(process.cwd(), `${manifest.id}-${manifest.version}.oppkg`);
  await packPlugin({});

  // Read the built bundle and POST it to the marketplace.
  const bundleContent = readFileSync(defaultBundlePath);
  const form = new FormData();
  form.append("bundle", new Blob([bundleContent]), "plugin.oppkg");
  form.append("category", category);
  if (tags.length > 0) {
    form.append("tags", JSON.stringify(tags));
  }

  const resp = await ctx.http.postMultipart<{
    id: string; name: string; version: string; marketplaceUrl: string;
  }>("/api/v1/marketplace/plugins", form);

  ctx.renderer.success(
    `Plugin '${resp.name}' v${resp.version} published to the marketplace (ID: ${resp.id}).`,
  );
  ctx.renderer.info(`Marketplace URL: ${resp.marketplaceUrl}`);
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

// ─────────────────────────────────────────────────────────────────────────────
// op plugin dev
// ─────────────────────────────────────────────────────────────────────────────

interface DevOpts {
  /** Directory containing plugin.manifest.json. Default: process.cwd(). */
  dir?: string;
  /** TCP port for a webhook testing endpoint. Omit to run headless. */
  port?: string;
  /** JSON file mapping credential name → value (kept local, never sent to server). */
  credentials?: string;
  /** JSON file with plugin instance config values. */
  config?: string;
  /** JSON file with URL-keyed mock API responses. */
  mockData?: string;
  /** Enable real network fetch (default: mock). */
  realFetch?: boolean;
  /** Watch for source changes and hot-reload. */
  watch?: boolean;
  /** Maximum fetchBatch iterations before halting (safety guard). */
  maxBatches?: string;
  /** Per-call timeout in milliseconds. */
  timeout?: string;
  /** Tenant ID injected into the dev context. */
  tenantId?: string;
}

async function devAction(opts: DevOpts): Promise<void> {
  // Resolve the plugin directory — default to cwd so the developer can run
  // "op plugin dev" from the plugin root without any arguments.
  const pluginDir = resolve(opts.dir ?? process.cwd());

  // Load optional JSON files for credentials, config, and mock data.
  // We parse these here (boundary layer) so that PluginDevServer receives
  // clean typed options and does not need to know about file I/O.
  const credentials = opts.credentials !== undefined
    ? loadStringRecord(opts.credentials, "--credentials")
    : undefined;

  const config = opts.config !== undefined
    ? loadJsonRecord(opts.config, "--config")
    : undefined;

  const mockData = opts.mockData !== undefined
    ? loadJsonRecord(opts.mockData, "--mock-data")
    : undefined;

  const devOptions: DevServerOptions = {
    ...(opts.port !== undefined ? { port: parseInt(opts.port, 10) } : {}),
    ...(credentials !== undefined ? { credentials } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(mockData !== undefined ? { mockData } : {}),
    ...(opts.realFetch === true ? { allowRealFetch: true } : {}),
    ...(opts.maxBatches !== undefined ? { maxBatches: parseInt(opts.maxBatches, 10) } : {}),
    ...(opts.timeout !== undefined ? { callTimeoutMs: parseInt(opts.timeout, 10) } : {}),
    ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
  };

  const server = new PluginDevServer();

  // Graceful shutdown on Ctrl+C so the watcher is cleaned up and the terminal
  // is restored to a clean state.
  process.on("SIGINT", () => {
    server.stop();
    process.stderr.write("\nDev server stopped.\n");
    process.exit(0);
  });

  await server.start(pluginDir, devOptions);

  if (opts.watch === true) {
    server.startWatching(pluginDir, devOptions);

    // Keep the process alive until SIGINT. The watcher's async callbacks keep
    // Node's event loop active, so we only need to avoid returning here.
    await new Promise<void>(() => {
      // This promise intentionally never resolves; SIGINT handler calls process.exit().
    });
  }
}

// File-loading helpers used by devAction to validate boundary inputs.

function loadJsonRecord(filePath: string, label: string): Record<string, unknown> {
  const raw = readFileSync(filePath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CliError(`${label}: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`, EXIT.GENERAL);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${label}: invalid JSON in "${filePath}" — ${String(err)}`, EXIT.GENERAL);
  }
}

function loadStringRecord(filePath: string, label: string): Record<string, string> {
  const obj = loadJsonRecord(filePath, label);
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string") {
      throw new CliError(
        `${label}: all values must be strings, but "${k}" is ${typeof v}`,
        EXIT.GENERAL,
      );
    }
  }
  return obj as Record<string, string>;
}

export function registerPlugin(program: Command): void {
  const plugin = program.command("plugin").description("Plugin management");

  plugin.command("list").description("List all plugins")
    .option("--type <type>", "Filter by type: connector|transformer|destination|auth-provider|widget")
    .option("--status <status>", "Filter by status: enabled|disabled|installed")
    .action(withContext<[ListOpts]>(listAction));

  plugin.command("install").description("Install a plugin from file, URL, or registry reference")
    .argument("<source>", "Local .oppkg path, HTTPS URL, or registry reference")
    .option("--tenant <id>", "Install for specific tenant (ignored in --dev mode; always uses your own tenant)")
    .option(
      "--dev",
      "Install in development mode: requires only plugins:manage scope, scoped to your tenant, expires in 7 days",
    )
    .action(withContext<[string, InstallOpts]>(installAction));

  plugin.command("upgrade").description("Upload a new plugin version (replaces the active version)")
    .argument("<source>", "Local .oppkg path or HTTPS URL of the updated plugin package")
    .option("--tenant <id>", "Target tenant for the upgrade")
    .action(withContext<[string, UpgradeOpts]>(upgradeAction));

  plugin.command("rollback").description("Roll back a plugin to its previous version")
    .argument("<plugin-id>", "Plugin manifest ID to roll back")
    .action(withContext<[string, RollbackOpts]>(rollbackAction));

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

  plugin.command("publish").description("Publish the current plugin project to the marketplace")
    .option("--category <category>", "Marketplace category (e.g. data-source, transformation, analytics)")
    .option("--tags <tags>", "Comma-separated list of tags")
    .option("--dry-run", "Validate and preview without actually publishing")
    .action(withContext<[PublishOpts]>(publishAction));

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

  plugin.command("dev")
    .description(
      "Run the connector lifecycle locally for development (no server required). " +
        "Drives metadata() → connect() → fetchBatch() → disconnect() and displays results. " +
        "Use --watch to hot-reload on source changes.",
    )
    .option("--dir <path>", "Plugin project root (default: current directory)")
    .option("--credentials <file.json>", "JSON file mapping credential name → value")
    .option("--config <file.json>",      "JSON file with plugin instance config values")
    .option("--mock-data <file.json>",   "JSON file mapping URL substrings → mock response bodies")
    .option("--port <number>",           "TCP port for a webhook testing endpoint (optional)")
    .option("--real-fetch",              "Allow real network requests (default: all fetch calls are mocked)")
    .option("--watch",                   "Watch plugin source for changes and reload automatically")
    .option("--max-batches <n>",         "Maximum fetchBatch iterations before halting (default: 100)")
    .option("--timeout <ms>",            "Per-call timeout in milliseconds (default: 30000)")
    .option("--tenant-id <id>",          "Tenant ID in the dev context (default: dev-tenant)")
    .action(async (opts: DevOpts) => {
      // devAction does not need a CommandContext (no HTTP calls, no auth token).
      // We call it directly rather than through withContext to avoid a spurious
      // "not authenticated" error when the developer is working offline.
      await devAction(opts);
    });
}
