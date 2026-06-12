import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { createDbClient } from "@oneplatform/core";
import type pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupIngestionTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

describe("Ingestion — webhook receivers (Level 1)", () => {
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

  it("POST /api/v1/webhooks/inbound creates a webhook receiver and returns a plaintext secret", async () => {
    const tenantId = newTenantId();

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/webhooks/inbound", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            name: "My Webhook",
            hmacAlgorithm: "sha256",
            headerName: "X-Webhook-Signature",
          }),
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json() as { data: { id: string; name: string; secret: string } };
      expect(body.data.id).toBeTruthy();
      expect(body.data.name).toBe("My Webhook");
      // The plaintext signing secret is returned once at creation time only.
      expect(typeof body.data.secret).toBe("string");
      expect(body.data.secret.length).toBeGreaterThan(16);
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("POST /api/v1/webhooks/inbound/:id/receive accepts a valid HMAC-signed payload with 200", async () => {
    const tenantId = newTenantId();

    try {
      // Create receiver and capture the signing secret
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/webhooks/inbound", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            name: "HMAC Valid Test",
            hmacAlgorithm: "sha256",
            headerName: "X-Webhook-Signature",
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: receiver } = await createRes.json() as { data: { id: string; secret: string } };

      const payload = JSON.stringify({ event: "order.created", orderId: "42" });
      const signature = createHmac("sha256", receiver.secret)
        .update(payload)
        .digest("hex");

      const receiveRes = await app.fetch(
        new Request(`http://localhost/api/v1/webhooks/inbound/${receiver.id}/receive`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
          },
          body: payload,
        }),
      );

      // The receive endpoint always returns 200 (anti-enumeration — spec §security)
      expect(receiveRes.status).toBe(200);
      const body = await receiveRes.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("POST /api/v1/webhooks/inbound/:id/receive returns 200 even for tampered payloads (anti-enumeration)", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/webhooks/inbound", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            name: "HMAC Tamper Test",
            hmacAlgorithm: "sha256",
            headerName: "X-Webhook-Signature",
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: receiver } = await createRes.json() as { data: { id: string; secret: string } };

      const originalPayload = JSON.stringify({ event: "order.created" });
      const validSignature = createHmac("sha256", receiver.secret)
        .update(originalPayload)
        .digest("hex");

      // Tamper: send a different body with the signature for the original body.
      const tamperedPayload = JSON.stringify({ event: "order.deleted" });

      const receiveRes = await app.fetch(
        new Request(`http://localhost/api/v1/webhooks/inbound/${receiver.id}/receive`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Valid signature for originalPayload but sent with tamperedPayload
            "X-Webhook-Signature": validSignature,
          },
          body: tamperedPayload,
        }),
      );

      // Anti-enumeration: even a failed HMAC returns 200 so attackers cannot
      // distinguish "wrong signature" from "receiver not found" or "processed OK".
      expect(receiveRes.status).toBe(200);
      const body = await receiveRes.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });

  it("GET /api/v1/webhooks/inbound lists receivers for the authenticated tenant", async () => {
    const tenantId = newTenantId();

    try {
      // Create two receivers
      for (const name of ["Receiver Alpha", "Receiver Beta"]) {
        const res = await app.fetch(
          new Request("http://localhost/api/v1/webhooks/inbound", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: await authHeader(tenantId),
            },
            body: JSON.stringify({
              name,
              hmacAlgorithm: "sha256",
              headerName: "X-Webhook-Signature",
            }),
          }),
        );
        expect(res.status).toBe(201);
      }

      const listRes = await app.fetch(
        new Request("http://localhost/api/v1/webhooks/inbound", {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(listRes.status).toBe(200);
      const body = await listRes.json() as { data: Array<{ name: string }> };
      expect(Array.isArray(body.data)).toBe(true);
      const names = body.data.map((r) => r.name);
      expect(names).toContain("Receiver Alpha");
      expect(names).toContain("Receiver Beta");
    } finally {
      await cleanupIngestionTenant(db, tenantId);
    }
  });
});
