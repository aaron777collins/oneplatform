// Route-level tests for tenant management routes.
//
// All routes require the "admin" scope (platform-admin only). Tests verify:
//   - Authorization enforcement (non-admin callers receive 403)
//   - Request validation (Zod schema enforcement)
//   - Happy-path response shapes
//   - Error propagation (NotFoundError → 404, TenantHasActiveUsersError → 409)

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables, UserContext } from "@oneplatform/core";
import { errorHandlerMiddleware } from "@oneplatform/core";
import type pg from "pg";
import type { TenantRepository } from "../../repositories/index.js";
import { createTenantRoutes } from "../../routes/tenants.js";

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

function makeTenantRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "tenant-1",
    name: "Acme Corp",
    slug: "acme-corp",
    settings: {},
    created_at: new Date("2024-01-01T00:00:00Z"),
    updated_at: new Date("2024-01-01T00:00:00Z"),
    deleted_at: null,
    ...overrides,
  };
}

function makeTenantRepository(
  overrides: Partial<TenantRepository> = {}
): TenantRepository {
  return {
    findById: vi.fn().mockResolvedValue(makeTenantRow()),
    findBySlug: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    list: vi
      .fn()
      .mockResolvedValue({ tenants: [makeTenantRow()], total: 1 }),
    update: vi.fn().mockResolvedValue(makeTenantRow()),
    delete: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as TenantRepository;
}

function makeDb(activeUserCount = 0): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({
      rows: [{ count: String(activeUserCount) }],
      rowCount: 1,
    }),
  } as unknown as pg.Pool;
}

function buildApp(
  tenantRepository: TenantRepository,
  db: pg.Pool,
  user: UserContext = PLATFORM_ADMIN
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandlerMiddleware());
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createTenantRoutes({ tenantRepository, db }));
  return app;
}

// ---------------------------------------------------------------------------
// GET /api/v1/tenants
// ---------------------------------------------------------------------------

describe("GET /api/v1/tenants", () => {
  it("returns 200 with paginated tenant list for platform-admin", async () => {
    const repo = makeTenantRepository();
    const app = buildApp(repo, makeDb());

    const res = await app.request("/api/v1/tenants");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body["data"]).toHaveLength(1);
    expect((body["data"] as unknown[])[0]).toMatchObject({
      id: "tenant-1",
      name: "Acme Corp",
      slug: "acme-corp",
    });
    expect(body["pagination"]).toMatchObject({ total: 1, limit: 20, offset: 0 });
  });

  it("passes limit and offset query params to the repository", async () => {
    const repo = makeTenantRepository();
    const app = buildApp(repo, makeDb());

    await app.request("/api/v1/tenants?limit=5&offset=10");
    expect(repo.list).toHaveBeenCalledWith({ limit: 5, offset: 10 });
  });

  it("returns 422 when limit is out of range", async () => {
    const app = buildApp(makeTenantRepository(), makeDb());
    const res = await app.request("/api/v1/tenants?limit=200");
    expect(res.status).toBe(422);
  });

  it("returns 422 when offset is negative", async () => {
    const app = buildApp(makeTenantRepository(), makeDb());
    const res = await app.request("/api/v1/tenants?offset=-1");
    expect(res.status).toBe(422);
  });

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(makeTenantRepository(), makeDb(), REGULAR_USER);
    const res = await app.request("/api/v1/tenants");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/tenants/:id
// ---------------------------------------------------------------------------

describe("GET /api/v1/tenants/:id", () => {
  it("returns 200 with tenant data for platform-admin", async () => {
    const repo = makeTenantRepository();
    const app = buildApp(repo, makeDb());

    const res = await app.request("/api/v1/tenants/tenant-1");
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "tenant-1", name: "Acme Corp" });
    // Deleted_at must not be exposed in the response
    expect(body).not.toHaveProperty("deleted_at");
  });

  it("returns 404 when tenant does not exist", async () => {
    const repo = makeTenantRepository({
      findById: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(repo, makeDb());

    const res = await app.request("/api/v1/tenants/missing-id");
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(makeTenantRepository(), makeDb(), REGULAR_USER);
    const res = await app.request("/api/v1/tenants/tenant-1");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/v1/tenants/:id
// ---------------------------------------------------------------------------

describe("PATCH /api/v1/tenants/:id", () => {
  it("returns 200 with updated tenant on valid request", async () => {
    const updatedRow = makeTenantRow({ name: "Acme Corp Renamed" });
    const repo = makeTenantRepository({
      update: vi.fn().mockResolvedValue(updatedRow),
    });
    const app = buildApp(repo, makeDb());

    const res = await app.request("/api/v1/tenants/tenant-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme Corp Renamed" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body["name"]).toBe("Acme Corp Renamed");
  });

  it("allows updating only settings without providing name", async () => {
    const repo = makeTenantRepository();
    const app = buildApp(repo, makeDb());

    const res = await app.request("/api/v1/tenants/tenant-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { maxUsers: 50 } }),
    });
    expect(res.status).toBe(200);
    expect(repo.update).toHaveBeenCalledWith("tenant-1", {
      settings: { maxUsers: 50 },
    });
  });

  it("returns 422 when body fails validation (name is empty string)", async () => {
    const app = buildApp(makeTenantRepository(), makeDb());

    const res = await app.request("/api/v1/tenants/tenant-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 404 when tenant does not exist", async () => {
    const repo = makeTenantRepository({
      findById: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(repo, makeDb());

    const res = await app.request("/api/v1/tenants/missing-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(makeTenantRepository(), makeDb(), REGULAR_USER);
    const res = await app.request("/api/v1/tenants/tenant-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/tenants/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/tenants/:id", () => {
  it("returns 204 when tenant has no active users", async () => {
    const repo = makeTenantRepository();
    // db returns 0 active users
    const app = buildApp(repo, makeDb(0));

    const res = await app.request("/api/v1/tenants/tenant-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(repo.delete).toHaveBeenCalledWith("tenant-1");
  });

  it("returns 409 when tenant has active users", async () => {
    const repo = makeTenantRepository();
    // db returns 3 active users
    const app = buildApp(repo, makeDb(3));

    const res = await app.request("/api/v1/tenants/tenant-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    // delete must NOT have been called
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("returns 404 when tenant does not exist", async () => {
    const repo = makeTenantRepository({
      findById: vi.fn().mockResolvedValue(null),
    });
    const app = buildApp(repo, makeDb(0));

    const res = await app.request("/api/v1/tenants/missing-id", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin users", async () => {
    const app = buildApp(makeTenantRepository(), makeDb(0), REGULAR_USER);
    const res = await app.request("/api/v1/tenants/tenant-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
