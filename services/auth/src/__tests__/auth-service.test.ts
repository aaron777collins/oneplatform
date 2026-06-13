// Unit tests for auth-service.ts
// Covers: register(), login(), logout(), forgotPassword(), resetPassword(), verifyEmail().
// All external dependencies (DB, Redis, passwordService, tokenService, events, logger)
// are mocked — no real database or Redis required.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { PasswordService } from "../services/password-service.js";
import type { TokenService } from "../services/token-service.js";
import type { AuthServiceDeps } from "../services/auth-service.js";

const JWT_SECRET = "test-jwt-secret-must-be-32chars!!";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    audit: vi.fn(),
  } as unknown as Logger;
}

function makeEvents(): EventPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventPublisher;
}

function makePasswordService(overrides: Partial<PasswordService> = {}): PasswordService {
  return {
    hash: vi.fn().mockResolvedValue("$2b$10$hashedpassword"),
    compare: vi.fn().mockResolvedValue(true),
    compareDummy: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function makeTokenService(overrides: Partial<TokenService> = {}): TokenService {
  return {
    issueAccessToken: vi.fn().mockResolvedValue("mock-access-token"),
    issueRefreshToken: vi.fn().mockResolvedValue({ token: "mock-refresh-token", jti: "mock-jti" }),
    verifyAccessToken: vi.fn().mockResolvedValue(null),
    revokeAccessToken: vi.fn().mockResolvedValue(undefined),
    rotateRefreshToken: vi.fn().mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 900,
    }),
    ...overrides,
  };
}

function makeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue("1"),     // Lua GET-DEL gate: returns "1" (key exists)
    smembers: vi.fn().mockResolvedValue([]),  // user-sessions set: empty by default
    srem: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// DB builder: configure per-test SQL query responses
// ---------------------------------------------------------------------------

type QueryResponse = { rows: Record<string, unknown>[] };

function makeDb(queryMap: (sql: string, params?: unknown[]) => QueryResponse): pg.Pool {
  const mockClient = {
    query: vi.fn().mockImplementation(queryMap),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockImplementation(queryMap),
    connect: vi.fn().mockResolvedValue(mockClient),
  } as unknown as pg.Pool;
}

// ---------------------------------------------------------------------------
// Standard user row
// ---------------------------------------------------------------------------

function makeUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    tenant_id: "tenant-1",
    email: "alice@example.com",
    password_hash: "$2b$10$hashedpassword",
    email_verified: true,
    is_active: true,
    display_name: "Alice",
    roles: ["viewer"],
    failed_login_count: 0,
    locked_until: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe("AuthService.register()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    process.env["OP_REFRESH_TOKEN_TTL_SECONDS"] = "604800";
    delete process.env["OP_REQUIRE_EMAIL_VERIFICATION"];
    delete process.env["OP_SMTP_HOST"];
    vi.resetModules();
  });

  function buildDeps(overrides: Partial<AuthServiceDeps> = {}): AuthServiceDeps {
    return {
      db: makeDb((sql: string) => {
        if (sql.includes("auth.tenants")) return { rows: [{ id: "tenant-1", name: "Acme" }] };
        if (sql.includes("lower(email)") && sql.includes("SELECT")) return { rows: [] }; // no conflict
        if (sql.includes("INSERT INTO auth.users")) return { rows: [{ id: "user-1" }] };
        if (sql.includes("INSERT INTO auth.sessions")) return { rows: [] };
        if (sql.includes("UPDATE auth.sessions")) return { rows: [] };
        return { rows: [] };
      }),
      redis: makeRedis(),
      passwordService: makePasswordService(),
      tokenService: makeTokenService(),
      logger: makeLogger(),
      events: makeEvents(),
      ...overrides,
    };
  }

  it("returns userId and tokens when email verification is not required", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const svc = createAuthService(buildDeps());
    const result = await svc.register({
      email: "alice@example.com",
      password: "SuperSecure123!",
      tenantId: "tenant-1",
    });
    expect(result.userId).toBe("user-1");
    expect(result.requiresEmailVerification).toBe(false);
    expect(result.accessToken).toBe("mock-access-token");
    expect(result.refreshToken).toBe("mock-refresh-token");
  });

  it("throws TenantNotFoundError when tenant does not exist", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { TenantNotFoundError } = await import("../services/errors.js");

    const deps = buildDeps({
      db: makeDb((sql: string) => {
        if (sql.includes("auth.tenants")) return { rows: [] }; // tenant not found
        return { rows: [] };
      }),
    });
    const svc = createAuthService(deps);
    await expect(
      svc.register({ email: "a@b.com", password: "SuperSecure123!", tenantId: "nonexistent" }),
    ).rejects.toThrow(TenantNotFoundError);
  });

  it("throws ConflictError when email already exists in tenant", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { ConflictError } = await import("@oneplatform/core");

    const deps = buildDeps({
      db: makeDb((sql: string) => {
        if (sql.includes("auth.tenants")) return { rows: [{ id: "tenant-1", name: "Acme" }] };
        if (sql.includes("lower(email)") && sql.includes("SELECT")) return { rows: [{ id: "existing-user" }] };
        return { rows: [] };
      }),
    });
    const svc = createAuthService(deps);
    await expect(
      svc.register({ email: "existing@example.com", password: "SuperSecure123!", tenantId: "tenant-1" }),
    ).rejects.toThrow(ConflictError);
  });

  it("returns verifyLink (no tokens) when email verification is required and no SMTP", async () => {
    process.env["OP_REQUIRE_EMAIL_VERIFICATION"] = "true";
    const { createAuthService } = await import("../services/auth-service.js");

    const deps = buildDeps();
    const svc = createAuthService(deps);
    const result = await svc.register({
      email: "new@example.com",
      password: "SuperSecure123!",
      tenantId: "tenant-1",
    });
    expect(result.requiresEmailVerification).toBe(true);
    expect(result.verifyLink).toBeDefined();
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
  });

  it("does not return verifyLink when SMTP is configured (link goes via email)", async () => {
    process.env["OP_REQUIRE_EMAIL_VERIFICATION"] = "true";
    process.env["OP_SMTP_HOST"] = "smtp.example.com";
    const { createAuthService } = await import("../services/auth-service.js");

    const deps = buildDeps();
    const svc = createAuthService(deps);
    const result = await svc.register({
      email: "new@example.com",
      password: "SuperSecure123!",
      tenantId: "tenant-1",
    });
    expect(result.requiresEmailVerification).toBe(true);
    expect(result.verifyLink).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// login()
// ---------------------------------------------------------------------------

describe("AuthService.login()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    process.env["OP_REFRESH_TOKEN_TTL_SECONDS"] = "604800";
    vi.resetModules();
  });

  function buildLoginDeps(
    userRow: Record<string, unknown> | null,
    passwordMatch = true,
  ): AuthServiceDeps {
    const passwordService = makePasswordService({
      compare: vi.fn().mockResolvedValue(passwordMatch),
    });
    const db = makeDb((sql: string) => {
      if (sql.includes("SELECT") && sql.includes("auth.users")) {
        return userRow ? { rows: [userRow] } : { rows: [] };
      }
      if (sql.includes("INSERT INTO auth.sessions")) return { rows: [] };
      if (sql.includes("UPDATE auth.sessions")) return { rows: [] };
      if (sql.includes("UPDATE auth.users")) return { rows: [] };
      return { rows: [] };
    });
    return {
      db,
      redis: makeRedis(),
      passwordService,
      tokenService: makeTokenService(),
      logger: makeLogger(),
      events: makeEvents(),
    };
  }

  it("returns accessToken and user on successful login", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const svc = createAuthService(buildLoginDeps(makeUserRow()));
    const result = await svc.login({
      email: "alice@example.com",
      password: "correct-password",
      tenantId: "tenant-1",
    });
    expect(result.accessToken).toBe("mock-access-token");
    expect(result.user.email).toBe("alice@example.com");
    expect(result.tokenType).toBe("Bearer");
  });

  it("runs compareDummy and throws UnauthorizedError when user not found", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { UnauthorizedError } = await import("@oneplatform/core");
    const deps = buildLoginDeps(null);
    const svc = createAuthService(deps);
    await expect(
      svc.login({ email: "ghost@example.com", password: "any", tenantId: "tenant-1" }),
    ).rejects.toThrow(UnauthorizedError);
    // Verify dummy compare was called (timing attack prevention)
    expect((deps.passwordService.compareDummy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("throws generic UnauthorizedError when account is locked (prevents user enumeration)", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { UnauthorizedError } = await import("@oneplatform/core");
    const lockedUser = makeUserRow({
      locked_until: new Date(Date.now() + 10 * 60 * 1000),
    });
    const svc = createAuthService(buildLoginDeps(lockedUser));
    await expect(
      svc.login({ email: "alice@example.com", password: "any", tenantId: "tenant-1" }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("throws generic UnauthorizedError when account is deactivated (prevents user enumeration)", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { UnauthorizedError } = await import("@oneplatform/core");
    const deactivatedUser = makeUserRow({ is_active: false });
    const deps = buildLoginDeps(deactivatedUser);
    const svc = createAuthService(deps);
    await expect(
      svc.login({ email: "alice@example.com", password: "any", tenantId: "tenant-1" }),
    ).rejects.toThrow(UnauthorizedError);
    expect((deps.passwordService.compareDummy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("throws UnauthorizedError and runs compareDummy for OAuth-only account (no password hash)", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { UnauthorizedError } = await import("@oneplatform/core");
    const oauthUser = makeUserRow({ password_hash: null });
    const deps = buildLoginDeps(oauthUser);
    const svc = createAuthService(deps);
    await expect(
      svc.login({ email: "alice@example.com", password: "any", tenantId: "tenant-1" }),
    ).rejects.toThrow(UnauthorizedError);
    expect((deps.passwordService.compareDummy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("throws UnauthorizedError when password is wrong", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { UnauthorizedError } = await import("@oneplatform/core");
    const svc = createAuthService(buildLoginDeps(makeUserRow(), false));
    await expect(
      svc.login({ email: "alice@example.com", password: "wrong!", tenantId: "tenant-1" }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("locks the account after 10 failed login attempts", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    // User has already failed 9 times; this is the 10th attempt
    const nearLockUser = makeUserRow({ failed_login_count: 9 });
    const updateSpy = vi.fn().mockResolvedValue({ rows: [] });
    const db = makeDb((sql: string) => {
      if (sql.includes("SELECT") && sql.includes("auth.users")) {
        return { rows: [nearLockUser] };
      }
      if (sql.includes("UPDATE auth.users")) {
        updateSpy(sql);
        return { rows: [] };
      }
      return { rows: [] };
    });
    const deps: AuthServiceDeps = {
      db,
      redis: makeRedis(),
      passwordService: makePasswordService({ compare: vi.fn().mockResolvedValue(false) }),
      tokenService: makeTokenService(),
      logger: makeLogger(),
      events: makeEvents(),
    };
    const svc = createAuthService(deps);
    await expect(
      svc.login({ email: "alice@example.com", password: "wrong!", tenantId: "tenant-1" }),
    ).rejects.toThrow();
    // The UPDATE should set locked_until to a future date
    const updateCall = (db.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("UPDATE auth.users"),
    );
    expect(updateCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// logout()
// ---------------------------------------------------------------------------

describe("AuthService.logout()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    vi.resetModules();
  });

  it("revokes the specific session when all=false and refreshToken is provided", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const redis = makeRedis({
      get: vi.fn().mockResolvedValue(JSON.stringify({ sessionId: "session-1", userId: "user-1" })),
      del: vi.fn().mockResolvedValue(1),
      srem: vi.fn().mockResolvedValue(1),
    });
    const tokenService = makeTokenService();
    const db = makeDb(() => ({ rows: [] }));
    const events = makeEvents();
    const svc = createAuthService({
      db, redis, passwordService: makePasswordService(), tokenService, logger: makeLogger(), events,
    });

    await svc.logout("refresh-token-value", "access-jti", Date.now() / 1000 + 900, "user-1", false);

    expect(tokenService.revokeAccessToken).toHaveBeenCalledWith("access-jti", expect.any(Number));
    expect(redis.del).toHaveBeenCalledWith("auth:refresh:refresh-token-value");
    expect(events.publish).toHaveBeenCalled();
  });

  it("revokes all sessions when all=true using Redis smembers", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const redis = makeRedis({
      smembers: vi.fn().mockResolvedValue(["hex-token-1", "hex-token-2"]),
      del: vi.fn().mockResolvedValue(1),
    });
    const tokenService = makeTokenService();
    const db = makeDb((sql: string) => {
      if (sql.includes("UPDATE auth.sessions")) return { rows: [] };
      return { rows: [] };
    });
    const svc = createAuthService({
      db, redis, passwordService: makePasswordService(), tokenService, logger: makeLogger(), events: makeEvents(),
    });

    await svc.logout(undefined, "access-jti", Date.now() / 1000 + 900, "user-1", true);

    // Each token key should have its refresh token deleted from Redis
    expect(redis.smembers).toHaveBeenCalledWith("auth:user-sessions:user-1");
    expect(redis.del).toHaveBeenCalledWith("auth:refresh:hex-token-1");
    expect(redis.del).toHaveBeenCalledWith("auth:refresh:hex-token-2");
  });
});

// ---------------------------------------------------------------------------
// forgotPassword()
// ---------------------------------------------------------------------------

describe("AuthService.forgotPassword()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    delete process.env["OP_SMTP_HOST"];
    vi.resetModules();
  });

  it("returns standard message regardless of whether email exists (prevents enumeration)", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const db = makeDb(() => ({ rows: [] })); // user not found
    const svc = createAuthService({
      db, redis: makeRedis(), passwordService: makePasswordService(),
      tokenService: makeTokenService(), logger: makeLogger(), events: makeEvents(),
    });
    const result = await svc.forgotPassword("ghost@example.com", "tenant-1");
    expect(result.message).toContain("If an account with this email exists");
  });

  it("returns resetLink in dev mode (no SMTP) when user exists", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const db = makeDb((sql: string) => {
      if (sql.includes("auth.users")) return { rows: [{ id: "user-1", is_active: true }] };
      if (sql.includes("auth.password_reset_tokens")) return { rows: [] };
      return { rows: [] };
    });
    const redis = makeRedis({ set: vi.fn().mockResolvedValue("OK") });
    const svc = createAuthService({
      db, redis, passwordService: makePasswordService(),
      tokenService: makeTokenService(), logger: makeLogger(), events: makeEvents(),
    });
    const result = await svc.forgotPassword("alice@example.com", "tenant-1");
    expect(result.resetLink).toBeDefined();
    expect(result.resetLink).toContain("reset-password");
  });

  it("does not return resetLink when SMTP is configured", async () => {
    process.env["OP_SMTP_HOST"] = "smtp.example.com";
    const { createAuthService } = await import("../services/auth-service.js");
    const db = makeDb((sql: string) => {
      if (sql.includes("auth.users")) return { rows: [{ id: "user-1", is_active: true }] };
      if (sql.includes("auth.password_reset_tokens")) return { rows: [] };
      return { rows: [] };
    });
    const svc = createAuthService({
      db, redis: makeRedis(), passwordService: makePasswordService(),
      tokenService: makeTokenService(), logger: makeLogger(), events: makeEvents(),
    });
    const result = await svc.forgotPassword("alice@example.com", "tenant-1");
    expect(result.resetLink).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resetPassword()
// ---------------------------------------------------------------------------

describe("AuthService.resetPassword()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    vi.resetModules();
  });

  async function makeValidResetToken(userId = "user-1", jti = "reset-jti-1"): Promise<string> {
    const { SignJWT } = await import("jose");
    const secretBytes = new TextEncoder().encode(JWT_SECRET);
    return new SignJWT({ sub: userId, purpose: "password-reset", jti })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretBytes);
  }

  function buildResetDeps(redisEvalResult: string | null = "1") {
    const redis = makeRedis({
      eval: vi.fn().mockResolvedValue(redisEvalResult),
      smembers: vi.fn().mockResolvedValue([]),  // no active session tokens to clean up
      del: vi.fn().mockResolvedValue(1),
    });

    const mockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("UPDATE auth.users")) return { rows: [] };
        if (sql.includes("UPDATE auth.password_reset_tokens")) return { rows: [] };
        if (sql.includes("UPDATE auth.sessions")) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as pg.Pool;

    return {
      db, redis, passwordService: makePasswordService(),
      tokenService: makeTokenService(), logger: makeLogger(), events: makeEvents(),
    };
  }

  it("completes successfully with a valid token", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const token = await makeValidResetToken();
    const svc = createAuthService(buildResetDeps("1")); // eval returns "1" = key was present
    await expect(svc.resetPassword(token, "NewPassword123!")).resolves.toBeUndefined();
  });

  it("throws ResetTokenExpiredError for an expired JWT", async () => {
    const { SignJWT } = await import("jose");
    const { createAuthService } = await import("../services/auth-service.js");
    const { ResetTokenExpiredError } = await import("../services/errors.js");

    const secretBytes = new TextEncoder().encode(JWT_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({ sub: "u1", purpose: "password-reset", jti: "j1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600) // expired 1h ago
      .sign(secretBytes);

    const svc = createAuthService(buildResetDeps());
    await expect(svc.resetPassword(expiredToken, "NewPassword123!")).rejects.toThrow(
      ResetTokenExpiredError,
    );
  });

  it("throws ResetTokenInvalidError for a completely invalid token string", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { ResetTokenInvalidError } = await import("../services/errors.js");
    const svc = createAuthService(buildResetDeps());
    await expect(svc.resetPassword("not-a-valid-jwt", "NewPassword123!")).rejects.toThrow(
      ResetTokenInvalidError,
    );
  });

  it("throws ResetTokenUsedError when token has already been consumed from Redis", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { ResetTokenUsedError } = await import("../services/errors.js");

    const token = await makeValidResetToken("user-1", "used-jti");
    // eval returns null = key was not in Redis (already consumed)
    const svc = createAuthService(buildResetDeps(null));
    await expect(svc.resetPassword(token, "NewPassword123!")).rejects.toThrow(ResetTokenUsedError);
  });

  it("throws ResetTokenInvalidError when the purpose claim is wrong", async () => {
    const { SignJWT } = await import("jose");
    const { createAuthService } = await import("../services/auth-service.js");
    const { ResetTokenInvalidError } = await import("../services/errors.js");

    const secretBytes = new TextEncoder().encode(JWT_SECRET);
    const wrongPurposeToken = await new SignJWT({ sub: "u1", purpose: "email-verify", jti: "j1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretBytes);

    const svc = createAuthService(buildResetDeps());
    await expect(svc.resetPassword(wrongPurposeToken, "NewPassword123!")).rejects.toThrow(
      ResetTokenInvalidError,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyEmail()
// ---------------------------------------------------------------------------

describe("AuthService.verifyEmail()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    vi.resetModules();
  });

  async function makeValidVerifyToken(userId = "user-1", jti = "verify-jti-1"): Promise<string> {
    const { SignJWT } = await import("jose");
    const secretBytes = new TextEncoder().encode(JWT_SECRET);
    return new SignJWT({ sub: userId, purpose: "email-verify", jti })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(secretBytes);
  }

  function buildVerifyDeps(
    userRow: Record<string, unknown> | null = { email_verified: false, tenant_id: "tenant-1" },
    evalResult: string | null = "1", // "1" = key present; null = already consumed
  ) {
    const redis = makeRedis({
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(evalResult),
    });

    const db = makeDb((sql: string) => {
      if (sql.includes("SELECT") && sql.includes("auth.users")) {
        return userRow ? { rows: [userRow] } : { rows: [] };
      }
      if (sql.includes("UPDATE auth.users")) return { rows: [] };
      return { rows: [] };
    });

    return {
      db, redis, passwordService: makePasswordService(),
      tokenService: makeTokenService(), logger: makeLogger(), events: makeEvents(),
    };
  }

  it("returns success message and userId on valid token", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const token = await makeValidVerifyToken("user-1");
    const svc = createAuthService(buildVerifyDeps());
    const result = await svc.verifyEmail(token);
    expect(result.message).toBe("Email verified successfully.");
    expect(result.userId).toBe("user-1");
  });

  it("throws EmailAlreadyVerifiedError when email is already verified", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { EmailAlreadyVerifiedError } = await import("../services/errors.js");
    const token = await makeValidVerifyToken("user-1");
    const svc = createAuthService(
      buildVerifyDeps({ email_verified: true, tenant_id: "tenant-1" }, "1"),
    );
    await expect(svc.verifyEmail(token)).rejects.toThrow(EmailAlreadyVerifiedError);
  });

  it("throws VerifyTokenExpiredError for an expired token", async () => {
    const { SignJWT } = await import("jose");
    const { createAuthService } = await import("../services/auth-service.js");
    const { VerifyTokenExpiredError } = await import("../services/errors.js");

    const secretBytes = new TextEncoder().encode(JWT_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({ sub: "u1", purpose: "email-verify", jti: "j1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now - 90000)
      .setExpirationTime(now - 3600)
      .sign(secretBytes);

    const svc = createAuthService(buildVerifyDeps());
    await expect(svc.verifyEmail(expiredToken)).rejects.toThrow(VerifyTokenExpiredError);
  });

  it("throws VerifyTokenUsedError when the Redis gate has already been consumed", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { VerifyTokenUsedError } = await import("../services/errors.js");
    const token = await makeValidVerifyToken();
    // eval returns null = key not in Redis (already consumed)
    const svc = createAuthService(
      buildVerifyDeps({ email_verified: false, tenant_id: "tenant-1" }, null),
    );
    await expect(svc.verifyEmail(token)).rejects.toThrow(VerifyTokenUsedError);
  });

  it("throws VerifyTokenInvalidError for a completely invalid token", async () => {
    const { createAuthService } = await import("../services/auth-service.js");
    const { VerifyTokenInvalidError } = await import("../services/errors.js");
    const svc = createAuthService(buildVerifyDeps());
    await expect(svc.verifyEmail("garbage")).rejects.toThrow(VerifyTokenInvalidError);
  });

  it("throws VerifyTokenInvalidError when purpose claim is wrong", async () => {
    const { SignJWT } = await import("jose");
    const { createAuthService } = await import("../services/auth-service.js");
    const { VerifyTokenInvalidError } = await import("../services/errors.js");

    const secretBytes = new TextEncoder().encode(JWT_SECRET);
    const wrongToken = await new SignJWT({ sub: "u1", purpose: "password-reset", jti: "j1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secretBytes);

    const svc = createAuthService(buildVerifyDeps());
    await expect(svc.verifyEmail(wrongToken)).rejects.toThrow(VerifyTokenInvalidError);
  });
});
