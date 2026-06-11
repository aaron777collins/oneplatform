// Unit tests for services/ingestion/src/schemas/index.ts
//
// Tests every exported Zod schema: valid inputs, invalid inputs, defaults,
// optional/nullable fields, boundary conditions.

import { describe, it, expect } from "vitest";
import {
  listConnectorsQuery,
  createConnectorRequest,
  patchConnectorRequest,
  testConnectorRequest,
  triggerSyncRequest,
  listSyncsQuery,
  createWebhookReceiverRequest,
  patchWebhookReceiverRequest,
  rotateWebhookSecretRequest,
  listWebhookReceiversQuery,
  uploadStatusQuery,
  registerConnectorPluginRequest,
  internalSyncRequest,
} from "../schemas/index.js";

// ---------------------------------------------------------------------------
// listConnectorsQuery
// ---------------------------------------------------------------------------

describe("listConnectorsQuery — defaults", () => {
  it("defaults limit to 50 when omitted", () => {
    const result = listConnectorsQuery.safeParse({});
    expect(result.success && result.data.limit).toBe(50);
  });

  it("defaults sort to '-createdAt' when omitted", () => {
    const result = listConnectorsQuery.safeParse({});
    expect(result.success && result.data.sort).toBe("-createdAt");
  });

  it("cursor is undefined when omitted", () => {
    const result = listConnectorsQuery.safeParse({});
    expect(result.success && result.data.cursor).toBeUndefined();
  });

  it("filter[status][eq] is undefined when omitted", () => {
    const result = listConnectorsQuery.safeParse({});
    expect(result.success && result.data["filter[status][eq]"]).toBeUndefined();
  });
});

describe("listConnectorsQuery — valid inputs", () => {
  it("accepts limit = 1 (min bound)", () => {
    const result = listConnectorsQuery.safeParse({ limit: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts limit = 100 (max bound)", () => {
    const result = listConnectorsQuery.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
  });

  it("coerces string limit to number", () => {
    const result = listConnectorsQuery.safeParse({ limit: "25" });
    expect(result.success && result.data.limit).toBe(25);
  });

  it("accepts filter[status][eq] = 'enabled'", () => {
    const result = listConnectorsQuery.safeParse({ "filter[status][eq]": "enabled" });
    expect(result.success).toBe(true);
  });

  it("accepts filter[status][eq] = 'disabled'", () => {
    const result = listConnectorsQuery.safeParse({ "filter[status][eq]": "disabled" });
    expect(result.success).toBe(true);
  });

  it("accepts a cursor string", () => {
    const result = listConnectorsQuery.safeParse({ cursor: "some-uuid" });
    expect(result.success && result.data.cursor).toBe("some-uuid");
  });

  it("accepts a custom sort value", () => {
    const result = listConnectorsQuery.safeParse({ sort: "name" });
    expect(result.success && result.data.sort).toBe("name");
  });

  it("accepts filter[pluginId][eq]", () => {
    const result = listConnectorsQuery.safeParse({ "filter[pluginId][eq]": "my-plugin" });
    expect(result.success).toBe(true);
  });
});

describe("listConnectorsQuery — invalid inputs", () => {
  it("rejects limit = 0", () => {
    const result = listConnectorsQuery.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects limit = 101", () => {
    const result = listConnectorsQuery.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects fractional limit", () => {
    const result = listConnectorsQuery.safeParse({ limit: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown filter[status][eq] value", () => {
    const result = listConnectorsQuery.safeParse({ "filter[status][eq]": "archived" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createConnectorRequest
// ---------------------------------------------------------------------------

describe("createConnectorRequest — valid inputs", () => {
  const minimal = {
    pluginId: "my-plugin",
    name: "My Connector",
    config: {},
    credentials: {},
  };

  it("accepts a minimal valid request", () => {
    const result = createConnectorRequest.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("defaults syncMode to 'incremental'", () => {
    const result = createConnectorRequest.safeParse(minimal);
    expect(result.success && result.data.syncMode).toBe("incremental");
  });

  it("defaults isEnabled to true", () => {
    const result = createConnectorRequest.safeParse(minimal);
    expect(result.success && result.data.isEnabled).toBe(true);
  });

  it("accepts syncMode = 'full'", () => {
    const result = createConnectorRequest.safeParse({ ...minimal, syncMode: "full" });
    expect(result.success && result.data.syncMode).toBe("full");
  });

  it("accepts isEnabled = false", () => {
    const result = createConnectorRequest.safeParse({ ...minimal, isEnabled: false });
    expect(result.success && result.data.isEnabled).toBe(false);
  });

  it("accepts an optional description", () => {
    const result = createConnectorRequest.safeParse({ ...minimal, description: "My connector" });
    expect(result.success && result.data.description).toBe("My connector");
  });

  it("accepts an optional scheduleCron", () => {
    const result = createConnectorRequest.safeParse({ ...minimal, scheduleCron: "0 * * * *" });
    expect(result.success && result.data.scheduleCron).toBe("0 * * * *");
  });

  it("accepts non-empty credentials record", () => {
    const result = createConnectorRequest.safeParse({ ...minimal, credentials: { apiKey: "secret" } });
    expect(result.success).toBe(true);
  });

  it("accepts config with nested objects", () => {
    const result = createConnectorRequest.safeParse({ ...minimal, config: { host: "db.example.com", port: 5432 } });
    expect(result.success).toBe(true);
  });

  it("accepts name at max boundary (200 chars)", () => {
    const result = createConnectorRequest.safeParse({ ...minimal, name: "a".repeat(200) });
    expect(result.success).toBe(true);
  });

  it("accepts description at max boundary (1000 chars)", () => {
    const result = createConnectorRequest.safeParse({ ...minimal, description: "a".repeat(1000) });
    expect(result.success).toBe(true);
  });
});

describe("createConnectorRequest — invalid inputs", () => {
  it("rejects empty pluginId", () => {
    const result = createConnectorRequest.safeParse({ pluginId: "", name: "N", config: {}, credentials: {} });
    expect(result.success).toBe(false);
  });

  it("rejects missing pluginId", () => {
    const result = createConnectorRequest.safeParse({ name: "N", config: {}, credentials: {} });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = createConnectorRequest.safeParse({ pluginId: "p", name: "", config: {}, credentials: {} });
    expect(result.success).toBe(false);
  });

  it("rejects name longer than 200 chars", () => {
    const result = createConnectorRequest.safeParse({ pluginId: "p", name: "a".repeat(201), config: {}, credentials: {} });
    expect(result.success).toBe(false);
  });

  it("rejects description longer than 1000 chars", () => {
    const result = createConnectorRequest.safeParse({ pluginId: "p", name: "N", config: {}, credentials: {}, description: "a".repeat(1001) });
    expect(result.success).toBe(false);
  });

  it("rejects unknown syncMode", () => {
    const result = createConnectorRequest.safeParse({ pluginId: "p", name: "N", config: {}, credentials: {}, syncMode: "delta" });
    expect(result.success).toBe(false);
  });

  it("rejects non-string credential values", () => {
    const result = createConnectorRequest.safeParse({ pluginId: "p", name: "N", config: {}, credentials: { key: 123 } });
    expect(result.success).toBe(false);
  });

  it("rejects missing config field", () => {
    const result = createConnectorRequest.safeParse({ pluginId: "p", name: "N", credentials: {} });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// patchConnectorRequest
// ---------------------------------------------------------------------------

describe("patchConnectorRequest — valid inputs", () => {
  it("accepts an empty patch (all optional)", () => {
    const result = patchConnectorRequest.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts name alone", () => {
    const result = patchConnectorRequest.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });

  it("accepts description = null (clears the field)", () => {
    const result = patchConnectorRequest.safeParse({ description: null });
    expect(result.success).toBe(true);
  });

  it("accepts scheduleCron = null (clears the schedule)", () => {
    const result = patchConnectorRequest.safeParse({ scheduleCron: null });
    expect(result.success).toBe(true);
  });

  it("accepts isEnabled = false", () => {
    const result = patchConnectorRequest.safeParse({ isEnabled: false });
    expect(result.success).toBe(true);
  });

  it("accepts syncMode change to 'full'", () => {
    const result = patchConnectorRequest.safeParse({ syncMode: "full" });
    expect(result.success).toBe(true);
  });

  it("accepts a full patch with all fields", () => {
    const result = patchConnectorRequest.safeParse({
      name: "Updated",
      description: "New description",
      config: { host: "new-host" },
      credentials: { apiKey: "new-secret" },
      syncMode: "incremental",
      scheduleCron: "0 * * * *",
      isEnabled: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("patchConnectorRequest — invalid inputs", () => {
  it("rejects name longer than 200 chars", () => {
    const result = patchConnectorRequest.safeParse({ name: "a".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects empty name string", () => {
    const result = patchConnectorRequest.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects description longer than 1000 chars", () => {
    const result = patchConnectorRequest.safeParse({ description: "a".repeat(1001) });
    expect(result.success).toBe(false);
  });

  it("rejects unknown syncMode value", () => {
    const result = patchConnectorRequest.safeParse({ syncMode: "partial" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// testConnectorRequest (optional schema)
// ---------------------------------------------------------------------------

describe("testConnectorRequest", () => {
  it("accepts undefined (entire body omitted)", () => {
    const result = testConnectorRequest.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it("accepts empty object", () => {
    const result = testConnectorRequest.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts config override", () => {
    const result = testConnectorRequest.safeParse({ config: { host: "test" } });
    expect(result.success).toBe(true);
  });

  it("accepts credentials override", () => {
    const result = testConnectorRequest.safeParse({ credentials: { apiKey: "test-key" } });
    expect(result.success).toBe(true);
  });

  it("accepts both config and credentials override", () => {
    const result = testConnectorRequest.safeParse({ config: { x: 1 }, credentials: { k: "v" } });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// triggerSyncRequest (optional schema)
// ---------------------------------------------------------------------------

describe("triggerSyncRequest", () => {
  it("accepts undefined (body omitted)", () => {
    const result = triggerSyncRequest.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it("defaults force to false", () => {
    const result = triggerSyncRequest.safeParse({});
    expect(result.success && result.data?.force).toBe(false);
  });

  it("accepts mode = 'full'", () => {
    const result = triggerSyncRequest.safeParse({ mode: "full" });
    expect(result.success).toBe(true);
  });

  it("accepts mode = 'incremental'", () => {
    const result = triggerSyncRequest.safeParse({ mode: "incremental" });
    expect(result.success).toBe(true);
  });

  it("accepts force = true", () => {
    const result = triggerSyncRequest.safeParse({ force: true });
    expect(result.success && result.data?.force).toBe(true);
  });

  it("rejects unknown mode value", () => {
    const result = triggerSyncRequest.safeParse({ mode: "partial" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listSyncsQuery
// ---------------------------------------------------------------------------

describe("listSyncsQuery — defaults", () => {
  it("defaults limit to 20 when omitted", () => {
    const result = listSyncsQuery.safeParse({});
    expect(result.success && result.data.limit).toBe(20);
  });

  it("cursor is undefined when omitted", () => {
    const result = listSyncsQuery.safeParse({});
    expect(result.success && result.data.cursor).toBeUndefined();
  });
});

describe("listSyncsQuery — valid inputs", () => {
  it("accepts limit = 1", () => {
    const result = listSyncsQuery.safeParse({ limit: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts limit = 100", () => {
    const result = listSyncsQuery.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
  });

  it("accepts all valid status values", () => {
    for (const status of ["running", "success", "failed", "cancelled"] as const) {
      const result = listSyncsQuery.safeParse({ "filter[status][eq]": status });
      expect(result.success).toBe(true);
    }
  });
});

describe("listSyncsQuery — invalid inputs", () => {
  it("rejects limit = 0", () => {
    const result = listSyncsQuery.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects limit = 101", () => {
    const result = listSyncsQuery.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown filter[status][eq] value", () => {
    const result = listSyncsQuery.safeParse({ "filter[status][eq]": "never_run" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createWebhookReceiverRequest
// ---------------------------------------------------------------------------

describe("createWebhookReceiverRequest — valid inputs", () => {
  const minimal = { name: "My Receiver" };

  it("accepts a minimal request with just a name", () => {
    const result = createWebhookReceiverRequest.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("defaults hmacAlgorithm to 'sha256'", () => {
    const result = createWebhookReceiverRequest.safeParse(minimal);
    expect(result.success && result.data.hmacAlgorithm).toBe("sha256");
  });

  it("defaults headerName to 'X-Webhook-Signature'", () => {
    const result = createWebhookReceiverRequest.safeParse(minimal);
    expect(result.success && result.data.headerName).toBe("X-Webhook-Signature");
  });

  it("accepts hmacAlgorithm = 'sha512'", () => {
    const result = createWebhookReceiverRequest.safeParse({ ...minimal, hmacAlgorithm: "sha512" });
    expect(result.success && result.data.hmacAlgorithm).toBe("sha512");
  });

  it("accepts an optional connectorId UUID", () => {
    const result = createWebhookReceiverRequest.safeParse({
      ...minimal,
      connectorId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional description", () => {
    const result = createWebhookReceiverRequest.safeParse({ ...minimal, description: "My webhook" });
    expect(result.success).toBe(true);
  });

  it("accepts a custom headerName", () => {
    const result = createWebhookReceiverRequest.safeParse({ ...minimal, headerName: "X-Sig" });
    expect(result.success && result.data.headerName).toBe("X-Sig");
  });

  it("accepts name at max boundary (200 chars)", () => {
    const result = createWebhookReceiverRequest.safeParse({ name: "a".repeat(200) });
    expect(result.success).toBe(true);
  });

  it("accepts description at max boundary (1000 chars)", () => {
    const result = createWebhookReceiverRequest.safeParse({ ...minimal, description: "a".repeat(1000) });
    expect(result.success).toBe(true);
  });
});

describe("createWebhookReceiverRequest — invalid inputs", () => {
  it("rejects empty name", () => {
    const result = createWebhookReceiverRequest.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name longer than 200 chars", () => {
    const result = createWebhookReceiverRequest.safeParse({ name: "a".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects description longer than 1000 chars", () => {
    const result = createWebhookReceiverRequest.safeParse({ name: "R", description: "a".repeat(1001) });
    expect(result.success).toBe(false);
  });

  it("rejects connectorId that is not a UUID", () => {
    const result = createWebhookReceiverRequest.safeParse({ name: "R", connectorId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown hmacAlgorithm", () => {
    const result = createWebhookReceiverRequest.safeParse({ name: "R", hmacAlgorithm: "md5" });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = createWebhookReceiverRequest.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// patchWebhookReceiverRequest
// ---------------------------------------------------------------------------

describe("patchWebhookReceiverRequest — valid inputs", () => {
  it("accepts empty object (all optional)", () => {
    const result = patchWebhookReceiverRequest.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts name alone", () => {
    const result = patchWebhookReceiverRequest.safeParse({ name: "Updated" });
    expect(result.success).toBe(true);
  });

  it("accepts description = null (clears the field)", () => {
    const result = patchWebhookReceiverRequest.safeParse({ description: null });
    expect(result.success).toBe(true);
  });

  it("accepts connectorId = null (unlinks connector)", () => {
    const result = patchWebhookReceiverRequest.safeParse({ connectorId: null });
    expect(result.success).toBe(true);
  });

  it("accepts isEnabled = false", () => {
    const result = patchWebhookReceiverRequest.safeParse({ isEnabled: false });
    expect(result.success).toBe(true);
  });

  it("accepts hmacAlgorithm = 'sha512'", () => {
    const result = patchWebhookReceiverRequest.safeParse({ hmacAlgorithm: "sha512" });
    expect(result.success).toBe(true);
  });
});

describe("patchWebhookReceiverRequest — invalid inputs", () => {
  it("rejects name longer than 200 chars", () => {
    const result = patchWebhookReceiverRequest.safeParse({ name: "a".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = patchWebhookReceiverRequest.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects connectorId that is not a UUID", () => {
    const result = patchWebhookReceiverRequest.safeParse({ connectorId: "bad-id" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown hmacAlgorithm", () => {
    const result = patchWebhookReceiverRequest.safeParse({ hmacAlgorithm: "sha1" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rotateWebhookSecretRequest
// ---------------------------------------------------------------------------

describe("rotateWebhookSecretRequest", () => {
  it("accepts a non-empty currentSecret", () => {
    const result = rotateWebhookSecretRequest.safeParse({ currentSecret: "my-secret-value" });
    expect(result.success).toBe(true);
  });

  it("rejects empty currentSecret", () => {
    const result = rotateWebhookSecretRequest.safeParse({ currentSecret: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing currentSecret", () => {
    const result = rotateWebhookSecretRequest.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listWebhookReceiversQuery
// ---------------------------------------------------------------------------

describe("listWebhookReceiversQuery", () => {
  it("defaults limit to 50 when omitted", () => {
    const result = listWebhookReceiversQuery.safeParse({});
    expect(result.success && result.data.limit).toBe(50);
  });

  it("accepts limit = 1 (min bound)", () => {
    const result = listWebhookReceiversQuery.safeParse({ limit: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts limit = 100 (max bound)", () => {
    const result = listWebhookReceiversQuery.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
  });

  it("rejects limit = 0", () => {
    const result = listWebhookReceiversQuery.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects limit = 101", () => {
    const result = listWebhookReceiversQuery.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it("accepts a cursor string", () => {
    const result = listWebhookReceiversQuery.safeParse({ cursor: "abc" });
    expect(result.success && result.data.cursor).toBe("abc");
  });

  it("cursor is undefined when omitted", () => {
    const result = listWebhookReceiversQuery.safeParse({});
    expect(result.success && result.data.cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// uploadStatusQuery
// ---------------------------------------------------------------------------

describe("uploadStatusQuery", () => {
  it("accepts a valid UUID", () => {
    const result = uploadStatusQuery.safeParse({ id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID string", () => {
    const result = uploadStatusQuery.safeParse({ id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing id", () => {
    const result = uploadStatusQuery.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an empty string", () => {
    const result = uploadStatusQuery.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// registerConnectorPluginRequest
// ---------------------------------------------------------------------------

describe("registerConnectorPluginRequest — valid inputs", () => {
  const valid = {
    pluginId: "stripe",
    instanceId: "550e8400-e29b-41d4-a716-446655440001",
    tenantId: "550e8400-e29b-41d4-a716-446655440002",
    displayName: "Stripe Connector",
    version: "1.0.0",
    metadata: {},
  };

  it("accepts a valid registration request", () => {
    const result = registerConnectorPluginRequest.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts metadata with nested fields", () => {
    const result = registerConnectorPluginRequest.safeParse({ ...valid, metadata: { capabilities: ["read", "write"] } });
    expect(result.success).toBe(true);
  });

  it("accepts any string for pluginId", () => {
    const result = registerConnectorPluginRequest.safeParse({ ...valid, pluginId: "my-custom-plugin-v2" });
    expect(result.success).toBe(true);
  });
});

describe("registerConnectorPluginRequest — invalid inputs", () => {
  const valid = {
    pluginId: "stripe",
    instanceId: "550e8400-e29b-41d4-a716-446655440001",
    tenantId: "550e8400-e29b-41d4-a716-446655440002",
    displayName: "Stripe",
    version: "1.0.0",
    metadata: {},
  };

  it("rejects instanceId that is not a UUID", () => {
    const result = registerConnectorPluginRequest.safeParse({ ...valid, instanceId: "not-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects tenantId that is not a UUID", () => {
    const result = registerConnectorPluginRequest.safeParse({ ...valid, tenantId: "not-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects empty displayName", () => {
    const result = registerConnectorPluginRequest.safeParse({ ...valid, displayName: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty version", () => {
    const result = registerConnectorPluginRequest.safeParse({ ...valid, version: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing pluginId", () => {
    const { pluginId: _p, ...rest } = valid;
    const result = registerConnectorPluginRequest.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects missing metadata", () => {
    const { metadata: _m, ...rest } = valid;
    const result = registerConnectorPluginRequest.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// internalSyncRequest
// ---------------------------------------------------------------------------

describe("internalSyncRequest — valid inputs", () => {
  const valid = {
    connectorInstanceId: "550e8400-e29b-41d4-a716-446655440001",
    tenantId: "550e8400-e29b-41d4-a716-446655440002",
  };

  it("accepts a minimal request", () => {
    const result = internalSyncRequest.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("defaults waitForCompletion to true", () => {
    const result = internalSyncRequest.safeParse(valid);
    expect(result.success && result.data.waitForCompletion).toBe(true);
  });

  it("accepts syncMode = 'full'", () => {
    const result = internalSyncRequest.safeParse({ ...valid, syncMode: "full" });
    expect(result.success).toBe(true);
  });

  it("accepts syncMode = 'incremental'", () => {
    const result = internalSyncRequest.safeParse({ ...valid, syncMode: "incremental" });
    expect(result.success).toBe(true);
  });

  it("accepts an optional runId UUID", () => {
    const result = internalSyncRequest.safeParse({ ...valid, runId: "550e8400-e29b-41d4-a716-446655440003" });
    expect(result.success).toBe(true);
  });

  it("accepts an optional stepId string", () => {
    const result = internalSyncRequest.safeParse({ ...valid, stepId: "step-abc" });
    expect(result.success).toBe(true);
  });

  it("accepts waitForCompletion = false", () => {
    const result = internalSyncRequest.safeParse({ ...valid, waitForCompletion: false });
    expect(result.success && result.data.waitForCompletion).toBe(false);
  });
});

describe("internalSyncRequest — invalid inputs", () => {
  it("rejects connectorInstanceId that is not a UUID", () => {
    const result = internalSyncRequest.safeParse({
      connectorInstanceId: "not-uuid",
      tenantId: "550e8400-e29b-41d4-a716-446655440002",
    });
    expect(result.success).toBe(false);
  });

  it("rejects tenantId that is not a UUID", () => {
    const result = internalSyncRequest.safeParse({
      connectorInstanceId: "550e8400-e29b-41d4-a716-446655440001",
      tenantId: "not-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects runId that is not a UUID", () => {
    const result = internalSyncRequest.safeParse({
      connectorInstanceId: "550e8400-e29b-41d4-a716-446655440001",
      tenantId: "550e8400-e29b-41d4-a716-446655440002",
      runId: "not-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing connectorInstanceId", () => {
    const result = internalSyncRequest.safeParse({ tenantId: "550e8400-e29b-41d4-a716-446655440002" });
    expect(result.success).toBe(false);
  });

  it("rejects missing tenantId", () => {
    const result = internalSyncRequest.safeParse({ connectorInstanceId: "550e8400-e29b-41d4-a716-446655440001" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown syncMode", () => {
    const result = internalSyncRequest.safeParse({
      connectorInstanceId: "550e8400-e29b-41d4-a716-446655440001",
      tenantId: "550e8400-e29b-41d4-a716-446655440002",
      syncMode: "delta",
    });
    expect(result.success).toBe(false);
  });
});
