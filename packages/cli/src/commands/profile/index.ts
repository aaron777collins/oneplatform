/**
 * profile command group — multi-environment profile management.
 * Operates on local config files only; no API calls except optional key validation.
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import {
  saveProfile,
  loadProfile,
  listProfiles,
  deleteProfile,
  setActiveProfile,
  getActiveProfileName,
  profileExists,
} from "../../lib/profiles.js";
import { saveCredentials } from "../../lib/credentials.js";
import { confirmDestructive } from "../../lib/prompts.js";

interface AddOpts { platform: string; key?: string }
interface RemoveOpts { yes?: boolean }

async function addAction(name: string, opts: AddOpts, ctx: CommandContext): Promise<void> {
  if (!opts.platform) {
    throw new CliError("--platform is required.", EXIT.GENERAL);
  }

  // Validate the key against the API if provided
  if (opts.key) {
    try {
      await ctx.http.get("/api/v1/auth/me");
    } catch {
      throw new CliError(
        `API key validation failed. Check the key and platform URL.`,
        EXIT.AUTH,
      );
    }
    await saveCredentials(name, opts.platform, opts.key);
  }

  saveProfile({ name, platformUrl: opts.platform });

  if (opts.key) {
    ctx.renderer.success(`Profile '${name}' added with credentials.`);
  } else {
    ctx.renderer.success(
      `Profile '${name}' added. Run 'op auth login --profile ${name}' to add credentials.`,
    );
  }
}

async function listAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const profiles = listProfiles();
  const active = getActiveProfileName();
  const rows = profiles.map((p) => ({
    name: p.name,
    platformUrl: p.platformUrl,
    active: p.name === active ? "*" : "",
  }));
  ctx.renderer.render(rows, [
    { header: "Name", key: "name" },
    { header: "Platform URL", key: "platformUrl" },
    { header: "Active", key: "active" },
  ]);
}

async function useAction(name: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  if (!profileExists(name)) {
    throw new CliError(`Profile '${name}' not found. Run 'op profile list' to see available profiles.`, EXIT.GENERAL);
  }
  setActiveProfile(name);
  ctx.renderer.success(`Switched to profile '${name}'.`);
}

async function removeAction(name: string, opts: RemoveOpts, ctx: CommandContext): Promise<void> {
  if (!profileExists(name)) {
    throw new CliError(`Profile '${name}' not found.`, EXIT.GENERAL);
  }
  const active = getActiveProfileName();
  if (name === active && !ctx.yes) {
    await confirmDestructive(
      `'${name}' is the active profile. Remove it anyway?`,
      ctx.yes,
    );
  }

  deleteProfile(name);
  ctx.renderer.success(`Profile '${name}' removed.`);
}

export function registerProfile(program: Command): void {
  const profile = program.command("profile").description("Multi-environment profile management");

  profile.command("add")
    .description("Create a new profile")
    .argument("<name>", "Profile name")
    .requiredOption("--platform <url>", "Platform base URL")
    .option("--key <api-key>", "API key to store encrypted")
    .action(withContext<[string, AddOpts]>(addAction));

  profile.command("list")
    .description("List all profiles")
    .action(withContext<[Record<string, never>]>(listAction));

  profile.command("use")
    .description("Set the active profile")
    .argument("<name>", "Profile name to activate")
    .action(withContext<[string, Record<string, never>]>(useAction));

  profile.command("remove")
    .description("Remove a profile")
    .argument("<name>", "Profile name to remove")
    .action(withContext<[string, RemoveOpts]>(removeAction));
}
