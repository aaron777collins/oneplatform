/**
 * Level 2 integration tests for the Logging service.
 *
 * The service process is already running on port 13007 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP.
 *
 * Auth tokens are minted locally with jose (same secret as the running
 * service) to avoid depending on the auth service being active.
 *
 * The logging service exposes:
 *   GET  /healthz               — liveness probe (public)
 *   GET  /api/v1/logs           — query log events (requires logs:read or admin scope)
 *   GET  /api/v1/audit-events   — query audit events (requires audit:read or admin scope)
 *
 * Tests use the "admin" scope to pass scope guards without needing per-route
 * scope configuration.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { newTenantId, cleanupLoggingTenant } from "../helpers/tenant.js";
import { mintTestToken } from "../helpers/jwt.js";

const BASE = "http://localhost:13007";

const db = new pg.Pool({
  connectionString: process.env["OP_DATABASE_URL"]!,
  max: 2,
});

afterAll(async () => {
  await db.end();
});

// ---------------------------------------------------------------------------

describe("Logging service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // 2 -----------------------------------------------------------------------
  it("GET /api/v1/logs without auth returns 401", async () => {
    const res = await fetch(`${BASE}/api/v1/logs`);
    expect(res.status).toBe(401);
  });

  // 3 -----------------------------------------------------------------------
  it("GET /api/v1/logs returns paginated log events with a valid token", async () => {
    const tenantId = newTenantId();
    const token = await mintTestToken({
      tenantId,
      roles: ["platform-admin"],
      scopes: ["admin"],
    });

    try {
      const res = await fetch(`${BASE}/api/v1/logs`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: unknown[];
        pagination: { cursor: string | null; limit: number; hasMore: boolean };
      };
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.pagination.limit).toBe("number");
    } finally {
      await cleanupLoggingTenant(db, tenantId);
    }
  });
});
