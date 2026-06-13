/**
 * Level 2 integration tests for the App service.
 *
 * The service process is already running on port 13006 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP.
 *
 * Auth tokens are minted locally with jose (same secret as the running
 * service) to avoid depending on the auth service being active.
 *
 * Isolation: the app service has no RLS — tenant isolation relies on unique
 * tenant UUIDs and explicit cleanup. Each test cleans up in a finally block.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { newTenantId, cleanupAppTenant } from "../helpers/tenant.js";
import { createTestToken } from "../helpers/auth.js";

const BASE = "http://localhost:13006";

const db = new pg.Pool({
  connectionString: process.env["OP_DATABASE_URL"]!,
  max: 2,
});

afterAll(async () => {
  await db.end();
});

// ---------------------------------------------------------------------------

describe("App service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // 2 -----------------------------------------------------------------------
  it("GET /api/v1/apps without auth returns 401", async () => {
    const res = await fetch(`${BASE}/api/v1/apps`);
    expect(res.status).toBe(401);
  });

  // 3 -----------------------------------------------------------------------
  it("POST /api/v1/apps creates an app and returns its id", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId, { roles: ["tenant-admin"] });

    try {
      const res = await fetch(`${BASE}/api/v1/apps`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: `L2 Test App ${tenantId.slice(0, 8)}`,
          slug: `l2-test-${tenantId.slice(0, 8)}`,
          accessMode: "private",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as {
        data: { id: string; name: string; tenantId: string; accessMode: string };
      };
      expect(body.data.id).toBeTruthy();
      expect(body.data.name).toContain(tenantId.slice(0, 8));
      expect(body.data.tenantId).toBe(tenantId);
      expect(body.data.accessMode).toBe("private");
    } finally {
      await cleanupAppTenant(db, tenantId);
    }
  });
});
