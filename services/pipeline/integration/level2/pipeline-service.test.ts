/**
 * Level 2 integration tests for the Pipeline service.
 *
 * The service process is already running on port 13004 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP.
 *
 * Pipeline has RLS. Each test uses a unique tenant UUID. Cleanup deletes
 * all rows created by the test tenant via the superuser pool.
 *
 * Routes exercised:
 *   GET  /healthz                         — liveness probe
 *   POST /api/v1/pipelines                — create pipeline
 *   GET  /api/v1/pipelines                — list pipelines
 *   POST /api/v1/pipelines/:id/trigger    — trigger a run
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { newTenantId, cleanupPipelineTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

const BASE = "http://localhost:13004";

const db = new pg.Pool({
  connectionString: process.env["OP_DATABASE_URL"]!,
  max: 2,
});

afterAll(async () => {
  await db.end();
});

// Minimal valid pipeline body accepted by PipelineCreateSchema.
function minimalDefinition(): Record<string, unknown> {
  return {
    version: 1,
    entryStepId: "step-1",
    steps: [
      {
        id: "step-1",
        name: "Hello",
        type: "code",
        language: "javascript",
        code: "return { ok: true };",
        onError: "fail",
      },
    ],
  };
}

function pipelineBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "L2 Test Pipeline",
    definition: minimalDefinition(),
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("Pipeline service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // 2 -----------------------------------------------------------------------
  it("POST /api/v1/pipelines creates a pipeline", async () => {
    const tenantId = newTenantId();

    try {
      const res = await fetch(`${BASE}/api/v1/pipelines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(pipelineBody({ name: "Created Pipeline" })),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as {
        data: { id: string; name: string; isActive: boolean };
      };
      expect(body.data.id).toBeTruthy();
      expect(body.data.name).toBe("Created Pipeline");
      expect(body.data.isActive).toBe(true);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  // 3 -----------------------------------------------------------------------
  it("GET /api/v1/pipelines lists the tenant's pipelines", async () => {
    const tenantId = newTenantId();

    try {
      // Create one pipeline
      const createRes = await fetch(`${BASE}/api/v1/pipelines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(pipelineBody({ name: "Listed Pipeline" })),
      });
      expect(createRes.status).toBe(201);

      const listRes = await fetch(`${BASE}/api/v1/pipelines`, {
        headers: { Authorization: await authHeader(tenantId) },
      });
      expect(listRes.status).toBe(200);

      const body = await listRes.json() as {
        data: Array<{ id: string; name: string }>;
      };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((p) => p.name === "Listed Pipeline")).toBe(true);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  // 4 -----------------------------------------------------------------------
  it("POST /api/v1/pipelines/:id/trigger creates a run in pending status", async () => {
    const tenantId = newTenantId();

    try {
      // Create a pipeline first
      const createRes = await fetch(`${BASE}/api/v1/pipelines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await authHeader(tenantId),
        },
        body: JSON.stringify(pipelineBody({ name: "Trigger Test Pipeline" })),
      });
      expect(createRes.status).toBe(201);
      const pipeline = await createRes.json() as { data: { id: string } };

      // Trigger a run
      const triggerRes = await fetch(
        `${BASE}/api/v1/pipelines/${pipeline.data.id}/trigger`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({ inputs: {} }),
        },
      );

      expect(triggerRes.status).toBe(201);
      const triggerBody = await triggerRes.json() as {
        data: { id: string; status: string; pipelineId: string };
      };
      expect(triggerBody.data.id).toBeTruthy();
      expect(triggerBody.data.pipelineId).toBe(pipeline.data.id);
      // Run starts in pending status (worker picks it up asynchronously)
      expect(triggerBody.data.status).toBe("pending");
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  // 5 -----------------------------------------------------------------------
  it("POST /api/v1/pipelines without auth returns 401", async () => {
    const res = await fetch(`${BASE}/api/v1/pipelines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pipelineBody()),
    });
    expect(res.status).toBe(401);
  });

  // 6 -----------------------------------------------------------------------
  it("POST /api/v1/pipelines with invalid definition returns 400", async () => {
    const tenantId = newTenantId();

    const res = await fetch(`${BASE}/api/v1/pipelines`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await authHeader(tenantId),
      },
      // Omit required fields — definition is missing entryStepId
      body: JSON.stringify({ name: "Bad Pipeline", definition: { version: 1, steps: [] } }),
    });

    expect(res.status).toBe(400);
  });
});
