/**
 * service command group — service administration. Required scope: admin
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { confirmDestructive } from "../../lib/prompts.js";

interface RotateKeysOpts { service?: string; overlap?: string }

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

export function registerService(program: Command): void {
  const service = program.command("service").description("Service administration (scope: admin)");

  service.command("rotate-keys").description("Rotate inter-service signing keys")
    .option("--service <name>", "Specific service name; omit to rotate all")
    .option("--overlap <duration>", "Overlap period for key transition", "5m")
    .action(withContext<[RotateKeysOpts]>(rotateKeysAction));

  service.command("health").description("Show detailed service health metrics")
    .action(withContext<[Record<string, never>]>(healthAction));
}
