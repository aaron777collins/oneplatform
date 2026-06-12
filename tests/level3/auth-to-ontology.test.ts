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
import type pg from "pg";

const AUTH_URL     = "http://localhost:13001";
const ONTOLOGY_URL = "http://localhost:13003";

// ---------------------------------------------------------------------------
// Shared pool — created once for the file, closed in afterAll
// ---------------------------------------------------------------------------

let pool: pg.Pool;

beforeAll(() => {
  pool = createCleanupPool();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helper: register a user in a tenant and return the access token
// ---------------------------------------------------------------------------

async function registerAndLogin(tenantId: string, email: string, password: string): Promise<string> {
  const regRes = await fetch(`${AUTH_URL}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, tenantId }),
  });
  if (regRes.status !== 201) {
    const body = await regRes.text();
    throw new Error(`Register failed (${regRes.status}): ${body}`);
  }

  // Registration returns tokens directly when OP_REQUIRE_EMAIL_VERIFICATION=false
  const regBody = await regRes.json() as {
    data: { accessToken?: string; tenantId: string };
  };

  // If registration returned a token, use it directly; otherwise login
  if (regBody.data.accessToken !== undefined) {
    return regBody.data.accessToken;
  }

  const loginRes = await fetch(`${AUTH_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, tenantId }),
  });
  if (loginRes.status !== 200) {
    const body = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status}): ${body}`);
  }
  const loginBody = await loginRes.json() as {
    data: { accessToken: string };
  };
  return loginBody.data.accessToken;
}

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
            { name: "SKU", type: "string", required: true },
          ],
        }),
      });

      expect(createRes.status).toBe(201);
      const createBody = await createRes.json() as {
        data: { id: string; slug: string; name: string };
      };
      expect(createBody.data.slug).toBe(entitySlug);
      expect(createBody.data.name).toBe("Product");
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
          fields: [{ name: "Total", type: "number", required: false }],
        }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json() as { data: { id: string } };
      const entityId = created.data.id;

      // Retrieve entity by ID
      const getRes = await fetch(
        `${ONTOLOGY_URL}/api/v1/ontology/${entityId}`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as { data: { id: string; slug: string } };
      expect(getBody.data.id).toBe(entityId);
      expect(getBody.data.slug).toBe(entitySlug);
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
