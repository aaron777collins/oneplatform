/**
 * version command — prints CLI and platform version information.
 * No scope or authentication required.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";

// Read version from package.json at startup so it stays in sync with the
// published package version and never falls out of date.
function readCliVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLI_VERSION = readCliVersion();

async function versionAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const platform = process.platform;
  const arch = process.arch;
  const runtime = `node/${process.version.slice(1)} ${platform}/${arch}`;

  ctx.renderer.info(`op v${CLI_VERSION}`);

  // Fetch platform version if authenticated; gracefully fall back if not
  if (ctx.credentials.apiKey) {
    try {
      const platformInfo = await ctx.http.get<{ version: string; apiVersion: string }>(
        "/api/v1/version",
      );
      ctx.renderer.info(`Platform: v${platformInfo.version} (API ${platformInfo.apiVersion})`);
    } catch {
      ctx.renderer.info("Platform: unknown (not authenticated or unreachable)");
    }
  } else {
    ctx.renderer.info("Platform: unknown (not authenticated)");
  }

  ctx.renderer.info(`Build: ${runtime}`);
}

export function registerVersion(program: Command): void {
  program
    .command("version")
    .description("Print CLI and platform version information")
    .action(withContext<[Record<string, never>]>(versionAction));
}
