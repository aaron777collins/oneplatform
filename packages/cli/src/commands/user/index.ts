/**
 * user command group — user management. Required scope: users:manage
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { confirmDestructive } from "../../lib/prompts.js";

const USER_COLUMNS = [
  { header: "ID", key: "id" },
  { header: "Email", key: "email" },
  { header: "Display Name", key: "displayName" },
  { header: "Roles", key: "roles" },
  { header: "Status", key: "status" },
  { header: "Created", key: "createdAt" },
];

interface ListOpts { tenant?: string; limit?: string; status?: string }
interface InviteOpts { email: string; role: string; sendEmail?: boolean }
interface UpdateOpts { role?: string; displayName?: string }
interface ImportOpts { file: string; role?: string; dryRun?: boolean }

async function listAction(opts: ListOpts, ctx: CommandContext): Promise<void> {
  const query: Record<string, unknown> = {};
  if (opts.tenant) query["tenantId"] = opts.tenant;
  if (opts.limit) query["limit"] = opts.limit;
  if (opts.status) query["status"] = opts.status;
  const users = await ctx.http.get<unknown[]>("/api/v1/users", query);
  ctx.renderer.render(users, USER_COLUMNS);
}

async function inviteAction(opts: InviteOpts, ctx: CommandContext): Promise<void> {
  const sendEmail = opts.sendEmail ?? process.stdin.isTTY === true;
  const resp = await ctx.http.post<{ id: string; email: string }>(
    "/api/v1/users/invite",
    { email: opts.email, role: opts.role, sendEmail },
  );
  ctx.renderer.success(`Invited ${resp.email} (ID: ${resp.id}).`);
}

async function getAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const user = await ctx.http.get<unknown>(`/api/v1/users/${encodeURIComponent(id)}`);
  ctx.renderer.render(user, USER_COLUMNS);
}

async function updateAction(id: string, opts: UpdateOpts, ctx: CommandContext): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.role) body["role"] = opts.role;
  if (opts.displayName) body["displayName"] = opts.displayName;
  await ctx.http.patch<unknown>(`/api/v1/users/${encodeURIComponent(id)}`, body);
  ctx.renderer.success(`User ${id} updated.`);
}

async function deactivateAction(id: string, _opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Deactivate user '${id}'?`, ctx.yes);
  await ctx.http.post(`/api/v1/users/${encodeURIComponent(id)}/deactivate`);
  ctx.renderer.success(`User ${id} deactivated.`);
}

async function importAction(opts: ImportOpts, ctx: CommandContext): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const csvContent = readFileSync(opts.file, "utf8");
  const form = new FormData();
  form.append("file", new Blob([csvContent], { type: "text/csv" }), "users.csv");
  if (opts.role) form.append("defaultRole", opts.role);
  if (opts.dryRun) form.append("dryRun", "true");

  const resp = await ctx.http.postMultipart<{ created: number; skipped: number; failed: number }>(
    "/api/v1/users/import",
    form,
  );
  ctx.renderer.success(`Import complete: ${resp.created} created, ${resp.skipped} skipped, ${resp.failed} failed.`);
}

export function registerUser(program: Command): void {
  const user = program.command("user").description("User management (scope: users:manage)");

  user.command("list")
    .description("List users")
    .option("--tenant <id>", "Filter by tenant ID")
    .option("--limit <n>", "Maximum records to return")
    .option("--status <status>", "Filter by status: active|inactive|all")
    .action(withContext<[ListOpts]>(listAction));

  user.command("invite")
    .description("Invite a new user")
    .requiredOption("--email <email>", "Target email address")
    .requiredOption("--role <role>", "Role to assign")
    .option("--send-email", "Trigger invitation email")
    .action(withContext<[InviteOpts]>(inviteAction));

  user.command("get")
    .description("Get user details")
    .argument("<id>", "User ID")
    .action(withContext<[string, Record<string, never>]>(getAction));

  user.command("update")
    .description("Update user attributes")
    .argument("<id>", "User ID")
    .option("--role <role>", "Assign a role")
    .option("--display-name <name>", "Update display name")
    .action(withContext<[string, UpdateOpts]>(updateAction));

  user.command("deactivate")
    .description("Deactivate a user")
    .argument("<id>", "User ID")
    .action(withContext<[string, Record<string, never>]>(deactivateAction));

  user.command("import")
    .description("Bulk import users from CSV")
    .requiredOption("--file <csv-path>", "Path to CSV file (headers: email,displayName,role)")
    .option("--role <role>", "Default role if CSV row omits role column")
    .option("--dry-run", "Validate and report counts without writing")
    .action(withContext<[ImportOpts]>(importAction));
}
