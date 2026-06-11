/**
 * status command — platform health overview with optional watch mode.
 * No scope required for basic status; admin scope for detailed service internals.
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";

interface StatusOpts { watch?: boolean; interval?: string }

interface HealthService {
  name: string;
  status: "healthy" | "degraded" | "unhealthy";
  latencyMs?: number;
}

interface HealthResponse {
  version?: string;
  services: HealthService[];
  infrastructure: HealthService[];
  checkedAt: string;
}

// ANSI codes without external chalk — stays consistent with output.ts approach
const ANSI = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
} as const;

function serviceColor(status: string, noColor: boolean): string {
  if (noColor) return status;
  switch (status) {
    case "healthy": return `${ANSI.green}${status}${ANSI.reset}`;
    case "degraded": return `${ANSI.yellow}${status}${ANSI.reset}`;
    case "unhealthy": return `${ANSI.red}${status}${ANSI.reset}`;
    default: return status;
  }
}

function renderHealth(health: HealthResponse, platformUrl: string, noColor: boolean): void {
  process.stdout.write(`\nOnePlatform ${health.version ?? ""} — ${platformUrl}\n\n`);

  process.stdout.write("Services\n");
  for (const svc of health.services) {
    const status = serviceColor(svc.status, noColor);
    const latency = svc.latencyMs !== undefined ? ` (${svc.latencyMs}ms)` : "";
    process.stdout.write(`  ${svc.name.padEnd(16)} ${status}${latency}\n`);
  }

  process.stdout.write("\nInfrastructure\n");
  for (const infra of health.infrastructure) {
    const status = serviceColor(infra.status, noColor);
    process.stdout.write(`  ${infra.name.padEnd(16)} ${status}\n`);
  }

  process.stdout.write(`\nLast checked: ${health.checkedAt}\n`);
}

async function fetchHealth(ctx: CommandContext): Promise<HealthResponse> {
  // Try admin endpoint for details; fall back to public if 403
  try {
    return await ctx.http.get<HealthResponse>("/api/v1/admin/health/detailed");
  } catch {
    return ctx.http.get<HealthResponse>("/api/v1/health");
  }
}

async function statusAction(opts: StatusOpts, ctx: CommandContext): Promise<void> {
  const interval = parseInt(opts.interval ?? "5", 10) * 1000;

  const renderOnce = async (): Promise<boolean> => {
    const health = await fetchHealth(ctx);
    if (opts.watch && process.stdout.isTTY) {
      // Clear terminal before each refresh in watch mode
      process.stdout.write("\x1b[2J\x1b[H");
    }
    renderHealth(health, ctx.config.platformUrl, ctx.noColor);
    const anyUnhealthy = [
      ...health.services,
      ...health.infrastructure,
    ].some((s) => s.status === "unhealthy");
    return anyUnhealthy;
  };

  if (!opts.watch) {
    const unhealthy = await renderOnce();
    if (unhealthy) process.exit(1);
    return;
  }

  process.stderr.write("Watching platform status (Ctrl+C to stop)...\n");
  while (true) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show platform health status")
    .option("--watch", "Refresh in place on an interval until Ctrl+C")
    .option("--interval <seconds>", "Refresh interval in seconds (default 5)")
    .action(withContext<[StatusOpts]>(statusAction));
}
