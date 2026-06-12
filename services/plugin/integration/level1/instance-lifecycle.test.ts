/**
 * Level 1 integration tests for the Plugin service — instance lifecycle.
 *
 * Routes exercised:
 *   POST  /api/v1/plugins/:id/instances              — create instance for tenant
 *   PATCH /api/v1/plugins/:id/instances/:instanceId  — enable/disable/update
 *   GET   /api/v1/plugins/:id/instances              — list instances
 *
 * Because installing a plugin at Level 1 requires MinIO bundle storage,
 * these tests insert a minimal plugin row directly into the database to
 * avoid the bundle upload dependency. The plugin row represents a valid
 * installed plugin that instances can be created against.
 *
 * RLS: plugin service has no RLS policies. Isolation relies on per-test
 * tenantId UUIDs. Cleanup deletes hooks and instances for the test tenant.
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

// A plugin row inserted directly into the DB for all instance tests.
// Uses a stable manifest_id per test run (cleaned up in afterAll).
let sharedPluginId: string;
const sharedManifestId = `com.test.fixture-${randomUUID().split("-")[0] ?? "x"}`;
const sharedUserId = randomUUID();

beforeAll(async () => {
  const result = await buildTestApp();
  app = result.app;
  cleanup = result.cleanup;

  pool = new pg.Pool({
    connectionString: process.env["OP_DATABASE_URL"]!,
    max: 3,
  });

  // Insert a minimal plugin row so instance tests have a real FK target.
  // The manifest content is minimal valid JSON — no bundle is needed.
  const manifest = {
    manifestVersion: "1",
    id: sharedManifestId,
    name: "Test Fixture Plugin",
    version: "1.0.0",
    type: "transformer",
    description: "Fixture plugin for Level 1 integration tests",
    author: "test",
    minPlatformVersion: "1.0.0",
    entrypoint: "index.js",
    configSchema: {},
    hooks: [],
    requiredExternalUrls: [],
    requiredApis: [],
    requiredCredentials: [],
    bundleChecksum: "a".repeat(64),
    license: "MIT",
  };

  const result2 = await pool.query<{ id: string }>(
    `INSERT INTO plugin.plugins
       (manifest_id, name, version, type, status, bundle_bucket, manifest, is_platform_wide, installed_by)
     VALUES ($1, $2, $3, $4, 'active', 'plugin-bundles', $5, false, $6)
     RETURNING id`,
    [
      sharedManifestId,
      "Test Fixture Plugin",
      "1.0.0",
      "transformer",
      JSON.stringify(manifest),
      sharedUserId,
    ],
  );
  const row = result2.rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert fixture plugin row");
  }
  sharedPluginId = row.id;
});

afterAll(async () => {
  // Remove all instances and hooks created during these tests (across all tenants),
  // then delete the fixture plugin row.
  await pool.query(
    "DELETE FROM plugin.hooks WHERE plugin_id = $1",
    [sharedPluginId],
  );
  await pool.query(
    "DELETE FROM plugin.instances WHERE plugin_id = $1",
    [sharedPluginId],
  );
  await pool.query(
    "DELETE FROM plugin.approved_urls WHERE plugin_id = $1",
    [sharedPluginId],
  );
  await pool.query(
    "DELETE FROM plugin.plugins WHERE id = $1",
    [sharedPluginId],
  );
  await cleanup();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetch(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

interface InstanceBody {
  instanceId: string;
  pluginManifestId: string;
  tenantId: string;
  displayName: string;
  enabled: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// POST /:id/instances — create instance
// ---------------------------------------------------------------------------

describe("Plugin service — create instance", () => {
  it("POST /api/v1/plugins/:id/instances creates an instance for the tenant", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);

    try {
      const res = await fetch(`/api/v1/plugins/${sharedPluginId}/instances`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: "My Plugin Instance",
          config: { key: "value" },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as InstanceBody;
      expect(body.instanceId).toBeTruthy();
      expect(body.tenantId).toBe(tenantId);
      expect(body.displayName).toBe("My Plugin Instance");
      // Instances start disabled (not yet enabled)
      expect(body.enabled).toBe("disabled");
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });

  it("POST /api/v1/plugins/:id/instances returns 401 without a token", async () => {
    const res = await fetch(`/api/v1/plugins/${sharedPluginId}/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Unauthed Instance" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/v1/plugins/:id/instances returns 400 for missing displayName", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);

    try {
      const res = await fetch(`/api/v1/plugins/${sharedPluginId}/instances`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ config: {} }),  // displayName is required
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
// PATCH /:id/instances/:instanceId — enable/disable
// ---------------------------------------------------------------------------

describe("Plugin service — enable and disable instance", () => {
  it("PATCH /api/v1/plugins/:id/instances/:instanceId enables an instance", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);

    try {
      // Create instance
      const createRes = await fetch(`/api/v1/plugins/${sharedPluginId}/instances`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Enable Me Instance" }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as InstanceBody;
      const instanceId = created.instanceId;

      // Enable via PATCH
      const patchRes = await fetch(
        `/api/v1/plugins/${sharedPluginId}/instances/${instanceId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as {
        instanceId: string;
        enabled: string;
      };
      expect(patched.instanceId).toBe(instanceId);
      // enabled field is a string enum per the DB schema
      expect(patched.enabled).toBe("enabled");
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });

  it("PATCH /api/v1/plugins/:id/instances/:instanceId returns 401 without a token", async () => {
    const fakeInstanceId = randomUUID();
    const res = await fetch(
      `/api/v1/plugins/${sharedPluginId}/instances/${fakeInstanceId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/instances — list instances
// ---------------------------------------------------------------------------

describe("Plugin service — list instances", () => {
  it("GET /api/v1/plugins/:id/instances returns the tenant's instances", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);

    try {
      // Create an instance
      const createRes = await fetch(`/api/v1/plugins/${sharedPluginId}/instances`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Listed Instance" }),
      });
      expect(createRes.status).toBe(201);

      const listRes = await fetch(`/api/v1/plugins/${sharedPluginId}/instances`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as {
        items: { tenantId: string; displayName: string }[];
      };
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThanOrEqual(1);

      const ours = body.items.find((i) => i.displayName === "Listed Instance");
      expect(ours).toBeDefined();
      // Tenant isolation — every item belongs to this tenant (non-admin view)
      for (const item of body.items) {
        expect(item.tenantId).toBe(tenantId);
      }
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });

  it("RLS isolation: tenant A cannot see tenant B's instances via list", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();
    const tokenA = await createTestToken(tenantA);
    const tokenB = await createTestToken(tenantB);

    try {
      // Tenant A creates an instance
      const createRes = await fetch(`/api/v1/plugins/${sharedPluginId}/instances`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenA}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Tenant A Instance" }),
      });
      expect(createRes.status).toBe(201);

      // Tenant B lists instances — must not see Tenant A's instance
      const listRes = await fetch(`/api/v1/plugins/${sharedPluginId}/instances`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      expect(listRes.status).toBe(200);
      const body = (await listRes.json()) as {
        items: { tenantId: string }[];
      };
      const tenantAInstances = body.items.filter((i) => i.tenantId === tenantA);
      expect(tenantAInstances).toHaveLength(0);
    } finally {
      await cleanupPluginTenant(pool, tenantA);
      await cleanupPluginTenant(pool, tenantB);
    }
  });
});
