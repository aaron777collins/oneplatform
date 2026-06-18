// packages/core/src/__tests__/auth-eddsa.test.ts
//
// Tests for EdDSA JWT support in authMiddleware (G-085).
// The HS256 path is covered by auth.test.ts; this file focuses on:
//   - EdDSA token acceptance with jwtPublicKey configured
//   - Rejection when public key is absent but token is EdDSA
//   - Rejection of EdDSA token signed with wrong key
//   - Mixed-mode: HS256 token still accepted when public key is also configured

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { generateKeyPairSync } from "crypto";
import { authMiddleware } from "../middleware/auth.js";

// ---------------------------------------------------------------------------
// Test Ed25519 key pairs
// ---------------------------------------------------------------------------

const { privateKey: testPrivKey, publicKey: testPubKey } = generateKeyPairSync("ed25519");
const testPrivKeyPem = testPrivKey.export({ type: "pkcs8", format: "pem" }) as string;
const testPubKeyPem = testPubKey.export({ type: "spki", format: "pem" }) as string;
// Encode PEMs as base64 — this is the format expected by AuthMiddlewareConfig.jwtPublicKey
const testPubKeyB64 = Buffer.from(testPubKeyPem).toString("base64");

// A second key pair to test wrong-key rejection
const { privateKey: wrongPrivKey } = generateKeyPairSync("ed25519");

const JWT_SECRET = "test-jwt-secret-must-be-32chars!!";
const secretBytes = new TextEncoder().encode(JWT_SECRET);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function issueEdDsaToken(payload: Record<string, unknown>, privKey = testPrivKey) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .setJti("eddsa-jti-" + Math.random())
    .sign(privKey);
}

async function issueHs256Token(payload: Record<string, unknown>) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .setJti("hs256-jti-" + Math.random())
    .sign(secretBytes);
}

function makeMockRedis(revokedJtis: string[] = []) {
  return {
    exists: vi.fn().mockImplementation(async (key: string) => {
      return revokedJtis.some((jti) => key.includes(jti)) ? 1 : 0;
    }),
  };
}

function makeMockApiKeyValidator() {
  return vi.fn().mockResolvedValue(null);
}

function buildApp(opts: {
  jwtSecret: string;
  jwtPublicKey?: string;
  redis: ReturnType<typeof makeMockRedis>;
  validateApiKey: ReturnType<typeof makeMockApiKeyValidator>;
  publicRoutes?: string[];
}) {
  const app = new Hono<{ Variables: { user: unknown; requestId: string } }>();
  app.use("*", (c, next) => { c.set("requestId", "req-test"); return next(); });
  app.use("*", authMiddleware({
    jwtSecret: opts.jwtSecret,
    ...(opts.jwtPublicKey !== undefined ? { jwtPublicKey: opts.jwtPublicKey } : {}),
    // @ts-expect-error using mock
    redis: opts.redis,
    validateApiKey: opts.validateApiKey,
    publicRoutes: opts.publicRoutes ?? [],
  }));
  app.get("/protected", (c) => c.json({ user: c.var.user }));
  return app;
}

// ---------------------------------------------------------------------------
// EdDSA token acceptance
// ---------------------------------------------------------------------------

describe("authMiddleware — EdDSA JWT path", () => {
  it("accepts a valid EdDSA token and sets c.var.user", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator();
    const token = await issueEdDsaToken({
      sub: "eddsa-user",
      tid: "tenant-ed",
      roles: ["developer"],
      scopes: ["data:read"],
    });

    const app = buildApp({ jwtSecret: JWT_SECRET, jwtPublicKey: testPubKeyB64, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe("eddsa-user");
    expect(body.user.tenantId).toBe("tenant-ed");
    expect(body.user.roles).toContain("developer");
    expect(body.user.isService).toBe(false);
  });

  it("returns 401 when an EdDSA token is presented but no public key is configured", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator();
    const token = await issueEdDsaToken({
      sub: "u", tid: "t", roles: [], scopes: [],
    });

    // No jwtPublicKey in config
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("public key");
  });

  it("returns 401 for an EdDSA token signed with a different private key", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator();
    // Sign with the wrong private key
    const token = await issueEdDsaToken({
      sub: "u", tid: "t", roles: [], scopes: [],
    }, wrongPrivKey);

    // Verify with the correct (different) public key
    const app = buildApp({ jwtSecret: JWT_SECRET, jwtPublicKey: testPubKeyB64, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired EdDSA token", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator();
    const expiredToken = await new SignJWT({
      sub: "u", tid: "t", roles: [], scopes: [],
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt()
      .setExpirationTime("-5m") // already expired
      .setJti("expired-eddsa")
      .sign(testPrivKey);

    const app = buildApp({ jwtSecret: JWT_SECRET, jwtPublicKey: testPubKeyB64, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a revoked EdDSA token (jti in Redis blocklist)", async () => {
    const revokedJti = "revoked-eddsa-jti-abc";
    const redis = makeMockRedis([revokedJti]);
    const validateApiKey = makeMockApiKeyValidator();
    const token = await new SignJWT({ sub: "u", tid: "t", roles: [], scopes: [] })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti(revokedJti)
      .sign(testPrivKey);

    const app = buildApp({ jwtSecret: JWT_SECRET, jwtPublicKey: testPubKeyB64, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Mixed-mode: both HS256 and EdDSA configured simultaneously
// ---------------------------------------------------------------------------

describe("authMiddleware — mixed-mode (HS256 + EdDSA)", () => {
  it("accepts an HS256 token when both algorithms are configured (rolling migration)", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator();
    const hs256Token = await issueHs256Token({
      sub: "hs256-during-migration",
      tid: "t1",
      roles: ["viewer"],
      scopes: ["data:read"],
    });

    // Both secret and public key configured
    const app = buildApp({ jwtSecret: JWT_SECRET, jwtPublicKey: testPubKeyB64, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${hs256Token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe("hs256-during-migration");
  });

  it("accepts an EdDSA token when both algorithms are configured", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator();
    const eddsaToken = await issueEdDsaToken({
      sub: "eddsa-during-migration",
      tid: "t1",
      roles: ["developer"],
      scopes: ["data:read"],
    });

    const app = buildApp({ jwtSecret: JWT_SECRET, jwtPublicKey: testPubKeyB64, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${eddsaToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe("eddsa-during-migration");
  });
});

// ---------------------------------------------------------------------------
// jwtPublicKey startup validation
// ---------------------------------------------------------------------------

describe("authMiddleware — jwtPublicKey validation at construction time", () => {
  it("throws at construction time if jwtPublicKey is not valid base64-PEM", () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator();
    expect(() => {
      authMiddleware({
        jwtSecret: JWT_SECRET,
        jwtPublicKey: "this-is-not-valid-base64-pem",
        // @ts-expect-error mock
        redis,
        validateApiKey,
      });
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unverified-user downgrade still works with EdDSA tokens
// ---------------------------------------------------------------------------

describe("authMiddleware — unverified users with EdDSA tokens", () => {
  it("downgrades unverified EdDSA-token user to viewer", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator();
    const token = await issueEdDsaToken({
      sub: "unverified-eddsa",
      tid: "t1",
      roles: ["tenant-admin"],
      scopes: ["admin"],
      unverified: true,
    });

    const app = buildApp({ jwtSecret: JWT_SECRET, jwtPublicKey: testPubKeyB64, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.emailVerified).toBe(false);
    expect(body.user.roles).not.toContain("tenant-admin");
    expect(body.user.roles).toContain("viewer");
  });
});
