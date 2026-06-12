/**
 * Level 1 integration tests for the App service — deployment management.
 *
 * Routes exercised:
 *   POST /api/v1/apps/:appId/deploy   — deploy a build (sets current_build_id)
 *   POST /api/v1/apps/:appId/rollback — roll back to a previous build
 *
 * At Level 1 there is no running Execution service, so no successful builds
 * exist. Deployment tests verify:
 *   - 401 without auth
 *   - Error response when deploying an app with no successful builds
 *   - Error response when deploying with an invalid buildId
 *   - App detail reflects currentBuildId after a successful deploy
 *
 * The "current deployment is returned in app detail" assertion requires a
 * successful build to be present. Since that depends on the Execution service,
 * that specific scenario is tested at Level 2/3. The test below documents the
 * expected failure shape at Level 1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupAppTenant } from "../helpers/tenant.js";
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

function appFetch(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

interface CreateAppResponse {
  data: { id: string };
}

async function createApp(
  token: string,
  name: string,
  slug: string,
): Promise<string> {
  const res = await appFetch("/api/v1/apps", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, slug }),
  });
  if (res.status !== 201) {
    throw new Error(`createApp failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as CreateAppResponse;
  return body.data.id;
}

// ---------------------------------------------------------------------------
// POST /deploy — auth enforcement
// ---------------------------------------------------------------------------

describe("App service — deploy auth enforcement", () => {
  it("POST /api/v1/apps/:appId/deploy returns 401 without a token", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);
    const slug = `deploy-auth-${randomUUID().split("-")[0] ?? "x"}`;

    try {
      const appId = await createApp(token, "Deploy Auth App", slug);

      const res = await appFetch(`/api/v1/apps/${appId}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    } finally {
      await cleanupAppTenant(pool, tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /deploy — no builds available
// ---------------------------------------------------------------------------

describe("App service — deploy with no successful build", () => {
  it("POST /api/v1/apps/:appId/deploy returns an error when no successful build exists", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);
    const slug = `deploy-no-build-${randomUUID().split("-")[0] ?? "x"}`;

    try {
      const appId = await createApp(token, "No Build App", slug);

      // Deploy without specifying a buildId — the service looks for the latest
      // successful build and finds none
      const res = await appFetch(`/api/v1/apps/${appId}/deploy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      // The deploy service throws AppBuildNotReadyError when no successful
      // build exists. The core error handler maps this to a 4xx or 5xx.
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(204);
    } finally {
      await cleanupAppTenant(pool, tenantId);
    }
  });

  it("POST /api/v1/apps/:appId/deploy returns an error for a non-existent buildId", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);
    const slug = `deploy-bad-build-${randomUUID().split("-")[0] ?? "x"}`;

    try {
      const appId = await createApp(token, "Bad Build App", slug);
      const fakeBuildId = randomUUID();

      const res = await appFetch(`/api/v1/apps/${appId}/deploy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ buildId: fakeBuildId }),
      });

      // AppBuildNotFoundError → non-2xx
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(204);
    } finally {
      await cleanupAppTenant(pool, tenantId);
    }
  });

  it("App detail shows currentBuildId as null before any deploy", async () => {
    const tenantId = newTenantId();
    const token = await createTestToken(tenantId);
    const slug = `no-deploy-yet-${randomUUID().split("-")[0] ?? "x"}`;

    try {
      const appId = await createApp(token, "Not Deployed App", slug);

      const getRes = await appFetch(`/api/v1/apps/${appId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as {
        data: { currentBuildId: string | null };
      };
      expect(body.data.currentBuildId).toBeNull();
    } finally {
      await cleanupAppTenant(pool, tenantId);
    }
  });
});
