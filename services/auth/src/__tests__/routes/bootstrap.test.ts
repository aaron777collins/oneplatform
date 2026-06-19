// Route-level tests for bootstrap routes.
// Tests HTTP validation, response shapes, and error propagation.
// Services are mocked — no real DB or Redis.

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { errorHandlerMiddleware } from "@oneplatform/core";
import type { BootstrapService } from "../../services/index.js";
import { createBootstrapRoutes } from "../../routes/bootstrap.js";
import {
  BootstrapAlreadyCompletedError,
  BootstrapInvalidTokenError,
} from "../../services/errors.js";
import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Mock Redis factory
// ---------------------------------------------------------------------------

function makeMockRedis(): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function buildApp(bootstrapService: BootstrapService, redis?: Redis): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandlerMiddleware());
  const routes = createBootstrapRoutes({ bootstrapService, redis: redis ?? makeMockRedis() });
  app.route("/", routes);
  return app;
}

function makeBootstrapService(overrides: Partial<BootstrapService> = {}): BootstrapService {
  return {
    getStatus: vi.fn().mockResolvedValue({ completed: false }),
    bootstrap: vi.fn().mockResolvedValue({
      tenantId: "tenant-1",
      adminUserId: "admin-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/bootstrap/status
// ---------------------------------------------------------------------------

describe("GET /api/v1/bootstrap/status", () => {
  it("returns 200 with completed=false when bootstrap has not run", async () => {
    const app = buildApp(makeBootstrapService({ getStatus: vi.fn().mockResolvedValue({ completed: false }) }));
    const res = await app.request("/api/v1/bootstrap/status");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["completed"]).toBe(false);
  });

  it("returns 200 with completed=true when bootstrap has run", async () => {
    const app = buildApp(makeBootstrapService({ getStatus: vi.fn().mockResolvedValue({ completed: true }) }));
    const res = await app.request("/api/v1/bootstrap/status");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["completed"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/bootstrap
// ---------------------------------------------------------------------------

describe("POST /api/v1/bootstrap", () => {
  const validBody = {
    adminEmail: "admin@example.com",
    adminPassword: "SuperSecure123!",
    tenantName: "Acme Corp",
    bootstrapToken: "a".repeat(64),
  };

  it("returns 201 with tenant and token data on successful bootstrap", async () => {
    const app = buildApp(makeBootstrapService());
    const res = await app.request("/api/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body["tenantId"]).toBe("tenant-1");
    expect(body["accessToken"]).toBe("access-token");
  });

  it("returns 422 when adminEmail is missing", async () => {
    const app = buildApp(makeBootstrapService());
    const { adminEmail: _drop, ...bodyWithoutEmail } = validBody;
    const res = await app.request("/api/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyWithoutEmail),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when adminPassword is too short (< 12 chars)", async () => {
    const app = buildApp(makeBootstrapService());
    const res = await app.request("/api/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, adminPassword: "short" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when bootstrapToken is not exactly 64 chars", async () => {
    const app = buildApp(makeBootstrapService());
    const res = await app.request("/api/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, bootstrapToken: "tooshort" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 410 when bootstrap service throws BootstrapAlreadyCompletedError", async () => {
    const svc = makeBootstrapService({
      bootstrap: vi.fn().mockRejectedValue(
        new BootstrapAlreadyCompletedError("Already done."),
      ),
    });
    const app = buildApp(svc);
    const res = await app.request("/api/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(410);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_BOOTSTRAP_ALREADY_COMPLETED");
  });

  it("returns 401 when bootstrap service throws BootstrapInvalidTokenError", async () => {
    const svc = makeBootstrapService({
      bootstrap: vi.fn().mockRejectedValue(
        new BootstrapInvalidTokenError("Bad token."),
      ),
    });
    const app = buildApp(svc);
    const res = await app.request("/api/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_BOOTSTRAP_INVALID_TOKEN");
  });

  it("passes X-Forwarded-For IP to the service", async () => {
    const bootstrapSpy = vi.fn().mockResolvedValue({
      tenantId: "t1", adminUserId: "u1", accessToken: "at", refreshToken: "rt", expiresIn: 900,
    });
    const app = buildApp(makeBootstrapService({ bootstrap: bootstrapSpy }));
    await app.request("/api/v1/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.42",
      },
      body: JSON.stringify(validBody),
    });
    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: "203.0.113.42" }),
    );
  });
});
