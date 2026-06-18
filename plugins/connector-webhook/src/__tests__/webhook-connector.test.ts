/**
 * Unit tests for the Webhook Connector.
 *
 * These tests run entirely in-process using the SDK's mock context.
 * No network calls, no Redis, no ingestion service dependency.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
import { assertValidPlugin, assertValidMetadata } from "@oneplatform/plugin-sdk/testing";
import type { MockContext } from "@oneplatform/plugin-sdk/testing";
import { PluginConfigError, PluginAuthError } from "@oneplatform/plugin-sdk";
import { webhookConnector } from "../index.js";
import type { WebhookPayload } from "../index.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const INSTANCE_ID = "test-instance-001";

/** Minimal valid config satisfying the connector's required fields. */
function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { webhookPath: "my-webhook", batchSize: 100, ...overrides };
}

/**
 * Pre-populate the mock cache with webhook payloads the way the ingestion
 * service would — the connector reads from this staging area in fetchBatch.
 */
async function seedWebhookPayloads(
  ctx: MockContext,
  payloads: WebhookPayload[],
): Promise<void> {
  const ids = payloads.map((p) => p.id);
  await ctx.cache.set(`webhook:index:${INSTANCE_ID}`, { ids });
  for (const payload of payloads) {
    await ctx.cache.set(`webhook:pending:${INSTANCE_ID}:${payload.id}`, payload);
  }
}

function makePayload(
  id: string,
  body: Record<string, unknown> = { eventId: id, type: "test" },
  headers: Record<string, string> = {},
): WebhookPayload {
  return {
    id,
    receivedAt: new Date().toISOString(),
    rawBody: JSON.stringify(body),
    headers,
  };
}

/**
 * Compute a real HMAC-SHA256 hex digest using the Web Crypto API.
 * Used to generate correct test signatures without importing crypto.
 */
async function computeTestHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "HMAC", hash: { name: "SHA-256" } },
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ────────────────────────────────────────────────────────────────────────────
// Interface conformance
// ────────────────────────────────────────────────────────────────────────────

describe("interface conformance", () => {
  it("satisfies the Connector interface", () => {
    assertValidPlugin(webhookConnector, "connector");
  });

  it("returns valid metadata", () => {
    const meta = webhookConnector.metadata();
    assertValidMetadata(meta);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// metadata()
// ────────────────────────────────────────────────────────────────────────────

describe("metadata()", () => {
  it("returns type connector", () => {
    expect(webhookConnector.metadata().type).toBe("connector");
  });

  it("has the correct plugin id", () => {
    expect(webhookConnector.metadata().id).toBe("com.oneplatform.connector-webhook");
  });

  it("has category api", () => {
    expect(webhookConnector.metadata().category).toBe("api");
  });

  it("reports supportsIncremental true", () => {
    expect(webhookConnector.metadata().supportsIncremental).toBe(true);
  });

  it("reports supportsRealtime false — webhook delivery is batch-processed", () => {
    expect(webhookConnector.metadata().supportsRealtime).toBe(false);
  });

  it("returns the same object reference on repeated calls (no allocation per call)", () => {
    expect(webhookConnector.metadata()).toBe(webhookConnector.metadata());
  });
});

// ────────────────────────────────────────────────────────────────────────────
// connect() — config validation
// ────────────────────────────────────────────────────────────────────────────

describe("connect()", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext({ instanceId: INSTANCE_ID });
  });

  it("succeeds with minimal valid config", async () => {
    const handle = await webhookConnector.connect(baseConfig(), ctx);
    expect(handle.connectionId).toContain("webhook:");
    expect(handle.connectionId).toContain(INSTANCE_ID);
  });

  it("embeds webhookPath in handle metadata", async () => {
    const handle = await webhookConnector.connect(baseConfig({ webhookPath: "orders-inbound" }), ctx);
    const meta = handle.metadata as Record<string, unknown>;
    expect(meta["webhookPath"]).toBe("orders-inbound");
  });

  it("rejects a missing webhookPath", async () => {
    await expect(webhookConnector.connect({ batchSize: 100 }, ctx)).rejects.toThrow(
      PluginConfigError,
    );
  });

  it("rejects an empty webhookPath string", async () => {
    await expect(
      webhookConnector.connect(baseConfig({ webhookPath: "" }), ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("rejects webhookPath with invalid characters (uppercase)", async () => {
    await expect(
      webhookConnector.connect(baseConfig({ webhookPath: "MyWebhook" }), ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("rejects webhookPath with spaces", async () => {
    await expect(
      webhookConnector.connect(baseConfig({ webhookPath: "my webhook" }), ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("accepts webhookPath with hyphens and underscores", async () => {
    const handle = await webhookConnector.connect(
      baseConfig({ webhookPath: "github-events_v2" }),
      ctx,
    );
    expect(handle.connectionId).toBeTruthy();
  });

  it("rejects an unknown signatureAlgorithm", async () => {
    await expect(
      webhookConnector.connect(
        baseConfig({ signatureHeader: "X-Signature", signatureAlgorithm: "md5" }),
        ctx,
      ),
    ).rejects.toThrow(PluginConfigError);
  });

  it("rejects batchSize of 0", async () => {
    await expect(
      webhookConnector.connect(baseConfig({ batchSize: 0 }), ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("rejects batchSize over 1000", async () => {
    await expect(
      webhookConnector.connect(baseConfig({ batchSize: 1001 }), ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("rejects non-integer batchSize", async () => {
    await expect(
      webhookConnector.connect(baseConfig({ batchSize: 1.5 }), ctx),
    ).rejects.toThrow(PluginConfigError);
  });

  it("fails when signatureHeader is set but signatureSecret credential is absent", async () => {
    // No credentials configured in context — signatureSecret is not available.
    await expect(
      webhookConnector.connect(
        baseConfig({ signatureHeader: "X-Hub-Signature-256" }),
        ctx,
      ),
    ).rejects.toThrow(PluginConfigError);
  });

  it("succeeds when signatureHeader is set and signatureSecret credential is bound", async () => {
    const ctxWithSecret = createMockContext({
      instanceId: INSTANCE_ID,
      credentials: { signatureSecret: "super-secret" },
    });

    const handle = await webhookConnector.connect(
      baseConfig({ signatureHeader: "X-Hub-Signature-256" }),
      ctxWithSecret,
    );

    const meta = handle.metadata as Record<string, unknown>;
    expect(meta["signatureVerificationEnabled"]).toBe(true);
  });

  it("marks signatureVerificationEnabled false when no signatureHeader is configured", async () => {
    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const meta = handle.metadata as Record<string, unknown>;
    expect(meta["signatureVerificationEnabled"]).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — basic operation
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — basic operation", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext({ instanceId: INSTANCE_ID });
  });

  it("returns an empty result when the staging queue is empty", async () => {
    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("processes all payloads in a single batch when count <= batchSize", async () => {
    const payloads = [
      makePayload("p1", { orderId: "1001" }),
      makePayload("p2", { orderId: "1002" }),
    ];
    await seedWebhookPayloads(ctx, payloads);

    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it("sets fetchedAt to an ISO 8601 timestamp", async () => {
    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(() => new Date(result.fetchedAt)).not.toThrow();
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("removes processed payloads from the staging cache", async () => {
    const payload = makePayload("p1");
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig(), ctx);
    await webhookConnector.fetchBatch(handle, null, ctx);

    // Both the individual payload entry and the index should reflect removal.
    const remaining = await ctx.cache.get<{ ids: string[] }>(`webhook:index:${INSTANCE_ID}`);
    expect(remaining?.ids ?? []).toHaveLength(0);

    const gone = await ctx.cache.get(`webhook:pending:${INSTANCE_ID}:p1`);
    expect(gone).toBeNull();
  });

  it("maps payload body fields into the DataRecord data object", async () => {
    const payload = makePayload("p1", { customerId: "C-999", event: "purchase" });
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    const record = result.records[0];
    expect(record).toBeDefined();
    expect(record!.data["customerId"]).toBe("C-999");
    expect(record!.data["event"]).toBe("purchase");
  });

  it("appends _webhookPayloadId and _webhookReceivedAt to each record", async () => {
    const payload = makePayload("p1");
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    const record = result.records[0]!;
    expect(record.data["_webhookPayloadId"]).toBe("p1");
    expect(typeof record.data["_webhookReceivedAt"]).toBe("string");
  });

  it("uses the payload ID as sourceId when no idField is configured", async () => {
    const payload = makePayload("p1", { myId: "external-123" });
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.sourceId).toBe("p1");
  });

  it("wraps non-object JSON payloads in an envelope rather than failing", async () => {
    const payload: WebhookPayload = {
      id: "p1",
      receivedAt: new Date().toISOString(),
      rawBody: '["a","b","c"]',
      headers: {},
    };
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.data["_payload"]).toEqual(["a", "b", "c"]);
  });

  it("wraps malformed JSON payloads rather than throwing PluginDataError", async () => {
    const payload: WebhookPayload = {
      id: "p1",
      receivedAt: new Date().toISOString(),
      rawBody: "not json {{{",
      headers: {},
    };
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.data["_rawBody"]).toBe("not json {{{");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — idField extraction
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — idField", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext({ instanceId: INSTANCE_ID });
  });

  it("uses a top-level idField as sourceId", async () => {
    const payload = makePayload("p1", { orderId: "ORDER-42", type: "created" });
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig({ idField: "orderId" }), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.sourceId).toBe("ORDER-42");
  });

  it("uses dot-notation idField for nested extraction", async () => {
    const payload = makePayload("p1", { event: { id: "EVT-99" }, type: "order" });
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig({ idField: "event.id" }), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.sourceId).toBe("EVT-99");
  });

  it("falls back to payload ID when idField path does not exist", async () => {
    const payload = makePayload("p1", { type: "ping" });
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig({ idField: "nonexistent.path" }), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.sourceId).toBe("p1");
  });

  it("converts numeric idField values to strings", async () => {
    const payload = makePayload("p1", { sequenceNumber: 12345 });
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(baseConfig({ idField: "sequenceNumber" }), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records[0]!.sourceId).toBe("12345");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — pagination via cursor
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — pagination", () => {
  let ctx: MockContext;

  beforeEach(() => {
    ctx = createMockContext({ instanceId: INSTANCE_ID });
  });

  it("processes only batchSize records per call when more are queued", async () => {
    const payloads = Array.from({ length: 5 }, (_, i) => makePayload(`p${i + 1}`));
    await seedWebhookPayloads(ctx, payloads);

    const handle = await webhookConnector.connect(baseConfig({ batchSize: 2 }), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it("provides a non-null nextCursor when hasMore is true", async () => {
    const payloads = Array.from({ length: 3 }, (_, i) => makePayload(`p${i + 1}`));
    await seedWebhookPayloads(ctx, payloads);

    const handle = await webhookConnector.connect(baseConfig({ batchSize: 2 }), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.nextCursor).not.toBeNull();
  });

  it("drains the full queue across multiple fetchBatch calls", async () => {
    const payloads = Array.from({ length: 5 }, (_, i) => makePayload(`p${i + 1}`));
    await seedWebhookPayloads(ctx, payloads);

    const handle = await webhookConnector.connect(baseConfig({ batchSize: 2 }), ctx);

    const allRecords = [];
    let cursor: string | null = null;

    // The payloads are removed from the index after each batch, so we use hasMore
    // from the previous batch to decide whether to continue rather than re-reading.
    let hasMore = true;
    while (hasMore) {
      const result = await webhookConnector.fetchBatch(handle, cursor, ctx);
      allRecords.push(...result.records);
      cursor = result.nextCursor;
      hasMore = result.hasMore;
    }

    expect(allRecords).toHaveLength(5);
  });

  it("returns hasMore=false and nextCursor=null after the last batch", async () => {
    const payloads = [makePayload("p1"), makePayload("p2")];
    await seedWebhookPayloads(ctx, payloads);

    const handle = await webhookConnector.connect(baseConfig({ batchSize: 100 }), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("skips missing payloads without halting the batch (TTL eviction scenario)", async () => {
    const p1 = makePayload("p1", { value: "a" });
    const p2 = makePayload("p2", { value: "b" });
    await seedWebhookPayloads(ctx, [p1, p2]);

    // Simulate p1's individual entry being evicted while the index still references it.
    await ctx.cache.delete(`webhook:pending:${INSTANCE_ID}:p1`);

    const handle = await webhookConnector.connect(baseConfig(), ctx);
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    // p2 should still be processed successfully.
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.data["value"]).toBe("b");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// fetchBatch() — HMAC signature verification
// ────────────────────────────────────────────────────────────────────────────

describe("fetchBatch() — HMAC signature verification", () => {
  const SECRET = "test-hmac-secret-xyz";

  async function ctxWithSecret(): Promise<MockContext> {
    return createMockContext({
      instanceId: INSTANCE_ID,
      credentials: { signatureSecret: SECRET },
    });
  }

  it("accepts payloads with a correct HMAC-SHA256 signature", async () => {
    const ctx = await ctxWithSecret();

    const body = JSON.stringify({ event: "order.created", id: "O-1" });
    const sig = await computeTestHmac(SECRET, body);

    const payload: WebhookPayload = {
      id: "p1",
      receivedAt: new Date().toISOString(),
      rawBody: body,
      headers: { "x-hub-signature-256": `sha256=${sig}` },
    };
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(
      baseConfig({ signatureHeader: "X-Hub-Signature-256" }),
      ctx,
    );
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(1);
  });

  it("skips payloads with an incorrect HMAC signature and logs a warning", async () => {
    const ctx = await ctxWithSecret();

    const body = JSON.stringify({ event: "order.created" });
    const payload: WebhookPayload = {
      id: "p1",
      receivedAt: new Date().toISOString(),
      rawBody: body,
      headers: { "x-hub-signature-256": "sha256=deadbeefdeadbeef" },
    };
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(
      baseConfig({ signatureHeader: "X-Hub-Signature-256" }),
      ctx,
    );
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    // Invalid signature — payload skipped, not halting the batch.
    expect(result.records).toHaveLength(0);
    const warnings = ctx.logger.__logs.filter((l) => l.level === "warn");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("skips payloads missing the signature header entirely", async () => {
    const ctx = await ctxWithSecret();

    const payload = makePayload("p1", { event: "test" }, {}); // no headers
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(
      baseConfig({ signatureHeader: "X-Hub-Signature-256" }),
      ctx,
    );
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(0);
  });

  it("accepts signatures without the algorithm= prefix (bare hex)", async () => {
    const ctx = await ctxWithSecret();

    const body = JSON.stringify({ type: "ping" });
    const sig = await computeTestHmac(SECRET, body);

    const payload: WebhookPayload = {
      id: "p1",
      receivedAt: new Date().toISOString(),
      rawBody: body,
      // No "sha256=" prefix — just the raw hex string.
      headers: { "x-signature": sig },
    };
    await seedWebhookPayloads(ctx, [payload]);

    const handle = await webhookConnector.connect(
      baseConfig({ signatureHeader: "X-Signature" }),
      ctx,
    );
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(1);
  });

  it("continues processing valid payloads after skipping an invalid one", async () => {
    const ctx = await ctxWithSecret();

    const goodBody = JSON.stringify({ id: "E-2" });
    const goodSig = await computeTestHmac(SECRET, goodBody);

    const badPayload: WebhookPayload = {
      id: "p1",
      receivedAt: new Date().toISOString(),
      rawBody: JSON.stringify({ id: "E-1" }),
      headers: { "x-sig": "sha256=badbadbadbad" },
    };
    const goodPayload: WebhookPayload = {
      id: "p2",
      receivedAt: new Date().toISOString(),
      rawBody: goodBody,
      headers: { "x-sig": `sha256=${goodSig}` },
    };
    await seedWebhookPayloads(ctx, [badPayload, goodPayload]);

    const handle = await webhookConnector.connect(
      baseConfig({ signatureHeader: "X-Sig" }),
      ctx,
    );
    const result = await webhookConnector.fetchBatch(handle, null, ctx);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.data["id"]).toBe("E-2");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// disconnect()
// ────────────────────────────────────────────────────────────────────────────

describe("disconnect()", () => {
  it("resolves without error", async () => {
    const ctx = createMockContext({ instanceId: INSTANCE_ID });
    const handle = await webhookConnector.connect(baseConfig(), ctx);
    await expect(webhookConnector.disconnect(handle, ctx)).resolves.toBeUndefined();
  });

  it("does not throw even when called multiple times", async () => {
    const ctx = createMockContext({ instanceId: INSTANCE_ID });
    const handle = await webhookConnector.connect(baseConfig(), ctx);
    await webhookConnector.disconnect(handle, ctx);
    await expect(webhookConnector.disconnect(handle, ctx)).resolves.toBeUndefined();
  });
});
