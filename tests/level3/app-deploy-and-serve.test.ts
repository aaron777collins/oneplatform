/**
 * Level 3 E2E: App service — create, retrieve, list builds, and verify isolation.
 *
 * Tests the full app management surface via real HTTP to the app service.
 * The app service is started without MinIO or the execution service, so build
 * triggering is not exercised here (it requires artifact storage). These tests
 * validate:
 *   1. App creation returns a well-formed response with the correct shape
 *   2. The created app is retrievable by ID
 *   3. Listing builds for a new app returns an empty array
 *   4. Tenant isolation: app created by tenant A is not visible to tenant B
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCleanupPool, createE2ETenant, cleanupE2ETenant } from "../helpers/e2e-cleanup.js";
import { getToken } from "../helpers/e2e-auth.js";
import type pg from "pg";

const APP_URL = "http://localhost:13006";

let pool: pg.Pool;

beforeAll(() => {
  pool = createCleanupPool();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: app service create, retrieve, and isolation", () => {
  it("creates an app and returns a valid response shape", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      const token = await getToken(
        tenantId,
        `e2e-app-create-${tenantId.slice(0, 8)}@example.com`,
        "Correct-Horse-Battery-Staple-99"
      );

      // App slug must be lowercase alphanumeric with hyphens, ≤64 chars
      const appSlug = `e2e-app-${tenantId.replace(/-/g, "").slice(0, 12)}`;

      const createRes = await fetch(`${APP_URL}/api/v1/apps`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          name:        `E2E App ${tenantId.slice(0, 8)}`,
          slug:        appSlug,
          accessMode:  "platform-user",
          description: "Created by Level 3 E2E test",
        }),
      });

      expect(createRes.status).toBe(201);
      const body = await createRes.json() as {
        data: { id: string; slug: string; name: string; accessMode: string };
      };
      expect(body.data.id).toBeTruthy();
      expect(body.data.slug).toBe(appSlug);
      expect(body.data.accessMode).toBe("platform-user");
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("retrieves the created app by ID", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      const token = await getToken(
        tenantId,
        `e2e-app-get-${tenantId.slice(0, 8)}@example.com`,
        "Correct-Horse-Battery-Staple-99"
      );

      const appSlug = `get-app-${tenantId.replace(/-/g, "").slice(0, 12)}`;

      // Create
      const createRes = await fetch(`${APP_URL}/api/v1/apps`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          name:       `Get Test App ${tenantId.slice(0, 8)}`,
          slug:       appSlug,
          accessMode: "platform-user",
        }),
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json() as { data: { id: string } };
      const appId = createBody.data.id;

      // Retrieve
      const getRes = await fetch(`${APP_URL}/api/v1/apps/${appId}`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as { data: { id: string; slug: string } };
      expect(getBody.data.id).toBe(appId);
      expect(getBody.data.slug).toBe(appSlug);
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("lists builds for a new app — returns an empty array", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      const token = await getToken(
        tenantId,
        `e2e-app-builds-${tenantId.slice(0, 8)}@example.com`,
        "Correct-Horse-Battery-Staple-99"
      );

      const appSlug = `builds-app-${tenantId.replace(/-/g, "").slice(0, 11)}`;

      // Create app
      const createRes = await fetch(`${APP_URL}/api/v1/apps`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          name:       `Builds Test ${tenantId.slice(0, 8)}`,
          slug:       appSlug,
          accessMode: "platform-user",
        }),
      });
      expect(createRes.status).toBe(201);
      const { data: app } = await createRes.json() as { data: { id: string } };

      // List builds — app was just created, no builds yet
      const buildsRes = await fetch(
        `${APP_URL}/api/v1/apps/${app.id}/builds`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      expect(buildsRes.status).toBe(200);
      const buildsBody = await buildsRes.json() as { data: unknown[] };
      // A brand-new app has no builds — the array must be empty
      expect(buildsBody.data).toHaveLength(0);
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("tenant A's app is not visible to tenant B", async () => {
    const { tenantId: tenantA } = await createE2ETenant(pool);
    const { tenantId: tenantB } = await createE2ETenant(pool);

    try {
      const tokenA = await getToken(
        tenantA,
        `iso-app-a-${tenantA.slice(0, 8)}@example.com`,
        "Correct-Horse-Battery-Staple-99"
      );
      const tokenB = await getToken(
        tenantB,
        `iso-app-b-${tenantB.slice(0, 8)}@example.com`,
        "Correct-Horse-Battery-Staple-99"
      );

      // Tenant A creates an app
      const appSlugA = `iso-app-${tenantA.replace(/-/g, "").slice(0, 12)}`;
      const createA = await fetch(`${APP_URL}/api/v1/apps`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          name:       `Isolation App ${tenantA.slice(0, 8)}`,
          slug:       appSlugA,
          accessMode: "platform-user",
        }),
      });
      expect(createA.status).toBe(201);
      const { data: appA } = await createA.json() as { data: { id: string } };

      // Tenant B tries to GET tenant A's app by ID — must get 404 (not found in scope)
      const getRes = await fetch(`${APP_URL}/api/v1/apps/${appA.id}`, {
        headers: { "Authorization": `Bearer ${tokenB}` },
      });
      // The app exists in DB but tenant B has no access — service must return 404
      expect(getRes.status).toBe(404);

      // Tenant B lists apps — must not see tenant A's app
      const listRes = await fetch(`${APP_URL}/api/v1/apps`, {
        headers: { "Authorization": `Bearer ${tokenB}` },
      });
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json() as { data: Array<{ id: string }> };
      const ids = listBody.data.map((a) => a.id);
      expect(ids).not.toContain(appA.id);
    } finally {
      await cleanupE2ETenant(pool, tenantA);
      await cleanupE2ETenant(pool, tenantB);
    }
  });
});
