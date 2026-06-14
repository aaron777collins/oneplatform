/**
 * service command group — service administration. Required scope: admin
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { confirmDestructive } from "../../lib/prompts.js";

interface RotateKeysOpts { service?: string; overlap?: string }
interface RestartOpts { graceful: boolean }

async function rotateKeysAction(opts: RotateKeysOpts, ctx: CommandContext): Promise<void> {
  const target = opts.service ?? "all services";
  await confirmDestructive(`Rotate signing keys for ${target}?`, ctx.yes);
  const body: Record<string, unknown> = { overlap: opts.overlap ?? "5m" };
  if (opts.service) body["service"] = opts.service;

  const resp = await ctx.http.post<{ rotated: string[]; overlapExpiresAt: string }>(
    "/api/v1/admin/services/rotate-keys",
    body,
  );
  ctx.renderer.success(
    `Rotated keys for: ${resp.rotated.join(", ")}. Old keys valid until ${resp.overlapExpiresAt}.`,
  );
}

async function healthAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const health = await ctx.http.get<unknown>("/api/v1/admin/health/detailed");
  ctx.renderer.json(health);
}

async function restartAction(
  serviceName: string | undefined,
  opts: RestartOpts,
  ctx: CommandContext,
): Promise<void> {
  const target = serviceName ?? "all services";
  await confirmDestructive(`Restart ${target}?`, ctx.yes);

  const path = serviceName
    ? `/api/v1/admin/services/${encodeURIComponent(serviceName)}/restart`
    : "/api/v1/admin/services/restart";

  const resp = await ctx.http.post<{ restarted: string[]; graceful: boolean }>(
    path,
    { graceful: opts.graceful },
  );
  ctx.renderer.success(
    `Restarted: ${resp.restarted.join(", ")} (graceful=${String(resp.graceful)}).`,
  );
}

async function scaleAction(
  serviceName: string,
  replicas: string,
  _opts: Record<string, never>,
  ctx: CommandContext,
): Promise<void> {
  const replicaCount = parseInt(replicas, 10);
  if (isNaN(replicaCount) || replicaCount < 1) {
    ctx.renderer.error("Replica count must be a positive integer.");
    process.exit(1);
  }

  // Scale is a 501 stub — requires Docker Swarm, Kubernetes, or equivalent.
  // The gateway endpoint returns 501 with instructions, which we surface here.
  // To scale in standalone Docker Compose, use:
  //   docker compose up --scale <service>=<count>
  //
  // For Swarm:
  //   docker service scale oneplatform_<service>=<count>
  //
  // For Kubernetes:
  //   kubectl scale deployment <service> --replicas=<count>
  try {
    await ctx.http.post<unknown>(
      `/api/v1/admin/services/${encodeURIComponent(serviceName)}/scale`,
      { replicas: replicaCount },
    );
    ctx.renderer.success(`Scale request submitted for ${serviceName} → ${replicaCount} replica(s).`);
  } catch (err: unknown) {
    // The 501 response from the gateway contains actionable instructions.
    // Surface them directly rather than showing a generic error.
    if (err instanceof Error && err.message.includes("501")) {
      ctx.renderer.warn(
        `Scale via API is not yet implemented. Use one of the following instead:\n` +
        `  Docker Compose (standalone): docker compose up --scale ${serviceName}=${replicaCount}\n` +
        `  Docker Swarm:                docker service scale oneplatform_${serviceName}=${replicaCount}\n` +
        `  Kubernetes:                  kubectl scale deployment ${serviceName} --replicas=${replicaCount}`,
      );
    } else {
      throw err;
    }
  }
}

export function registerService(program: Command): void {
  const service = program.command("service").description("Service administration (scope: admin)");

  service.command("rotate-keys").description("Rotate inter-service signing keys")
    .option("--service <name>", "Specific service name; omit to rotate all")
    .option("--overlap <duration>", "Overlap period for key transition", "5m")
    .action(withContext<[RotateKeysOpts]>(rotateKeysAction));

  service.command("health").description("Show detailed service health metrics")
    .action(withContext<[Record<string, never>]>(healthAction));

  service.command("restart")
    .description("Restart one or all services (scope: admin)")
    .argument("[service-name]", "Service to restart; omit to restart all")
    .option("--graceful", "Wait for in-flight requests to drain before restarting (default: true)", true)
    .action(withContext<[string | undefined, RestartOpts]>(restartAction));

  service.command("scale")
    .description(
      "Set the replica count for a service.\n" +
      "Requires orchestrator support (Docker Swarm or Kubernetes).\n" +
      "In standalone Docker Compose, use: docker compose up --scale <service>=<count>",
    )
    .argument("<service-name>", "Service name (e.g. gateway-service)")
    .argument("<replicas>", "Desired replica count (positive integer)")
    .action(withContext<[string, string, Record<string, never>]>(scaleAction));
}
