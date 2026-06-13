/**
 * Level 3 E2E: Auth → Ontology cross-service flow.
 *
 * Tests that a tenant registered in the auth service can immediately use the
 * token it receives to create and query ontology entities in a separate service.
 * This validates that JWT signing (auth service) and JWT verification (ontology
 * service) are configured with the same OP_JWT_SECRET, and that the token's
 * tenantId claim is correctly propagated through the authorization middleware.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCleanupPool, createE2ETenant, cleanupE2ETenant } from "../helpers/e2e-cleanup.js";
import { getToken as registerAndLogin } from "../helpers/e2e-auth.js";
import type pg from "pg";

const ONTOLOGY_URL = "http://localhost:13003";

let pool: pg.Pool;

beforeAll(() => {
  pool = createCleanupPool();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E: auth-to-ontology cross-service flow", () => {
  it("registers a tenant and creates an ontology entity using the issued token", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      // Step 1: Register a user and obtain an access token
      const email    = `e2e-user-${tenantId.slice(0, 8)}@example.com`;
      const password = "Correct-Horse-Battery-Staple-99";
      const token    = await registerAndLogin(tenantId, email, password);

      expect(token).toBeTruthy();

      // Step 2: Create an ontology entity — cross-service call using the auth token
      const entitySlug = `product${tenantId.replace(/-/g, "").slice(0, 8)}`;
      const createRes = await fetch(`${ONTOLOGY_URL}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: "Product",
          slug: entitySlug,
          description: "E2E test product entity",
          fields: [
            { name: "SKU", fieldType: "string", required: true },
          ],
        }),
      });

      expect(createRes.status).toBe(201);
      // Ontology CREATE returns a flat response (no data wrapper)
      const createBody = await createRes.json() as { id: string; slug: string; name: string };
      expect(createBody.slug).toBe(entitySlug);
      expect(createBody.name).toBe("Product");
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("retrieves the created ontology entity via GET", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      const email    = `e2e-read-${tenantId.slice(0, 8)}@example.com`;
      const password = "Correct-Horse-Battery-Staple-99";
      const token    = await registerAndLogin(tenantId, email, password);

      // Create entity
      const entitySlug = `order${tenantId.replace(/-/g, "").slice(0, 8)}`;
      const createRes = await fetch(`${ONTOLOGY_URL}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: "Order",
          slug: entitySlug,
          fields: [{ name: "Total", fieldType: "number", required: false }],
        }),
      });
      expect(createRes.status).toBe(201);
      // Ontology CREATE returns a flat response (no data wrapper)
      const created = await createRes.json() as { id: string; slug: string };

      // Retrieve entity by slug — the route expects a slug, not a UUID
      const getRes = await fetch(
        `${ONTOLOGY_URL}/api/v1/ontology/${entitySlug}`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      expect(getRes.status).toBe(200);
      // GET by slug also returns a flat response
      const getBody = await getRes.json() as { id: string; slug: string };
      expect(getBody.id).toBe(created.id);
      expect(getBody.slug).toBe(entitySlug);
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("rejects ontology requests with no token (401)", async () => {
    const res = await fetch(`${ONTOLOGY_URL}/api/v1/ontology`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unauthorized",
        slug: "unauthorized",
        fields: [],
      }),
    });

    // Auth middleware must reject the unauthenticated request before the route handler runs
    expect(res.status).toBe(401);
  });

  it("rejects ontology requests with a malformed token (401)", async () => {
    const res = await fetch(`${ONTOLOGY_URL}/api/v1/ontology`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer this-is-not-a-real-jwt",
      },
      body: JSON.stringify({
        name: "Unauthorized",
        slug: "unauthorized",
        fields: [],
      }),
    });

    expect(res.status).toBe(401);
  });

  it("lists ontology entities scoped to the registering tenant only", async () => {
    const { tenantId: tenantA } = await createE2ETenant(pool);
    const { tenantId: tenantB } = await createE2ETenant(pool);

    try {
      const passwordA = "Correct-Horse-Battery-Staple-99";
      const tokenA = await registerAndLogin(
        tenantA,
        `list-user-a-${tenantA.slice(0, 8)}@example.com`,
        passwordA
      );

      const passwordB = "Correct-Horse-Battery-Staple-99";
      const tokenB = await registerAndLogin(
        tenantB,
        `list-user-b-${tenantB.slice(0, 8)}@example.com`,
        passwordB
      );

      // Tenant A creates an entity
      const slugA = `tenanta${tenantA.replace(/-/g, "").slice(0, 8)}`;
      const createA = await fetch(`${ONTOLOGY_URL}/api/v1/ontology`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          name: "TenantAEntity",
          slug: slugA,
          fields: [],
        }),
      });
      expect(createA.status).toBe(201);

      // Tenant B lists entities — must NOT see tenant A's entity
      const listB = await fetch(`${ONTOLOGY_URL}/api/v1/ontology`, {
        headers: { "Authorization": `Bearer ${tokenB}` },
      });
      expect(listB.status).toBe(200);
      const listBody = await listB.json() as { data: Array<{ slug: string }> };
      const slugs = listBody.data.map((e) => e.slug);
      expect(slugs).not.toContain(slugA);
    } finally {
      // Clean up both tenants; ontology rows cascade from entities
      await cleanupE2ETenant(pool, tenantA);
      await cleanupE2ETenant(pool, tenantB);
    }
  });
});
