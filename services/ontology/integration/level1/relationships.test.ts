import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDbClient } from "@oneplatform/core";
import type pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupOntologyTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

// Relationship routes live at POST /api/v1/ontology/:entityType/relationships
// and GET /api/v1/ontology/:entityType (relationships field in the response).
// There is no standalone GET /api/v1/relationships list — relationships are
// returned embedded in the entity GET response.

async function createTestEntity(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  tenantId: string,
  name: string,
  slug: string,
): Promise<{ slug: string; id: string }> {
  const res = await app.fetch(
    new Request("http://localhost/api/v1/ontology", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await authHeader(tenantId),
      },
      body: JSON.stringify({
        name,
        slug,
        fields: [
          {
            name: "Label",
            fieldType: "string",
            required: false,
            nullable: true,
            validationRules: [],
            isIndexed: false,
            isUnique: false,
          },
        ],
      }),
    }),
  );

  if (res.status !== 201) {
    const err = await res.text();
    throw new Error(`Failed to create entity ${name}: ${res.status} ${err}`);
  }
  return res.json() as Promise<{ slug: string; id: string }>;
}

describe("Ontology — relationships (Level 1)", () => {
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

  it("POST /api/v1/ontology/:entityType/relationships creates a 1:N relationship", async () => {
    const tenantId = newTenantId();

    try {
      await createTestEntity(app, tenantId, "Org", "org");
      await createTestEntity(app, tenantId, "Member", "member");

      const res = await app.fetch(
        new Request("http://localhost/api/v1/ontology/org/relationships", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            fromEntitySlug: "org",
            toEntitySlug: "member",
            relationshipType: "1:N",
            fromFieldName: "members",
            cascadeDelete: false,
          }),
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json() as {
        fromEntitySlug: string;
        toEntitySlug: string;
        relationshipType: string;
      };
      expect(body.fromEntitySlug).toBe("org");
      expect(body.toEntitySlug).toBe("member");
      expect(body.relationshipType).toBe("1:N");
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  it("cardinality validation rejects relationships with invalid type values", async () => {
    const tenantId = newTenantId();

    try {
      await createTestEntity(app, tenantId, "Team", "team");
      await createTestEntity(app, tenantId, "Player", "player");

      const res = await app.fetch(
        new Request("http://localhost/api/v1/ontology/team/relationships", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            fromEntitySlug: "team",
            toEntitySlug: "player",
            // "1:MANY" is not a valid enum value — only "1:1", "1:N", "M:N"
            relationshipType: "1:MANY",
            fromFieldName: "players",
            cascadeDelete: false,
          }),
        }),
      );

      // Zod schema validation should reject the invalid cardinality with 400 or
      // a ValidationError. The exact status depends on whether the error is
      // thrown or returned — expect either 400 or 422.
      expect([400, 422]).toContain(res.status);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  it("GET /api/v1/ontology/:entityType includes relationships in the response", async () => {
    const tenantId = newTenantId();

    try {
      await createTestEntity(app, tenantId, "Project", "project");
      await createTestEntity(app, tenantId, "Task", "task");

      // Create relationship
      const relRes = await app.fetch(
        new Request("http://localhost/api/v1/ontology/project/relationships", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            fromEntitySlug: "project",
            toEntitySlug: "task",
            relationshipType: "1:N",
            fromFieldName: "tasks",
            cascadeDelete: true,
          }),
        }),
      );
      expect(relRes.status).toBe(201);

      // Fetch the entity — relationships should be embedded
      const getRes = await app.fetch(
        new Request("http://localhost/api/v1/ontology/project", {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(getRes.status).toBe(200);
      const body = await getRes.json() as {
        slug: string;
        relationships: Array<{ toEntitySlug: string; relationshipType: string }>;
      };
      expect(Array.isArray(body.relationships)).toBe(true);
      const rel = body.relationships.find((r) => r.toEntitySlug === "task");
      expect(rel).toBeDefined();
      if (rel !== undefined) {
        expect(rel.relationshipType).toBe("1:N");
      }
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });
});
