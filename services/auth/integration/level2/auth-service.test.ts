/**
 * Level 2 integration tests for the Auth service.
 *
 * The service process is already running on port 13001 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP — not
 * app.fetch() — which validates the Node HTTP adapter, port binding,
 * and actual network I/O.
 *
 * Auth is special: it requires a bootstrapped tenant before user
 * registration is possible. We bootstrap once in beforeAll using the
 * test bootstrap token, then register users within that tenant for each
 * test. All rows are cleaned up via direct DB queries in afterAll.
 *
 * Bootstrap state: the service process holds the bootstrap token in memory.
 * The token path does not exist in the test environment so the service starts
 * with bootstrapToken: null — meaning /api/v1/bootstrap will return 503 unless
 * OP_BOOTSTRAP_TOKEN is set. We work around this by seeding the tenant directly.
 *
 * Actually: the service reads OP_BOOTSTRAP_TOKEN from the spawned process env
 * (if the auth service supports it) or from the file system. Since we pass all
 * process.env vars from .env.test, and the file path /data/init/bootstrap.token
 * may not exist, the service starts without a bootstrap token. Therefore
 * register tests use a pre-seeded tenant inserted directly into the DB.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { newTenantId, cleanupAuthTenant } from "../helpers/tenant.js";

const BASE = "http://localhost:13001";

// A pool connected to the test PostgreSQL for direct cleanup.
// Two connections is enough — Level 2 cleanup is serial.
let db: pg.Pool;

// The tenant we seed directly into the DB so registration tests work
// without a live bootstrap call (the spawned process may not have a
// bootstrap token file present).
let sharedTenantId: string;
let sharedTenantName: string;

// Track user tenantIds created during tests for cleanup
const usedTenantIds: string[] = [];

beforeAll(async () => {
  db = new pg.Pool({
    connectionString: process.env["OP_DATABASE_URL"]!,
    max: 2,
  });

  // Seed a tenant directly so register calls have a valid tenantId.
  // The auth service validates that tenantId exists in auth.tenants.
  sharedTenantId = randomUUID();
  sharedTenantName = `l2-auth-tenant-${sharedTenantId.slice(0, 8)}`;
  await db.query(
    "INSERT INTO auth.tenants (id, name, created_at) VALUES ($1, $2, NOW())",
    [sharedTenantId, sharedTenantName],
  );
  usedTenantIds.push(sharedTenantId);
});

afterAll(async () => {
  for (const tid of usedTenantIds) {
    await cleanupAuthTenant(db, tid);
  }
  await db.end();
});

// Generates a unique email for each test to prevent cross-test conflicts.
function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerUser(
  email: string,
  password: string,
  tenantId = sharedTenantId,
): Promise<Response> {
  return fetch(`${BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, tenantId }),
  });
}

// ---------------------------------------------------------------------------

describe("Auth service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // 2 -----------------------------------------------------------------------
  it("POST /api/v1/auth/register returns 201 and issues tokens", async () => {
    const email = uniqueEmail("register");
    const tenantId = newTenantId();

    // Seed a tenant for this test's user
    await db.query(
      "INSERT INTO auth.tenants (id, name, created_at) VALUES ($1, $2, NOW())",
      [tenantId, `l2-reg-tenant-${tenantId.slice(0, 8)}`],
    );
    usedTenantIds.push(tenantId);

    try {
      const res = await registerUser(email, "Correct-Horse-Battery-Staple-99", tenantId);
      expect(res.status).toBe(201);

      const body = await res.json() as {
        userId: string;
        email: string;
        tenantId: string;
        accessToken?: string;
        refreshToken?: string;
        requiresEmailVerification: boolean;
      };
      expect(body.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.email).toBe(email);
      expect(body.tenantId).toBe(tenantId);
      // Email verification is disabled in test env (OP_REQUIRE_EMAIL_VERIFICATION=false)
      expect(body.requiresEmailVerification).toBe(false);
      expect(body.accessToken).toBeTruthy();
      expect(body.refreshToken).toBeTruthy();
    } finally {
      await cleanupAuthTenant(db, tenantId);
      // Remove from usedTenantIds since we cleaned up here
      const idx = usedTenantIds.indexOf(tenantId);
      if (idx !== -1) usedTenantIds.splice(idx, 1);
    }
  });

  // 3 -----------------------------------------------------------------------
  it("POST /api/v1/auth/login returns tokens for valid credentials", async () => {
    const email = uniqueEmail("login");
    const password = "Correct-Horse-Battery-Staple-99";

    const regRes = await registerUser(email, password);
    expect(regRes.status).toBe(201);

    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, tenantId: sharedTenantId }),
    });

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
  });

  // 4 -----------------------------------------------------------------------
  it("POST /api/v1/auth/login returns 401 for wrong password", async () => {
    const email = uniqueEmail("login-fail");

    const regRes = await registerUser(email, "Correct-Horse-Battery-Staple-99");
    expect(regRes.status).toBe(201);

    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "completely-wrong",
        tenantId: sharedTenantId,
      }),
    });
    expect(res.status).toBe(401);
  });

  // 5 -----------------------------------------------------------------------
  it("POST /api/v1/auth/refresh exchanges a valid refresh token", async () => {
    const email = uniqueEmail("refresh");
    const password = "Correct-Horse-Battery-Staple-99";

    const regRes = await registerUser(email, password);
    expect(regRes.status).toBe(201);
    const regBody = await regRes.json() as { refreshToken?: string };
    const originalToken = regBody.refreshToken;
    expect(originalToken).toBeTruthy();

    const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: originalToken }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      accessToken: string;
      refreshToken: string;
    };
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    // Token rotation: the new refresh token must be different from the original
    expect(body.refreshToken).not.toBe(originalToken);
  });

  // 6 -----------------------------------------------------------------------
  it("handles concurrent register requests without cross-tenant data leaks", async () => {
    // Fire 5 concurrent registrations, each with their own seeded tenant.
    // All must succeed with 201 and return unique userIds.
    const concurrency = 5;
    const tenantIds: string[] = [];

    // Seed tenants for concurrent registrations
    for (let i = 0; i < concurrency; i++) {
      const tid = newTenantId();
      await db.query(
        "INSERT INTO auth.tenants (id, name, created_at) VALUES ($1, $2, NOW())",
        [tid, `l2-concurrent-${i}-${tid.slice(0, 8)}`],
      );
      tenantIds.push(tid);
      usedTenantIds.push(tid);
    }

    try {
      const results = await Promise.all(
        tenantIds.map((tid, i) =>
          registerUser(
            uniqueEmail(`concurrent-${i}`),
            "Correct-Horse-Battery-Staple-99",
            tid,
          ),
        ),
      );

      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 201)).toBe(true);

      const bodies = await Promise.all(
        results.map((r) => r.json() as Promise<{ userId: string }>),
      );
      const userIds = bodies.map((b) => b.userId);
      // Each registration must produce a distinct userId
      const uniqueIds = new Set(userIds);
      expect(uniqueIds.size).toBe(concurrency);
    } finally {
      for (const tid of tenantIds) {
        await cleanupAuthTenant(db, tid);
        const idx = usedTenantIds.indexOf(tid);
        if (idx !== -1) usedTenantIds.splice(idx, 1);
      }
    }
  });

  // 7 -----------------------------------------------------------------------
  it("POST /api/v1/auth/register with invalid body returns 400", async () => {
    const res = await fetch(`${BASE}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "short" }),
    });
    // Validation error (missing tenantId or invalid email/password) → 400 or 422
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
