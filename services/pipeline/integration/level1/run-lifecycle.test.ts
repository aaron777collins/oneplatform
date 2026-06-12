import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDbClient } from "@oneplatform/core";
import type pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupPipelineTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

// Minimal valid pipeline definition — see PipelineDefinitionSchema in schemas/index.ts.
function minimalDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    entryStepId: "step-1",
    steps: [
      {
        id: "step-1",
        name: "Noop Step",
        type: "code",
        language: "javascript",
        code: "return {};",
        onError: "fail",
      },
    ],
    ...overrides,
  };
}

async function createActivePipeline(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  tenantId: string,
  name: string,
  definitionOverrides: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await app.fetch(
    new Request("http://localhost/api/v1/pipelines", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await authHeader(tenantId),
      },
      body: JSON.stringify({
        name,
        definition: minimalDefinition(definitionOverrides),
        isActive: true,
      }),
    }),
  );

  if (res.status !== 201) {
    const err = await res.text();
    throw new Error(`Failed to create pipeline: ${res.status} ${err}`);
  }
  const body = await res.json() as { data: { id: string } };
  return body.data;
}

describe("Pipeline — run lifecycle (Level 1)", () => {
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

  it("POST /api/v1/pipelines/:id/trigger creates a run in 'pending' status", async () => {
    const tenantId = newTenantId();

    try {
      const pipeline = await createActivePipeline(app, tenantId, "Trigger Run Test");

      const triggerRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${pipeline.id}/trigger`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({ input: {} }),
        }),
      );

      expect(triggerRes.status).toBe(202);
      const body = await triggerRes.json() as { data: { runId: string; status: string } };
      expect(body.data.runId).toBeTruthy();
      // triggerRun always returns status "pending" synchronously (the BullMQ
      // worker transitions it to "running" — workers are disabled in Level 1).
      expect(body.data.status).toBe("pending");
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("GET /api/v1/pipeline-runs/:runId returns the run with status", async () => {
    const tenantId = newTenantId();

    try {
      const pipeline = await createActivePipeline(app, tenantId, "Get Run Test");

      const triggerRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${pipeline.id}/trigger`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({ input: {} }),
        }),
      );
      expect(triggerRes.status).toBe(202);
      const { data: triggered } = await triggerRes.json() as { data: { runId: string } };

      const getRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipeline-runs/${triggered.runId}`, {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(getRes.status).toBe(200);
      const body = await getRes.json() as {
        data: { run: { id: string; status: string }; steps: unknown[] };
      };
      expect(body.data.run.id).toBe(triggered.runId);
      // Status starts as "pending" because workers are disabled in Level 1
      expect(["pending", "running", "completed", "failed"]).toContain(body.data.run.status);
      expect(Array.isArray(body.data.steps)).toBe(true);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("GET /api/v1/pipelines/:id/runs lists runs for a pipeline", async () => {
    const tenantId = newTenantId();

    try {
      const pipeline = await createActivePipeline(app, tenantId, "List Runs Test");

      // Trigger two runs
      for (let i = 0; i < 2; i++) {
        const res = await app.fetch(
          new Request(`http://localhost/api/v1/pipelines/${pipeline.id}/trigger`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: await authHeader(tenantId),
            },
            body: JSON.stringify({ input: { iteration: i } }),
          }),
        );
        expect(res.status).toBe(202);
      }

      const listRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${pipeline.id}/runs`, {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(listRes.status).toBe(200);
      const body = await listRes.json() as { data: Array<{ id: string }> };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("concurrent run prevention: second trigger is rejected when allowConcurrentRuns is false", async () => {
    const tenantId = newTenantId();

    try {
      // Pipeline definition with allowConcurrentRuns: false
      const pipeline = await createActivePipeline(app, tenantId, "No Concurrent Runs", {
        options: { allowConcurrentRuns: false },
      });

      // First trigger — creates a "pending" run (worker is disabled so it stays pending)
      const firstRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${pipeline.id}/trigger`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({ input: {} }),
        }),
      );
      expect(firstRes.status).toBe(202);

      // Second trigger — the pending run counts as "active" so this must be rejected
      const secondRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${pipeline.id}/trigger`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({ input: {} }),
        }),
      );

      // PipelineConcurrentRunError maps to 409 Conflict
      expect(secondRes.status).toBe(409);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });
});
