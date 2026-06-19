/**
 * CommandContext — the object injected into every action handler.
 * The preAction hook resolves all configuration before any command runs,
 * so actions don't need to read files or environment variables themselves.
 *
 * withContext is the HOF that wraps every action: it injects the context,
 * catches CliError and maps it to process.exit, and logs stack traces when verbose.
 */
import type { Command } from "commander";
import {
  loadCredentials,
  checkCredentialsPermissions,
  type ResolvedCredentials,
} from "./credentials.js";
import { loadProfile, getActiveProfileName, type Profile } from "./profiles.js";
import { createHttpClient, type HttpClient, type HttpClientConfig } from "./http-client.js";
import {
  createOutputRenderer,
  detectDefaultFormat,
  type OutputFormat,
  type OutputRenderer,
} from "./output.js";
import { CliError, formatCliError } from "./errors.js";

export interface ResolvedConfig {
  platformUrl: string;
  timeout: number;
  insecureTls: boolean;
  verbose: boolean;
}

export interface CommandContext {
  config: ResolvedConfig;
  credentials: ResolvedCredentials;
  /** The resolved profile name (from --profile, OP_PROFILE, or active profile). */
  profileName: string;
  output: OutputFormat;
  renderer: OutputRenderer;
  quiet: boolean;
  noColor: boolean;
  yes: boolean;
  http: HttpClient;
}

interface GlobalOpts {
  profile?: string;
  output?: string;
  yes?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  verbose?: boolean;
  timeout?: string;
  platform?: string;
}

function resolveOutputFormat(
  opts: GlobalOpts,
  profile: Profile | null,
): OutputFormat {
  const raw =
    opts.output ??
    process.env["OP_OUTPUT"] ??
    profile?.defaultOutput;

  if (raw === "json" || raw === "table" || raw === "tsv" || raw === "jsonl") return raw;
  return detectDefaultFormat(false);
}

function resolvePlatformUrl(
  opts: GlobalOpts,
  profile: Profile | null,
  envCredUrl: string | null,
): string {
  return (
    opts.platform ??
    process.env["OP_PLATFORM_URL"] ??
    profile?.platformUrl ??
    envCredUrl ??
    ""
  );
}

function resolveTimeout(opts: GlobalOpts, profile: Profile | null): number {
  const raw =
    opts.timeout ??
    process.env["OP_TIMEOUT"] ??
    (profile?.timeout !== undefined ? String(profile.timeout) : undefined);
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 30_000;
}

/**
 * Commander preAction hook — resolves all configuration before any command runs.
 * Attaches the resolved CommandContext as a hidden option on the action command,
 * which withContext extracts in every handler.
 */
export async function globalPreActionHook(
  thisCommand: Command,
  actionCommand: Command,
): Promise<void> {
  const opts = thisCommand.optsWithGlobals() as GlobalOpts;

  const profileName =
    opts.profile ?? process.env["OP_PROFILE"] ?? getActiveProfileName();
  const profile = loadProfile(profileName);
  const credentials = await loadCredentials(profileName);

  const noColor =
    opts.noColor === true ||
    process.env["NO_COLOR"] !== undefined ||
    process.stdout.isTTY !== true;

  const verbose = opts.verbose === true || process.env["OP_VERBOSE"] === "1";
  const quiet = opts.quiet === true;
  const yes = opts.yes === true;

  const platformUrl = resolvePlatformUrl(opts, profile, credentials.platformUrl);
  const timeout = resolveTimeout(opts, profile);
  const insecureTls = profile?.insecureTls === true;

  if (insecureTls) {
    process.stderr.write(
      "WARNING: TLS certificate verification is disabled (--insecure-tls). Do not use in production.\n",
    );
  }

  // Non-blocking permission warning — runs after creds are loaded
  const permWarning = checkCredentialsPermissions();
  if (permWarning) {
    process.stderr.write(`WARNING: ${permWarning}\n`);
  }

  const outputFormat = resolveOutputFormat(opts, profile);

  const httpConfig: HttpClientConfig = {
    platformUrl,
    apiKey: credentials.apiKey,
    timeout,
    insecureTls,
    verbose,
  };

  const http = createHttpClient(httpConfig);
  const renderer = createOutputRenderer(outputFormat, quiet, noColor);

  const ctx: CommandContext = {
    config: { platformUrl, timeout, insecureTls, verbose },
    credentials,
    profileName,
    output: outputFormat,
    renderer,
    quiet,
    noColor,
    yes,
    http,
  };

  // Attach context to the action command so withContext can retrieve it
  actionCommand.setOptionValueWithSource("_ctx", ctx, "env");
}

/**
 * Wraps an action handler with context injection and error handling.
 * All command action handlers are wrapped with this function.
 *
 * Usage:
 *   .action(withContext(async (opts, args, ctx) => { ... }))
 */
export function withContext<TArgs extends unknown[]>(
  fn: (...args: [...TArgs, CommandContext]) => Promise<void>,
): (...commanderArgs: unknown[]) => Promise<void> {
  return async (...commanderArgs: unknown[]): Promise<void> => {
    // Commander passes (opts, ...positionalArgs, command) or (arg1, ..., opts, command)
    // The last argument is always the Command instance
    const commandInstance = commanderArgs[commanderArgs.length - 1] as Command;
    const ctx = commandInstance.opts()["_ctx"] as CommandContext | undefined;

    if (!ctx) {
      process.stderr.write("Error: Internal error — context not initialized.\n");
      process.exit(1);
    }

    try {
      // Re-spread args excluding the Command instance at the end, and append ctx
      const actionArgs = commanderArgs.slice(0, -1) as TArgs;
      await fn(...actionArgs, ctx);
    } catch (err) {
      if (err instanceof CliError) {
        ctx.renderer.error(formatCliError(err, ctx.config.verbose));
        if (ctx.config.verbose && err.underlyingCause?.stack) {
          process.stderr.write(`\n${err.underlyingCause.stack}\n`);
        }
        process.exit(err.exitCode);
      }
      // Unexpected error — always print stack
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: Unexpected error: ${msg}\n`);
      if (err instanceof Error && err.stack) {
        process.stderr.write(`${err.stack}\n`);
      }
      process.exit(1);
    }
  };
}
