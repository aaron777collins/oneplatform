import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDbClient } from "@oneplatform/core";
import type pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupPipelineTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

// Minimal valid pipeline definition — version 1 is the only accepted version.
// The code step satisfies the StepSchema discriminated union.
function minimalDefinition(): Record<string, unknown> {
  return {
    version: 1,
    entryStepId: "step-1",
    steps: [
      {
        id: "step-1",
        name: "Hello World",
        type: "code",
        language: "javascript",
        code: "return { result: 'ok' };",
        onError: "fail",
      },
    ],
  };
}

function pipelineBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Test Pipeline",
    definition: minimalDefinition(),
    isActive: true,
    ...overrides,
  };
}

describe("Pipeline — pipeline CRUD (Level 1)", () => {
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

  it("POST /api/v1/pipelines creates a pipeline", async () => {
    const tenantId = newTenantId();

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/pipelines", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(pipelineBody({ name: "My First Pipeline" })),
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json() as { data: { id: string; name: string; isActive: boolean } };
      expect(body.data.id).toBeTruthy();
      expect(body.data.name).toBe("My First Pipeline");
      expect(body.data.isActive).toBe(true);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("GET /api/v1/pipelines lists pipelines for the tenant", async () => {
    const tenantId = newTenantId();

    try {
      // Create a pipeline first
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/pipelines", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(pipelineBody({ name: "Listed Pipeline" })),
        }),
      );
      expect(createRes.status).toBe(201);

      const listRes = await app.fetch(
        new Request("http://localhost/api/v1/pipelines", {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(listRes.status).toBe(200);
      const body = await listRes.json() as { data: Array<{ name: string }> };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((p) => p.name === "Listed Pipeline")).toBe(true);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("GET /api/v1/pipelines/:id returns a specific pipeline", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/pipelines", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(pipelineBody({ name: "Fetch Me" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: created } = await createRes.json() as { data: { id: string } };

      const getRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${created.id}`, {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(getRes.status).toBe(200);
      const body = await getRes.json() as { data: { id: string; name: string } };
      expect(body.data.id).toBe(created.id);
      expect(body.data.name).toBe("Fetch Me");
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("PATCH /api/v1/pipelines/:id updates the pipeline name and isActive", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/pipelines", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(pipelineBody({ name: "Before Patch" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: created } = await createRes.json() as { data: { id: string } };

      const patchRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${created.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({ name: "After Patch", isActive: false }),
        }),
      );

      expect(patchRes.status).toBe(200);
      const body = await patchRes.json() as { data: { name: string; isActive: boolean } };
      expect(body.data.name).toBe("After Patch");
      expect(body.data.isActive).toBe(false);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("DELETE /api/v1/pipelines/:id deletes the pipeline", async () => {
    const tenantId = newTenantId();

    try {
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/pipelines", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify(pipelineBody({ name: "To Be Deleted" })),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: created } = await createRes.json() as { data: { id: string } };

      const deleteRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${created.id}`, {
          method: "DELETE",
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(deleteRes.status).toBe(204);

      // Deleted pipeline should return 404
      const getRes = await app.fetch(
        new Request(`http://localhost/api/v1/pipelines/${created.id}`, {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );
      expect(getRes.status).toBe(404);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });
});
