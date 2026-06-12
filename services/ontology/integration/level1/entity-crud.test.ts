import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDbClient } from "@oneplatform/core";
import type pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupOntologyTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

// The ontology service registers entity routes at /api/v1/ontology (not /api/v1/entities).
// The :entityType path parameter is the entity's slug.

function entityBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Customer",
    fields: [
      {
        name: "Full Name",
        fieldType: "string",
        required: true,
        nullable: false,
        validationRules: [],
        isIndexed: false,
        isUnique: false,
      },
    ],
    ...overrides,
  };
}

describe("Ontology — entity CRUD (Level 1)", () => {
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

  it("POST /api/v1/ontology creates an entity with fields", async () => {
    const tenantId = newTenantId();

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/ontology", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(entityBody({ name: "Invoice" })),
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json() as { id: string; name: string; fields: unknown[] };
      expect(body.id).toBeTruthy();
      expect(body.name).toBe("Invoice");
      expect(Array.isArray(body.fields)).toBe(true);
      expect(body.fields.length).toBe(1);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  it("GET /api/v1/ontology lists entities for the tenant", async () => {
    const tenantId = newTenantId();

    try {
      // Create an entity first
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/ontology", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(entityBody({ name: "Product" })),
        }),
      );
      expect(createRes.status).toBe(201);

      const listRes = await app.fetch(
        new Request("http://localhost/api/v1/ontology", {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(listRes.status).toBe(200);
      const body = await listRes.json() as {
        data: Array<{ name: string }>;
        pagination: { total: number };
      };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((e) => e.name === "Product")).toBe(true);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  it("GET /api/v1/ontology/:entityType returns entity with fields and relationships", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/ontology", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(entityBody({ name: "Order", slug: "order" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { slug: string; name: string };

      const getRes = await app.fetch(
        new Request(`http://localhost/api/v1/ontology/${created.slug}`, {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(getRes.status).toBe(200);
      const body = await getRes.json() as {
        slug: string;
        name: string;
        fields: unknown[];
        relationships: unknown[];
      };
      expect(body.slug).toBe(created.slug);
      expect(body.name).toBe("Order");
      expect(Array.isArray(body.fields)).toBe(true);
      // Relationships array is present even when empty
      expect(Array.isArray(body.relationships)).toBe(true);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  it("PATCH /api/v1/ontology/:entityType adds a field (backward-compatible change)", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/ontology", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(entityBody({ name: "Shipment", slug: "shipment" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { slug: string };

      const patchRes = await app.fetch(
        new Request(`http://localhost/api/v1/ontology/${created.slug}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            addFields: [
              {
                name: "Tracking Number",
                fieldType: "string",
                required: false,
                nullable: true,
                validationRules: [],
                isIndexed: true,
                isUnique: false,
              },
            ],
          }),
        }),
      );

      // Adding a nullable field is a backward-compatible change — returns 200 immediately.
      expect(patchRes.status).toBe(200);
      const body = await patchRes.json() as {
        changeType: string;
        appliedImmediately: boolean;
        entity: { fields: Array<{ name: string }> };
      };
      expect(body.changeType).toBe("backward_compatible");
      expect(body.appliedImmediately).toBe(true);

      // Verify the response includes the updated entity with the new field
      const entity = body.entity;
      expect(entity).toBeDefined();
      const fields = entity.fields;
      expect(fields.some((f) => f.name === "Tracking Number")).toBe(true);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  it("DELETE /api/v1/ontology/:entityType soft-deletes the entity", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/ontology", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(entityBody({ name: "Ephemeral", slug: "ephemeral" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { slug: string };

      const deleteRes = await app.fetch(
        new Request(`http://localhost/api/v1/ontology/${created.slug}?confirm=true`, {
          method: "DELETE",
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(deleteRes.status).toBe(204);

      // Deleted entity should no longer be retrievable
      const getRes = await app.fetch(
        new Request(`http://localhost/api/v1/ontology/${created.slug}`, {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );
      expect(getRes.status).toBe(404);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  it("slug uniqueness is enforced within a tenant", async () => {
    const tenantId = newTenantId();

    try {
      const first = await app.fetch(
        new Request("http://localhost/api/v1/ontology", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(entityBody({ name: "Contact", slug: "contact" })),
        }),
      );
      expect(first.status).toBe(201);

      // Attempting to create a second entity with the same slug must be rejected.
      const duplicate = await app.fetch(
        new Request("http://localhost/api/v1/ontology", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(entityBody({ name: "Contact Again", slug: "contact" })),
        }),
      );
      // Expect a 409 Conflict (ConflictError from the entity service)
      expect(duplicate.status).toBe(409);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });
});
