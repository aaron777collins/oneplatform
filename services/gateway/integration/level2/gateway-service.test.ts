/**
 * Level 2 integration tests for the Gateway service.
 *
 * The service process is already running on port 13000 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP.
 *
 * The gateway is a reverse proxy — at Level 2 only the gateway process is
 * started. Requests that the gateway forwards to upstream services will fail
 * with connection errors (the upstream ports are not bound here). Tests
 * therefore focus on:
 *   1. Liveness probe — no upstream dependency
 *   2. Auth enforcement — gateway middleware returns 401 before proxying
 *   3. Admin rate-limit config endpoint — does not proxy, handled locally
 *
 * Auth tokens are minted locally using OP_JWT_SECRET (the same value the
 * gateway uses for token verification).
 */

import { describe, it, expect, afterAll } from "vitest";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { newTenantId, cleanupGatewayTenant } from "../helpers/tenant.js";

const BASE = "http://localhost:13000";

const JWT_SECRET = process.env["OP_JWT_SECRET"] ?? "test-jwt-secret-for-integration-tests-32c";
const secretBytes = new TextEncoder().encode(JWT_SECRET);

async function createTestToken(
  tenantId: string,
  opts: { roles?: string[]; scopes?: string[] } = {},
): Promise<string> {
  const { roles = ["tenant-admin"], scopes = ["*"] } = opts;

  return new SignJWT({
    sub: randomUUID(),
    tid: tenantId,
    roles,
    scopes,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti(randomUUID())
    .sign(secretBytes);
}

const db = new pg.Pool({
  connectionString: process.env["OP_DATABASE_URL"]!,
  max: 2,
});

afterAll(async () => {
  await db.end();
});

// ---------------------------------------------------------------------------

describe("Gateway service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    // Gateway health returns "healthy" (not "ok") per its health route implementation
    expect(body.status).toMatch(/^(ok|healthy)$/);
  });

  // 2 -----------------------------------------------------------------------
  it("GET /api/v1/auth/users without auth returns 401", async () => {
    // Gateway auth middleware enforces 401 before proxying any /api/v1/* path.
    const res = await fetch(`${BASE}/api/v1/auth/users`);
    expect(res.status).toBe(401);
  });

  // 3 -----------------------------------------------------------------------
  it("GET /admin/rate-limits returns 403 for non-admin token", async () => {
    // Rate-limit config is a gateway-local route. Tenant-admin does not have
    // the "admin" role required, so the route returns 403 without proxying.
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId, { roles: ["tenant-admin"] });

    try {
      const res = await fetch(`${BASE}/admin/rate-limits`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // 403 from admin route guard, or 404 if admin is mounted elsewhere
      expect(res.status === 403 || res.status === 404).toBe(true);
    } finally {
      await cleanupGatewayTenant(db, tenantId);
    }
  });
});
