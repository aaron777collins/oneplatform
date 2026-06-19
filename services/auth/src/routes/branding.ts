/**
 * Tenant branding route handlers.
 *
 * Branding is a per-tenant sub-resource of /api/v1/tenants/:id. All three
 * endpoints require the "admin" scope — the same guard used by the tenant
 * management routes — because modifying branding affects the platform UI for
 * every user in that tenant.
 *
 * Routes:
 *   GET    /api/v1/tenants/:id/branding — read current (resolved) branding
 *   PATCH  /api/v1/tenants/:id/branding — partial update
 *   DELETE /api/v1/tenants/:id/branding — reset to platform defaults
 */

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from "@oneplatform/core";
import type { TenantRepository } from "../repositories/index.js";
import type { BrandingService } from "../services/branding-service.js";
import { updateBrandingRequest } from "../schemas/index.js";

export interface BrandingRouteDeps {
  tenantRepository: TenantRepository;
  brandingService: BrandingService;
}

const PLATFORM_ADMIN_SCOPE = "admin";

/**
 * V6-100: Allow both platform-admin and tenant-admin users to manage branding.
 * Tenant-admin users can only access branding for their own tenant (enforced
 * by the callerTenantId check). Platform-admin users can access any tenant.
 */
function requireBrandingAccess(
  scopes: string[],
  callerTenantId: string,
  targetTenantId: string,
): void {
  // Platform-admin can manage branding for any tenant.
  if (scopes.includes(PLATFORM_ADMIN_SCOPE)) return;

  // Tenant-admin can manage branding for their own tenant only.
  if (scopes.includes("users:manage") && callerTenantId === targetTenantId) return;

  throw new ForbiddenError(
    "admin scope or tenant-admin role for this tenant is required for branding management operations."
  );
}

export function createBrandingRoutes(
  deps: BrandingRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { tenantRepository, brandingService } = deps;

  // GET /api/v1/tenants/:id/branding
  // Returns the resolved branding config (defaults filled in for unset fields).
  routes.get("/api/v1/tenants/:id/branding", async (c) => {
    const id = c.req.param("id");
    requireBrandingAccess(c.var.user.scopes, c.var.user.tenantId, id);

    // Verify the tenant exists before proxying to the service — gives a clear
    // 404 rather than silently returning defaults for a non-existent tenant.
    const tenant = await tenantRepository.findById(id);
    if (!tenant) {
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    const branding = await brandingService.getBranding(id);
    return c.json(branding);
  });

  // PATCH /api/v1/tenants/:id/branding
  // Partial update — only the fields present in the body are changed.
  routes.patch("/api/v1/tenants/:id/branding", async (c) => {
    const id = c.req.param("id");
    requireBrandingAccess(c.var.user.scopes, c.var.user.tenantId, id);
    const body = await c.req.json();
    const parsed = updateBrandingRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid branding update request", parsed.error.issues);
    }

    // Existence check before write so the caller gets a 404 rather than a
    // silent no-op when the tenant has already been deleted.
    const tenant = await tenantRepository.findById(id);
    if (!tenant) {
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    // Build the branding payload without undefined values.
    // exactOptionalPropertyTypes requires we never pass `undefined` for an
    // optional property — we must omit the key entirely when not provided.
    const d = parsed.data;
    const payload: import("../services/branding-service.js").TenantBranding = {
      ...(d.logoUrl !== undefined ? { logoUrl: d.logoUrl } : {}),
      ...(d.faviconUrl !== undefined ? { faviconUrl: d.faviconUrl } : {}),
      ...(d.primaryColor !== undefined ? { primaryColor: d.primaryColor } : {}),
      ...(d.accentColor !== undefined ? { accentColor: d.accentColor } : {}),
      ...(d.appName !== undefined ? { appName: d.appName } : {}),
      ...(d.supportEmail !== undefined ? { supportEmail: d.supportEmail } : {}),
      ...(d.customCss !== undefined ? { customCss: d.customCss } : {}),
    };
    const branding = await brandingService.updateBranding(id, payload);
    return c.json(branding);
  });

  // DELETE /api/v1/tenants/:id/branding
  // Removes all custom branding — UI reverts to platform defaults.
  routes.delete("/api/v1/tenants/:id/branding", async (c) => {
    const id = c.req.param("id");
    requireBrandingAccess(c.var.user.scopes, c.var.user.tenantId, id);

    const tenant = await tenantRepository.findById(id);
    if (!tenant) {
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    const branding = await brandingService.resetBranding(id);
    return c.json(branding);
  });

  return routes;
}
