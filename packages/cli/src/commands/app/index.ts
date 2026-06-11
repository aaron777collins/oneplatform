/**
 * app command group — app management.
 * Read scope: apps:read | Deploy scope: apps:deploy | Dev scope: apps:dev
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { confirmDestructive } from "../../lib/prompts.js";
import { streamSse } from "../../lib/streaming.js";
import { colorizeLogLevel } from "../../lib/output.js";
import { startLocalWatcher, applyRemoteChange, type ConflictResolution } from "../../lib/file-sync.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const APP_COLUMNS = [
  { header: "Slug", key: "slug" },
  { header: "Name", key: "name" },
  { header: "Status", key: "status" },
  { header: "Version", key: "version" },
  { header: "Access Mode", key: "accessMode" },
  { header: "Last Deployed", key: "lastDeployedAt" },
];

interface ListOpts { status?: string }
interface CreateOpts { name: string; template?: string; slug?: string }
interface DeployOpts { file?: string; env?: string; wait?: boolean }
interface DevOpts { port?: string; preferLocal?: boolean; preferRemote?: boolean }
interface LogsOpts { follow?: boolean; from?: string; level?: string }
interface EnvSetOpts {}
interface RollbackOpts { to?: string }

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.status) query["status"] = opts.status;
  const apps = await ctx.http.get<unknown[]>("/api/v1/apps", query);
  ctx.renderer.render(apps, APP_COLUMNS);
}

async function getAction(slug: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const app = await ctx.http.get<unknown>(`/api/v1/apps/${encodeURIComponent(slug)}`);
  ctx.renderer.json(app);
}

async function createAction(opts: CreateOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.template) body["template"] = opts.template;
  if (opts.slug) body["slug"] = opts.slug;
  const resp = await ctx.http.post<{ slug: string; name: string }>("/api/v1/apps", body);
  ctx.renderer.success(`App '${resp.name}' created (slug: ${resp.slug}).`);
}

async function deployAction(slug: string, opts: DeployOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.env) body["env"] = opts.env;

  let resp: { deploymentId: string; buildId?: string };

  if (opts.file) {
    const content = readFileSync(opts.file);
    const form = new FormData();
    form.append("bundle", new Blob([content]), opts.file.split("/").pop() ?? "bundle");
    if (opts.env) form.append("env", opts.env);
    resp = await ctx.http.postMultipart<typeof resp>(
      `/api/v1/apps/${encodeURIComponent(slug)}/deploy`,
      form,
    );
  } else {
    resp = await ctx.http.post<typeof resp>(`/api/v1/apps/${encodeURIComponent(slug)}/deploy`, body);
  }

  ctx.renderer.info(`Deployment ${resp.deploymentId} started.`);

  if (!opts.wait) return;

  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await ctx.http.get<{ status: string; buildLogs?: string }>(
      `/api/v1/apps/${encodeURIComponent(slug)}/deployments/${resp.deploymentId}`,
    );
    if (status.buildLogs) process.stderr.write(status.buildLogs);
    if (status.status === "deployed") {
      ctx.renderer.success("Deployment complete.");
      return;
    }
    if (status.status === "failed") {
      throw new CliError("Deployment failed.", EXIT.SERVER);
    }
  }
}

async function devAction(slug: string, opts: DevOpts, ctx: CommandContext): Promise<void> {
  const port = parseInt(opts.port ?? "3100", 10);
  const resolution: ConflictResolution = opts.preferLocal
    ? "prefer-local"
    : opts.preferRemote
      ? "prefer-remote"
      : "prompt";

  // Register dev session with the platform
  await ctx.http.post(`/api/v1/apps/${encodeURIComponent(slug)}/dev-session`, {
    redirectUri: `http://localhost:${port}/auth/callback`,
  });
  ctx.renderer.info(`Dev session started for '${slug}'. Local server: http://localhost:${port}`);

  const localDir = process.cwd();
  const stopWatcher = startLocalWatcher({
    slug,
    localDir,
    http: ctx.http,
    conflictResolution: resolution,
    onStatus: (msg) => ctx.renderer.info(msg),
  });

  // Stream remote file changes
  const remoteStreamPromise = (async () => {
    for await (const event of streamSse(ctx.http, `/api/v1/apps/${encodeURIComponent(slug)}/files/events`)) {
      try {
        const change = JSON.parse(event.data) as { path: string; content: string; modifiedAt: string };
        await applyRemoteChange(change, localDir, resolution, (msg) => ctx.renderer.info(msg));
      } catch {
        // Non-JSON SSE events (keepalive pings) are ignored
      }
    }
  })();

  // Start local proxy server
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`OnePlatform dev proxy for ${slug}\n`);
  });
  server.listen(port, () => ctx.renderer.info(`Listening on http://localhost:${port}`));

  // Clean up on SIGINT/SIGTERM
  const cleanup = async (): Promise<void> => {
    ctx.renderer.info("Shutting down dev session...");
    stopWatcher();
    server.close();
    try {
      await ctx.http.delete(`/api/v1/apps/${encodeURIComponent(slug)}/dev-session`);
    } catch {
      // Best-effort cleanup; server TTL handles unclean shutdowns
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());

  await remoteStreamPromise;
}

async function logsAction(slug: string, opts: LogsOpts, ctx: CommandContext): Promise<void> {
  if (opts.follow) {
    const query: Record<string, unknown> = {};
    if (opts.level) query["level"] = opts.level;
    for await (const event of streamSse(ctx.http, `/api/v1/apps/${encodeURIComponent(slug)}/logs/stream`, query)) {
      try {
        const entry = JSON.parse(event.data) as { level?: string; message?: string; timestamp?: string };
        const level = colorizeLogLevel(entry.level ?? "info", ctx.noColor);
        process.stdout.write(`[${entry.timestamp ?? ""}] ${level}: ${entry.message ?? event.data}\n`);
      } catch {
        process.stdout.write(event.data + "\n");
      }
    }
    return;
  }

  const query: Record<string, unknown> = {};
  if (opts.from) query["from"] = opts.from;
  if (opts.level) query["level"] = opts.level;
  const logs = await ctx.http.get<unknown>(`/api/v1/apps/${encodeURIComponent(slug)}/logs`, query);
  ctx.renderer.json(logs);
}

async function deleteAction(slug: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Delete app '${slug}'? This will remove all versions and data.`, ctx.yes);
  await ctx.http.delete(`/api/v1/apps/${encodeURIComponent(slug)}`);
  ctx.renderer.success(`App '${slug}' deleted.`);
}

async function envSetAction(slug: string, key: string, value: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await ctx.http.put(
    `/api/v1/apps/${encodeURIComponent(slug)}/env/${encodeURIComponent(key)}`,
    { value },
  );
  // Value is never stored locally or echoed back — it's encrypted server-side
  ctx.renderer.success(`Environment variable '${key}' set.`);
}

async function envListAction(slug: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const envVars = await ctx.http.get<Array<{ key: string; setAt: string }>>(
    `/api/v1/apps/${encodeURIComponent(slug)}/env`,
  );
  ctx.renderer.render(
    envVars.map((e) => ({ key: e.key, value: "[encrypted]", setAt: e.setAt })),
    [
      { header: "Key", key: "key" },
      { header: "Value", key: "value" },
      { header: "Set At", key: "setAt" },
    ],
  );
}

async function rollbackAction(slug: string, opts: RollbackOpts, ctx: CommandContext): Promise<void> {
  // Fetch current deployment info first so we can show a meaningful confirmation message
  // before the destructive POST. The confirmation must happen before the rollback is
  // triggered server-side, not after.
  const current = await ctx.http.get<{ version: string; deployedAt?: string }>(
    `/api/v1/apps/${encodeURIComponent(slug)}/deployments/current`,
  );
  const targetVersion = opts.to ?? "(previous)";
  const currentInfo = `current: ${current.version}${current.deployedAt ? ` deployed ${current.deployedAt}` : ""}`;
  await confirmDestructive(
    `Roll back '${slug}' to version ${targetVersion}? (${currentInfo})`,
    ctx.yes,
  );

  const body: Record<string, unknown> = {};
  if (opts.to) body["version"] = opts.to;
  const resp = await ctx.http.post<{ version: string }>(
    `/api/v1/apps/${encodeURIComponent(slug)}/rollback`,
    body,
  );
  ctx.renderer.success(`App '${slug}' rolled back to version ${resp.version}.`);
}

export function registerApp(program: Command): void {
  const app = program.command("app").description("App management");

  app.command("list").description("List all apps")
    .option("--status <status>", "Filter by status: draft|building|deployed|failed")
    .action(withContext<[ListOpts]>(listAction));

  app.command("get").description("Get app details")
    .argument("<slug>", "App URL slug")
    .action(withContext<[string, Record<string, never>]>(getAction));

  app.command("create").description("Create a new app")
    .requiredOption("--name <name>", "Display name")
    .option("--template <template>", "Starter template name")
    .option("--slug <slug>", "URL slug (auto-derived from name if omitted)")
    .action(withContext<[CreateOpts]>(createAction));

  app.command("deploy").description("Deploy an app")
    .argument("<slug>", "App URL slug")
    .option("--file <bundle-path>", "Local bundle path")
    .option("--env <env>", "Deployment environment: production|preview")
    .option("--wait", "Poll build until complete, stream build logs to stderr")
    .action(withContext<[string, DeployOpts]>(deployAction));

  app.command("dev").description("Start a local development server against the live platform")
    .argument("<slug>", "App URL slug")
    .option("--port <n>", "Local server port", "3100")
    .option("--prefer-local", "Always keep local files on conflict")
    .option("--prefer-remote", "Always use remote files on conflict")
    .action(withContext<[string, DevOpts]>(devAction));

  app.command("logs").description("Get or stream app logs")
    .argument("<slug>", "App URL slug")
    .option("-f, --follow", "Stream live logs via SSE until Ctrl+C")
    .option("--from <date>", "Start date filter (ISO 8601)")
    .option("--level <level>", "Minimum log level: debug|info|warn|error")
    .action(withContext<[string, LogsOpts]>(logsAction));

  app.command("delete").description("Delete an app permanently")
    .argument("<slug>", "App URL slug")
    .action(withContext<[string, Record<string, never>]>(deleteAction));

  app.command("env-set").description("Set an environment variable (encrypted at rest)")
    .argument("<slug>", "App URL slug")
    .argument("<key>", "Variable name")
    .argument("<value>", "Variable value")
    .action(withContext<[string, string, string, Record<string, never>]>(envSetAction));

  app.command("env-list").description("List environment variable names (values masked)")
    .argument("<slug>", "App URL slug")
    .action(withContext<[string, Record<string, never>]>(envListAction));

  app.command("rollback").description("Roll back an app to a previous version")
    .argument("<slug>", "App URL slug")
    .option("--to <version>", "Version number to roll back to")
    .action(withContext<[string, RollbackOpts]>(rollbackAction));
}
