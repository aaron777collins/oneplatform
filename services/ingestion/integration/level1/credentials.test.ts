import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupIngestionTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

// Credentials do not have a dedicated REST resource — they are stored and
// decrypted through the connector lifecycle. These tests verify:
//   1. The connector API never surfaces raw credentials in responses.
//   2. The encrypted blob in the DB differs from the plaintext value.
//   3. Updating a connector's credentials replaces the previous blob.

function connectorBody(name: string, credentials: Record<string, string>): Record<string, unknown> {
  return {
    pluginId: "test-plugin",
    name,
    config: { endpoint: "https://example.com" },
    credentials,
    syncMode: "incremental",
    isEnabled: true,
  };
}

describe("Ingestion — credential encryption (Level 1)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let cleanup: () => Promise<void>;
  let db: pg.Pool;

  beforeAll(async () => {
    const result = await buildTestApp();
    app = result.app;
    cleanup = result.cleanup;
    db = result.db;
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("credentials are encrypted at rest — raw value never appears in the DB blob", async () => {
    const tenantId = newTenantId();
    const plaintext = "super-secret-api-key-12345";

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(connectorBody("Cred Test Connector", { apiKey: plaintext })),
        }),
      );
      expect(res.status).toBe(201);
      const { data: connector } = await res.json() as { data: { id: string } };

      // Inspect the raw encrypted_blob column — it must not contain the plaintext.
      // The op_test superuser bypasses RLS for direct DB inspection.
      const { rows } = await db.query<{ encrypted_blob: string }>(
        "SELECT encrypted_blob FROM ingestion.credentials WHERE connector_id = $1",
        [connector.id],
      );

      expect(rows.length).toBeGreaterThan(0);
      const row = rows[0];
      if (row === undefined) throw new Error("No credential row found");
      // The blob is AES-256-GCM ciphertext encoded as a base64 or hex string —
      // it must not contain the plaintext in any encoding.
      expect(row.encrypted_blob).not.toContain(plaintext);
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("connector GET response does not expose credential values", async () => {
    const tenantId = newTenantId();

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(connectorBody("No Leak Connector", { token: "hidden-value" })),
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json() as { data: Record<string, unknown> };
      const bodyStr = JSON.stringify(body);

      // The plaintext secret must not appear anywhere in the API response.
      expect(bodyStr).not.toContain("hidden-value");
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("PATCH credentials replaces the stored encrypted blob", async () => {
    const tenantId = newTenantId();

    try {
      // Create connector with initial credentials
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/connectors", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(connectorBody("Rotate Creds Connector", { apiKey: "original-secret" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: connector } = await createRes.json() as { data: { id: string } };

      // Capture the original blob
      const before = await db.query<{ encrypted_blob: string }>(
        "SELECT encrypted_blob FROM ingestion.credentials WHERE connector_id = $1 AND field_name = 'apiKey'",
        [connector.id],
      );
      expect(before.rows.length).toBe(1);
      const originalBlob = before.rows[0]?.encrypted_blob;
      if (originalBlob === undefined) throw new Error("Expected original credential blob");

      // Update credentials via PATCH
      const patchRes = await app.fetch(
        new Request(`http://localhost/api/v1/connectors/${connector.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({ credentials: { apiKey: "rotated-secret" } }),
        }),
      );
      expect(patchRes.status).toBe(200);

      // The blob must differ — same key, new ciphertext (different IV + AEAD)
      const after = await db.query<{ encrypted_blob: string }>(
        "SELECT encrypted_blob FROM ingestion.credentials WHERE connector_id = $1 AND field_name = 'apiKey'",
        [connector.id],
      );
      expect(after.rows.length).toBe(1);
      const updatedBlob = after.rows[0]?.encrypted_blob;
      if (updatedBlob === undefined) throw new Error("Expected updated credential blob");
      expect(updatedBlob).not.toBe(originalBlob);
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });
});
