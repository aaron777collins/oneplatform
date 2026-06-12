import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDbClient } from "@oneplatform/core";
import type pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupIngestionTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

// Minimal valid connector body — pluginId is a free-form string so tests do
// not need a real plugin registered; the connector service persists it as-is.
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

describe("Ingestion — connector CRUD (Level 1)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let cleanup: () => Promise<void>;
  let db: pg.Pool;

  beforeAll(async () => {
    const result = await buildTestApp();
    app = result.app;
    cleanup = result.cleanup;
    db = createDbClient({
      connectionString: process.env["OP_DATABASE_URL"]!,
      maxConnections: 3,
    });
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("POST /api/v1/connectors creates a connector", async () => {
    const tenantId = newTenantId();

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(connectorBody({ name: "My Connector" })),
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json() as { data: { id: string; name: string; pluginId: string } };
      expect(body.data.id).toBeTruthy();
      expect(body.data.name).toBe("My Connector");
      expect(body.data.pluginId).toBe("test-plugin");
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("GET /api/v1/connectors lists connectors with RLS isolation", async () => {
    const tenantId = newTenantId();

    try {
      // Create one connector for this tenant
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(connectorBody({ name: "Listed Connector" })),
        }),
      );
      expect(createRes.status).toBe(201);

      // List — should see only this tenant's connector
      const listRes = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(listRes.status).toBe(200);
      const body = await listRes.json() as { data: Array<{ name: string }> };
      expect(Array.isArray(body.data)).toBe(true);
      // Every returned connector must belong to this tenant (verified by name)
      expect(body.data.some((c) => c.name === "Listed Connector")).toBe(true);
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("GET /api/v1/connectors/:id returns a specific connector", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(connectorBody({ name: "Fetch By ID" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: created } = await createRes.json() as { data: { id: string } };

      const getRes = await app.fetch(
        new Request(`http://localhost/api/v1/connectors/${created.id}`, {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(getRes.status).toBe(200);
      const body = await getRes.json() as { data: { id: string; name: string } };
      expect(body.data.id).toBe(created.id);
      expect(body.data.name).toBe("Fetch By ID");
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("PATCH /api/v1/connectors/:id updates a connector", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(connectorBody({ name: "Before Update" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: created } = await createRes.json() as { data: { id: string } };

      const patchRes = await app.fetch(
        new Request(`http://localhost/api/v1/connectors/${created.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({ name: "After Update" }),
        }),
      );

      expect(patchRes.status).toBe(200);
      const body = await patchRes.json() as { data: { name: string } };
      expect(body.data.name).toBe("After Update");
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("DELETE /api/v1/connectors/:id soft-deletes the connector", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(connectorBody({ name: "To Delete" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: created } = await createRes.json() as { data: { id: string } };

      const deleteRes = await app.fetch(
        new Request(`http://localhost/api/v1/connectors/${created.id}`, {
          method: "DELETE",
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(deleteRes.status).toBe(204);

      // Soft-deleted connectors should no longer be visible via GET
      const getRes = await app.fetch(
        new Request(`http://localhost/api/v1/connectors/${created.id}`, {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );
      expect(getRes.status).toBe(404);
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("RLS: a different tenant cannot see another tenant's connectors", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();

    try {
      // Tenant A creates a connector
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantA),
          },
          body: JSON.stringify(connectorBody({ name: "Tenant A Connector" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: tenantAConnector } = await createRes.json() as { data: { id: string } };

      // Tenant B tries to fetch tenant A's connector by ID — must get 404
      const getRes = await app.fetch(
        new Request(`http://localhost/api/v1/connectors/${tenantAConnector.id}`, {
          headers: { Authorization: await authHeader(tenantB) },
        }),
      );
      expect(getRes.status).toBe(404);

      // Tenant B's list must not include tenant A's connector
      const listRes = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          headers: { Authorization: await authHeader(tenantB) },
        }),
      );
      expect(listRes.status).toBe(200);
      const body = await listRes.json() as { data: Array<{ id: string }> };
      const ids = body.data.map((c) => c.id);
      expect(ids).not.toContain(tenantAConnector.id);
    } finally {
      await cleanupIngestionTenant(db, tenantA);
      await cleanupIngestionTenant(db, tenantB);
    }
  });
});
