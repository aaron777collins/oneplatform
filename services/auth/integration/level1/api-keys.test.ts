/**
 * Level 1 integration tests: Auth service API key management.
 *
 * API key routes require a valid Bearer token (not in publicRoutes).
 * We bootstrap once in beforeAll to get a tenant + admin access token,
 * then use that token for all API key operations.
 *
 * Cleanup: the bootstrap tenant is deleted in afterAll. API keys are tied
 * to users via FK with ON DELETE CASCADE, so they disappear when the user
 * is deleted. We still delete them explicitly first for clarity.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createServiceApp } from "../../dist/index.js";
import { cleanupAuthTenant, resetBootstrapState } from "../helpers/tenant.js";

const VALID_BOOTSTRAP_TOKEN = "c".repeat(64);

// ---------------------------------------------------------------------------
// Shared state for the suite
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof createServiceApp>>["app"];
let cleanup: () => Promise<void>;
let db: pg.Pool;

/** The tenant created by bootstrap. */
let sharedTenantId: string;
/** Access token for the bootstrap admin user. */
let adminAccessToken: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function createKey(
  name: string,
  scopes: string[] = ["data:read"],
): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/api/v1/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(adminAccessToken),
      },
      body: JSON.stringify({ name, scopes }),
    }),
  );
}

// ---------------------------------------------------------------------------

describe("Auth service — API keys", () => {
  beforeAll(async () => {
    db = new pg.Pool({
      connectionString: process.env["OP_DATABASE_URL"]!,
      max: 3,
      idleTimeoutMillis: 10_000,
    });

    await resetBootstrapState(db);

    const result = await createServiceApp({
      databaseUrl: process.env["OP_DATABASE_URL"]!,
      redisUrl: process.env["OP_REDIS_URL"]!,
      jwtSecret: process.env["OP_JWT_SECRET"]!,
      masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
      allowedOrigins: ["http://localhost:3000"],
      bootstrapToken: VALID_BOOTSTRAP_TOKEN,
    });
    app = result.app;
    cleanup = result.cleanup;

    // Bootstrap to get a tenant and admin access token
    const bootstrapRes = await app.fetch(
      new Request("http://localhost/api/v1/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminEmail: "admin@api-keys-test.example.com",
          adminPassword: "Correct-Horse-Battery-Staple-99",
          tenantName: `api-keys-test-${Date.now()}`,
          bootstrapToken: VALID_BOOTSTRAP_TOKEN,
        }),
      }),
    );

    if (bootstrapRes.status !== 201) {
      const text = await bootstrapRes.text();
      throw new Error(`Bootstrap failed (${bootstrapRes.status}): ${text}`);
    }

    const bootstrapBody = await bootstrapRes.json() as {
      tenantId: string;
      accessToken: string;
    };
    sharedTenantId = bootstrapBody.tenantId;
    adminAccessToken = bootstrapBody.accessToken;
  });

  afterAll(async () => {
    await cleanup();
    await resetBootstrapState(db);
    await cleanupAuthTenant(db, sharedTenantId);
    await db.end();
  });

  // -------------------------------------------------------------------------

  it("POST /api/v1/api-keys creates a key and returns the full key value once", async () => {
    const res = await createKey("test-key-create");

    expect(res.status).toBe(201);
    const body = await res.json() as {
      id: string;
      name: string;
      key: string;
      keyPrefix: string;
      scopes: string[];
      expiresAt: string | null;
      createdAt: string;
    };

    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe("test-key-create");
    // Full key is only returned at creation — it starts with "opk_"
    expect(body.key).toBeTruthy();
    expect(body.keyPrefix).toHaveLength(8);
    expect(body.scopes).toContain("data:read");
    expect(body.expiresAt).toBeNull();
    expect(body.createdAt).toBeTruthy();
  });

  // -------------------------------------------------------------------------

  it("GET /api/v1/api-keys lists API keys for the authenticated user", async () => {
    // Create a uniquely named key so we can find it in the list
    const keyName = `list-test-key-${Date.now()}`;
    const createRes = await createKey(keyName, ["data:read", "data:write"]);
    expect(createRes.status).toBe(201);

    const res = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        headers: authHeader(adminAccessToken),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Array<{
        id: string;
        name: string;
        keyPrefix: string;
        scopes: string[];
        revokedAt: string | null;
      }>;
      pagination: { total: number };
    };

    // The list must contain the key we just created
    const found = body.data.find((k) => k.name === keyName);
    expect(found).toBeDefined();
    expect(found?.revokedAt).toBeNull();
    // Full key value is NOT returned in list — only the prefix
    expect(body.data.every((k) => !("key" in k))).toBe(true);
  });

  // -------------------------------------------------------------------------

  it("DELETE /api/v1/api-keys/:id revokes the key (returns 204)", async () => {
    const createRes = await createKey("to-be-revoked");
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string };

    const deleteRes = await app.fetch(
      new Request(`http://localhost/api/v1/api-keys/${created.id}`, {
        method: "DELETE",
        headers: authHeader(adminAccessToken),
      }),
    );

    expect(deleteRes.status).toBe(204);
  });

  // -------------------------------------------------------------------------

  it("GET /api/v1/api-keys shows revokedAt after deletion", async () => {
    const createRes = await createKey("revoke-and-list");
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string; name: string };

    // Revoke
    const deleteRes = await app.fetch(
      new Request(`http://localhost/api/v1/api-keys/${created.id}`, {
        method: "DELETE",
        headers: authHeader(adminAccessToken),
      }),
    );
    expect(deleteRes.status).toBe(204);

    // Verify revokedAt is now set in the list
    const listRes = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        headers: authHeader(adminAccessToken),
      }),
    );
    expect(listRes.status).toBe(200);

    const listBody = await listRes.json() as {
      data: Array<{ id: string; revokedAt: string | null }>;
    };

    const revokedKey = listBody.data.find((k) => k.id === created.id);
    expect(revokedKey).toBeDefined();
    // revokedAt must be a non-null ISO timestamp after deletion
    expect(revokedKey?.revokedAt).not.toBeNull();
    expect(typeof revokedKey?.revokedAt).toBe("string");
  });

  // -------------------------------------------------------------------------

  it("POST /api/v1/api-keys/:id/rotate issues a new key and invalidates the old one", async () => {
    const createRes = await createKey("to-be-rotated", ["data:read"]);
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as {
      id: string;
      key: string;
      keyPrefix: string;
    };
    const originalId = created.id;
    const originalPrefix = created.keyPrefix;

    const rotateRes = await app.fetch(
      new Request(`http://localhost/api/v1/api-keys/${originalId}/rotate`, {
        method: "POST",
        headers: authHeader(adminAccessToken),
      }),
    );

    expect(rotateRes.status).toBe(200);
    const rotated = await rotateRes.json() as {
      id: string;
      key: string;
      keyPrefix: string;
      scopes: string[];
      createdAt: string;
    };

    // Rotation produces a new key record with a new ID
    expect(rotated.id).not.toBe(originalId);
    // New full key value is returned
    expect(rotated.key).toBeTruthy();
    // Prefix must differ (different random bytes underlying the new key)
    expect(rotated.keyPrefix).not.toBe(originalPrefix);
    expect(rotated.scopes).toContain("data:read");
  });

  // -------------------------------------------------------------------------

  it("POST /api/v1/api-keys without auth returns 401", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "no-auth", scopes: ["data:read"] }),
      }),
    );

    expect(res.status).toBe(401);
  });
});
