// Tenant management route handlers.
//
// All routes require the "admin" scope (platform-admin only). Tenant management
// is a cross-tenant operation — there is no tenant-admin equivalent because a
// tenant admin operates *within* a single tenant and cannot affect other tenants
// or the platform itself.
//
// Safety invariants enforced here:
//   - A tenant cannot be deleted while it has active users. The caller must
//     deactivate or transfer all users first.
//   - Slug is immutable after creation (branding/URLs depend on it).

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from "@oneplatform/core";
import type pg from "pg";
import type { TenantRepository } from "../repositories/index.js";
import { TenantHasActiveUsersError } from "../services/errors.js";
import { createTenantRequest, updateTenantRequest } from "../schemas/index.js";

export interface TenantRouteDeps {
  tenantRepository: TenantRepository;
  db: pg.Pool;
}

// Required scope for all tenant management operations.
const PLATFORM_ADMIN_SCOPE = "admin";

function requirePlatformAdmin(scopes: string[]): void {
  if (!scopes.includes(PLATFORM_ADMIN_SCOPE)) {
    throw new ForbiddenError(
      "admin scope is required for tenant management operations."
    );
  }
}

function formatTenant(t: {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    settings: t.settings,
    createdAt: t.created_at.toISOString(),
    updatedAt: t.updated_at.toISOString(),
  };
}

export function createTenantRoutes(
  deps: TenantRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { tenantRepository, db } = deps;

  // GET /api/v1/tenants — paginated list of all tenants (platform-admin only)
  //
  // Query params:
  //   limit  — number of results per page (1–100, default 20)
  //   offset — zero-based starting position (default 0)
  routes.get("/api/v1/tenants", async (c) => {
    requirePlatformAdmin(c.var.user.scopes);

    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");

    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 20;
    const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError("limit must be an integer between 1 and 100", []);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError("offset must be a non-negative integer", []);
    }

    const { tenants, total } = await tenantRepository.list({ limit, offset });

    return c.json({
      data: tenants.map(formatTenant),
      pagination: { total, limit, offset },
    });
  });

  // POST /api/v1/tenants — create a new tenant (platform-admin only)
  //
  // Body: { name: string; slug: string; settings?: Record<string, unknown> }
  //
  // Slug must be unique across all non-deleted tenants. It is immutable after
  // creation because external systems (DNS, OAuth redirect URIs) depend on it.
  routes.post("/api/v1/tenants", async (c) => {
    requirePlatformAdmin(c.var.user.scopes);

    const body = await c.req.json();
    const parsed = createTenantRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid tenant creation request", parsed.error.issues);
    }

    // Validate slug uniqueness — two tenants with the same slug would break
    // subdomain routing and OAuth redirect URI resolution.
    const existingBySlug = await tenantRepository.findBySlug(parsed.data.slug);
    if (existingBySlug) {
      throw new ValidationError(
        `Slug "${parsed.data.slug}" is already in use by another tenant.`,
        [],
      );
    }

    const tenant = await tenantRepository.create({
      name: parsed.data.name,
      slug: parsed.data.slug,
      ...(parsed.data.settings !== undefined
        ? { settings: parsed.data.settings as Record<string, unknown> }
        : {}),
    });

    return c.json(formatTenant(tenant), 201);
  });

  // GET /api/v1/tenants/:id — fetch a single tenant by ID (platform-admin only)
  routes.get("/api/v1/tenants/:id", async (c) => {
    requirePlatformAdmin(c.var.user.scopes);

    const id = c.req.param("id");
    const tenant = await tenantRepository.findById(id);
    if (!tenant) {
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    return c.json(formatTenant(tenant));
  });

  // PATCH /api/v1/tenants/:id — update name and/or settings (platform-admin only)
  //
  // Slug is intentionally excluded — it is immutable after creation because
  // external systems (DNS, OAuth redirect URIs) may depend on it.
  routes.patch("/api/v1/tenants/:id", async (c) => {
    requirePlatformAdmin(c.var.user.scopes);

    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = updateTenantRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid tenant update request", parsed.error.issues);
    }

    // Verify existence before update so we can return a clear 404.
    const existing = await tenantRepository.findById(id);
    if (!existing) {
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    // Spread only fields that were actually provided — exactOptionalPropertyTypes
    // requires we never pass `undefined` for optional properties.
    const updated = await tenantRepository.update(id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.settings !== undefined ? { settings: parsed.data.settings as Record<string, unknown> } : {}),
    });
    if (!updated) {
      // Extremely unlikely (tenant deleted between our check and the UPDATE),
      // but fail loudly rather than returning stale data.
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    return c.json(formatTenant(updated));
  });

  // DELETE /api/v1/tenants/:id — soft-delete a tenant (platform-admin only)
  //
  // Safety check: reject the request if the tenant still has active users.
  // The caller must deactivate or remove all users before deleting the tenant.
  // This prevents orphaning active user sessions and access tokens.
  routes.delete("/api/v1/tenants/:id", async (c) => {
    requirePlatformAdmin(c.var.user.scopes);

    const id = c.req.param("id");

    const existing = await tenantRepository.findById(id);
    if (!existing) {
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    // Count active users — parameterized query, no string interpolation.
    const activeUsersResult = await db.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM auth.users
        WHERE tenant_id = $1
          AND is_active = true`,
      [id]
    );
    const activeUserCount = parseInt(
      activeUsersResult.rows[0]?.count ?? "0",
      10
    );

    if (activeUserCount > 0) {
      throw new TenantHasActiveUsersError(
        `Cannot delete tenant "${existing.name}": it has ${activeUserCount} active user(s). ` +
          "Deactivate or remove all users before deleting the tenant."
      );
    }

    const deleted = await tenantRepository.delete(id);
    if (!deleted) {
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    return new Response(null, { status: 204 });
  });

  return routes;
}
