// Role management route handlers.
// All routes require authentication. Creating/modifying roles additionally
// requires the users:manage scope to prevent privilege escalation.
//
// Predefined roles (is_predefined = true) are immutable — only their entity
// permissions may be read, not changed.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "@oneplatform/core";
import type pg from "pg";
import type { RoleRepository } from "../repositories/index.js";
import type { EntityPermissionRepository } from "../repositories/entity-permission-repository.js";
import { PredefinedRoleImmutableError } from "../services/errors.js";
import {
  createRoleRequest,
  updateRoleRequest,
  updateRolePermissionsRequest,
} from "../schemas/index.js";

export interface RoleRouteDeps {
  roleRepository: RoleRepository;
  entityPermissionRepository: EntityPermissionRepository;
  db: pg.Pool;
}

// Scope required to mutate roles (create, update, delete, set permissions).
const ROLE_MANAGE_SCOPE = "users:manage";

export function createRoleRoutes(deps: RoleRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { roleRepository, entityPermissionRepository, db } = deps;

  // POST /api/v1/roles — create a new tenant-scoped role
  routes.post("/api/v1/roles", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(ROLE_MANAGE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("users:manage scope is required to create roles.");
    }

    const body = await c.req.json();
    const parsed = createRoleRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid role creation request", parsed.error.issues);
    }

    const role = await roleRepository.create({
      tenant_id: user.tenantId,
      name: parsed.data.name,
      description: parsed.data.description,
      is_predefined: false,
      permissions: parsed.data.permissions,
    });

    return c.json(
      {
        id: role.id,
        tenantId: role.tenant_id,
        name: role.name,
        description: role.description,
        isPredefined: role.is_predefined,
        permissions: role.permissions,
        createdAt: role.created_at.toISOString(),
      },
      201,
    );
  });

  // GET /api/v1/roles — list all roles visible to this tenant
  routes.get("/api/v1/roles", async (c) => {
    const user = c.var.user;
    const roles = await roleRepository.findByTenantId(user.tenantId);

    const data = roles.map((role) => ({
      id: role.id,
      tenantId: role.tenant_id,
      name: role.name,
      description: role.description,
      isPredefined: role.is_predefined,
      permissions: role.permissions,
      createdAt: role.created_at.toISOString(),
    }));

    return c.json({
      data,
      pagination: { nextCursor: null, total: data.length },
    });
  });

  // GET /api/v1/roles/:id — fetch a single role by ID
  routes.get("/api/v1/roles/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.var.user;

    const role = await roleRepository.findById(user.tenantId, id);

    if (!role) {
      throw new NotFoundError(`Role ${id} not found.`);
    }

    return c.json({
      id: role.id,
      tenantId: role.tenant_id,
      name: role.name,
      description: role.description,
      isPredefined: role.is_predefined,
      permissions: role.permissions,
      createdAt: role.created_at.toISOString(),
    });
  });

  // PUT /api/v1/roles/:id — update a tenant-scoped role
  // Predefined roles are immutable — returns 403 if attempted.
  routes.put("/api/v1/roles/:id", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(ROLE_MANAGE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("users:manage scope is required to update roles.");
    }

    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = updateRoleRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid role update request", parsed.error.issues);
    }

    const existing = await roleRepository.findById(user.tenantId, id);
    if (!existing) {
      throw new NotFoundError(`Role ${id} not found.`);
    }
    if (existing.is_predefined) {
      throw new PredefinedRoleImmutableError(
        `Role "${existing.name}" is a predefined role and cannot be modified.`,
      );
    }

    const isRename = parsed.data.name !== undefined && parsed.data.name !== existing.name;

    let updated: import("../repositories/types.js").Role;

    if (isRename) {
      // Wrap both the role update and the user roles array_replace in a single
      // transaction so a crash between them cannot leave users referencing a
      // role name that no longer exists (or retaining the old name after rename).
      const client = await db.connect();
      try {
        await client.query("BEGIN");

        const sets: string[] = [];
        const values: unknown[] = [];
        let idx = 1;
        if (parsed.data.name !== undefined) { sets.push(`name = $${idx++}`); values.push(parsed.data.name); }
        if (parsed.data.description !== undefined) { sets.push(`description = $${idx++}`); values.push(parsed.data.description); }
        if (parsed.data.permissions !== undefined) { sets.push(`permissions = $${idx++}`); values.push(parsed.data.permissions); }
        sets.push(`updated_at = now()`);
        values.push(id);
        const roleResult = await client.query<import("../repositories/types.js").Role>(
          `UPDATE auth.roles
              SET ${sets.join(", ")}
            WHERE id = $${idx}
              AND is_predefined = false
         RETURNING id, tenant_id, name, description, is_predefined, permissions, created_at, updated_at`,
          values,
        );
        const updatedRow = roleResult.rows[0];
        if (updatedRow === undefined) {
          throw new Error(`UPDATE auth.roles found no updatable row with id=${id}`);
        }
        updated = updatedRow;

        await client.query(
          `UPDATE auth.users
              SET roles = array_replace(roles, $1, $2),
                  updated_at = now()
            WHERE tenant_id = $3
              AND $1 = ANY(roles)`,
          [existing.name, parsed.data.name, user.tenantId],
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } else {
      updated = await roleRepository.update(id, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.permissions !== undefined ? { permissions: parsed.data.permissions } : {}),
      });
    }

    return c.json({
      id: updated.id,
      tenantId: updated.tenant_id,
      name: updated.name,
      description: updated.description,
      isPredefined: updated.is_predefined,
      permissions: updated.permissions,
      createdAt: updated.created_at.toISOString(),
    });
  });

  // DELETE /api/v1/roles/:id — soft-delete a tenant-scoped role
  // Predefined roles cannot be deleted.
  routes.delete("/api/v1/roles/:id", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(ROLE_MANAGE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("users:manage scope is required to delete roles.");
    }

    const id = c.req.param("id");
    const existing = await roleRepository.findById(user.tenantId, id);

    if (!existing) {
      throw new NotFoundError(`Role ${id} not found.`);
    }
    if (existing.is_predefined) {
      throw new PredefinedRoleImmutableError(
        `Role "${existing.name}" is a predefined role and cannot be deleted.`,
      );
    }

    // Prevent deletion of roles that are currently assigned to users.
    // The caller must first remove the role from all users before deleting it.
    const assignedResult = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM auth.users WHERE tenant_id = $1 AND $2 = ANY(roles)`,
      [user.tenantId, existing.name],
    );
    const assignedCount = parseInt(assignedResult.rows[0]?.count ?? "0", 10);
    if (assignedCount > 0) {
      throw new ConflictError(
        "Cannot delete role that is assigned to users. Remove role from all users first.",
      );
    }

    const deleted = await roleRepository.delete(id);
    if (!deleted) {
      throw new NotFoundError(`Role ${id} not found or could not be deleted.`);
    }

    return new Response(null, { status: 204 });
  });

  // GET /api/v1/roles/:id/permissions — fetch entity permissions for a role
  routes.get("/api/v1/roles/:id/permissions", async (c) => {
    const id = c.req.param("id");
    const user = c.var.user;

    const role = await roleRepository.findById(user.tenantId, id);
    if (!role) {
      throw new NotFoundError(`Role ${id} not found.`);
    }

    const allPerms = await entityPermissionRepository.findByTenantAndEntity(
      user.tenantId,
      "*",
    );

    // Filter to permissions that belong to this role name
    const rolePerms = allPerms.filter((p) => p.role === role.name);

    const entityPermissions = rolePerms.map((p) => ({
      entityType: p.entity_type,
      actions: p.actions,
      fieldRestrictions: {
        denyRead: (p.field_restrictions["deny_read"] as string[] | undefined) ?? [],
        denyWrite: (p.field_restrictions["deny_write"] as string[] | undefined) ?? [],
      },
      rowFilter: p.row_filter as Record<string, string>,
    }));

    return c.json({
      roleId: id,
      entityPermissions,
    });
  });

  // PUT /api/v1/roles/:id/permissions — full-replace entity permissions for a role
  routes.put("/api/v1/roles/:id/permissions", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(ROLE_MANAGE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("users:manage scope is required to set role permissions.");
    }

    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = updateRolePermissionsRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid permissions request", parsed.error.issues);
    }

    const role = await roleRepository.findById(user.tenantId, id);
    if (!role) {
      throw new NotFoundError(`Role ${id} not found.`);
    }
    if (role.is_predefined) {
      throw new PredefinedRoleImmutableError(
        `Role "${role.name}" is a predefined role and its permissions cannot be changed.`,
      );
    }

    // Persist the permission strings on the role record itself (the permissions
    // column stores the flat list of action strings used for scope derivation).
    // Entity-level permissions (entity_permissions table) are written separately
    // by the RBAC service — this route stores the declarative permissions list.
    const permissionStrings = parsed.data.entityPermissions.flatMap(
      (ep) => ep.actions.map((a) => `${ep.entityType}:${a}`),
    );

    await roleRepository.update(id, { permissions: permissionStrings });

    return c.json({
      roleId: id,
      entityPermissions: parsed.data.entityPermissions,
    });
  });

  return routes;
}
