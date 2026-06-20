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
import type { Redis } from "ioredis";
import type pg from "pg";
import type { UserRepository, RoleRepository } from "../repositories/index.js";
import type { PasswordService } from "../services/password-service.js";
import { createUserRequest, updateUserRequest } from "../schemas/index.js";

export interface UserRouteDeps {
  userRepository: UserRepository;
  // V6-103: Required for validating that requested roles exist in tenant.
  roleRepository: RoleRepository;
  // V6-099: Required for hashing temporaryPassword during admin user creation.
  passwordService: PasswordService;
  // Required for session revocation when a user is deactivated.
  // Active access tokens must be blocklisted and refresh tokens deleted so
  // a deactivated user cannot continue operating with already-issued tokens.
  db: pg.Pool;
  redis: Redis;
}

export function createUserRoutes(deps: UserRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { userRepository, roleRepository, passwordService, db, redis } = deps;

  // POST /api/v1/users — admin-create a new user in the caller's tenant
  // Requires users:manage scope. The created user has no password and must
  // complete onboarding (password reset or OAuth link) before they can log in.
  routes.post("/api/v1/users", async (c) => {
    const user = c.var.user;
    const canManage = user.scopes.includes("users:manage") || user.scopes.includes("admin");
    if (!canManage) {
      throw new ForbiddenError("users:manage scope is required to create users.");
    }

    const body = await c.req.json();
    const parsed = createUserRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid create-user request", parsed.error.issues);
    }

    // Privilege escalation guard: only platform-admin can assign platform-admin.
    const requestedRoles = parsed.data.roles as string[];
    if (requestedRoles.includes("platform-admin") && !user.scopes.includes("admin")) {
      throw new ForbiddenError(
        "Only platform-admin users can assign the platform-admin role."
      );
    }

    // V6-103: Validate that all requested roles exist in the tenant (or as
    // predefined platform roles) before creating the user. This prevents silent
    // assignment of nonexistent roles that would grant no permissions.
    const tenantRoles = await roleRepository.findByTenantId(user.tenantId);
    const knownRoleNames = new Set(tenantRoles.map((r) => r.name));
    const unknownRoles = requestedRoles.filter((r) => !knownRoleNames.has(r));
    if (unknownRoles.length > 0) {
      throw new ValidationError(
        `The following roles do not exist in this tenant: ${unknownRoles.join(", ")}`
      );
    }

    // Prevent duplicate emails within the tenant.
    const existing = await userRepository.findByEmail(user.tenantId, parsed.data.email);
    if (existing) {
      throw new ValidationError("A user with this email already exists in the tenant.");
    }

    // V6-099: If a temporaryPassword is provided, hash it and include in the
    // create call so the user can log in immediately. If omitted, the user has
    // no password and must complete onboarding via password reset or OAuth link.
    let passwordHash: string | undefined;
    if (parsed.data.temporaryPassword !== undefined) {
      passwordHash = await passwordService.hash(parsed.data.temporaryPassword);
    }

    const created = await userRepository.create({
      tenant_id: user.tenantId,
      email: parsed.data.email,
      display_name: parsed.data.displayName ?? "",
      roles: parsed.data.roles,
      email_verified: false,
      ...(passwordHash !== undefined ? { password_hash: passwordHash } : {}),
    });

    return c.json({
      id: created.id,
      email: created.email,
      displayName: created.display_name,
      roles: created.roles,
      emailVerified: created.email_verified,
      isActive: created.is_active,
      lastLoginAt: null,
      createdAt: created.created_at.toISOString(),
    }, 201);
  });

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

    // Optional search/filter query parameters
    const emailFilter = c.req.query("email");
    const roleFilter = c.req.query("role");
    const isActiveParam = c.req.query("isActive");
    const isActiveFilter = isActiveParam !== undefined
      ? isActiveParam === "true"
      : undefined;

    const filters = {
      ...(emailFilter !== undefined && { email: emailFilter }),
      ...(roleFilter !== undefined && { role: roleFilter }),
      ...(isActiveFilter !== undefined && { isActive: isActiveFilter }),
    };

    const [{ users, nextCursor }, total] = await Promise.all([
      userRepository.listByTenant(user.tenantId, cursor, limit, filters),
      userRepository.countByTenant(user.tenantId, filters),
    ]);

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
      pagination: { nextCursor, total },
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

    // Privilege escalation guard: only platform-admin can assign platform-admin.
    // No user may grant a role that exceeds their own privilege level, preventing
    // a tenant-admin from self-escalating or elevating others to platform-admin.
    if (parsed.data.roles !== undefined) {
      const requestingUserIsAdmin = user.scopes.includes("admin");
      const requestedRoles = parsed.data.roles as string[];
      if (requestedRoles.includes("platform-admin") && !requestingUserIsAdmin) {
        throw new ForbiddenError(
          "Only platform-admin users can assign the platform-admin role."
        );
      }
    }

    // Verify the user belongs to this tenant (prevents cross-tenant updates).
    const existing = await userRepository.findById(id);
    if (!existing || existing.tenant_id !== user.tenantId) {
      throw new NotFoundError(`User ${id} not found.`);
    }

    // V6-103: Validate that all requested roles exist in the tenant before
    // updating — matches the same check on the POST /api/v1/users route.
    if (parsed.data.roles !== undefined) {
      const requestedRoles = parsed.data.roles as string[];
      const tenantRoles = await roleRepository.findByTenantId(user.tenantId);
      const knownRoleNames = new Set(tenantRoles.map((r) => r.name));
      const unknownRoles = requestedRoles.filter((r) => !knownRoleNames.has(r));
      if (unknownRoles.length > 0) {
        throw new ValidationError(
          `The following roles do not exist in this tenant: ${unknownRoles.join(", ")}`
        );
      }
    }

    // Only call update() when there are catalog fields to change — the method
    // throws if the update set is empty (which happens when only isActive is
    // provided). isActive is handled below via dedicated activate/deactivate
    // methods, so we can safely skip the update() call in that case.
    const hasFieldUpdates =
      parsed.data.displayName !== undefined || parsed.data.roles !== undefined;

    let updated = hasFieldUpdates
      ? await userRepository.update(id, {
          ...(parsed.data.displayName !== undefined ? { display_name: parsed.data.displayName } : {}),
          ...(parsed.data.roles !== undefined ? { roles: parsed.data.roles } : {}),
        })
      : existing;

    // isActive changes go through separate activate/deactivate paths in the
    // repository since they are distinct column updates with side effects.
    if (parsed.data.isActive === true) {
      await userRepository.activate(id);
    } else if (parsed.data.isActive === false) {
      // V6-039: Guard — prevent a user from deactivating themselves if they are
      // the last active tenant-admin (or platform-admin). Losing the last admin
      // would lock the tenant out of user management permanently.
      if (isSelf) {
        const adminRoles = ["platform-admin", "tenant-admin"];
        const userAdminRoles = existing.roles.filter((r: string) => adminRoles.includes(r));
        if (userAdminRoles.length > 0) {
          // Check if there is at least one OTHER active user with an admin role
          const otherAdminsResult = await db.query<{ count: string }>(
            `SELECT count(*) AS count FROM auth.users
             WHERE tenant_id = $1
               AND is_active = true
               AND id != $2
               AND (
                 'platform-admin' = ANY(roles)
                 OR 'tenant-admin' = ANY(roles)
               )`,
            [user.tenantId, id],
          );
          const otherAdminCount = parseInt(otherAdminsResult.rows[0]?.count ?? "0", 10);
          if (otherAdminCount === 0) {
            throw new ForbiddenError(
              "Cannot deactivate yourself — you are the last active admin for this tenant."
            );
          }
        }
      }

      // Guard: prevent deactivating the last platform admin. If the target user
      // holds the platform-admin role, verify at least one other active admin
      // exists before proceeding.
      if (existing.roles.includes("platform-admin")) {
        const otherAdminsResult = await db.query<{ count: string }>(
          `SELECT count(*) AS count FROM auth.users
           WHERE tenant_id = $1
             AND 'platform-admin' = ANY(roles)
             AND is_active = true
             AND id != $2`,
          [user.tenantId, id],
        );
        const otherAdminCount = parseInt(otherAdminsResult.rows[0]?.count ?? "0", 10);
        if (otherAdminCount === 0) {
          throw new ForbiddenError("Cannot deactivate the last platform admin.");
        }
      }

      await userRepository.deactivate(id);

      // Revoke all active sessions immediately so the deactivated user cannot
      // continue using previously-issued tokens. Access tokens are short-lived
      // (default 15 min) but still represent a window of unauthorized access.
      //
      // 1. Revoke all DB sessions — prevents refresh token rotation from succeeding.
      const activeSessionsResult = await db.query<{
        id: string;
        refresh_token_jti: string | null;
      }>(
        `UPDATE auth.sessions
         SET revoked_at = now(), revoked_reason = 'user_deactivated'
         WHERE user_id = $1 AND revoked_at IS NULL
         RETURNING id, refresh_token_jti`,
        [id]
      );

      // 2. Delete all refresh tokens from Redis tracked in the user-sessions set.
      const tokenKeys = await redis.smembers(`auth:user-sessions:${id}`);
      for (const tokenKey of tokenKeys) {
        await redis.del(`auth:refresh:${tokenKey}`);
        await redis.del(`auth:token-family:${tokenKey}`);
      }
      await redis.del(`auth:user-sessions:${id}`);

      // 3. Blocklist ALL access tokens for this user via a per-user revocation key.
      // Access token JTIs are embedded in the JWT and not stored in the sessions
      // table, so per-JTI blocklisting is not possible. Instead, the auth middleware
      // checks revocation:user:{userId} — any active access token for this user
      // will be rejected. TTL matches the max JWT lifetime so the entry self-cleans.
      const jwtExpirySeconds = parseInt(
        process.env["OP_JWT_EXPIRY_SECONDS"] ?? "900",
        10
      );
      await redis.set(
        `revocation:user:${id}`,
        "1",
        "EX",
        jwtExpirySeconds
      );
    }

    return c.json({
      id: updated.id,
      email: updated.email,
      displayName: updated.display_name,
      roles: updated.roles,
      emailVerified: updated.email_verified,
      isActive: parsed.data.isActive !== undefined ? parsed.data.isActive : updated.is_active,
      lastLoginAt: updated.last_login_at?.toISOString() ?? null,
      createdAt: updated.created_at.toISOString(),
    });
  });

  return routes;
}
