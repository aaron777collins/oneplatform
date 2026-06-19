/**
 * auth command group — authentication and credential management.
 * Scope requirements: none for login/logout/status/whoami; admin for emergency-rotate.
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { CliError, EXIT } from "../../lib/errors.js";
import { saveCredentials, deleteCredentials } from "../../lib/credentials.js";
import { saveProfile, loadProfile } from "../../lib/profiles.js";
import { confirmDestructive, confirmByTyping, promptPassword, promptText } from "../../lib/prompts.js";

interface LoginOpts { platform?: string; key?: string }
interface GenerateKeyOpts { name: string; scopes: string; expires?: string }
interface RotateKeyOpts { overlap?: string }

const VALID_SCOPES = new Set([
  "data:read", "data:write",
  "ontology:read", "ontology:write",
  "pipelines:read", "pipelines:trigger", "pipelines:manage",
  "apps:read", "apps:deploy", "apps:manage",
  "plugins:read", "plugins:manage",
  "users:read", "users:manage",
  "logs:read",
  "webhooks:manage",
  "execution:read", "execution:run",
  "admin",
]);

async function loginAction(opts: LoginOpts, ctx: CommandContext): Promise<void> {
  const platformUrl = opts.platform ?? ctx.config.platformUrl;
  if (!platformUrl) {
    throw new CliError("No platform URL. Provide --platform or run 'op profile add'.", EXIT.GENERAL);
  }

  let apiKey: string;

  if (opts.key) {
    // Validate the supplied key by constructing a temporary HTTP client that uses it.
    // Using ctx.http here would validate the already-stored credential, not the new key.
    const { createHttpClient } = await import("../../lib/http-client.js");
    const tempClient = createHttpClient({
      platformUrl,
      apiKey: opts.key,
      timeout: ctx.config.timeout,
      insecureTls: ctx.config.insecureTls,
      verbose: ctx.config.verbose,
    });
    const me = await tempClient.get<{ email: string }>("/api/v1/auth/me");
    apiKey = opts.key;
    ctx.renderer.success(`Logged in as ${me.email} on ${platformUrl}`);
  } else {
    // Interactive mode
    const email = await promptText("Email:");
    const pass = await promptPassword("Password:");
    // Auth service login returns { accessToken, user: { email } } — not apiKey.
    // Some gateway configurations may also return { token } or { access_token },
    // so we defensively extract the token from whichever field is present.
    const resp = await ctx.http.post<Record<string, unknown>>(
      "/api/v1/auth/login",
      { email, password: pass },
    );
    const token = (resp["accessToken"] ?? resp["token"] ?? resp["access_token"]) as string | undefined;
    if (!token || typeof token !== "string") {
      throw new CliError(
        "Login succeeded but the response did not contain an access token. " +
        "The gateway may need its publicRoutes configured to allow /api/v1/auth/login.",
        EXIT.SERVER,
      );
    }
    apiKey = token;
    const user = resp["user"] as { email?: string } | undefined;
    const displayEmail = user?.email ?? email;
    ctx.renderer.success(`Logged in as ${displayEmail} on ${platformUrl}`);
  }

  // Persist the profile and encrypted credential.
  // Use the resolved profile name from context (respects --profile flag and OP_PROFILE env).
  const profileName = ctx.profileName;

  await saveCredentials(profileName, platformUrl, apiKey);
  const profile = loadProfile(profileName) ?? { name: profileName, platformUrl };
  saveProfile({ ...profile, platformUrl });
}

async function logoutAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const platformUrl = ctx.config.platformUrl;
  // Use the profile name resolved from --profile / OP_PROFILE / active profile
  // so multi-profile users always log out of the profile they actually specified.
  deleteCredentials(ctx.profileName);
  ctx.renderer.success(`Logged out of ${platformUrl}`);
}

async function statusAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  if (!ctx.credentials.apiKey) {
    ctx.renderer.info("Not authenticated. Run 'op auth login' to log in.");
    return;
  }
  const me = await ctx.http.get<{ email: string; id: string }>("/api/v1/auth/me");
  ctx.renderer.render(
    [
      { field: "Profile", value: ctx.credentials.source },
      { field: "Platform", value: ctx.config.platformUrl },
      { field: "Email", value: me.email },
      { field: "Status", value: "authenticated" },
    ],
    [
      { header: "Field", key: "field" },
      { header: "Value", key: "value" },
    ],
  );
}

async function whoamiAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  if (!ctx.credentials.apiKey) {
    throw new CliError("Not authenticated. Run 'op auth login' to log in.", EXIT.AUTH);
  }
  const me = await ctx.http.get<{
    id: string; email: string; displayName: string;
    tenantId: string; tenantName: string; roles: string[]
  }>("/api/v1/auth/me");

  ctx.renderer.render(
    [
      { field: "id", value: me.id },
      { field: "email", value: me.email },
      { field: "tenant", value: `${me.tenantName} (${me.tenantId})` },
      { field: "roles", value: me.roles.join(", ") },
    ],
    [
      { header: "Field", key: "field" },
      { header: "Value", key: "value" },
    ],
  );
}

async function generateKeyAction(opts: GenerateKeyOpts, ctx: CommandContext): Promise<void> {
  const scopes = opts.scopes.split(",").map((s) => s.trim());
  const invalid = scopes.filter((s) => !VALID_SCOPES.has(s));
  if (invalid.length > 0) {
    throw new CliError(
      `Invalid scope(s): ${invalid.join(", ")}. Valid scopes: ${[...VALID_SCOPES].join(", ")}`,
      EXIT.GENERAL,
    );
  }

  const body: Record<string, unknown> = {
    name: opts.name,
    scopes,
  };
  if (opts.expires) body["expiresAt"] = opts.expires;

  const resp = await ctx.http.post<{ id: string; key: string; name: string }>(
    "/api/v1/auth/api-keys",
    body,
  );
  ctx.renderer.warn("Store this key securely. It will not be shown again.");
  ctx.renderer.info(`Key ID: ${resp.id}`);
  ctx.renderer.info(`Key:    ${resp.key}`);
}

async function listKeysAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const keys = await ctx.http.get<Array<{
    id: string; name: string; scopes: string[]; createdAt: string;
    expiresAt?: string; lastUsedAt?: string
  }>>("/api/v1/auth/api-keys");

  ctx.renderer.render(keys, [
    { header: "ID", key: "id" },
    { header: "Name", key: "name" },
    { header: "Scopes", key: "scopes" },
    { header: "Created", key: "createdAt" },
    { header: "Expires", key: "expiresAt" },
    { header: "Last Used", key: "lastUsedAt" },
  ]);
}

async function revokeKeyAction(keyId: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Revoke API key '${keyId}'?`, ctx.yes);
  await ctx.http.delete(`/api/v1/auth/api-keys/${encodeURIComponent(keyId)}`);
  ctx.renderer.success(`Key ${keyId} revoked.`);
}

async function rotateKeyAction(keyId: string, opts: RotateKeyOpts, ctx: CommandContext): Promise<void> {
  const overlap = opts.overlap ?? "1h";
  const resp = await ctx.http.post<{ newKey: string; overlapExpiresAt: string }>(
    `/api/v1/auth/api-keys/${encodeURIComponent(keyId)}/rotate`,
    { overlap },
  );
  ctx.renderer.warn("Store this new key securely. It will not be shown again.");
  ctx.renderer.info(`New key: ${resp.newKey}`);
  ctx.renderer.info(`Old key valid until: ${resp.overlapExpiresAt}`);
}

async function emergencyRotateAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  // --yes never bypasses this command — always requires typing ROTATE
  await confirmByTyping(
    "This will invalidate ALL active sessions. Type ROTATE to confirm:",
    "ROTATE",
  );
  const resp = await ctx.http.post<{ invalidatedSessions: number }>(
    "/api/v1/admin/auth/emergency-rotate",
  );
  ctx.renderer.success(
    `Emergency rotation complete. All ${resp.invalidatedSessions} active sessions have been invalidated.`,
  );
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Authentication and credential management");

  auth.command("login")
    .description("Establish credentials for the active profile")
    .option("--platform <url>", "Platform URL")
    .option("--key <api-key>", "API key (skips interactive prompt)")
    .action(withContext<[LoginOpts]>(loginAction));

  auth.command("logout")
    .description("Clear credentials for the current profile")
    .action(withContext<[Record<string, never>]>(logoutAction));

  auth.command("status")
    .description("Show current authentication state")
    .action(withContext<[Record<string, never>]>(statusAction));

  auth.command("whoami")
    .description("Print current user details")
    .action(withContext<[Record<string, never>]>(whoamiAction));

  auth.command("generate-key")
    .description("Generate a new API key")
    .requiredOption("--name <name>", "Human-readable label for the key")
    .requiredOption("--scopes <scopes>", "Comma-separated scopes (valid: data:read, data:write, ontology:read, ontology:write, pipelines:read, pipelines:trigger, pipelines:manage, apps:read, apps:deploy, apps:manage, plugins:read, plugins:manage, users:read, users:manage, logs:read, webhooks:manage, execution:read, execution:run, admin)")
    .option("--expires <ISO-date>", "Expiry date (ISO 8601); omit for non-expiring key")
    .action(withContext<[GenerateKeyOpts]>(generateKeyAction));

  auth.command("list-keys")
    .description("List all API keys for the current user")
    .action(withContext<[Record<string, never>]>(listKeysAction));

  auth.command("revoke-key")
    .description("Revoke an API key")
    .argument("<key-id>", "API key ID to revoke")
    .action(withContext<[string, Record<string, never>]>(revokeKeyAction));

  auth.command("rotate-key")
    .description("Rotate an API key with overlap period")
    .argument("<key-id>", "API key ID to rotate")
    .option("--overlap <duration>", "Overlap duration (e.g. 1h, 30m)", "1h")
    .action(withContext<[string, RotateKeyOpts]>(rotateKeyAction));

  auth.command("emergency-rotate")
    .description("Rotate JWT signing secret, invalidating ALL active sessions (admin only)")
    .action(withContext<[Record<string, never>]>(emergencyRotateAction));
}
