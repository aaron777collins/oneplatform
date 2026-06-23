// packages/core/src/__tests__/app.test.ts
import { describe, it, expect, vi, beforeAll } from "vitest";
import { SignJWT } from "jose";
import type { UserContext } from "../types.js";

const JWT_SECRET = "test-jwt-secret-must-be-32chars!!";
const secretBytes = new TextEncoder().encode(JWT_SECRET);

async function issueToken(sub: string, tid: string, roles: string[], scopes: string[]) {
  return new SignJWT({ sub, tid, roles, scopes })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("oneplatform")
    .setAudience("oneplatform")
    .setIssuedAt()
    .setExpirationTime("15m")
    .setJti("test-jti-" + Math.random())
    .sign(secretBytes);
}

// Mock Redis — no revoked tokens
const mockRedis = { exists: vi.fn().mockResolvedValue(0) };
const mockValidateApiKey = vi.fn().mockResolvedValue(null);

async function buildTestApp() {
  const { createApp } = await import("../app.js");
  const app = createApp({
    serviceName: "test-service",
    version: "0.1.0",
    jwtSecret: JWT_SECRET,
    // @ts-expect-error mock
    redis: mockRedis,
    validateApiKey: mockValidateApiKey,
    allowedOrigins: ["https://app.example.com"],
    publicRoutes: ["/healthz", "/readyz"],
    servicePublicKeys: {},
    targetService: "test-service",
  });

  // Register a test route
  app.get("/api/v1/items", (c) => c.json([{ id: "1", name: "Widget" }]));
  app.delete("/api/v1/items/1", (c) => new Response(null, { status: 204 }));

  return app;
}

describe("createApp() integration", () => {
  it("applies requestId middleware (X-Request-ID response header)", async () => {
    const app = await buildTestApp();
    const token = await issueToken("u1", "t1", ["viewer"], ["data:read"]);
    const res = await app.request("/api/v1/items", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://app.example.com" },
    });
    expect(res.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("applies CORS middleware (Access-Control-Allow-Origin header)", async () => {
    const app = await buildTestApp();
    const token = await issueToken("u1", "t1", ["viewer"], ["data:read"]);
    const res = await app.request("/api/v1/items", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://app.example.com" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  it("applies auth middleware (401 when no token on protected route)", async () => {
    const app = await buildTestApp();
    const res = await app.request("/api/v1/items", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("applies response envelope (valid response wrapped in { data: T })", async () => {
    const app = await buildTestApp();
    const token = await issueToken("u1", "t1", ["viewer"], ["data:read"]);
    const res = await app.request("/api/v1/items", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("applies error handler (thrown error becomes { error: {...} } envelope)", async () => {
    const { createApp } = await import("../app.js");
    const { NotFoundError } = await import("../errors.js");
    const app = createApp({
      serviceName: "test-service",
      version: "0.1.0",
      jwtSecret: JWT_SECRET,
      // @ts-expect-error mock
      redis: mockRedis,
      validateApiKey: mockValidateApiKey,
      allowedOrigins: ["https://app.example.com"],
      publicRoutes: ["/healthz", "/crash"],
      servicePublicKeys: {},
      targetService: "test-service",
    });
    app.get("/crash", () => { throw new NotFoundError("Widget not found."); });
    const res = await app.request("/crash");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("handles preflight OPTIONS from an allowed origin (204)", async () => {
    const app = await buildTestApp();
    const res = await app.request("/api/v1/items", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
  });

  it("skips auth on public routes (/healthz)", async () => {
    const { createApp } = await import("../app.js");
    const { healthz } = await import("../health.js");
    const app = createApp({
      serviceName: "test-service",
      version: "0.1.0",
      jwtSecret: JWT_SECRET,
      // @ts-expect-error mock
      redis: mockRedis,
      validateApiKey: mockValidateApiKey,
      allowedOrigins: [],
      publicRoutes: ["/healthz"],
      servicePublicKeys: {},
      targetService: "test-service",
    });
    app.get("/healthz", healthz({ service: "test-service", version: "0.1.0" }));
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Health endpoints are NOT wrapped in { data: T } — Docker probes parse them directly
    expect(body.status).toBe("ok");
  });

  it("passes 204 No Content through without wrapping", async () => {
    const app = await buildTestApp();
    const token = await issueToken("u1", "t1", ["viewer"], ["data:read"]);
    const res = await app.request("/api/v1/items/1", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
  });
});
