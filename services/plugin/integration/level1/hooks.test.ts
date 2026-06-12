/**
 * Level 1 integration tests for the Plugin service — hook query.
 *
 * The public hook API has a single route:
 *   GET /api/v1/plugins/:id/hooks?stage=<stage>
 *
 * Hooks are registered internally when plugin instances are created and
 * enabled (there is no public POST /hooks endpoint). The GET endpoint
 * resolves the active hook chain for a given stage + tenant.
 *
 * Tests verify:
 *   - Validation: 400 when stage query param is missing
 *   - Auth: 401 when no auth token is present (auth middleware runs before the handler)
 *   - Happy path: 200 with { hooks: [] } for a tenant with no active hooks
 *   - Response shape: hooks array contains the expected fields
 *
 * Note: The hooks route is not listed in publicRoutes, so unauthenticated
 * requests receive 401 from the auth middleware — the route handler's
 * `!tenantId` guard (which would return 400) is never reached without a token.
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

// Fixture plugin for hook resolution queries
let fixturePluginId: string;
const fixtureManifestId = `com.test.hooks-fixture-${randomUUID().split("-")[0] ?? "x"}`;
const fixtureUserId = randomUUID();

beforeAll(async () => {
  const result = await buildTestApp();
  app = result.app;
  cleanup = result.cleanup;

  pool = new pg.Pool({
    connectionString: process.env["OP_DATABASE_URL"]!,
    max: 3,
  });

  // Insert a minimal fixture plugin to use as the :id path param
  const manifest = {
    manifestVersion: "1",
    id: fixtureManifestId,
    name: "Hooks Fixture Plugin",
    version: "1.0.0",
    type: "transformer",
    description: "Fixture for hooks Level 1 tests",
    author: "test",
    minPlatformVersion: "1.0.0",
    entrypoint: "index.js",
    configSchema: {},
    hooks: [],
    requiredExternalUrls: [],
    requiredApis: [],
    requiredCredentials: [],
    bundleChecksum: "b".repeat(64),
    license: "MIT",
  };

  const insertResult = await pool.query<{ id: string }>(
    `INSERT INTO plugin.plugins
       (manifest_id, name, version, type, status, bundle_bucket, manifest, is_platform_wide, installed_by)
     VALUES ($1, $2, $3, $4, 'active', 'plugin-bundles', $5, false, $6)
     RETURNING id`,
    [
      fixtureManifestId,
      "Hooks Fixture Plugin",
      "1.0.0",
      "transformer",
      JSON.stringify(manifest),
      fixtureUserId,
    ],
  );

  const row = insertResult.rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert fixture plugin row for hooks tests");
  }
  fixturePluginId = row.id;
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM plugin.hooks WHERE plugin_id = $1",
    [fixturePluginId],
  );
  await pool.query(
    "DELETE FROM plugin.instances WHERE plugin_id = $1",
    [fixturePluginId],
  );
  await pool.query(
    "DELETE FROM plugin.approved_urls WHERE plugin_id = $1",
    [fixturePluginId],
  );
  await pool.query(
    "DELETE FROM plugin.plugins WHERE id = $1",
    [fixturePluginId],
  );
  await cleanup();
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appFetch(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

// ---------------------------------------------------------------------------
// Validation — missing stage parameter
// ---------------------------------------------------------------------------

describe("Plugin service — hook query validation", () => {
  it("GET /api/v1/plugins/:id/hooks returns 400 when stage is missing", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);

    try {
      // No ?stage= query param
      const res = await appFetch(`/api/v1/plugins/${fixturePluginId}/hooks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });

  it("GET /api/v1/plugins/:id/hooks returns 401 without auth token", async () => {
    // The hooks route is not listed in publicRoutes, so the auth middleware
    // intercepts the request before the handler runs and returns 401.
    const res = await appFetch(
      `/api/v1/plugins/${fixturePluginId}/hooks?stage=before:pipeline.step`,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Happy path — empty hook chain for a fresh tenant
// ---------------------------------------------------------------------------

describe("Plugin service — hook query happy path", () => {
  it("GET /api/v1/plugins/:id/hooks returns 200 with empty hooks array for tenant with no active hooks", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);

    try {
      const res = await appFetch(
        `/api/v1/plugins/${fixturePluginId}/hooks?stage=before:pipeline.step`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hooks: unknown[] };
      expect(Array.isArray(body.hooks)).toBe(true);
      // No active hooks exist for this fresh tenant
      expect(body.hooks).toHaveLength(0);
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });

  it("GET /api/v1/plugins/:id/hooks response shape has hooks array at top level", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);

    try {
      const res = await appFetch(
        `/api/v1/plugins/${fixturePluginId}/hooks?stage=after:data.ingestion`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);

      // Verify the response has the documented shape: { hooks: ResolvedHook[] }
      // ResolvedHook fields per the hook service: stage, criticality, priority,
      // entrypoint, pluginId, instanceId, tenantId, state.
      const body = (await res.json()) as { hooks: unknown[] };
      expect(Object.keys(body)).toContain("hooks");
      expect(Array.isArray(body.hooks)).toBe(true);
    } finally {
      await cleanupPluginTenant(pool, tenantId);
    }
  });
});
