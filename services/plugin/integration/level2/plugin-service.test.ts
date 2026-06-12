/**
 * Level 2 integration tests for the Plugin service.
 *
 * The service process is already running on port 13008 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP.
 *
 * The plugin service uses /health/live (not /healthz) as its liveness probe.
 *
 * Plugin.plugins is a platform-wide table with no tenant_id. Cleanup for
 * plugin rows uses the manifest_id. Instances and hooks tables have tenant_id
 * and are cleaned up via cleanupPluginTenant.
 *
 * Auth: GET /api/v1/plugins goes through the auth middleware. Even though
 * the route handler does not check roles, the middleware requires either a
 * Bearer token or X-API-Key (the route is not in publicRoutes). We pass a
 * token with tenant-admin role for read calls. POST requires platform-admin.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { newTenantId, cleanupPluginTenant } from "../helpers/tenant.js";
import { createTestToken } from "../helpers/auth.js";

const BASE = "http://localhost:13008";

const db = new pg.Pool({
  connectionString: process.env["OP_DATABASE_URL"]!,
  max: 2,
});

afterAll(async () => {
  await db.end();
});

// ---------------------------------------------------------------------------

describe("Plugin service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /health/live returns 200", async () => {
    const res = await fetch(`${BASE}/health/live`);
    expect(res.status).toBe(200);
  });

  // 2 -----------------------------------------------------------------------
  it("GET /api/v1/plugins returns list with a valid token", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId, { roles: ["tenant-admin"] });

    const res = await fetch(`${BASE}/api/v1/plugins`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: unknown[];
      nextCursor: string | null;
      total: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    // nextCursor is null when there are no more pages
    expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true);
  });

  // 3 -----------------------------------------------------------------------
  it("GET /api/v1/plugins without auth returns 401", async () => {
    // The route is not in publicRoutes — auth middleware enforces 401.
    const res = await fetch(`${BASE}/api/v1/plugins`);
    expect(res.status).toBe(401);
  });

  // 4 -----------------------------------------------------------------------
  it("POST /api/v1/plugins returns 403 for tenant-admin (not platform-admin)", async () => {
    const tenantId = newTenantId();
    // Regular tenant-admin — the route handler checks for platform-admin role
    const token = await createTestToken(tenantId, { roles: ["tenant-admin"] });

    const formData = new FormData();
    formData.append("approveUrls", "false");

    const res = await fetch(`${BASE}/api/v1/plugins`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  // 5 -----------------------------------------------------------------------
  it("POST /api/v1/plugins returns 401 without a token", async () => {
    const formData = new FormData();
    formData.append("approveUrls", "false");

    const res = await fetch(`${BASE}/api/v1/plugins`, {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(401);
  });

  // 6 -----------------------------------------------------------------------
  it(
    "POST /api/v1/plugins returns 400 for platform-admin with missing bundle field",
    async () => {
      const tenantId = newTenantId();
      const token = await createTestToken(tenantId, { roles: ["platform-admin"] });

      try {
        // Send a multipart form without the required bundle file —
        // auth check passes, then validation fails on the missing bundle.
        const formData = new FormData();
        formData.append("approveUrls", "false");

        const res = await fetch(`${BASE}/api/v1/plugins`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        // Missing bundle field → 400 validation error
        expect(res.status).toBe(400);
      } finally {
        await cleanupPluginTenant(db, tenantId);
      }
    },
  );

  // 7 -----------------------------------------------------------------------
  it("GET /api/v1/plugins accepts type query parameter", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId, { roles: ["tenant-admin"] });

    const res = await fetch(`${BASE}/api/v1/plugins?type=connector`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ type: string }> };
    // All returned items must match the type filter
    for (const item of body.items) {
      expect(item.type).toBe("connector");
    }
  });
});
