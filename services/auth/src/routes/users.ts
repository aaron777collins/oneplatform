// User management route handlers.
// Listing and reading users requires the users:read scope.
// Updating users (roles, isActive) requires users:manage scope.
// A user may always update their own displayName without special scope.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from "@oneplatform/core";
import type { UserRepository } from "../repositories/index.js";
import { updateUserRequest } from "../schemas/index.js";

export interface UserRouteDeps {
  userRepository: UserRepository;
}

export function createUserRoutes(deps: UserRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { userRepository } = deps;

  // GET /api/v1/users — list users in the caller's tenant
  // Requires users:read scope.
  routes.get("/api/v1/users", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes("users:read") && !user.scopes.includes("admin")) {
      throw new ForbiddenError("users:read scope is required to list users.");
    }

    const cursor = c.req.query("cursor");
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? parseInt(limitParam, 10) : undefined;

    const { users, nextCursor } = await userRepository.listByTenant(
      user.tenantId,
      cursor,
      limit,
    );

    const data = users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      roles: u.roles,
      emailVerified: u.email_verified,
      isActive: u.is_active,
      lastLoginAt: u.last_login_at?.toISOString() ?? null,
      createdAt: u.created_at.toISOString(),
    }));

    return c.json({
      data,
      pagination: { nextCursor, total: null },
    });
  });

  // GET /api/v1/users/:id — get a single user by ID
  // Requires users:read scope, OR the caller is reading their own record.
  routes.get("/api/v1/users/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.var.user;

    const isSelf = id === user.userId;
    const canRead = user.scopes.includes("users:read") || user.scopes.includes("admin");

    if (!isSelf && !canRead) {
      throw new ForbiddenError("users:read scope is required to read other users.");
    }

    const found = await userRepository.findById(id);
    if (!found || found.tenant_id !== user.tenantId) {
      // Tenant mismatch is hidden as NotFound to avoid cross-tenant user enumeration.
      throw new NotFoundError(`User ${id} not found.`);
    }

    return c.json({
      id: found.id,
      email: found.email,
      displayName: found.display_name,
      roles: found.roles,
      emailVerified: found.email_verified,
      isActive: found.is_active,
      lastLoginAt: found.last_login_at?.toISOString() ?? null,
      createdAt: found.created_at.toISOString(),
    });
  });

  // PUT /api/v1/users/:id — update a user record
  // - displayName: any authenticated user can update their own
  // - roles: requires users:manage scope
  // - isActive: requires users:manage scope
  routes.put("/api/v1/users/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.var.user;

    const body = await c.req.json();
    const parsed = updateUserRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid user update request", parsed.error.issues);
    }

    const canManage = user.scopes.includes("users:manage") || user.scopes.includes("admin");
    const isSelf = id === user.userId;

    // Prevent updating another user's display name without manage scope.
    if (!isSelf && !canManage) {
      throw new ForbiddenError("users:manage scope is required to update other users.");
    }

    // Role and activation changes require manage scope even when updating self.
    if ((parsed.data.roles !== undefined || parsed.data.isActive !== undefined) && !canManage) {
      throw new ForbiddenError("users:manage scope is required to change roles or activation status.");
    }

    // Verify the user belongs to this tenant (prevents cross-tenant updates).
    const existing = await userRepository.findById(id);
    if (!existing || existing.tenant_id !== user.tenantId) {
      throw new NotFoundError(`User ${id} not found.`);
    }

    const updated = await userRepository.update(id, {
      ...(parsed.data.displayName !== undefined ? { display_name: parsed.data.displayName } : {}),
      ...(parsed.data.roles !== undefined ? { roles: parsed.data.roles } : {}),
    });

    // isActive changes go through a separate deactivate path in the repository
    // since it's a distinct column update.
    if (parsed.data.isActive === false) {
      await userRepository.deactivate(id);
    }

    return c.json({
      id: updated.id,
      email: updated.email,
      displayName: updated.display_name,
      roles: updated.roles,
      emailVerified: updated.email_verified,
      isActive: parsed.data.isActive === false ? false : updated.is_active,
      lastLoginAt: updated.last_login_at?.toISOString() ?? null,
      createdAt: updated.created_at.toISOString(),
    });
  });

  return routes;
}
