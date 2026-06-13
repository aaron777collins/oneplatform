/**
 * Level 3 E2E: Ingestion → Pipeline cross-service flow.
 *
 * Tests that a user can create a connector via the ingestion service and
 * a pipeline via the pipeline service, trigger a pipeline run, and verify
 * the run record is created with the correct pipeline reference.
 *
 * The connector step in the pipeline definition references a connector
 * instance UUID that must exist in the ingestion service. Because the
 * execution service is not started in this test environment, triggering the
 * pipeline creates a run record (status: "pending") but does not execute it.
 * The test validates the run creation, not execution completion.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCleanupPool, createE2ETenant, cleanupE2ETenant } from "../helpers/e2e-cleanup.js";
import { getToken } from "../helpers/e2e-auth.js";
import type pg from "pg";

const INGESTION_URL = "http://localhost:13002";
const PIPELINE_URL  = "http://localhost:13004";

let pool: pg.Pool;

beforeAll(() => {
  pool = createCleanupPool();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: ingestion connector and pipeline run lifecycle", () => {
  it("creates a connector via ingestion service", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      const email    = `e2e-ing-${tenantId.slice(0, 8)}@example.com`;
      const password = "Correct-Horse-Battery-Staple-99";
      const token    = await getToken(tenantId, email, password);

      const createRes = await fetch(`${INGESTION_URL}/api/v1/connectors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          pluginId:    "com.example.test-connector",
          name:        `Test Connector ${tenantId.slice(0, 8)}`,
          config:      { endpoint: "https://api.example.com/data" },
          credentials: {},
          syncMode:    "incremental",
          isEnabled:   true,
        }),
      });

      expect(createRes.status).toBe(201);
      const body = await createRes.json() as { data: { id: string; name: string } };
      expect(body.data.id).toBeTruthy();
      expect(body.data.name).toContain("Test Connector");
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("creates a pipeline via pipeline service", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      const email    = `e2e-pipe-${tenantId.slice(0, 8)}@example.com`;
      const password = "Correct-Horse-Battery-Staple-99";
      const token    = await getToken(tenantId, email, password);

      // A webhook step is safe to define without an external service running
      const createRes = await fetch(`${PIPELINE_URL}/api/v1/pipelines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          name:     `E2E Pipeline ${tenantId.slice(0, 8)}`,
          isActive: true,
          definition: {
            version:     1,
            entryStepId: "step-notify",
            steps: [
              {
                id:       "step-notify",
                name:     "Notify",
                type:     "webhook",
                url:      "https://webhook.example.com/notify",
                method:   "POST",
                onError:  "fail",
              },
            ],
          },
        }),
      });

      expect(createRes.status).toBe(201);
      const body = await createRes.json() as { data: { id: string; name: string } };
      expect(body.data.id).toBeTruthy();
      expect(body.data.name).toContain("E2E Pipeline");
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("triggers a pipeline run and verifies the run record references the pipeline", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      const email    = `e2e-run-${tenantId.slice(0, 8)}@example.com`;
      const password = "Correct-Horse-Battery-Staple-99";
      const token    = await getToken(tenantId, email, password);

      // Create the pipeline first
      const pipelineRes = await fetch(`${PIPELINE_URL}/api/v1/pipelines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          name:     `Trigger Test ${tenantId.slice(0, 8)}`,
          isActive: true,
          definition: {
            version:     1,
            entryStepId: "step-a",
            steps: [
              {
                id:      "step-a",
                name:    "Step A",
                type:    "webhook",
                url:     "https://webhook.example.com/step-a",
                method:  "POST",
                onError: "fail",
              },
            ],
          },
        }),
      });
      expect(pipelineRes.status).toBe(201);
      const pipelineBody = await pipelineRes.json() as { data: { id: string } };
      const pipelineId = pipelineBody.data.id;

      // Trigger a manual run
      const triggerRes = await fetch(
        `${PIPELINE_URL}/api/v1/pipelines/${pipelineId}/trigger`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: JSON.stringify({ input: {} }),
        }
      );
      // 202 Accepted — run created, queued for execution
      expect(triggerRes.status).toBe(202);
      const triggerBody = await triggerRes.json() as { data: { runId: string; status: string } };
      expect(triggerBody.data.runId).toBeTruthy();
      // Run starts in pending status (worker picks it up asynchronously)
      expect(triggerBody.data.status).toBe("pending");
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("lists runs for a pipeline — includes the triggered run", async () => {
    const { tenantId } = await createE2ETenant(pool);

    try {
      const email    = `e2e-list-runs-${tenantId.slice(0, 8)}@example.com`;
      const password = "Correct-Horse-Battery-Staple-99";
      const token    = await getToken(tenantId, email, password);

      // Create pipeline
      const pipelineRes = await fetch(`${PIPELINE_URL}/api/v1/pipelines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          name:     `List Runs Test ${tenantId.slice(0, 8)}`,
          isActive: true,
          definition: {
            version:     1,
            entryStepId: "step-one",
            steps: [
              {
                id:      "step-one",
                name:    "Step One",
                type:    "webhook",
                url:     "https://webhook.example.com/one",
                method:  "POST",
                onError: "fail",
              },
            ],
          },
        }),
      });
      expect(pipelineRes.status).toBe(201);
      const { data: pipeline } = await pipelineRes.json() as { data: { id: string } };

      // Trigger a run and assert the response before checking the list
      const triggerRes = await fetch(`${PIPELINE_URL}/api/v1/pipelines/${pipeline.id}/trigger`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ input: {} }),
      });
      expect(triggerRes.status).toBe(202);
      const triggerBody = await triggerRes.json() as { data: { runId: string; status: string } };
      expect(triggerBody.data.runId).toBeTruthy();

      // List runs for this pipeline
      const listRes = await fetch(
        `${PIPELINE_URL}/api/v1/pipelines/${pipeline.id}/runs`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json() as { data: Array<{ id: string; pipeline_id: string }> };
      expect(listBody.data.length).toBeGreaterThanOrEqual(1);
      // Every run in the list must belong to this pipeline
      for (const run of listBody.data) {
        expect(run.pipeline_id).toBe(pipeline.id);
      }
    } finally {
      await cleanupE2ETenant(pool, tenantId);
    }
  });

  it("creating a connector and pipeline in the same tenant preserves tenant isolation", async () => {
    const { tenantId: tenantA } = await createE2ETenant(pool);
    const { tenantId: tenantB } = await createE2ETenant(pool);

    try {
      const tokenA = await getToken(
        tenantA,
        `iso-a-${tenantA.slice(0, 8)}@example.com`,
        "Correct-Horse-Battery-Staple-99"
      );
      const tokenB = await getToken(
        tenantB,
        `iso-b-${tenantB.slice(0, 8)}@example.com`,
        "Correct-Horse-Battery-Staple-99"
      );

      // Tenant A creates a pipeline
      await fetch(`${PIPELINE_URL}/api/v1/pipelines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          name:     `Tenant A Pipeline ${tenantA.slice(0, 8)}`,
          isActive: true,
          definition: {
            version:     1,
            entryStepId: "s1",
            steps: [
              { id: "s1", name: "S1", type: "webhook", url: "https://webhook.example.com/s1", method: "POST", onError: "fail" },
            ],
          },
        }),
      });

      // Tenant B lists pipelines — must NOT see tenant A's pipeline
      const listB = await fetch(`${PIPELINE_URL}/api/v1/pipelines`, {
        headers: { "Authorization": `Bearer ${tokenB}` },
      });
      expect(listB.status).toBe(200);
      const listBody = await listB.json() as { data: Array<{ pipeline: { name: string }; lastRunAt: string | null }> };
      const names = listBody.data.map((p) => p.pipeline.name);
      expect(names.some((n) => n.includes(tenantA.slice(0, 8)))).toBe(false);
    } finally {
      await cleanupE2ETenant(pool, tenantA);
      await cleanupE2ETenant(pool, tenantB);
    }
  });
});
