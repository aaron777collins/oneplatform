// Reconciliation routes — exposes the async reconciliation workflow over HTTP.
//
// POST  /api/v1/connectors/:id/reconcile
//   Triggers a reconciliation job and returns 202 with a jobId.
//
// GET   /api/v1/connectors/:id/reconciliation-reports
//   Lists stored reconciliation reports for the connector.
//
// GET   /api/v1/connectors/:id/reconciliation-reports/:jobId
//   Retrieves a single report by job ID (used for polling).

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import type { ConnectorService } from "../services/index.js";
import type { ReconciliationService } from "../services/reconciliation-service.js";
import {
  triggerReconcileRequest,
  listReconciliationReportsQuery,
} from "../schemas/index.js";

export interface ReconciliationRouteDeps {
  connectorService: ConnectorService;
  reconciliationService: ReconciliationService;
}

export function createReconciliationRoutes(
  deps: ReconciliationRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { connectorService, reconciliationService } = deps;

  // POST /:id/reconcile — enqueue a reconciliation job
  routes.post("/:id/reconcile", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Verify tenant ownership before doing anything else.
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      // empty body uses schema defaults
    }

    const parsed = triggerReconcileRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const d = parsed.data;
    const result = await reconciliationService.triggerReconcile(
      c.req.param("id"),
      user.tenantId,
      {
        idField: d.idField,
        ...(d.sampleSize !== undefined ? { sampleSize: d.sampleSize } : {}),
        ...(d.fields !== undefined ? { fields: d.fields } : {}),
      },
    );

    return c.json({ data: result }, 202);
  });

  // GET /:id/reconciliation-reports — list reports for a connector
  routes.get("/:id/reconciliation-reports", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Verify tenant ownership.
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    const raw = c.req.query();
    const parsed = listReconciliationReportsQuery.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters.", parsed.error.issues);
    }

    const q = parsed.data;
    const result = await reconciliationService.listReports(c.req.param("id"), {
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });

    return c.json(result);
  });

  // GET /:id/reconciliation-reports/:jobId — get a single report (polling endpoint)
  routes.get("/:id/reconciliation-reports/:jobId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Verify tenant ownership before exposing any report data.
    const connectorId = c.req.param("id");
    await connectorService.getConnector(user.tenantId, connectorId);

    const report = await reconciliationService.getReport(c.req.param("jobId"));

    // Guard against IDOR: a valid jobId for a different connector must not be
    // readable via this connector's URL even though the tenant check passed.
    if (report !== null && report.connectorId !== connectorId) {
      return c.json({ data: null }, 404);
    }

    return c.json({ data: report ?? null });
  });

  return routes;
}
