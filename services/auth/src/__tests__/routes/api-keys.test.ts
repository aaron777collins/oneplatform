// Route-level tests for API key management routes.
// All routes require an authenticated user (c.var.user).

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables, UserContext } from "@oneplatform/core";
import { errorHandlerMiddleware, NotFoundError, ForbiddenError } from "@oneplatform/core";
import type { ApiKeyService } from "../../services/index.js";
import { createApiKeyRoutes } from "../../routes/api-keys.js";

const MOCK_USER: UserContext = {
  userId: "user-1",
  tenantId: "tenant-1",
  roles: ["developer"],
  scopes: ["data:read"],
  isGuest: false,
  isService: false,
  emailVerified: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(
  apiKeyService: ApiKeyService,
  user = MOCK_USER,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandlerMiddleware());
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  const routes = createApiKeyRoutes({ apiKeyService });
  app.route("/", routes);
  return app;
}

function makeKeyRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-id-1",
    userId: "user-1",
    tenantId: "tenant-1",
    name: "My Key",
    keyPrefix: "abcdefgh",
    scopes: ["data:read"],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    revokedAt: null,
    ...overrides,
  };
}

function makeApiKeyService(overrides: Partial<ApiKeyService> = {}): ApiKeyService {
  return {
    create: vi.fn().mockResolvedValue({
      apiKey: "op_live_" + "A".repeat(43),
      keyRecord: makeKeyRecord(),
    }),
    validate: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue(undefined),
    rotate: vi.fn().mockResolvedValue({
      apiKey: "op_live_" + "B".repeat(43),
      keyRecord: makeKeyRecord({ id: "new-key-id" }),
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/api-keys
// ---------------------------------------------------------------------------

describe("POST /api/v1/api-keys", () => {
  const validBody = { name: "Test Key", scopes: ["data:read"] };

  it("returns 201 with key details including the full key value", async () => {
    const app = buildApp(makeApiKeyService());
    const res = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(String(body["key"])).toMatch(/^op_live_/);
    expect(body["keyPrefix"]).toBeDefined();
    expect(body["scopes"]).toEqual(["data:read"]);
  });

  it("returns 422 when name is missing", async () => {
    const app = buildApp(makeApiKeyService());
    const res = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopes: ["data:read"] }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when scopes array is empty", async () => {
    const app = buildApp(makeApiKeyService());
    const res = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Key", scopes: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when scope value is not in the allowed enum", async () => {
    const app = buildApp(makeApiKeyService());
    const res = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Key", scopes: ["not:a:valid:scope"] }),
    });
    expect(res.status).toBe(422);
  });

  it("uses authenticated user id and tenantId — not from request body", async () => {
    const createSpy = vi.fn().mockResolvedValue({
      apiKey: "op_live_X",
      keyRecord: makeKeyRecord(),
    });
    const app = buildApp(makeApiKeyService({ create: createSpy }), MOCK_USER);
    await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(createSpy).toHaveBeenCalledWith("user-1", "tenant-1", expect.any(Object));
  });

  it("accepts an optional expiresAt ISO datetime", async () => {
    const app = buildApp(makeApiKeyService());
    const res = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Expiring Key", scopes: ["data:read"], expiresAt: "2025-12-31T23:59:59.000Z" }),
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/api-keys
// ---------------------------------------------------------------------------

describe("GET /api/v1/api-keys", () => {
  it("returns 200 with paginated key list", async () => {
    const listSpy = vi.fn().mockResolvedValue([
      makeKeyRecord({ id: "k1", name: "Key 1" }),
      makeKeyRecord({ id: "k2", name: "Key 2" }),
    ]);
    const app = buildApp(makeApiKeyService({ list: listSpy }));
    const res = await app.request("/api/v1/api-keys");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; pagination: Record<string, unknown> };
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toBeDefined();
    expect(body.pagination["total"]).toBe(2);
  });

  it("returns 200 with empty data array when user has no keys", async () => {
    const app = buildApp(makeApiKeyService({ list: vi.fn().mockResolvedValue([]) }));
    const res = await app.request("/api/v1/api-keys");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });

  it("queries with the authenticated user's userId", async () => {
    const listSpy = vi.fn().mockResolvedValue([]);
    const app = buildApp(makeApiKeyService({ list: listSpy }), MOCK_USER);
    await app.request("/api/v1/api-keys");
    expect(listSpy).toHaveBeenCalledWith("user-1");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/api-keys/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/api-keys/:id", () => {
  it("returns 204 on successful revocation", async () => {
    const app = buildApp(makeApiKeyService());
    const res = await app.request("/api/v1/api-keys/key-id-1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("returns 404 when service throws NotFoundError", async () => {
    const svc = makeApiKeyService({
      revoke: vi.fn().mockRejectedValue(new NotFoundError("Key not found.")),
    });
    const app = buildApp(svc);
    const res = await app.request("/api/v1/api-keys/nonexistent-id", { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("passes the authenticated user id as revokedBy", async () => {
    const revokeSpy = vi.fn().mockResolvedValue(undefined);
    const app = buildApp(makeApiKeyService({ revoke: revokeSpy }), MOCK_USER);
    await app.request("/api/v1/api-keys/key-id-1", { method: "DELETE" });
    expect(revokeSpy).toHaveBeenCalledWith("key-id-1", "user-1");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/api-keys/:id/rotate
// ---------------------------------------------------------------------------

describe("POST /api/v1/api-keys/:id/rotate", () => {
  it("returns 200 with the new key details", async () => {
    const app = buildApp(makeApiKeyService());
    const res = await app.request("/api/v1/api-keys/key-id-1/rotate", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(String(body["key"])).toMatch(/^op_live_/);
    expect(body["id"]).toBe("new-key-id");
    expect(body["scopes"]).toBeDefined();
  });

  it("returns 404 when service throws NotFoundError", async () => {
    const svc = makeApiKeyService({
      rotate: vi.fn().mockRejectedValue(new NotFoundError("Key not found.")),
    });
    const app = buildApp(svc);
    const res = await app.request("/api/v1/api-keys/nonexistent/rotate", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 403 when service throws ForbiddenError", async () => {
    const svc = makeApiKeyService({
      rotate: vi.fn().mockRejectedValue(new ForbiddenError("Not your key.")),
    });
    const app = buildApp(svc);
    const res = await app.request("/api/v1/api-keys/other-users-key/rotate", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("passes the authenticated user id to service.rotate", async () => {
    const rotateSpy = vi.fn().mockResolvedValue({
      apiKey: "op_live_X",
      keyRecord: makeKeyRecord({ id: "new-key-id" }),
    });
    const app = buildApp(makeApiKeyService({ rotate: rotateSpy }), MOCK_USER);
    await app.request("/api/v1/api-keys/key-id-1/rotate", { method: "POST" });
    expect(rotateSpy).toHaveBeenCalledWith("key-id-1", "user-1");
  });
});
