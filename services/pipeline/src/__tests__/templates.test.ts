// Unit tests for services/pipeline/src/templates/
//
// Verifies that:
// 1. Every template factory produces a definition that passes PipelineDefinitionSchema.
// 2. The registry list endpoint returns the expected metadata.
// 3. buildFromTemplate() validates params and surfaces errors correctly.
// 4. Edge cases (unknown template, bad params, optional fields) are handled.

import { describe, it, expect } from "vitest";
import { PipelineDefinitionSchema } from "../schemas/index.js";
import { listTemplates, buildFromTemplate } from "../templates/index.js";
import { syncToPostgresTemplate } from "../templates/sync-to-postgres.js";
import { csvImportTemplate } from "../templates/csv-import.js";
import { dailyExportTemplate } from "../templates/daily-export.js";
import { webhookToPipelineTemplate } from "../templates/webhook-to-pipeline.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440001";
const HTTPS_URL = "https://api.example.com/callback";

// ---------------------------------------------------------------------------
// syncToPostgresTemplate — direct factory tests
// ---------------------------------------------------------------------------

describe("syncToPostgresTemplate — definition validity", () => {
  it("produces a valid definition with minimum required params", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("produces a valid definition with optional transformerId", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "order",
      transformerId: "my-transformer",
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("produces a valid definition with syncMode: full", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
      syncMode: "full",
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("includes exactly 2 steps when no transformer is requested", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
    });
    expect(def.steps).toHaveLength(2);
  });

  it("includes exactly 3 steps when a transformer is requested", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
      transformerId: "plugin-x",
    });
    expect(def.steps).toHaveLength(3);
  });

  it("sets entryStepId to sync-connector", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
    });
    expect(def.entryStepId).toBe("sync-connector");
  });

  it("disallows concurrent runs (allowConcurrentRuns: false)", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
    });
    expect(def.options?.allowConcurrentRuns).toBe(false);
  });

  it("connector step uses the supplied connectorInstanceId", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
    });
    const connectorStep = def.steps.find((s) => s.id === "sync-connector");
    expect(connectorStep).toBeDefined();
    expect((connectorStep as { connectorInstanceId?: string }).connectorInstanceId).toBe(CONNECTOR_ID);
  });

  it("defaults syncMode to incremental", () => {
    const def = syncToPostgresTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
    });
    const connectorStep = def.steps.find((s) => s.id === "sync-connector");
    expect((connectorStep as { syncMode?: string }).syncMode).toBe("incremental");
  });
});

// ---------------------------------------------------------------------------
// csvImportTemplate — direct factory tests
// ---------------------------------------------------------------------------

describe("csvImportTemplate — definition validity", () => {
  it("produces a valid definition with required params", () => {
    const def = csvImportTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "contact",
      columnMapping: { "First Name": "firstName", "Email": "email" },
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("produces a valid definition with skipInvalidRows: true", () => {
    const def = csvImportTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "contact",
      columnMapping: { "ID": "id" },
      skipInvalidRows: true,
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("sets entryStepId to fetch-csv", () => {
    const def = csvImportTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "contact",
      columnMapping: { "ID": "id" },
    });
    expect(def.entryStepId).toBe("fetch-csv");
  });

  it("includes a conditional check-has-records step", () => {
    const def = csvImportTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "contact",
      columnMapping: { "ID": "id" },
    });
    const condStep = def.steps.find((s) => s.id === "check-has-records");
    expect(condStep).toBeDefined();
    expect(condStep?.type).toBe("conditional");
  });

  it("includes a no-records-skip step as fallback branch", () => {
    const def = csvImportTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "contact",
      columnMapping: { "ID": "id" },
    });
    expect(def.steps.some((s) => s.id === "no-records-skip")).toBe(true);
  });

  it("embeds the column mapping into the parse-and-map code step", () => {
    const def = csvImportTemplate({
      connectorInstanceId: CONNECTOR_ID,
      entityType: "contact",
      columnMapping: { "Email": "email" },
    });
    const parseStep = def.steps.find((s) => s.id === "parse-and-map");
    expect(parseStep?.type).toBe("code");
    const code = (parseStep as { code?: string }).code ?? "";
    expect(code).toContain('"Email"');
    expect(code).toContain('"email"');
  });
});

// ---------------------------------------------------------------------------
// dailyExportTemplate — direct factory tests
// ---------------------------------------------------------------------------

describe("dailyExportTemplate — definition validity", () => {
  it("produces a valid definition with required params (JSON format)", () => {
    const def = dailyExportTemplate({
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("produces a valid definition with format: csv", () => {
    const def = dailyExportTemplate({
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
      format: "csv",
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("produces a valid definition with a filterExpression", () => {
    const def = dailyExportTemplate({
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
      filterExpression: "status = 'active'",
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("sets entryStepId to query-ontology", () => {
    const def = dailyExportTemplate({
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
    });
    expect(def.entryStepId).toBe("query-ontology");
  });

  it("uses a webhook step for post-to-destination", () => {
    const def = dailyExportTemplate({
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
    });
    const webhookStep = def.steps.find((s) => s.id === "post-to-destination");
    expect(webhookStep?.type).toBe("webhook");
    expect((webhookStep as { url?: string }).url).toBe(HTTPS_URL);
  });

  it("disallows concurrent runs for idempotent delivery", () => {
    const def = dailyExportTemplate({
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
    });
    expect(def.options?.allowConcurrentRuns).toBe(false);
  });

  it("CSV serialise step sets text/csv Content-Type header", () => {
    const def = dailyExportTemplate({
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
      format: "csv",
    });
    const webhookStep = def.steps.find((s) => s.id === "post-to-destination");
    const headers = (webhookStep as { headers?: Record<string, string> }).headers ?? {};
    expect(headers["Content-Type"]).toBe("text/csv");
  });

  it("JSON format sets application/json Content-Type header", () => {
    const def = dailyExportTemplate({
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
      format: "json",
    });
    const webhookStep = def.steps.find((s) => s.id === "post-to-destination");
    const headers = (webhookStep as { headers?: Record<string, string> }).headers ?? {};
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// webhookToPipelineTemplate — direct factory tests
// ---------------------------------------------------------------------------

describe("webhookToPipelineTemplate — definition validity", () => {
  it("produces a valid definition with required params", () => {
    const def = webhookToPipelineTemplate({
      entityType: "event",
      transformerId: "event-transformer",
      notificationWebhookUrl: HTTPS_URL,
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("produces a valid definition with a custom requiredPayloadField", () => {
    const def = webhookToPipelineTemplate({
      entityType: "event",
      transformerId: "event-transformer",
      notificationWebhookUrl: HTTPS_URL,
      requiredPayloadField: "eventPayload",
    });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("sets entryStepId to validate-payload", () => {
    const def = webhookToPipelineTemplate({
      entityType: "event",
      transformerId: "event-transformer",
      notificationWebhookUrl: HTTPS_URL,
    });
    expect(def.entryStepId).toBe("validate-payload");
  });

  it("includes a parallel fan-out step", () => {
    const def = webhookToPipelineTemplate({
      entityType: "event",
      transformerId: "event-transformer",
      notificationWebhookUrl: HTTPS_URL,
    });
    const fanOut = def.steps.find((s) => s.id === "fan-out");
    expect(fanOut?.type).toBe("parallel");
  });

  it("fan-out step has exactly 2 branches", () => {
    const def = webhookToPipelineTemplate({
      entityType: "event",
      transformerId: "event-transformer",
      notificationWebhookUrl: HTTPS_URL,
    });
    const fanOut = def.steps.find((s) => s.id === "fan-out");
    const branches = (fanOut as { branches?: unknown[] }).branches ?? [];
    expect(branches).toHaveLength(2);
  });

  it("allows concurrent runs (events are independent)", () => {
    const def = webhookToPipelineTemplate({
      entityType: "event",
      transformerId: "event-transformer",
      notificationWebhookUrl: HTTPS_URL,
    });
    expect(def.options?.allowConcurrentRuns).toBe(true);
  });

  it("reject-payload step exists for the false branch", () => {
    const def = webhookToPipelineTemplate({
      entityType: "event",
      transformerId: "event-transformer",
      notificationWebhookUrl: HTTPS_URL,
    });
    expect(def.steps.some((s) => s.id === "reject-payload")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listTemplates()
// ---------------------------------------------------------------------------

describe("listTemplates", () => {
  it("returns exactly 4 templates", () => {
    expect(listTemplates()).toHaveLength(4);
  });

  it("includes sync-to-postgres", () => {
    expect(listTemplates().some((t) => t.id === "sync-to-postgres")).toBe(true);
  });

  it("includes csv-import", () => {
    expect(listTemplates().some((t) => t.id === "csv-import")).toBe(true);
  });

  it("includes daily-export", () => {
    expect(listTemplates().some((t) => t.id === "daily-export")).toBe(true);
  });

  it("includes webhook-to-pipeline", () => {
    expect(listTemplates().some((t) => t.id === "webhook-to-pipeline")).toBe(true);
  });

  it("every descriptor has a non-empty name", () => {
    for (const t of listTemplates()) {
      expect(t.name.length).toBeGreaterThan(0);
    }
  });

  it("every descriptor has a category", () => {
    const validCategories = new Set(["integration", "import", "export", "events"]);
    for (const t of listTemplates()) {
      expect(validCategories.has(t.category)).toBe(true);
    }
  });

  it("every descriptor has a non-empty icon", () => {
    for (const t of listTemplates()) {
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });

  it("every descriptor has a paramsSchema object", () => {
    for (const t of listTemplates()) {
      expect(typeof t.paramsSchema).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// buildFromTemplate() — happy paths
// ---------------------------------------------------------------------------

describe("buildFromTemplate — success cases", () => {
  it("returns ok:true for valid sync-to-postgres params", () => {
    const result = buildFromTemplate("sync-to-postgres", {
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const valid = PipelineDefinitionSchema.safeParse(result.value.definition);
      expect(valid.success).toBe(true);
    }
  });

  it("returns ok:true for valid csv-import params", () => {
    const result = buildFromTemplate("csv-import", {
      connectorInstanceId: CONNECTOR_ID,
      entityType: "contact",
      columnMapping: { "Name": "name" },
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok:true for valid daily-export params", () => {
    const result = buildFromTemplate("daily-export", {
      entityType: "product",
      destinationWebhookUrl: HTTPS_URL,
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok:true for valid webhook-to-pipeline params", () => {
    const result = buildFromTemplate("webhook-to-pipeline", {
      entityType: "event",
      transformerId: "t1",
      notificationWebhookUrl: HTTPS_URL,
    });
    expect(result.ok).toBe(true);
  });

  it("passes through optional syncMode to sync-to-postgres", () => {
    const result = buildFromTemplate("sync-to-postgres", {
      connectorInstanceId: CONNECTOR_ID,
      entityType: "product",
      syncMode: "full",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const connStep = result.value.definition.steps.find((s: { id: string }) => s.id === "sync-connector");
      expect((connStep as { syncMode?: string } | undefined)?.syncMode).toBe("full");
    }
  });
});

// ---------------------------------------------------------------------------
// buildFromTemplate() — error cases
// ---------------------------------------------------------------------------

describe("buildFromTemplate — error cases", () => {
  it("returns ok:false with TEMPLATE_NOT_FOUND for an unknown template ID", () => {
    const result = buildFromTemplate("does-not-exist", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TEMPLATE_NOT_FOUND");
      expect(result.error.message).toContain("does-not-exist");
    }
  });

  it("returns ok:false with INVALID_PARAMS when connectorInstanceId is not a UUID", () => {
    const result = buildFromTemplate("sync-to-postgres", {
      connectorInstanceId: "not-a-uuid",
      entityType: "product",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("returns ok:false with INVALID_PARAMS when entityType is missing", () => {
    const result = buildFromTemplate("sync-to-postgres", {
      connectorInstanceId: CONNECTOR_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("returns ok:false with INVALID_PARAMS when columnMapping is empty", () => {
    const result = buildFromTemplate("csv-import", {
      connectorInstanceId: CONNECTOR_ID,
      entityType: "contact",
      columnMapping: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("returns ok:false with INVALID_PARAMS when destinationWebhookUrl uses HTTP", () => {
    const result = buildFromTemplate("daily-export", {
      entityType: "product",
      destinationWebhookUrl: "http://example.com/hook",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("returns ok:false with INVALID_PARAMS when notificationWebhookUrl is not a URL", () => {
    const result = buildFromTemplate("webhook-to-pipeline", {
      entityType: "event",
      transformerId: "t1",
      notificationWebhookUrl: "not-a-url",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("returns ok:false with INVALID_PARAMS when notificationWebhookUrl uses HTTP", () => {
    const result = buildFromTemplate("webhook-to-pipeline", {
      entityType: "event",
      transformerId: "t1",
      notificationWebhookUrl: "http://example.com/hook",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
    }
  });

  it("attaches details on INVALID_PARAMS for programmatic inspection", () => {
    const result = buildFromTemplate("sync-to-postgres", {
      connectorInstanceId: "not-a-uuid",
      entityType: "product",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toBeDefined();
    }
  });
});
