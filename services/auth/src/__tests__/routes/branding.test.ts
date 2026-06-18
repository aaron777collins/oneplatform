/**
 * Route-level tests for tenant branding endpoints.
 *
 * Tests cover:
 *   - Authorization (admin scope required for all three methods)
 *   - GET /api/v1/tenants/:id/branding — reads resolved config
 *   - PATCH /api/v1/tenants/:id/branding — partial update
 *   - DELETE /api/v1/tenants/:id/branding — reset to defaults
 *   - 404 when tenant does not exist
 *   - 422 when request body fails Zod validation
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables, UserContext } from "@oneplatform/core";
import { errorHandlerMiddleware } from "@oneplatform/core";
import type { TenantRepository } from "../../repositories/index.js";
import type { BrandingService, ResolvedBranding } from "../../services/branding-service.js";
import { createBrandingRoutes } from "../../routes/branding.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLATFORM_ADMIN: UserContext = {
  userId: "user-admin",
  tenantId: "tenant-1",
  roles: ["platform-admin"],
  scopes: ["admin"],
  isGuest: false,
  isService: false,
  emailVerified: true,
};

const REGULAR_USER: UserContext = {
  userId: "user-regular",
  tenantId: "tenant-1",
  roles: ["viewer"],
  scopes: ["data:read"],
  isGuest: false,
  isService: false,
  emailVerified: true,
};

const DEFAULT_BRANDING: ResolvedBranding = {
  logoUrl: null,
  faviconUrl: null,
  primaryColor: "#3b82f6",
  accentColor: "#8b5cf6",
  appName: "OnePlatform",
  supportEmail: null,
  customCss: null,
};

const CUSTOM_BRANDING: ResolvedBranding = {
  logoUrl: "https://cdn.acme.com/logo.svg",
  faviconUrl: null,
  primaryColor: "#ff0000",
  accentColor: "#00ff00",
  appName: "AcmeDash",
  supportEmail: "help@acme.com",
  customCss: "body { font-family: 'Inter', sans-serif; }",
};

function makeTenantRow() {
  return {
    id: "tenant-1",
    name: "Acme Corp",
    slug: "acme-corp",
    settings: {},
    branding: {},
    created_at: new Date("2024-01-01T00:00:00Z"),
    updated_at: new Date("2024-01-01T00:00:00Z"),
    deleted_at: null,
    ip_allowlist: [],
  };
}

function makeTenantRepository(
  overrides: Partial<TenantRepository> = {}
): TenantRepository {
  return {
    findById: vi.fn().mockResolvedValue(makeTenantRow()),
    findBySlug: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    list: vi.fn().mockResolvedValue({ tenants: [], total: 0 }),
    update: vi.fn().mockResolvedValue(makeTenantRow()),
    delete: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as TenantRepository;
}

function makeBrandingService(overrides: Partial<BrandingService> = {}): BrandingService {
  return {
    getBranding: vi.fn().mockResolvedValue(DEFAULT_BRANDING),
    updateBranding: vi.fn().mockResolvedValue(CUSTOM_BRANDING),
    resetBranding: vi.fn().mockResolvedValue(DEFAULT_BRANDING),
    ...overrides,
  };
}

function buildApp(
  tenantRepository: TenantRepository,
  brandingService: BrandingService,
  user: UserContext = PLATFORM_ADMIN
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandlerMiddleware());
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createBrandingRoutes({ tenantRepository, brandingService }));
  return app;
}

// ---------------------------------------------------------------------------
// GET /api/v1/tenants/:id/branding
// ---------------------------------------------------------------------------

describe("GET /api/v1/tenants/:id/branding", () => {
  it("returns 200 with resolved branding for platform-admin", async () => {
    const repo = makeTenantRepository();
    const svc = makeBrandingService();
    const app = buildApp(repo, svc);

    const res = await app.request("/api/v1/tenants/tenant-1/branding");
    expect(res.status).toBe(200);

    const body = await res.json() as ResolvedBranding;
    expect(body.primaryColor).toBe("#3b82f6");
    expect(body.appName).toBe("OnePlatform");
    expect(svc.getBranding).toHaveBeenCalledWith("tenant-1");
  });

  it("returns 403 for non-admin user", async () => {
    const app = buildApp(makeTenantRepository(), makeBrandingService(), REGULAR_USER);
    const res = await app.request("/api/v1/tenants/tenant-1/branding");
    expect(res.status).toBe(403);
  });

  it("returns 404 when tenant does not exist", async () => {
    const repo = makeTenantRepository({
      findById: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(repo, makeBrandingService());

    const res = await app.request("/api/v1/tenants/missing-id/branding");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/tenants/:id/branding
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/tenants/:id/branding", () => {
  it("returns 200 with updated branding on valid request", async () => {
    const repo = makeTenantRepository();
    const svc = makeBrandingService();
    const app = buildApp(repo, svc);

    const payload = { primaryColor: "#ff0000", appName: "AcmeDash" };
    const res = await app.request("/api/v1/tenants/tenant-1/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as ResolvedBranding;
    expect(body.primaryColor).toBe("#ff0000");
    expect(svc.updateBranding).toHaveBeenCalledWith("tenant-1", payload);
  });

  it("returns 422 when primaryColor is not a hex string", async () => {
    const app = buildApp(makeTenantRepository(), makeBrandingService());

    const res = await app.request("/api/v1/tenants/tenant-1/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ primaryColor: "red" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when logoUrl is not an absolute URL", async () => {
    const app = buildApp(makeTenantRepository(), makeBrandingService());

    const res = await app.request("/api/v1/tenants/tenant-1/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logoUrl: "/relative/path.png" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when supportEmail is malformed", async () => {
    const app = buildApp(makeTenantRepository(), makeBrandingService());

    const res = await app.request("/api/v1/tenants/tenant-1/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supportEmail: "not-an-email" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 404 when tenant does not exist", async () => {
    const repo = makeTenantRepository({
      findById: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(repo, makeBrandingService());

    const res = await app.request("/api/v1/tenants/missing-id/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appName: "Test" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin user", async () => {
    const app = buildApp(makeTenantRepository(), makeBrandingService(), REGULAR_USER);

    const res = await app.request("/api/v1/tenants/tenant-1/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appName: "Test" }),
    });
    expect(res.status).toBe(403);
  });

  it("accepts an empty object (no-op update)", async () => {
    const repo = makeTenantRepository();
    const svc = makeBrandingService();
    const app = buildApp(repo, svc);

    const res = await app.request("/api/v1/tenants/tenant-1/branding", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(svc.updateBranding).toHaveBeenCalledWith("tenant-1", {});
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/tenants/:id/branding
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/tenants/:id/branding", () => {
  it("returns 200 with default branding after reset", async () => {
    const repo = makeTenantRepository();
    const svc = makeBrandingService();
    const app = buildApp(repo, svc);

    const res = await app.request("/api/v1/tenants/tenant-1/branding", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = await res.json() as ResolvedBranding;
    expect(body.primaryColor).toBe("#3b82f6");
    expect(body.appName).toBe("OnePlatform");
    expect(svc.resetBranding).toHaveBeenCalledWith("tenant-1");
  });

  it("returns 404 when tenant does not exist", async () => {
    const repo = makeTenantRepository({
      findById: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(repo, makeBrandingService());

    const res = await app.request("/api/v1/tenants/missing-id/branding", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin user", async () => {
    const app = buildApp(makeTenantRepository(), makeBrandingService(), REGULAR_USER);

    const res = await app.request("/api/v1/tenants/tenant-1/branding", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
