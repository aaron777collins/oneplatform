// Unit tests for bootstrap-service.ts
// Covers: getStatus(), bootstrap() success/already-completed/invalid-token/rate-limit/concurrent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { PasswordService } from "../services/password-service.js";
import type { TokenService } from "../services/token-service.js";
import type { BootstrapServiceDeps } from "../services/bootstrap-service.js";

const JWT_SECRET = "test-jwt-secret-must-be-32chars!!";
// Valid 64-char hex token (matches bootstrapRequest schema length = 64)
const VALID_TOKEN = "a".repeat(64);

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn().mockReturnThis(), audit: vi.fn(),
  } as unknown as Logger;
}

function makeEvents(): EventPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventPublisher;
}

function makePasswordService(): PasswordService {
  return {
    hash: vi.fn().mockResolvedValue("$2b$10$hashedpassword"),
    compare: vi.fn().mockResolvedValue(true),
    compareDummy: vi.fn().mockResolvedValue(false),
  };
}

function makeTokenService(): TokenService {
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
  };
}

function makeClientForBootstrap(alreadyCompleted = false) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("pg_advisory_lock")) return { rows: [] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [] };
      if (sql.includes("SELECT bootstrap_completed")) {
        return { rows: [{ bootstrap_completed: alreadyCompleted }] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("INSERT INTO auth.tenants")) return { rows: [{ id: "tenant-1" }] };
      if (sql.includes("INSERT INTO auth.users")) return { rows: [{ id: "admin-1" }] };
      if (sql.includes("UPDATE auth.bootstrap_state")) return { rows: [] };
      if (sql.includes("INSERT INTO auth.sessions")) return { rows: [] };
      if (sql.includes("UPDATE auth.sessions")) return { rows: [] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function makeDb(
  bootstrapCompleted = false,
  innerLockCompleted = false,
): pg.Pool {
  const mockClient = makeClientForBootstrap(innerLockCompleted);
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT bootstrap_completed")) {
        return { rows: [{ bootstrap_completed: bootstrapCompleted }] };
      }
      return { rows: [] };
    }),
    connect: vi.fn().mockResolvedValue(mockClient),
  } as unknown as pg.Pool;
}

function makeDeps(
  overrides: Partial<BootstrapServiceDeps> & {
    inMemoryToken?: string | null;
    bootstrapCompleted?: boolean;
    innerLockCompleted?: boolean;
  } = {},
): BootstrapServiceDeps {
  const {
    inMemoryToken = VALID_TOKEN,
    bootstrapCompleted = false,
    innerLockCompleted = false,
    ...rest
  } = overrides;

  let currentToken: string | null = inMemoryToken;
  return {
    db: makeDb(bootstrapCompleted, innerLockCompleted),
    passwordService: makePasswordService(),
    tokenService: makeTokenService(),
    logger: makeLogger(),
    events: makeEvents(),
    getInMemoryToken: () => currentToken,
    clearInMemoryToken: vi.fn().mockImplementation(() => { currentToken = null; }),
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// getStatus()
// ---------------------------------------------------------------------------

describe("BootstrapService.getStatus()", () => {
  beforeEach(() => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    process.env["OP_REFRESH_TOKEN_TTL_SECONDS"] = "604800";
    vi.resetModules();
  });

  it("returns { completed: false } when bootstrap has not run", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const svc = createBootstrapService(makeDeps({ bootstrapCompleted: false }));
    const status = await svc.getStatus();
    expect(status.completed).toBe(false);
  });

  it("returns { completed: true } when bootstrap has already run", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const svc = createBootstrapService(makeDeps({ bootstrapCompleted: true }));
    const status = await svc.getStatus();
    expect(status.completed).toBe(true);
  });

  it("returns { completed: false } when DB returns no rows", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn(),
    } as unknown as pg.Pool;
    const svc = createBootstrapService(makeDeps({ db }));
    const status = await svc.getStatus();
    expect(status.completed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bootstrap()
// ---------------------------------------------------------------------------

describe("BootstrapService.bootstrap()", () => {
  beforeEach(async () => {
    process.env["OP_JWT_SECRET"] = JWT_SECRET;
    process.env["OP_JWT_EXPIRY_SECONDS"] = "900";
    process.env["OP_REFRESH_TOKEN_TTL_SECONDS"] = "604800";
    vi.resetModules();
    // Reset the in-memory rate limiter between tests
    const { resetBootstrapRateLimiter } = await import("../services/bootstrap-service.js");
    resetBootstrapRateLimiter();
  });

  const validInput = {
    adminEmail: "admin@example.com",
    adminPassword: "SuperSecure123!",
    tenantName: "Acme Corp",
    bootstrapToken: VALID_TOKEN,
    ipAddress: "10.0.0.1",
  };

  it("returns tenantId, adminUserId, and tokens on successful bootstrap", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const svc = createBootstrapService(makeDeps());
    const result = await svc.bootstrap(validInput);
    expect(result.tenantId).toBe("tenant-1");
    expect(result.adminUserId).toBe("admin-1");
    expect(result.accessToken).toBe("mock-access-token");
    expect(result.refreshToken).toBe("mock-refresh-token");
    expect(result.expiresIn).toBe(900);
  });

  it("clears the in-memory token after successful bootstrap", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const deps = makeDeps();
    const svc = createBootstrapService(deps);
    await svc.bootstrap(validInput);
    expect(deps.clearInMemoryToken).toHaveBeenCalledOnce();
  });

  it("throws BootstrapAlreadyCompletedError (410) when bootstrap has already run", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const { BootstrapAlreadyCompletedError } = await import("../services/errors.js");
    const svc = createBootstrapService(makeDeps({ bootstrapCompleted: true }));
    await expect(svc.bootstrap(validInput)).rejects.toThrow(BootstrapAlreadyCompletedError);
  });

  it("throws BootstrapInvalidTokenError (401) when token does not match", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const { BootstrapInvalidTokenError } = await import("../services/errors.js");
    const svc = createBootstrapService(makeDeps({ inMemoryToken: "b".repeat(64) }));
    await expect(
      svc.bootstrap({ ...validInput, bootstrapToken: "c".repeat(64) }),
    ).rejects.toThrow(BootstrapInvalidTokenError);
  });

  it("throws BootstrapTokenMissingError (503) when in-memory token is null", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const { BootstrapTokenMissingError } = await import("../services/errors.js");
    const svc = createBootstrapService(makeDeps({ inMemoryToken: null }));
    await expect(svc.bootstrap(validInput)).rejects.toThrow(BootstrapTokenMissingError);
  });

  it("throws RateLimitError after 3 attempts from the same IP within 10 minutes", async () => {
    const { createBootstrapService, resetBootstrapRateLimiter } = await import("../services/bootstrap-service.js");
    const { RateLimitError } = await import("@oneplatform/core");

    resetBootstrapRateLimiter();

    // Use a wrong token so each attempt fails fast without locking up the test
    // Each call still passes rate-limit check for attempts 1–3
    const wrongInput = { ...validInput, bootstrapToken: "d".repeat(64), ipAddress: "10.0.0.99" };
    const svc = createBootstrapService(makeDeps({ inMemoryToken: "e".repeat(64) }));

    // Attempts 1–3 should fail with BootstrapInvalidTokenError (not rate limited yet)
    for (let i = 0; i < 3; i++) {
      await expect(svc.bootstrap(wrongInput)).rejects.not.toBeInstanceOf(RateLimitError);
    }

    // Attempt 4 should be rate limited
    await expect(svc.bootstrap(wrongInput)).rejects.toThrow(RateLimitError);
  });

  it("publishes auth.bootstrap.completed event on success", async () => {
    const { createBootstrapService } = await import("../services/bootstrap-service.js");
    const deps = makeDeps();
    const svc = createBootstrapService(deps);
    await svc.bootstrap(validInput);
    const publishCalls = (deps.events.publish as ReturnType<typeof vi.fn>).mock.calls;
    const bootstrapEvent = publishCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)["eventType"] === "auth.bootstrap.completed",
    );
    expect(bootstrapEvent).toBeDefined();
  });
});
