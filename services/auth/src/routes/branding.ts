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

function requirePlatformAdmin(scopes: string[]): void {
  if (!scopes.includes(PLATFORM_ADMIN_SCOPE)) {
    throw new ForbiddenError(
      "admin scope is required for branding management operations."
    );
  }
}

export function createBrandingRoutes(
  deps: BrandingRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { tenantRepository, brandingService } = deps;

  // GET /api/v1/tenants/:id/branding
  // Returns the resolved branding config (defaults filled in for unset fields).
  routes.get("/api/v1/tenants/:id/branding", async (c) => {
    requirePlatformAdmin(c.var.user.scopes);

    const id = c.req.param("id");

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
    requirePlatformAdmin(c.var.user.scopes);

    const id = c.req.param("id");
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
    requirePlatformAdmin(c.var.user.scopes);

    const id = c.req.param("id");

    const tenant = await tenantRepository.findById(id);
    if (!tenant) {
      throw new NotFoundError(`Tenant ${id} not found.`);
    }

    const branding = await brandingService.resetBranding(id);
    return c.json(branding);
  });

  return routes;
}
