/**
 * CDC API routes — mounted under /api/v1/connectors/:id/cdc
 *
 * POST  /api/v1/connectors/:id/cdc/start   — start CDC stream for a connector
 * POST  /api/v1/connectors/:id/cdc/stop    — stop CDC stream for a connector
 * GET   /api/v1/connectors/:id/cdc/status  — get current CDC status
 *
 * All endpoints require a valid tenant-scoped JWT. The connector must belong
 * to the authenticated tenant or the request is rejected with 404.
 */

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import { z } from "zod";
import type { ConnectorService } from "../services/connector-service.js";
import type { CdcIngestionService } from "../services/cdc-ingestion-service.js";

export interface CdcRouteDeps {
  connectorService: ConnectorService;
  cdcIngestionService: CdcIngestionService;
}

// ---------------------------------------------------------------------------
// Zod schemas for request bodies
// ---------------------------------------------------------------------------

const startCdcRequest = z.object({
  /** Tables to capture. Fully-qualified names, e.g. ["public.orders"]. Empty = all. */
  tables: z.array(z.string().min(1)).default([]),
  /** Resume from this LSN. Omit to resume from the last persisted position. */
  startPosition: z.string().optional(),
  /** Events per batch before flushing. 1–10000. */
  batchSize: z.number().int().min(1).max(10_000).optional(),
  /** Max milliseconds before a partial batch is flushed. 100–60000. */
  batchTimeoutMs: z.number().int().min(100).max(60_000).optional(),
}).optional();

export function createCdcRoutes(deps: CdcRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { connectorService, cdcIngestionService } = deps;

  // ---------------------------------------------------------------------------
  // POST /:id/cdc/start
  // ---------------------------------------------------------------------------
  routes.post("/:id/cdc/start", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Ownership check — getConnector throws ConnectorNotFoundError (404) for
    // unknown or cross-tenant IDs, matching the pattern used in connectors.ts.
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    let body: z.infer<typeof startCdcRequest> = undefined;
    try {
      const raw = await c.req.json();
      const parsed = startCdcRequest.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError("Invalid request body.", parsed.error.issues);
      }
      body = parsed.data;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      // Empty body is valid — all fields are optional.
    }

    // Build options without setting optional keys to `undefined` because the
    // service is compiled with exactOptionalPropertyTypes. Spread conditional
    // fragments so absent keys are truly absent rather than set to `undefined`.
    await cdcIngestionService.startCdcIngestion(c.req.param("id"), user.tenantId, {
      ...(body?.tables !== undefined ? { tables: body.tables } : {}),
      ...(body?.startPosition !== undefined ? { startPosition: body.startPosition } : {}),
      ...(body?.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
      ...(body?.batchTimeoutMs !== undefined ? { batchTimeoutMs: body.batchTimeoutMs } : {}),
    });

    return c.json(
      {
        data: {
          connectorId: c.req.param("id"),
          status: "running",
          message: "CDC stream started.",
        },
      },
      202,
    );
  });

  // ---------------------------------------------------------------------------
  // POST /:id/cdc/stop
  // ---------------------------------------------------------------------------
  routes.post("/:id/cdc/stop", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    await connectorService.getConnector(user.tenantId, c.req.param("id"));
    await cdcIngestionService.stopCdcIngestion(c.req.param("id"));

    return c.json(
      {
        data: {
          connectorId: c.req.param("id"),
          status: "stopped",
          message: "CDC stream stop requested.",
        },
      },
      200,
    );
  });

  // ---------------------------------------------------------------------------
  // GET /:id/cdc/status
  // ---------------------------------------------------------------------------
  routes.get("/:id/cdc/status", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    await connectorService.getConnector(user.tenantId, c.req.param("id"));
    const status = await cdcIngestionService.getCdcStatus(c.req.param("id"));

    if (status === null) {
      return c.json(
        {
          data: {
            connectorId: c.req.param("id"),
            status: "stopped",
            currentPosition: null,
            eventsProcessed: 0,
            startedAt: null,
            lastCommittedAt: null,
            lastError: null,
          },
        },
        200,
      );
    }

    return c.json({ data: status }, 200);
  });

  return routes;
}
