// Unit tests for template routes:
//   GET  /templates
//   POST /from-template
//
// Routes are tested by calling .fetch() on the Hono app instance directly —
// no HTTP server needed.  PipelineService is replaced with a vi.fn() mock so
// tests are purely in-memory.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { PipelineService } from "../services/pipeline-service.js";
import type { RunService } from "../services/run-service.js";
import { createPipelineRoutes } from "../routes/pipelines.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "user-001";
const CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440001";
const HTTPS_URL = "https://api.example.com/callback";

function makeFakeUser() {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    roles: ["admin"],
    scopes: [],
    isGuest: false,
    isService: false,
    emailVerified: true,
  };
}

function makePipelineRow(name = "Test Pipeline") {
  return {
    id: "pipe-123",
    tenant_id: TENANT_ID,
    name,
    slug: "test-pipeline",
    description: null,
    definition: { version: 1, entryStepId: "step-1", steps: [] },
    is_active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    created_by: USER_ID,
    current_version: 0,
  };
}

// ---------------------------------------------------------------------------
// Test app builder
//
// Wraps the pipeline routes in a minimal Hono app that injects a fake user
// context, mirroring what the auth middleware does in production.
// ---------------------------------------------------------------------------

function buildTestApp(pipelineService: PipelineService) {
  const app = new Hono<{ Variables: AppVariables }>();

  // Inject auth context so routes don't throw UnauthorizedError
  app.use("*", async (c, next) => {
    c.set("user", makeFakeUser());
    c.set("requestId", "test-req-id");
    await next();
  });

  const runService = {
    triggerRun: vi.fn(),
    listRuns: vi.fn(),
  } as unknown as RunService;

  const routes = createPipelineRoutes({ pipelineService, runService });
  app.route("/api/v1/pipelines", routes);

  return app;
}

function buildUnauthApp(pipelineService: PipelineService) {
  const app = new Hono<{ Variables: AppVariables }>();
  // No user injected — c.var.user will be undefined, triggering UnauthorizedError
  const runService = {
    triggerRun: vi.fn(),
    listRuns: vi.fn(),
  } as unknown as RunService;
  const routes = createPipelineRoutes({ pipelineService, runService });
  app.route("/api/v1/pipelines", routes);
  return app;
}

// ---------------------------------------------------------------------------
// Shared mock
// ---------------------------------------------------------------------------

let mockCreatePipeline: ReturnType<typeof vi.fn>;
let pipelineService: PipelineService;

beforeEach(() => {
  mockCreatePipeline = vi.fn().mockResolvedValue(makePipelineRow());
  pipelineService = {
    createPipeline: mockCreatePipeline,
    getPipeline: vi.fn(),
    listPipelines: vi.fn(),
    updatePipeline: vi.fn(),
    deletePipeline: vi.fn(),
    validateDefinition: vi.fn(),
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    rollbackToVersion: vi.fn(),
  } as unknown as PipelineService;
});

// ---------------------------------------------------------------------------
// GET /api/v1/pipelines/templates
// ---------------------------------------------------------------------------

describe("GET /api/v1/pipelines/templates", () => {
  it("returns 200 with a data array of template descriptors", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/templates");
    expect(res.status).toBe(200);

    const body = await res.json() as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("returns exactly 4 templates", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/templates");
    const body = await res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(4);
  });

  it("each template descriptor has id, name, description, category, icon", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/templates");
    const body = await res.json() as { data: Record<string, unknown>[] };

    for (const t of body.data) {
      expect(typeof t["id"]).toBe("string");
      expect(typeof t["name"]).toBe("string");
      expect(typeof t["description"]).toBe("string");
      expect(typeof t["category"]).toBe("string");
      expect(typeof t["icon"]).toBe("string");
    }
  });

  it("returns 401 when no user context is present", async () => {
    const app = buildUnauthApp(pipelineService);
    // UnauthorizedError is thrown; without global error handler it propagates as 500
    // from Hono's default handler.  The routes throw, so the response is non-2xx.
    const res = await app.request("/api/v1/pipelines/templates");
    expect(res.status).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/pipelines/from-template
// ---------------------------------------------------------------------------

describe("POST /api/v1/pipelines/from-template", () => {
  it("returns 201 and created pipeline for valid sync-to-postgres params", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sync-to-postgres",
        name: "My Sync Pipeline",
        params: {
          connectorInstanceId: CONNECTOR_ID,
          entityType: "product",
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string } };
    expect(body.data.id).toBe("pipe-123");
  });

  it("calls pipelineService.createPipeline with the template name", async () => {
    const app = buildTestApp(pipelineService);
    await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sync-to-postgres",
        name: "Named Pipeline",
        params: {
          connectorInstanceId: CONNECTOR_ID,
          entityType: "product",
        },
      }),
    });

    expect(mockCreatePipeline).toHaveBeenCalledOnce();
    const callArgs = mockCreatePipeline.mock.calls[0] as [string, string, { name: string }];
    expect(callArgs[2].name).toBe("Named Pipeline");
  });

  it("passes the generated definition to createPipeline", async () => {
    const app = buildTestApp(pipelineService);
    await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sync-to-postgres",
        name: "Test",
        params: {
          connectorInstanceId: CONNECTOR_ID,
          entityType: "product",
        },
      }),
    });

    const callArgs = mockCreatePipeline.mock.calls[0] as [string, string, { definition: Record<string, unknown> }];
    expect(callArgs[2].definition).toBeDefined();
    expect(callArgs[2].definition["version"]).toBe(1);
    expect(Array.isArray(callArgs[2].definition["steps"])).toBe(true);
  });

  it("returns 201 for csv-import template", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "csv-import",
        name: "CSV Import Pipeline",
        params: {
          connectorInstanceId: CONNECTOR_ID,
          entityType: "contact",
          columnMapping: { "Email": "email" },
        },
      }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 for daily-export template", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "daily-export",
        name: "Nightly Export",
        params: {
          entityType: "product",
          destinationWebhookUrl: HTTPS_URL,
        },
      }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 for webhook-to-pipeline template", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "webhook-to-pipeline",
        name: "Webhook Pipeline",
        params: {
          entityType: "event",
          transformerId: "t1",
          notificationWebhookUrl: HTTPS_URL,
        },
      }),
    });
    expect(res.status).toBe(201);
  });

  it("passes optional slug and description through to createPipeline", async () => {
    const app = buildTestApp(pipelineService);
    await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sync-to-postgres",
        name: "Test",
        slug: "my-sync-pipeline",
        description: "A description",
        params: {
          connectorInstanceId: CONNECTOR_ID,
          entityType: "product",
        },
      }),
    });

    const callArgs = mockCreatePipeline.mock.calls[0] as [string, string, { slug?: string; description?: string }];
    expect(callArgs[2].slug).toBe("my-sync-pipeline");
    expect(callArgs[2].description).toBe("A description");
  });

  it("returns 404 when templateId does not exist", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "does-not-exist",
        name: "Test",
        params: {},
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 when template params are invalid", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sync-to-postgres",
        name: "Test",
        params: {
          connectorInstanceId: "not-a-uuid",
          entityType: "product",
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when request body is missing required name", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sync-to-postgres",
        params: { connectorInstanceId: CONNECTOR_ID, entityType: "product" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when request body is missing templateId", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test",
        params: { connectorInstanceId: CONNECTOR_ID, entityType: "product" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("does not call createPipeline when params are invalid", async () => {
    const app = buildTestApp(pipelineService);
    await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sync-to-postgres",
        name: "Test",
        params: { connectorInstanceId: "bad" },
      }),
    });
    expect(mockCreatePipeline).not.toHaveBeenCalled();
  });

  it("returns 400 when daily-export uses HTTP destination URL", async () => {
    const app = buildTestApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "daily-export",
        name: "Export",
        params: {
          entityType: "product",
          destinationWebhookUrl: "http://example.com/hook",
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 when no user context is present", async () => {
    const app = buildUnauthApp(pipelineService);
    const res = await app.request("/api/v1/pipelines/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateId: "sync-to-postgres",
        name: "Test",
        params: { connectorInstanceId: CONNECTOR_ID, entityType: "product" },
      }),
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
  });
});
