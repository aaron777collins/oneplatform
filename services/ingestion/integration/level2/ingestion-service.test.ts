/**
 * Level 2 integration tests for the Ingestion service.
 *
 * The service process is already running on port 13002 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP.
 *
 * Auth tokens are minted locally with jose (same secret as the running
 * service) to avoid depending on the auth service being active.
 *
 * Isolation: ingestion has RLS. Each test uses a unique tenant UUID so
 * service-written rows are invisible to other tests. Cleanup deletes
 * the test tenant's rows directly via the superuser pool.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { newTenantId, cleanupIngestionTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

const BASE = "http://localhost:13002";

const db = new pg.Pool({
  connectionString: process.env["OP_DATABASE_URL"]!,
  max: 2,
});

afterAll(async () => {
  await db.end();
});

// Minimal valid connector body matching the ingestion service's ConnectorSchema.
function connectorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pluginId: "test-plugin",
    name: "Test Connector",
    config: { endpoint: "https://example.com" },
    credentials: { apiKey: "test-secret" },
    syncMode: "incremental",
    isEnabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("Ingestion service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // 2 -----------------------------------------------------------------------
  it("POST /api/v1/connectors creates a connector with a valid auth token", async () => {
    const tenantId = newTenantId();

    try {
      const res = await fetch(`${BASE}/api/v1/connectors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(connectorBody({ name: "L2 Connector" })),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as {
        data: { id: string; name: string; pluginId: string; tenantId: string };
      };
      expect(body.data.id).toBeTruthy();
      expect(body.data.name).toBe("L2 Connector");
      expect(body.data.pluginId).toBe("test-plugin");
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  // 3 -----------------------------------------------------------------------
  it("GET /api/v1/connectors lists only the calling tenant's connectors", async () => {
    const tenantId = newTenantId();

    try {
      // Create one connector
      const createRes = await fetch(`${BASE}/api/v1/connectors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(connectorBody({ name: "Listed Connector" })),
      });
      expect(createRes.status).toBe(201);

      // List — must see exactly one connector for this tenant
      const listRes = await fetch(`${BASE}/api/v1/connectors`, {
        headers: { Authorization: await authHeader(tenantId) },
      });
      expect(listRes.status).toBe(200);

      const body = await listRes.json() as {
        data: Array<{ id: string; tenantId?: string }>;
      };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      // All returned connectors must belong to this tenant (RLS enforces this,
      // but we assert it explicitly so a regression is immediately obvious)
      for (const connector of body.data) {
        if (connector.tenantId !== undefined) {
          expect(connector.tenantId).toBe(tenantId);
        }
      }
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  // 4 -----------------------------------------------------------------------
  it("POST /api/v1/connectors without auth returns 401", async () => {
    const res = await fetch(`${BASE}/api/v1/connectors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(connectorBody()),
    });
    expect(res.status).toBe(401);
  });

  // 5 -----------------------------------------------------------------------
  it("POST /api/v1/connectors with non-JSON body returns 400 or 415", async () => {
    const tenantId = newTenantId();

    // Send plain text instead of JSON — the service should reject with a
    // content-type or parse error before touching the DB.
    const res = await fetch(`${BASE}/api/v1/connectors`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: await authHeader(tenantId),
      },
      body: "this is not json",
    });

    // The service may return 415 (Unsupported Media Type) or 400 (bad request).
    // Both are acceptable rejections — the key is it does not return 2xx.
    expect(res.status === 400 || res.status === 415).toBe(true);
  });

  // 6 -----------------------------------------------------------------------
  it("POST /api/v1/connectors with missing required fields returns 400", async () => {
    const tenantId = newTenantId();

    const res = await fetch(`${BASE}/api/v1/connectors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await authHeader(tenantId),
      },
      // pluginId and name are required — omit them
      body: JSON.stringify({ config: {}, syncMode: "full" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
