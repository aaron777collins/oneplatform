/**
 * Level 1 integration tests: Auth service registration and login flow.
 *
 * Registration (POST /api/v1/auth/register) requires an existing tenant — the
 * service enforces that tenantId maps to a real row in auth.tenants. We create
 * one tenant via bootstrap in beforeAll and share it across tests in this file.
 *
 * WHY share a tenant: each test registers its own user with a unique email
 * derived from the test's tenantId, so tests are isolated within the shared
 * tenant without needing repeated bootstrap/teardown cycles. The shared tenant
 * is cleaned up in afterAll along with all users registered during the suite.
 *
 * Rate-limit test: the bootstrap rate limiter is per-service-process and in
 * a separate module-level Map. The login rate limiter (Redis-backed) uses a
 * key per email+tenantId, so tests that exhaust the limit must use a unique
 * email that no other test in the suite uses.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createServiceApp } from "../../dist/index.js";
import { newTenantId, cleanupAuthTenant, resetBootstrapState } from "../helpers/tenant.js";

const VALID_BOOTSTRAP_TOKEN = "a".repeat(64);

// ---------------------------------------------------------------------------
// Shared state for the suite
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof createServiceApp>>["app"];
let cleanup: () => Promise<void>;
let db: pg.Pool;

/** The tenant created by bootstrap — used for all register/login calls. */
let sharedTenantId: string;

/** Tracks all tenantIds used so cleanup removes all rows. */
const usedTenantIds: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerUser(email: string, password: string) {
  return app.fetch(
    new Request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        tenantId: sharedTenantId,
      }),
    }),
  );
}

async function loginUser(email: string, password: string) {
  return app.fetch(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        tenantId: sharedTenantId,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------

describe("Auth service — login flow", () => {
  beforeAll(async () => {
    db = new pg.Pool({
      connectionString: process.env["OP_DATABASE_URL"]!,
      max: 3,
      idleTimeoutMillis: 10_000,
    });

    // Reset bootstrap state so we get a clean starting point
    await resetBootstrapState(db);

    // Build a fresh service app with the test bootstrap token pre-loaded
    const result = await createServiceApp({
      databaseUrl: process.env["OP_DATABASE_URL"]!,
      redisUrl: process.env["OP_REDIS_URL"]!,
      jwtSecret: process.env["OP_JWT_SECRET"]!,
      masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
      allowedOrigins: ["http://localhost:3000"],
      bootstrapToken: VALID_BOOTSTRAP_TOKEN,
    });
    app = result.app;
    cleanup = result.cleanup;

    // Bootstrap creates the first tenant so we have a tenantId for register calls
    const bootstrapRes = await app.fetch(
      new Request("http://localhost/api/v1/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminEmail: "admin@login-flow-test.example.com",
          adminPassword: "Correct-Horse-Battery-Staple-99",
          tenantName: `login-flow-test-${Date.now()}`,
          bootstrapToken: VALID_BOOTSTRAP_TOKEN,
        }),
      }),
    );

    if (bootstrapRes.status !== 201) {
      const text = await bootstrapRes.text();
      throw new Error(`Bootstrap failed (${bootstrapRes.status}): ${text}`);
    }

    const bootstrapBody = await bootstrapRes.json() as {
      tenantId: string;
    };
    sharedTenantId = bootstrapBody.tenantId;

    usedTenantIds.push(sharedTenantId);
  });

  afterAll(async () => {
    await cleanup();

    // Reset bootstrap_state FK references before deleting the tenant rows
    await resetBootstrapState(db);
    for (const tid of usedTenantIds) {
      await cleanupAuthTenant(db, tid);
    }
    await db.end();
  });

  // -------------------------------------------------------------------------

  it("registers a user and returns tokens when email verification is disabled", async () => {
    // OP_REQUIRE_EMAIL_VERIFICATION defaults to false in .env.test so tokens
    // are returned immediately without a verify step.
    const email = uniqueEmail("register");

    const res = await registerUser(email, "Correct-Horse-Battery-Staple-99");

    expect(res.status).toBe(201);
    const body = await res.json() as {
      userId: string;
      email: string;
      tenantId: string;
      roles: string[];
      requiresEmailVerification: boolean;
      accessToken?: string;
      refreshToken?: string;
    };

    expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.email).toBe(email);
    expect(body.tenantId).toBe(sharedTenantId);
    expect(body.requiresEmailVerification).toBe(false);
    // Tokens present when email verification is not required
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
  });

  // -------------------------------------------------------------------------

  it("POST /api/v1/auth/login with correct password returns tokens", async () => {
    const email = uniqueEmail("login-ok");
    const password = "Correct-Horse-Battery-Staple-99";

    // Register first
    const regRes = await registerUser(email, password);
    expect(regRes.status).toBe(201);

    const res = await loginUser(email, password);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      tokenType: string;
      user: { id: string; email: string; tenantId: string };
    };

    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.tokenType).toBe("Bearer");
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.user.email).toBe(email);
    expect(body.user.tenantId).toBe(sharedTenantId);
  });

  // -------------------------------------------------------------------------

  it("POST /api/v1/auth/login with wrong password returns 401", async () => {
    const email = uniqueEmail("login-fail");

    // Register first
    const regRes = await registerUser(email, "Correct-Horse-Battery-Staple-99");
    expect(regRes.status).toBe(201);

    const res = await loginUser(email, "absolutely-wrong-password");

    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------

  it("POST /api/v1/auth/refresh rotates the refresh token", async () => {
    const email = uniqueEmail("refresh");
    const password = "Correct-Horse-Battery-Staple-99";

    const regRes = await registerUser(email, password);
    expect(regRes.status).toBe(201);
    const regBody = await regRes.json() as { refreshToken?: string };
    const originalRefreshToken = regBody.refreshToken;
    expect(originalRefreshToken).toBeTruthy();

    const res = await app.fetch(
      new Request("http://localhost/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: originalRefreshToken }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    };

    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    // Rotated token must differ from the original
    expect(body.refreshToken).not.toBe(originalRefreshToken);
  });

  // -------------------------------------------------------------------------

  it("POST /api/v1/auth/logout invalidates the session", async () => {
    const email = uniqueEmail("logout");
    const password = "Correct-Horse-Battery-Staple-99";

    const regRes = await registerUser(email, password);
    expect(regRes.status).toBe(201);
    const regBody = await regRes.json() as {
      accessToken?: string;
      refreshToken?: string;
    };
    const accessToken = regBody.accessToken;
    const refreshToken = regBody.refreshToken;
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();

    // Logout requires a valid Bearer token (route is not in publicRoutes)
    const logoutRes = await app.fetch(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ refreshToken }),
      }),
    );

    expect(logoutRes.status).toBe(204);

    // The original refresh token must now be rejected
    const refreshRes = await app.fetch(
      new Request("http://localhost/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      }),
    );

    // Revoked token returns 401
    expect(refreshRes.status).toBe(401);
  });

  // -------------------------------------------------------------------------

  it("register with duplicate email within tenant returns 409", async () => {
    const email = uniqueEmail("duplicate");
    const password = "Correct-Horse-Battery-Staple-99";

    const first = await registerUser(email, password);
    expect(first.status).toBe(201);

    const second = await registerUser(email, password);
    expect(second.status).toBe(409);
  });

  // -------------------------------------------------------------------------

  it("register with non-existent tenantId returns 404", async () => {
    const fakeTenantId = newTenantId();

    const res = await app.fetch(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: uniqueEmail("no-tenant"),
          password: "Correct-Horse-Battery-Staple-99",
          tenantId: fakeTenantId,
        }),
      }),
    );

    // TenantNotFoundError maps to 404
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------

  it("account locks after 10 failed login attempts (returns 403)", async () => {
    // The auth service increments failed_login_count on each bad password and
    // locks the account when the count reaches 10 (locked_until = now + 15 min).
    // Subsequent login attempts return AccountLockedError (statusCode 403).
    const email = uniqueEmail("lockout");
    const password = "Correct-Horse-Battery-Staple-99";

    const regRes = await registerUser(email, password);
    expect(regRes.status).toBe(201);

    // Exhaust the failure threshold (10 attempts with the wrong password)
    for (let i = 0; i < 10; i++) {
      const res = await loginUser(email, "wrong-password");
      // Drain body to prevent connection pool exhaustion
      await res.text();
    }

    // The 11th attempt should hit the locked account path (403)
    const lockedRes = await loginUser(email, "wrong-password");
    expect(lockedRes.status).toBe(403);

    const body = await lockedRes.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("AUTH_ACCOUNT_LOCKED");
  });
});
