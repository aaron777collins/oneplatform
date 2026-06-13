/**
 * Level 2 integration tests for the Ontology service.
 *
 * The service process is already running on port 13003 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP.
 *
 * Ontology has no RLS — isolation is achieved by unique tenant UUIDs and
 * explicit cleanup. Slug uniqueness is per-tenant, so tests in the same suite
 * can use the same slug string as long as they use distinct tenant UUIDs.
 *
 * Routes exercised (all under /api/v1/ontology):
 *   GET  /healthz         — liveness probe
 *   POST /                — create entity
 *   GET  /                — list entities
 *   GET  /:slug           — retrieve entity by slug
 *   POST / (dup slug)     — 409 conflict on duplicate slug within tenant
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { newTenantId, cleanupOntologyTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

const BASE = "http://localhost:13003";

const db = new pg.Pool({
  connectionString: process.env["OP_DATABASE_URL"]!,
  max: 2,
});

afterAll(async () => {
  await db.end();
});

// Minimal valid entity body matching the ontology service's EntityCreateSchema.
function entityBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Product",
    fields: [
      {
        name: "SKU",
        fieldType: "string",
        required: true,
        nullable: false,
        validationRules: [],
        isIndexed: false,
        isUnique: true,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("Ontology service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // 2 -----------------------------------------------------------------------
  it("POST /api/v1/ontology creates an entity and returns its slug", async () => {
    const tenantId = newTenantId();

    try {
      const res = await fetch(`${BASE}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(entityBody({ name: "Invoice" })),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as {
        id: string;
        name: string;
        slug: string;
        fields: unknown[];
      };
      expect(body.id).toBeTruthy();
      expect(body.name).toBe("Invoice");
      expect(typeof body.slug).toBe("string");
      expect(body.slug.length).toBeGreaterThan(0);
      expect(Array.isArray(body.fields)).toBe(true);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  // 3 -----------------------------------------------------------------------
  it("GET /api/v1/ontology lists entities for the tenant", async () => {
    const tenantId = newTenantId();

    try {
      // Create an entity first
      const createRes = await fetch(`${BASE}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(entityBody({ name: "Order" })),
      });
      expect(createRes.status).toBe(201);

      const listRes = await fetch(`${BASE}/api/v1/ontology`, {
        headers: { Authorization: await authHeader(tenantId) },
      });
      expect(listRes.status).toBe(200);

      const body = await listRes.json() as { data: Array<{ id: string; name: string }>; pagination: unknown };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data.some((e) => e.name === "Order")).toBe(true);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  // 4 -----------------------------------------------------------------------
  it("GET /api/v1/ontology/:slug retrieves an entity by slug", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await fetch(`${BASE}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(entityBody({ name: "Customer" })),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { slug: string; name: string };

      const getRes = await fetch(`${BASE}/api/v1/ontology/${created.slug}`, {
        headers: { Authorization: await authHeader(tenantId) },
      });
      expect(getRes.status).toBe(200);
      const body = await getRes.json() as { slug: string; name: string; fields: unknown[] };
      expect(body.slug).toBe(created.slug);
      expect(body.name).toBe("Customer");
      expect(Array.isArray(body.fields)).toBe(true);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  // 5 -----------------------------------------------------------------------
  it("POST /api/v1/ontology returns 409 when slug already exists for the tenant", async () => {
    const tenantId = newTenantId();

    try {
      // First entity with explicit slug
      const first = await fetch(`${BASE}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(entityBody({ name: "Widget", slug: "widget" })),
      });
      expect(first.status).toBe(201);

      // Second entity with the same slug in the same tenant — must conflict
      const duplicate = await fetch(`${BASE}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(entityBody({ name: "Widget Clone", slug: "widget" })),
      });
      expect(duplicate.status).toBe(409);
    } finally {
      await cleanupOntologyTenant(db, tenantId);
    }
  });

  // 6 -----------------------------------------------------------------------
  it("POST /api/v1/ontology without auth returns 401", async () => {
    const res = await fetch(`${BASE}/api/v1/ontology`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entityBody()),
    });
    expect(res.status).toBe(401);
  });

  // 7 -----------------------------------------------------------------------
  it("Tenant B cannot see entities created by Tenant A", async () => {
    // Ontology has no RLS but filters by tenant_id from the JWT claim.
    // This test asserts the HTTP layer enforces that isolation.
    const tenantA = newTenantId();
    const tenantB = newTenantId();

    try {
      // Tenant A creates an entity with a name that encodes its tenantId for
      // identification. Same slug is fine since slugs are scoped per tenant.
      const createRes = await fetch(`${BASE}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantA),
        },
        body: JSON.stringify(entityBody({ name: `TenantA-${tenantA.slice(0, 8)}` })),
      });
      expect(createRes.status).toBe(201);

      // Tenant B lists entities — must not see Tenant A's entity
      const listRes = await fetch(`${BASE}/api/v1/ontology`, {
        headers: { Authorization: await authHeader(tenantB) },
      });
      expect(listRes.status).toBe(200);

      const listBody = await listRes.json() as { data: Array<{ name: string }>; pagination: unknown };
      const names = listBody.data.map((e) => e.name);
      expect(names.some((n) => n.includes(tenantA.slice(0, 8)))).toBe(false);
    } finally {
      await cleanupOntologyTenant(db, tenantA);
      await cleanupOntologyTenant(db, tenantB);
    }
  });
});
