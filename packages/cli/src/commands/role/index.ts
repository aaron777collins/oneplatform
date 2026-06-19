/**
 * role command group — role management. Required scope: users:manage
 */
import type { Command } from "commander";
import { withContext } from "../../lib/context.js";
import type { CommandContext } from "../../lib/context.js";
import { confirmDestructive } from "../../lib/prompts.js";

const ROLE_COLUMNS = [
  { header: "Name", key: "name" },
  { header: "Permissions", key: "permissions" },
  { header: "Users", key: "userCount" },
  { header: "Created", key: "createdAt" },
];

interface CreateOpts { name: string; permissions: string }
interface AssignOpts { user: string }

async function listAction(_opts: Record<string, never>, ctx: CommandContext): Promise<void> {
  const roles = await ctx.http.get<unknown[]>("/api/v1/roles");
  ctx.renderer.render(roles, ROLE_COLUMNS);
}

async function createAction(opts: CreateOpts, ctx: CommandContext): Promise<void> {
  const resp = await ctx.http.post<{ name: string }>(
    "/api/v1/roles",
    { name: opts.name, permissions: opts.permissions.split(",").map((p) => p.trim()) },
  );
  ctx.renderer.success(`Role '${resp.name}' created.`);
}

async function assignAction(roleName: string, opts: AssignOpts, ctx: CommandContext): Promise<void> {
  // Fetch user, add role to their roles array, and PUT back
  const user = await ctx.http.get<Record<string, unknown>>(`/api/v1/users/${encodeURIComponent(opts.user)}`);
  const rawRoles = user["roles"];
  const currentRoles: string[] = Array.isArray(rawRoles) ? (rawRoles as string[]) : [];
  if (!currentRoles.includes(roleName)) {
    currentRoles.push(roleName);
  }
  await ctx.http.put(`/api/v1/users/${encodeURIComponent(opts.user)}`, { ...user, roles: currentRoles });
  ctx.renderer.success(`Role '${roleName}' assigned to user ${opts.user}.`);
}

async function removeAction(roleName: string, opts: AssignOpts, ctx: CommandContext): Promise<void> {
  await confirmDestructive(`Remove role '${roleName}' from user '${opts.user}'?`, ctx.yes);
  // Fetch user, remove role from their roles array, and PUT back
  const user = await ctx.http.get<Record<string, unknown>>(`/api/v1/users/${encodeURIComponent(opts.user)}`);
  const rawRoles = user["roles"];
  const currentRoles: string[] = Array.isArray(rawRoles) ? (rawRoles as string[]) : [];
  const updatedRoles = currentRoles.filter((r) => r !== roleName);
  await ctx.http.put(`/api/v1/users/${encodeURIComponent(opts.user)}`, { ...user, roles: updatedRoles });
  ctx.renderer.success(`Role '${roleName}' removed from user ${opts.user}.`);
}

export function registerRole(program: Command): void {
  const role = program.command("role").description("Role management (scope: users:manage)");

  role.command("list")
    .description("List all roles")
    .action(withContext<[Record<string, never>]>(listAction));

  role.command("create")
    .description("Create a new role")
    .requiredOption("--name <name>", "Role identifier (lowercase, no spaces)")
    .requiredOption("--permissions <perm,...>", "Comma-separated permission list")
    .action(withContext<[CreateOpts]>(createAction));

  role.command("assign")
    .description("Assign a role to a user")
    .argument("<role-name>", "Role name")
    .requiredOption("--user <user-id>", "User ID")
    .action(withContext<[string, AssignOpts]>(assignAction));

  role.command("remove")
    .description("Remove a role from a user")
    .argument("<role-name>", "Role name")
    .requiredOption("--user <user-id>", "User ID")
    .action(withContext<[string, AssignOpts]>(removeAction));
}
