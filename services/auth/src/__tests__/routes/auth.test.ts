// Route-level tests for auth routes.
// Tests request validation, response shapes, and error propagation via mock services.

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables, UserContext } from "@oneplatform/core";
import { errorHandlerMiddleware, ConflictError, UnauthorizedError } from "@oneplatform/core";
import type { AuthService } from "../../services/index.js";
import type { TokenService } from "../../services/token-service.js";
import type { UserRepository } from "../../repositories/index.js";
import { createAuthRoutes } from "../../routes/auth.js";
import {
  AccountLockedError,
  ResetTokenExpiredError,
  ResetTokenUsedError,
  VerifyTokenInvalidError,
  EmailAlreadyVerifiedError,
  TenantNotFoundError,
} from "../../services/errors.js";

const MOCK_USER: UserContext = {
  userId: "user-1",
  tenantId: "tenant-1",
  roles: ["viewer"],
  scopes: ["data:read"],
  isGuest: false,
  isService: false,
  emailVerified: true,
};

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeUserRepository(overrides: Partial<UserRepository> = {}): UserRepository {
  return {
    findById: vi.fn().mockResolvedValue({
      id: "user-1",
      tenant_id: "tenant-1",
      email: "alice@example.com",
      password_hash: null,
      email_verified: true,
      is_active: true,
      display_name: "Alice",
      roles: ["viewer"],
      created_at: new Date(),
      updated_at: new Date(),
      last_login_at: null,
      failed_login_count: 0,
      locked_until: null,
      metadata: {},
    }),
    ...overrides,
  } as UserRepository;
}

function buildApp(
  authService: AuthService,
  tokenService: TokenService,
  authedUser?: UserContext,
  userRepository?: UserRepository,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError(errorHandlerMiddleware());

  if (authedUser !== undefined) {
    app.use("*", async (c, next) => {
      c.set("user", authedUser);
      await next();
    });
  }

  const routes = createAuthRoutes({
    authService,
    tokenService,
    userRepository: userRepository ?? makeUserRepository(),
  });
  app.route("/", routes);
  return app;
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeAuthService(overrides: Partial<AuthService> = {}): AuthService {
  return {
    register: vi.fn().mockResolvedValue({
      userId: "user-1",
      email: "alice@example.com",
      tenantId: "tenant-1",
      roles: ["viewer"],
      requiresEmailVerification: false,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
    }),
    login: vi.fn().mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
      tokenType: "Bearer" as const,
      user: {
        id: "user-1",
        email: "alice@example.com",
        displayName: null,
        tenantId: "tenant-1",
        roles: ["viewer"],
        emailVerified: true,
      },
    }),
    logout: vi.fn().mockResolvedValue(undefined),
    forgotPassword: vi.fn().mockResolvedValue({
      message: "If an account with this email exists, a reset link has been sent.",
    }),
    resetPassword: vi.fn().mockResolvedValue(undefined),
    verifyEmail: vi.fn().mockResolvedValue({
      message: "Email verified successfully.",
      userId: "user-1",
    }),
    ...overrides,
  };
}

function makeTokenService(overrides: Partial<TokenService> = {}): TokenService {
  return {
    issueAccessToken: vi.fn().mockResolvedValue("access-token"),
    issueRefreshToken: vi.fn().mockResolvedValue({ token: "refresh-token", jti: "jti-1" }),
    verifyAccessToken: vi.fn().mockResolvedValue({
      sub: "user-1",
      tid: "tenant-1",
      roles: ["viewer"],
      scopes: ["data:read"],
      ev: true,
      unverified: false,
      jti: "jti-1",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    }),
    revokeAccessToken: vi.fn().mockResolvedValue(undefined),
    rotateRefreshToken: vi.fn().mockResolvedValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresIn: 900,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /api/v1/auth/register
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/register", () => {
  const validBody = {
    email: "alice@example.com",
    password: "SuperSecure123!",
    tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  };

  it("returns 201 with tokens on successful registration", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body["userId"]).toBe("user-1");
    expect(body["accessToken"]).toBe("access-token");
  });

  it("returns 422 when email is not a valid email address", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, email: "not-an-email" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when password is shorter than 12 characters", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, password: "short" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when tenantId is not a UUID", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, tenantId: "not-a-uuid" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 409 when service throws ConflictError (duplicate email)", async () => {
    const svc = makeAuthService({ register: vi.fn().mockRejectedValue(new ConflictError("Already registered.")) });
    const app = buildApp(svc, makeTokenService());
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  it("returns 404 when service throws TenantNotFoundError", async () => {
    const svc = makeAuthService({ register: vi.fn().mockRejectedValue(new TenantNotFoundError("Not found.")) });
    const app = buildApp(svc, makeTokenService());
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
  });

  it("normalises email to lowercase before passing to service", async () => {
    const registerSpy = vi.fn().mockResolvedValue({
      userId: "u1", email: "alice@example.com", tenantId: "t1", roles: ["viewer"],
      requiresEmailVerification: false, accessToken: "at", refreshToken: "rt", expiresIn: 900,
    });
    const app = buildApp(makeAuthService({ register: registerSpy }), makeTokenService());
    await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, email: "ALICE@EXAMPLE.COM" }),
    });
    expect(registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ email: "alice@example.com" }),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/login", () => {
  const validBody = {
    email: "alice@example.com",
    password: "SuperSecure123!",
    tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  };

  it("returns 200 with tokens and user on success", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["accessToken"]).toBe("access-token");
    expect(body["tokenType"]).toBe("Bearer");
    const user = body["user"] as Record<string, unknown>;
    expect(user["email"]).toBe("alice@example.com");
  });

  it("returns 422 when email is missing", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pwd", tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 401 when service throws UnauthorizedError (wrong password)", async () => {
    const svc = makeAuthService({
      login: vi.fn().mockRejectedValue(new UnauthorizedError("Invalid credentials.")),
    });
    const app = buildApp(svc, makeTokenService());
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when service throws AccountLockedError", async () => {
    const svc = makeAuthService({
      login: vi.fn().mockRejectedValue(new AccountLockedError("Locked.")),
    });
    const app = buildApp(svc, makeTokenService());
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_ACCOUNT_LOCKED");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/logout", () => {
  it("returns 204 on successful logout", async () => {
    const app = buildApp(makeAuthService(), makeTokenService(), MOCK_USER);
    const res = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer some-token",
      },
      body: JSON.stringify({ refreshToken: "rt-value" }),
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 when body is empty (no refresh token)", async () => {
    const app = buildApp(makeAuthService(), makeTokenService(), MOCK_USER);
    const res = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer some-token" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(204);
  });

  it("passes all=true to service when requested", async () => {
    const logoutSpy = vi.fn().mockResolvedValue(undefined);
    const app = buildApp(makeAuthService({ logout: logoutSpy }), makeTokenService(), MOCK_USER);
    await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer some-token" },
      body: JSON.stringify({ all: true }),
    });
    expect(logoutSpy).toHaveBeenCalledWith(
      undefined,
      expect.any(String),
      expect.any(Number),
      MOCK_USER.userId,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/refresh
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/refresh", () => {
  it("returns 200 with new access and refresh tokens", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "old-refresh-token" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["accessToken"]).toBe("new-access-token");
    expect(body["refreshToken"]).toBe("new-refresh-token");
  });

  it("returns 422 when refreshToken is missing from body", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 401 when tokenService throws UnauthorizedError", async () => {
    const tokenSvc = makeTokenService({
      rotateRefreshToken: vi.fn().mockRejectedValue(new UnauthorizedError("Token not found.")),
    });
    const app = buildApp(makeAuthService(), tokenSvc);
    const res = await app.request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: "invalid-token" }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/forgot-password
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/forgot-password", () => {
  it("returns 200 with the standard enumeration-safe message", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["message"]).toContain("If an account with this email exists");
  });

  it("returns 422 when email is invalid", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bad-email", tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when tenantId is not a UUID", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", tenantId: "not-a-uuid" }),
    });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/reset-password/:token
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/reset-password/:token", () => {
  const validBody = { newPassword: "NewSecure123456!", confirmPassword: "NewSecure123456!" };

  it("returns 200 with success message", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/reset-password/some-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(String(body["message"])).toContain("Password reset successfully");
  });

  it("returns 422 when newPassword is shorter than 12 chars", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/reset-password/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: "short", confirmPassword: "short" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when passwords do not match", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/reset-password/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: "NewSecure123456!", confirmPassword: "DifferentPass123!" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 401 when service throws ResetTokenExpiredError", async () => {
    const svc = makeAuthService({
      resetPassword: vi.fn().mockRejectedValue(new ResetTokenExpiredError("Expired.")),
    });
    const app = buildApp(svc, makeTokenService());
    const res = await app.request("/api/v1/auth/reset-password/expired-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_RESET_TOKEN_EXPIRED");
  });

  it("returns 401 when service throws ResetTokenUsedError", async () => {
    const svc = makeAuthService({
      resetPassword: vi.fn().mockRejectedValue(new ResetTokenUsedError("Already used.")),
    });
    const app = buildApp(svc, makeTokenService());
    const res = await app.request("/api/v1/auth/reset-password/used-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_RESET_TOKEN_USED");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/auth/verify-email/:token
// ---------------------------------------------------------------------------

describe("GET /api/v1/auth/verify-email/:token", () => {
  it("returns 200 with success message and userId", async () => {
    const app = buildApp(makeAuthService(), makeTokenService());
    const res = await app.request("/api/v1/auth/verify-email/valid-token");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["message"]).toBe("Email verified successfully.");
    expect(body["userId"]).toBe("user-1");
  });

  it("returns 409 when service throws EmailAlreadyVerifiedError", async () => {
    const svc = makeAuthService({
      verifyEmail: vi.fn().mockRejectedValue(new EmailAlreadyVerifiedError("Already done.")),
    });
    const app = buildApp(svc, makeTokenService());
    const res = await app.request("/api/v1/auth/verify-email/token");
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_EMAIL_ALREADY_VERIFIED");
  });

  it("returns 401 when service throws VerifyTokenInvalidError", async () => {
    const svc = makeAuthService({
      verifyEmail: vi.fn().mockRejectedValue(new VerifyTokenInvalidError("Bad token.")),
    });
    const app = buildApp(svc, makeTokenService());
    const res = await app.request("/api/v1/auth/verify-email/bad-token");
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("AUTH_VERIFY_TOKEN_INVALID");
  });
});
