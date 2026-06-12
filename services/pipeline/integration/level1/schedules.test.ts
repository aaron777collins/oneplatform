import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDbClient } from "@oneplatform/core";
import type pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupPipelineTenant } from "../helpers/tenant.js";
import { authHeader } from "../helpers/auth.js";

// Helper: creates an active pipeline and returns its ID.
// Schedules require a valid pipelineId — they cannot exist without a pipeline.
async function createPipeline(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  tenantId: string,
  name: string,
): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/v1/pipelines", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await authHeader(tenantId),
      },
      body: JSON.stringify({
        name,
        definition: {
          version: 1,
          entryStepId: "s1",
          steps: [
            {
              id: "s1",
              name: "Step",
              type: "code",
              language: "javascript",
              code: "return {};",
              onError: "fail",
            },
          ],
        },
        isActive: true,
      }),
    }),
  );

  if (res.status !== 201) {
    const err = await res.text();
    throw new Error(`Failed to create pipeline: ${res.status} ${err}`);
  }
  const body = await res.json() as { data: { id: string } };
  return body.data.id;
}

describe("Pipeline — schedules (Level 1)", () => {
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

  it("POST /api/v1/schedules creates a cron schedule for a pipeline", async () => {
    const tenantId = newTenantId();

    try {
      const pipelineId = await createPipeline(app, tenantId, "Schedule Target Pipeline");

      const res = await app.fetch(
        new Request("http://localhost/api/v1/schedules", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            pipelineId,
            cronExpr: "0 * * * *",
            timezone: "UTC",
            enabled: true,
            inputTemplate: {},
          }),
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json() as {
        data: {
          id: string;
          pipelineId: string;
          cronExpr: string;
          timezone: string;
          enabled: boolean;
        };
      };
      expect(body.data.id).toBeTruthy();
      expect(body.data.pipelineId).toBe(pipelineId);
      expect(body.data.cronExpr).toBe("0 * * * *");
      expect(body.data.timezone).toBe("UTC");
      expect(body.data.enabled).toBe(true);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("GET /api/v1/schedules lists schedules for the tenant", async () => {
    const tenantId = newTenantId();

    try {
      const pipelineId = await createPipeline(app, tenantId, "List Schedules Pipeline");

      // Create two schedules on the same pipeline
      for (const cron of ["0 0 * * *", "0 12 * * *"]) {
        const res = await app.fetch(
          new Request("http://localhost/api/v1/schedules", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: await authHeader(tenantId),
            },
            body: JSON.stringify({
              pipelineId,
              cronExpr: cron,
              timezone: "UTC",
              enabled: true,
              inputTemplate: {},
            }),
          }),
        );
        expect(res.status).toBe(201);
      }

      const listRes = await app.fetch(
        new Request("http://localhost/api/v1/schedules", {
          headers: { Authorization: await authHeader(tenantId) },
        }),
      );

      expect(listRes.status).toBe(200);
      const body = await listRes.json() as { data: Array<{ cronExpr: string }> };
      expect(Array.isArray(body.data)).toBe(true);
      const crons = body.data.map((s) => s.cronExpr);
      expect(crons).toContain("0 0 * * *");
      expect(crons).toContain("0 12 * * *");
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });

  it("PATCH /api/v1/schedules/:id updates the cron expression and timezone", async () => {
    const tenantId = newTenantId();

    try {
      const pipelineId = await createPipeline(app, tenantId, "Update Schedule Pipeline");

      // Create the schedule
      const createRes = await app.fetch(
        new Request("http://localhost/api/v1/schedules", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            pipelineId,
            cronExpr: "30 6 * * 1",
            timezone: "UTC",
            enabled: true,
            inputTemplate: {},
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const { data: created } = await createRes.json() as { data: { id: string } };

      // Patch the schedule
      const patchRes = await app.fetch(
        new Request(`http://localhost/api/v1/schedules/${created.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: await authHeader(tenantId),
          },
          body: JSON.stringify({
            cronExpr: "0 9 * * 1-5",
            timezone: "America/New_York",
            enabled: false,
          }),
        }),
      );

      expect(patchRes.status).toBe(200);
      const body = await patchRes.json() as {
        data: { cronExpr: string; timezone: string; enabled: boolean };
      };
      expect(body.data.cronExpr).toBe("0 9 * * 1-5");
      expect(body.data.timezone).toBe("America/New_York");
      expect(body.data.enabled).toBe(false);
    } finally {
      await cleanupPipelineTenant(db, tenantId);
    }
  });
});
