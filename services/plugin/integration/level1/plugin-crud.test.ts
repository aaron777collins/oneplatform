/**
 * Level 1 integration tests for the Plugin service — plugin CRUD.
 *
 * Routes exercised (all under /api/v1/plugins):
 *   GET  /       — list plugins (public, no auth required)
 *   GET  /:id    — get plugin detail (public, no auth required)
 *   POST /       — install plugin (requires platform-admin + multipart bundle)
 *   DELETE /:id  — uninstall plugin (requires platform-admin)
 *
 * IMPORTANT STARTUP CONSTRAINT:
 * The plugin service calls bundleService.ensureBucket() during startup
 * regardless of skipMinioVerification. buildTestApp() requires MinIO to be
 * reachable at the configured endpoint. Run these tests in environments where
 * MinIO (or a compatible S3 server) is available.
 *
 * POST / (install) requires a multipart .oppkg bundle. At Level 1 the bundle
 * upload path is exercised for validation shape only — MinIO upload will fail
 * if the plugin manifest bundle is invalid. Full install is tested at Level 2+.
 *
 * Plugin.plugins is a platform-wide table with no tenant_id.
 * We clean up by manifest_id prefix after each test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupPluginTenant } from "../helpers/tenant.js";
import { createTestToken } from "../helpers/auth.js";

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

type App = Awaited<ReturnType<typeof buildTestApp>>["app"];

let app: App;
let cleanup: () => Promise<void>;
let pool: pg.Pool;

beforeAll(async () => {
  const result = await buildTestApp();
  app = result.app;
  cleanup = result.cleanup;

  pool = new pg.Pool({
    connectionString: process.env["OP_DATABASE_URL"]!,
    max: 3,
  });
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetch(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

// ---------------------------------------------------------------------------
// GET / — list plugins (public)
// ---------------------------------------------------------------------------

describe("Plugin service — list plugins", () => {
  it("GET /api/v1/plugins returns 200 with items array (no auth required)", async () => {
    const res = await fetch("/api/v1/plugins");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      nextCursor: string | null;
      total: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.nextCursor === null || typeof body.nextCursor === "string").toBe(true);
  });

  it("GET /api/v1/plugins accepts type query param", async () => {
    const res = await fetch("/api/v1/plugins?type=connector");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { type: string }[] };
    // All returned items must match the type filter
    for (const item of body.items) {
      expect(item.type).toBe("connector");
    }
  });

  it("GET /api/v1/plugins returns 400 for invalid type param", async () => {
    const res = await fetch("/api/v1/plugins?type=invalid-type-xyz");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// GET /:id — get plugin detail (public)
// ---------------------------------------------------------------------------

describe("Plugin service — get plugin detail", () => {
  it("GET /api/v1/plugins/:id returns error for a non-existent plugin ID", async () => {
    const fakeId = randomUUID();
    const res = await fetch(`/api/v1/plugins/${fakeId}`);
    // The route calls pluginService.getPlugin which should throw PluginNotFoundError
    // The core error handler maps this to a non-2xx response
    expect(res.status).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST / — install plugin (requires platform-admin, multipart form)
// ---------------------------------------------------------------------------

describe("Plugin service — install plugin auth enforcement", () => {
  it("POST /api/v1/plugins returns 403 when user lacks platform-admin role", async () => {
    const tenantId = newTenantId();
    // Regular tenant-admin, NOT platform-admin
    const token = await createTestToken(tenantId, { roles: ["tenant-admin"] });

    try {
      // Send a minimal multipart request — the auth check runs before bundle validation
      const formData = new FormData();
      formData.append("approveUrls", "false");

      const res = await fetch("/api/v1/plugins", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FORBIDDEN");
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });

  it("POST /api/v1/plugins returns 401 without a token", async () => {
    const formData = new FormData();
    formData.append("approveUrls", "false");

    const res = await fetch("/api/v1/plugins", {
      method: "POST",
      body: formData,
    });
    // No token → 401 from auth middleware
    expect(res.status).toBe(401);
  });

  it("POST /api/v1/plugins returns 400 when bundle field is missing", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId, { roles: ["platform-admin"] });

    try {
      // platform-admin token, but no bundle field
      const formData = new FormData();
      formData.append("approveUrls", "false");

      const res = await fetch("/api/v1/plugins", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /:id — uninstall plugin (requires platform-admin)
// ---------------------------------------------------------------------------

describe("Plugin service — uninstall plugin auth enforcement", () => {
  it("DELETE /api/v1/plugins/:id returns 403 when user lacks platform-admin role", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId, { roles: ["tenant-admin"] });
    const fakeId = randomUUID();

    try {
      const res = await fetch(`/api/v1/plugins/${fakeId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });

  it("DELETE /api/v1/plugins/:id returns 401 without a token", async () => {
    const fakeId = randomUUID();
    const res = await fetch(`/api/v1/plugins/${fakeId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
