// Unit tests for token-service.ts
// Covers: resolveScopes, issueAccessToken, verifyAccessToken, revokeAccessToken,
// rotateRefreshToken (success, replay, expired session).

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { jwtVerify } from "jose";
import type { Redis } from "ioredis";
import type pg from "pg";

const JWT_SECRET = "test-jwt-secret-must-be-32chars!!";
const secretBytes = new TextEncoder().encode(JWT_SECRET);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(),
    ...overrides,
  } as unknown as Redis;
}

function makeMockDb(queryImpl?: (sql: string) => unknown): pg.Pool {
  const queryFn = queryImpl ?? (() => ({ rows: [] }));
  return {
    query: vi.fn().mockImplementation(queryFn),
    connect: vi.fn(),
  } as unknown as pg.Pool;
}

function makeUserForToken(overrides: Partial<{
  id: string;
  tenantId: string;
  roles: string[];
  emailVerified: boolean;
}> = {}) {
  return {
    id: "user-1",
    tenantId: "tenant-1",
    roles: ["viewer"],
    emailVerified: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveScopes
// ---------------------------------------------------------------------------

describe("resolveScopes()", () => {
  let resolveScopes: (roles: string[]) => string[];

  beforeAll(async () => {
    const mod = await import("../services/token-service.js");
    resolveScopes = mod.resolveScopes;
  });

  it("returns viewer scopes for the viewer role", () => {
    const scopes = resolveScopes(["viewer"]);
    expect(scopes).toContain("data:read");
    expect(scopes).toContain("apps:read");
    expect(scopes).not.toContain("data:write");
  });

  it("returns all scopes when admin scope is expanded from platform-admin role", () => {
    const scopes = resolveScopes(["platform-admin"]);
    // platform-admin maps to ["admin"], which triggers full scope expansion
    expect(scopes).toContain("data:read");
    expect(scopes).toContain("data:write");
    expect(scopes).toContain("users:manage");
    expect(scopes).toContain("admin");
  });

  it("returns all scopes when the roles list itself contains admin (direct admin scope expansion)", () => {
    // If a role resolves to the 'admin' scope, all scopes are returned
    const scopes = resolveScopes(["platform-admin"]);
    // Should include every known scope
    expect(scopes.length).toBeGreaterThan(15);
  });

  it("returns the union of scopes for multiple roles", () => {
    const scopes = resolveScopes(["viewer", "developer"]);
    // developer has data:write; viewer does not
    expect(scopes).toContain("data:write");
    // both have data:read
    expect(scopes).toContain("data:read");
    // no duplicates
    const unique = new Set(scopes);
    expect(unique.size).toBe(scopes.length);
  });

  it("ignores unknown / custom role names", () => {
    const scopes = resolveScopes(["custom-role-that-does-not-exist"]);
    expect(scopes).toHaveLength(0);
  });

  it("returns empty array for empty roles list", () => {
    expect(resolveScopes([])).toHaveLength(0);
  });

  it("deduplicates overlapping scopes from multiple roles", () => {
    // Both viewer and editor include data:read
    const scopes = resolveScopes(["viewer", "editor"]);
    const dataReadCount = scopes.filter((s) => s === "data:read").length;
    expect(dataReadCount).toBe(1);
  });

  it("tenant-admin gets a broad but not full set of scopes (no admin scope)", () => {
    const scopes = resolveScopes(["tenant-admin"]);
    // tenant-admin does NOT include "admin" in its scope list
    expect(scopes).not.toContain("admin");
    expect(scopes).toContain("users:manage");
  });
});

// ---------------------------------------------------------------------------
// issueAccessToken
// ---------------------------------------------------------------------------

describe("issueAccessToken()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
  });

  it("returns a JWT verifiable with the configured secret", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUserForToken());
    const { payload } = await jwtVerify(token, secretBytes, { algorithms: ["HS256"] });
    expect(typeof payload).toBe("object");
  });

  it("encodes sub as the user id", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUserForToken({ id: "user-abc" }));
    const { payload } = await jwtVerify(token, secretBytes);
    expect(payload["sub"]).toBe("user-abc");
  });

  it("encodes tid as the tenant id", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUserForToken({ tenantId: "tenant-xyz" }));
    const { payload } = await jwtVerify(token, secretBytes);
    expect(payload["tid"]).toBe("tenant-xyz");
  });

  it("sets unverified=false when emailVerified=true", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUserForToken({ emailVerified: true }));
    const { payload } = await jwtVerify(token, secretBytes);
    expect(payload["ev"]).toBe(true);
    expect(payload["unverified"]).toBe(false);
  });

  it("sets unverified=true when emailVerified=false", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUserForToken({ emailVerified: false }));
    const { payload } = await jwtVerify(token, secretBytes);
    expect(payload["ev"]).toBe(false);
    expect(payload["unverified"]).toBe(true);
  });

  it("resolves scopes from roles and includes them in the JWT", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUserForToken({ roles: ["developer"] }));
    const { payload } = await jwtVerify(token, secretBytes);
    const scopes = payload["scopes"] as string[];
    expect(scopes).toContain("data:read");
    expect(scopes).toContain("data:write");
  });

  it("throws if OP_JWT_SECRET is not set", async () => {
    delete process.env["OP_JWT_SECRET"];
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    await expect(svc.issueAccessToken(makeUserForToken())).rejects.toThrow("OP_JWT_SECRET");
  });
});

// ---------------------------------------------------------------------------
// verifyAccessToken
// ---------------------------------------------------------------------------

describe("verifyAccessToken()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    vi.resetModules();
  });

  async function issueTestToken(
    user: ReturnType<typeof makeUserForToken>,
    expiresIn: string | number = "15m"
  ): Promise<string> {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    // Override expiry for issuance
    const origEnv = process.env["OP_JWT_EXPIRY_SECONDS"];
    if (typeof expiresIn === "number") {
      process.env["OP_JWT_EXPIRY_SECONDS"] = String(expiresIn);
    }
    const token = await svc.issueAccessToken(user);
    if (origEnv !== undefined) {
      process.env["OP_JWT_EXPIRY_SECONDS"] = origEnv;
    } else {
      delete process.env["OP_JWT_EXPIRY_SECONDS"];
    }
    return token;
  }

  it("returns valid JwtClaims for a freshly-issued token", async () => {
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    const { createTokenService } = await import("../services/token-service.js");
    const redis = makeMockRedis({ get: vi.fn().mockResolvedValue(null) });
    const svc = createTokenService({ redis, db: makeMockDb() });
    const token = await svc.issueAccessToken(makeUserForToken({ id: "u1", tenantId: "t1" }));
    const claims = await svc.verifyAccessToken(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("u1");
    expect(claims!.tid).toBe("t1");
    expect(typeof claims!.jti).toBe("string");
    expect(typeof claims!.exp).toBe("number");
  });

  it("returns null for a token signed with a different secret", async () => {
    // Sign with a different secret
    const { SignJWT } = await import("jose");
    const wrongSecretBytes = new TextEncoder().encode("wrong-secret-that-is-32charslong!!");
    const token = await new SignJWT({
      sub: "u1", tid: "t1", roles: ["viewer"], scopes: ["data:read"],
      ev: true, unverified: false,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti("test-jti")
      .sign(wrongSecretBytes);

    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const claims = await svc.verifyAccessToken(token);
    expect(claims).toBeNull();
  });

  it("returns null for a token with an expired exp claim", async () => {
    const { SignJWT } = await import("jose");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: "u1", tid: "t1", roles: ["viewer"], scopes: ["data:read"],
      ev: true, unverified: false,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now - 3600)
      .setExpirationTime(now - 1800) // already expired
      .setJti("test-jti")
      .sign(secretBytes);

    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const claims = await svc.verifyAccessToken(token);
    expect(claims).toBeNull();
  });

  it("returns null when the token jti is in the Redis revocation blocklist", async () => {
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    const { createTokenService } = await import("../services/token-service.js");

    // First create the token to capture its jti
    const issueSvc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const token = await issueSvc.issueAccessToken(makeUserForToken({ id: "u1", tenantId: "t1" }));
    const { payload } = await jwtVerify(token, secretBytes);
    const jti = payload["jti"] as string;

    // Now create a service whose Redis reports this jti as revoked
    const revokedRedis = makeMockRedis({
      get: vi.fn().mockImplementation((key: string) => {
        if (key === `revocation:${jti}`) return Promise.resolve("1");
        return Promise.resolve(null);
      }),
    });
    const verifySvc = createTokenService({ redis: revokedRedis, db: makeMockDb() });
    const claims = await verifySvc.verifyAccessToken(token);
    expect(claims).toBeNull();
  });

  it("returns null for a completely invalid string", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    expect(await svc.verifyAccessToken("not-a-jwt")).toBeNull();
    expect(await svc.verifyAccessToken("")).toBeNull();
  });

  it("returns null when required custom claims are missing", async () => {
    // Token without 'tid' claim
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ sub: "u1", ev: true, unverified: false })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti("test-jti-2")
      .sign(secretBytes);

    const { createTokenService } = await import("../services/token-service.js");
    const svc = createTokenService({ redis: makeMockRedis(), db: makeMockDb() });
    const claims = await svc.verifyAccessToken(token);
    expect(claims).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revokeAccessToken
// ---------------------------------------------------------------------------

describe("revokeAccessToken()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    vi.resetModules();
  });

  it("writes a revocation entry to Redis for a token that has not yet expired", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const redisMock = makeMockRedis();
    const svc = createTokenService({ redis: redisMock, db: makeMockDb() });

    const futureExp = Math.floor(Date.now() / 1000) + 500;
    await svc.revokeAccessToken("test-jti-abc", futureExp);

    expect(redisMock.set).toHaveBeenCalledWith(
      "revocation:test-jti-abc",
      "1",
      "EX",
      expect.any(Number),
    );
  });

  it("does not write to Redis when the token has already expired", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const redisMock = makeMockRedis();
    const svc = createTokenService({ redis: redisMock, db: makeMockDb() });

    const pastExp = Math.floor(Date.now() / 1000) - 60;
    await svc.revokeAccessToken("expired-jti", pastExp);

    expect(redisMock.set).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rotateRefreshToken
// ---------------------------------------------------------------------------

describe("rotateRefreshToken()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    process.env["OP_REFRESH_TOKEN_TTL_SECONDS"] = "604800";
    vi.resetModules();
  });

  function makeRefreshPayload(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      userId: "user-1",
      tenantId: "tenant-1",
      sessionId: "session-1",
      jti: "refresh-jti-1",
      familyId: "family-1",
      ...overrides,
    });
  }

  // makePipelineMock now only covers the rotation write-back pipeline (set/srem/sadd/expire).
  // The initial atomic GET+DEL is handled by redis.eval() in the implementation, so
  // rawPayload is supplied via makeEvalMock() on the redis object itself.
  function makePipelineMock() {
    const execResult: [[null, string], [null, number], [null, number], [null, number], [null, number], [null, number], [null, number]] = [
      [null, "OK"],
      [null, 1],
      [null, 1],
      [null, 1],
      [null, 1],
      [null, 1],
      [null, 1],
    ];
    return {
      get: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      srem: vi.fn().mockReturnThis(),
      sadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(execResult),
    };
  }

  // Returns the raw JSON payload string that redis.eval() (the atomic GET+DEL Lua
  // script) would return, or null to simulate a missing/already-consumed token.
  function makeEvalMock(rawPayload: string | null) {
    return vi.fn().mockResolvedValue(rawPayload);
  }

  function makeSessionQueryResult(overrides: Partial<{
    expires_at: Date;
    revoked_at: Date | null;
  }> = {}) {
    return {
      rows: [{
        expires_at: new Date(Date.now() + 3_600_000),
        revoked_at: null,
        ...overrides,
      }],
    };
  }

  it("returns new accessToken and refreshToken on successful rotation", async () => {
    const { createTokenService } = await import("../services/token-service.js");

    const pipelineMock = makePipelineMock();
    const redis = {
      eval: makeEvalMock(makeRefreshPayload()),
      pipeline: vi.fn().mockReturnValue(pipelineMock),
      set: vi.fn().mockResolvedValue("OK"),
      get: vi.fn().mockResolvedValue(null),
      sadd: vi.fn().mockResolvedValue(1),
      srem: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    const queryImpl = (sql: string) => {
      if (sql.includes("auth.sessions") && sql.includes("SELECT")) {
        return makeSessionQueryResult();
      }
      if (sql.includes("UPDATE auth.sessions")) {
        return { rows: [] };
      }
      if (sql.includes("auth.users")) {
        return {
          rows: [{
            id: "user-1",
            tenant_id: "tenant-1",
            roles: ["viewer"],
            email_verified: true,
          }],
        };
      }
      return { rows: [] };
    };

    const mockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        return queryImpl(sql);
      }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn().mockImplementation(queryImpl),
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as pg.Pool;

    const svc = createTokenService({ redis, db });
    const result = await svc.rotateRefreshToken("old-token-value");

    expect(result).toHaveProperty("accessToken");
    expect(result).toHaveProperty("refreshToken");
    expect(result).toHaveProperty("expiresIn");
    expect(typeof result.accessToken).toBe("string");
    expect(typeof result.refreshToken).toBe("string");
    expect(result.expiresIn).toBe(900);
  });

  it("throws UnauthorizedError when the refresh token is not in Redis (already used)", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const { UnauthorizedError } = await import("@oneplatform/core");

    // redis.eval returns null — the Lua script found no key (token already consumed)
    const redis = {
      eval: makeEvalMock(null),
      get: vi.fn().mockResolvedValue(null),
    } as unknown as Redis;

    const svc = createTokenService({ redis, db: makeMockDb() });
    await expect(svc.rotateRefreshToken("used-token")).rejects.toThrow(UnauthorizedError);
  });

  it("throws SessionRevokedError when the session has been revoked", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const { SessionRevokedError } = await import("../services/token-service.js");

    const pipelineMock = makePipelineMock();
    const redis = {
      eval: makeEvalMock(makeRefreshPayload()),
      pipeline: vi.fn().mockReturnValue(pipelineMock),
      set: vi.fn().mockResolvedValue("OK"),
    } as unknown as Redis;

    const db = makeMockDb((sql: string) => {
      if (sql.includes("auth.sessions") && sql.includes("SELECT")) {
        return {
          rows: [{
            expires_at: new Date(Date.now() + 3_600_000),
            revoked_at: new Date(), // revoked
          }],
        };
      }
      return { rows: [] };
    });

    const svc = createTokenService({ redis, db });
    await expect(svc.rotateRefreshToken("valid-token-but-revoked-session")).rejects.toThrow(
      SessionRevokedError,
    );
  });

  it("throws UnauthorizedError when the session has expired", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const { UnauthorizedError } = await import("@oneplatform/core");

    const pipelineMock = makePipelineMock();
    const redis = {
      eval: makeEvalMock(makeRefreshPayload()),
      pipeline: vi.fn().mockReturnValue(pipelineMock),
      set: vi.fn().mockResolvedValue("OK"),
    } as unknown as Redis;

    const db = makeMockDb((sql: string) => {
      if (sql.includes("auth.sessions") && sql.includes("SELECT")) {
        return {
          rows: [{
            expires_at: new Date(Date.now() - 1000), // already expired
            revoked_at: null,
          }],
        };
      }
      return { rows: [] };
    });

    const svc = createTokenService({ redis, db });
    await expect(svc.rotateRefreshToken("token-with-expired-session")).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it("throws UnauthorizedError when session row does not exist", async () => {
    const { createTokenService } = await import("../services/token-service.js");
    const { UnauthorizedError } = await import("@oneplatform/core");

    const pipelineMock = makePipelineMock();
    const redis = {
      eval: makeEvalMock(makeRefreshPayload()),
      pipeline: vi.fn().mockReturnValue(pipelineMock),
    } as unknown as Redis;

    const db = makeMockDb(() => ({ rows: [] })); // session not found

    const svc = createTokenService({ redis, db });
    await expect(svc.rotateRefreshToken("valid-token-no-session")).rejects.toThrow(
      UnauthorizedError,
    );
  });
});
