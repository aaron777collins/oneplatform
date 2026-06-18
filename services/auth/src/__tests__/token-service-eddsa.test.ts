// Unit tests for EdDSA (Ed25519) JWT signing/verification in token-service.ts.
//
// Tests the new asymmetric signing path added by G-085.
// The HS256 path is already covered by token-service.test.ts; this file
// focuses exclusively on EdDSA-specific behaviour and the algorithm-selection
// logic that enables backward-compatible migration.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { generateKeyPairSync } from "crypto";
import { SignJWT } from "jose";
import type { Redis } from "ioredis";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Test key pair
// ---------------------------------------------------------------------------

// Generate a fresh Ed25519 key pair for every test run so tests are
// hermetically isolated from any production keys.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const PRIVATE_KEY_B64 = Buffer.from(privateKeyPem).toString("base64");
const PUBLIC_KEY_B64 = Buffer.from(publicKeyPem).toString("base64");

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

function makeMockDb(): pg.Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
  } as unknown as pg.Pool;
}

function makeUser(overrides: Partial<{
  id: string;
  tenantId: string;
  roles: string[];
  emailVerified: boolean;
}> = {}) {
  return {
    id: "user-eddsa-1",
    tenantId: "tenant-eddsa-1",
    roles: ["viewer"],
    emailVerified: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getJwtAlgorithm
// ---------------------------------------------------------------------------

describe("getJwtAlgorithm()", () => {
  afterEach(() => {
    delete process.env["OP_JWT_ALGORITHM"];
  });

  it("returns HS256 when OP_JWT_ALGORITHM is not set (backward-compat default)", async () => {
    const { getJwtAlgorithm } = await import("../services/token-service.js");
    delete process.env["OP_JWT_ALGORITHM"];
    expect(getJwtAlgorithm()).toBe("HS256");
  });

  it("returns HS256 when OP_JWT_ALGORITHM=HS256", async () => {
    process.env["OP_JWT_ALGORITHM"] = "HS256";
    const { getJwtAlgorithm } = await import("../services/token-service.js");
    expect(getJwtAlgorithm()).toBe("HS256");
  });

  it("returns EdDSA when OP_JWT_ALGORITHM=EdDSA", async () => {
    process.env["OP_JWT_ALGORITHM"] = "EdDSA";
    const { getJwtAlgorithm } = await import("../services/token-service.js");
    expect(getJwtAlgorithm()).toBe("EdDSA");
  });

  it("throws on an unknown algorithm value", async () => {
    process.env["OP_JWT_ALGORITHM"] = "RS256";
    const { getJwtAlgorithm } = await import("../services/token-service.js");
    expect(() => getJwtAlgorithm()).toThrow("Unsupported OP_JWT_ALGORITHM");
  });
});

// ---------------------------------------------------------------------------
// issueAccessToken — EdDSA path
// ---------------------------------------------------------------------------

describe("issueAccessToken() — EdDSA", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env["OP_JWT_ALGORITHM"] = "EdDSA";
    process.env["OP_JWT_PRIVATE_KEY"] = PRIVATE_KEY_B64;
    process.env["OP_JWT_PUBLIC_KEY"] = PUBLIC_KEY_B64;
    process.env["OP_JWT_SECRET"] = "test-jwt-secret-must-be-32chars!!";
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
  });

  afterEach(() => {
    delete process.env["OP_JWT_ALGORITHM"];
    delete process.env["OP_JWT_PRIVATE_KEY"];
    delete process.env["OP_JWT_PUBLIC_KEY"];
  });

  it("issues a token with alg=EdDSA in the header", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUser());

    // Decode header without verifying to check algorithm
    const headerJson = Buffer.from(token.split(".")[0]!, "base64url").toString("utf8");
    const header = JSON.parse(headerJson) as { alg: string };
    expect(header.alg).toBe("EdDSA");
  });

  it("issued token is verifiable with the Ed25519 public key", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const redis = makeMockRedis({ get: vi.fn().mockResolvedValue(null) });
    const svc = createTokenService({ redis, db: makeMockDb() });

    const token = await svc.issueAccessToken(makeUser({ id: "u-ed", tenantId: "t-ed" }));
    const claims = await svc.verifyAccessToken(token);

    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("u-ed");
    expect(claims!.tid).toBe("t-ed");
  });

  it("returns null for an EdDSA token signed with a different private key", async () => {
    // Generate a different key pair
    const { privateKey: differentPrivateKey } = generateKeyPairSync("ed25519");
    const differentPrivatePem = differentPrivateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const differentPrivateB64 = Buffer.from(differentPrivatePem).toString("base64");

    // Issue with a different private key
    process.env["OP_JWT_PRIVATE_KEY"] = differentPrivateB64;
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUser());

    // Verify with the original public key — should reject
    process.env["OP_JWT_PRIVATE_KEY"] = PRIVATE_KEY_B64;
    // Reset modules so the key loader picks up the correct public key
    vi.resetModules();
    const { createTokenService: createTokenService2 } = await import("../services/token-service.js");
    const verifySvc = createTokenService2({ redis: makeMockRedis(), db: makeMockDb() });
    const result = await verifySvc.verifyAccessToken(token);
    expect(result).toBeNull();
  });

  it("throws when OP_JWT_PRIVATE_KEY is not set in EdDSA mode", async () => {
    delete process.env["OP_JWT_PRIVATE_KEY"];
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    await expect(svc.issueAccessToken(makeUser())).rejects.toThrow("OP_JWT_PRIVATE_KEY");
  });

  it("throws when OP_JWT_PUBLIC_KEY is not set during EdDSA verification", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    // Issue token first
    const token = await svc.issueAccessToken(makeUser());

    // Remove public key so verification fails
    delete process.env["OP_JWT_PUBLIC_KEY"];
    vi.resetModules();
    const { createTokenService: createTokenService2 } = await import("../services/token-service.js");
    const verifySvc = createTokenService2({ redis: makeMockRedis(), db: makeMockDb() });
    // verifyAccessToken catches internal errors and returns null
    const result = await verifySvc.verifyAccessToken(token);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyAccessToken — algorithm-detection (mixed-mode)
// ---------------------------------------------------------------------------

describe("verifyAccessToken() — mixed-mode algorithm detection", () => {
  const HS256_SECRET = "test-jwt-secret-must-be-32chars!!";
  const secretBytes = new TextEncoder().encode(HS256_SECRET);

  beforeEach(() => {
    vi.resetModules();
    process.env["OP_JWT_SECRET"] = HS256_SECRET;
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    // Start with HS256 mode — EdDSA env vars may or may not be set
  });

  afterEach(() => {
    delete process.env["OP_JWT_ALGORITHM"];
    delete process.env["OP_JWT_PRIVATE_KEY"];
    delete process.env["OP_JWT_PUBLIC_KEY"];
  });

  it("verifies an HS256 token even when OP_JWT_ALGORITHM=EdDSA (rolling migration support)", async () => {
    // The service is now configured for EdDSA but must still accept existing
    // HS256 tokens during a rolling key rotation window.
    process.env["OP_JWT_ALGORITHM"] = "EdDSA";
    process.env["OP_JWT_PRIVATE_KEY"] = PRIVATE_KEY_B64;
    process.env["OP_JWT_PUBLIC_KEY"] = PUBLIC_KEY_B64;

    // Issue an HS256 token directly (simulating a token issued before migration)
    const legacyToken = await new SignJWT({
      sub: "legacy-user",
      tid: "t1",
      roles: ["viewer"],
      scopes: ["data:read"],
      ev: true,
      unverified: false,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti("legacy-jti-123")
      .sign(secretBytes);

    const { createTokenService } = await import("../services/token-service.js");
    const redis = makeMockRedis({ get: vi.fn().mockResolvedValue(null) });
    const svc = createTokenService({ redis, db: makeMockDb() });

    const claims = await svc.verifyAccessToken(legacyToken);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("legacy-user");
  });

  it("returns null for an EdDSA token when no public key is configured (HS256-only mode)", async () => {
    // OP_JWT_ALGORITHM defaults to HS256; no public key is set
    delete process.env["OP_JWT_ALGORITHM"];

    // Manually issue an EdDSA token (simulating a token from a different issuer)
    const { SignJWT: SignJWT2 } = await import("jose");
    const eddsaPrivKey = privateKey; // use the test keypair
    const eddsaToken = await new SignJWT2({
      sub: "u1", tid: "t1", roles: ["viewer"], scopes: ["data:read"],
      ev: true, unverified: false,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti("eddsa-jti-xyz")
      .sign(eddsaPrivKey);

    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });

    // Should return null — no public key set, so EdDSA verification throws
    const result = await svc.verifyAccessToken(eddsaToken);
    expect(result).toBeNull();
  });

  it("returns null for tokens with a malformed header", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });

    // Completely invalid base64 in header
    const result = await svc.verifyAccessToken("notbase64!.payload.sig");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// exportPublicKeyAsJwk
// ---------------------------------------------------------------------------

describe("exportPublicKeyAsJwk()", () => {
  afterEach(() => {
    delete process.env["OP_JWT_ALGORITHM"];
    delete process.env["OP_JWT_PUBLIC_KEY"];
  });

  it("returns null when algorithm is HS256", async () => {
    vi.resetModules();
    process.env["OP_JWT_ALGORITHM"] = "HS256";
    const { exportPublicKeyAsJwk } = await import("../services/token-service.js");
    const jwk = await exportPublicKeyAsJwk();
    expect(jwk).toBeNull();
  });

  it("returns null when algorithm is EdDSA but no public key is configured", async () => {
    vi.resetModules();
    process.env["OP_JWT_ALGORITHM"] = "EdDSA";
    delete process.env["OP_JWT_PUBLIC_KEY"];
    const { exportPublicKeyAsJwk } = await import("../services/token-service.js");
    const jwk = await exportPublicKeyAsJwk();
    expect(jwk).toBeNull();
  });

  it("returns a valid OKP JWK for an Ed25519 public key", async () => {
    vi.resetModules();
    process.env["OP_JWT_ALGORITHM"] = "EdDSA";
    process.env["OP_JWT_PUBLIC_KEY"] = PUBLIC_KEY_B64;
    const { exportPublicKeyAsJwk } = await import("../services/token-service.js");
    const jwk = await exportPublicKeyAsJwk();

    expect(jwk).not.toBeNull();
    expect(jwk!.kty).toBe("OKP");
    expect(jwk!.crv).toBe("Ed25519");
    expect(jwk!.use).toBe("sig");
    expect(jwk!.alg).toBe("EdDSA");
    // x must be a 43-char base64url-encoded 32-byte public key
    expect(typeof jwk!.x).toBe("string");
    expect(Buffer.from(jwk!.x, "base64url").length).toBe(32);
    // kid must be present and be 8 bytes encoded as base64url (11 chars)
    expect(typeof jwk!.kid).toBe("string");
    expect(Buffer.from(jwk!.kid, "base64url").length).toBe(8);
  });

  it("returns the same kid for the same public key (stability across calls)", async () => {
    vi.resetModules();
    process.env["OP_JWT_ALGORITHM"] = "EdDSA";
    process.env["OP_JWT_PUBLIC_KEY"] = PUBLIC_KEY_B64;
    const { exportPublicKeyAsJwk } = await import("../services/token-service.js");
    const jwk1 = await exportPublicKeyAsJwk();
    const jwk2 = await exportPublicKeyAsJwk();
    expect(jwk1!.kid).toBe(jwk2!.kid);
  });
});
