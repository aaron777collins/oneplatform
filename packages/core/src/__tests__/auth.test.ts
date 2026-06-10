// packages/core/src/__tests__/auth.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { authMiddleware } from "../middleware/auth.js";

const JWT_SECRET = "test-jwt-secret-must-be-32chars!!";
const secretBytes = new TextEncoder().encode(JWT_SECRET);

async function issueToken(payload: Record<string, unknown>, expiresIn = "15m") {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setJti("test-jti-" + Math.random())
    .sign(secretBytes);
}

// Minimal Redis mock: tracks revocation keys
function makeMockRedis(revokedJtis: string[] = []) {
  return {
    exists: vi.fn().mockImplementation(async (key: string) => {
      return revokedJtis.some((jti) => key.includes(jti)) ? 1 : 0;
    }),
  };
}

// Minimal API key validator mock
function makeMockApiKeyValidator(validKey: string, user: Record<string, unknown> | null) {
  return vi.fn().mockImplementation(async (key: string) => {
    if (key === validKey) return user;
    return null;
  });
}

function buildApp(opts: {
  jwtSecret: string;
  redis: ReturnType<typeof makeMockRedis>;
  validateApiKey: ReturnType<typeof makeMockApiKeyValidator>;
  publicRoutes?: string[];
}) {
  const app = new Hono<{ Variables: { user: unknown; requestId: string } }>();
  app.use("*", (c, next) => { c.set("requestId", "req-test"); return next(); });
  app.use("*", authMiddleware({
    jwtSecret: opts.jwtSecret,
    // @ts-expect-error using mock
    redis: opts.redis,
    validateApiKey: opts.validateApiKey,
    publicRoutes: opts.publicRoutes ?? [],
  }));
  app.get("/protected", (c) => c.json({ user: c.var.user }));
  app.get("/public", (c) => c.json({ ok: true }));
  return app;
}

describe("authMiddleware — JWT path", () => {
  it("authenticates a valid JWT and sets c.var.user", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const token = await issueToken({
      sub: "user-123",
      tid: "tenant-abc",
      roles: ["viewer"],
      scopes: ["data:read"],
    });
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe("user-123");
    expect(body.user.tenantId).toBe("tenant-abc");
    expect(body.user.roles).toContain("viewer");
    expect(body.user.scopes).toContain("data:read");
    expect(body.user.isService).toBe(false);
    expect(body.user.isGuest).toBe(false);
  });

  it("returns 401 UNAUTHORIZED for an expired JWT", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    // Issue a token that expired 5 minutes ago
    const token = await issueToken({ sub: "user-123", tid: "tenant-abc", roles: [], scopes: [] }, "-5m");
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for a JWT with wrong signature", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const wrongSecret = new TextEncoder().encode("wrong-secret-32-chars-padding!!");
    const token = await new SignJWT({ sub: "u", tid: "t", roles: [], scopes: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(wrongSecret);
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a revoked JWT (jti in Redis revocation blocklist)", async () => {
    const revokedJti = "revoked-jti-9999";
    const redis = makeMockRedis([revokedJti]);
    const validateApiKey = makeMockApiKeyValidator("", null);
    const token = await new SignJWT({ sub: "u", tid: "t", roles: [], scopes: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti(revokedJti)
      .sign(secretBytes);
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("downgrades unverified users to viewer role maximum", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const token = await issueToken({
      sub: "user-unverified",
      tid: "tenant-abc",
      roles: ["tenant-admin"],
      scopes: ["admin"],
      unverified: true,
    });
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Unverified user must not keep elevated roles (spec §4 Email Verification)
    expect(body.user.emailVerified).toBe(false);
    expect(body.user.roles).not.toContain("tenant-admin");
    expect(body.user.roles).toContain("viewer");
  });
});

describe("authMiddleware — API key path", () => {
  it("authenticates a valid API key and sets c.var.user", async () => {
    const redis = makeMockRedis();
    const user = { userId: "user-api", tenantId: "tenant-api", roles: ["viewer"], scopes: ["data:read"], isGuest: false, isService: false, emailVerified: true };
    const validateApiKey = makeMockApiKeyValidator("op_live_validkey123456789012345", user);
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { "X-API-Key": "op_live_validkey123456789012345" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe("user-api");
  });

  it("returns 401 for an invalid API key", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("op_live_correct", { userId: "u", tenantId: "t", roles: [], scopes: [], isGuest: false, isService: false, emailVerified: true });
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { "X-API-Key": "op_live_wrongkey" },
    });
    expect(res.status).toBe(401);
  });
});

describe("authMiddleware — public routes", () => {
  it("skips auth for a public route", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const app = buildApp({
      jwtSecret: JWT_SECRET, redis, validateApiKey,
      publicRoutes: ["/public"],
    });
    const res = await app.request("/public");
    expect(res.status).toBe(200);
  });

  it("still requires auth for non-public routes", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const app = buildApp({
      jwtSecret: JWT_SECRET, redis, validateApiKey,
      publicRoutes: ["/public"],
    });
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 when no auth header is provided for a protected route", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
