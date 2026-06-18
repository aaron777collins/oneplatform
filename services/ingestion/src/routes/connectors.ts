import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import type {
  ConnectorService,
  SyncService,
  SchemaDriftService,
} from "../services/index.js";
import {
  listConnectorsQuery,
  createConnectorRequest,
  patchConnectorRequest,
  testConnectorRequest,
  triggerSyncRequest,
  listSyncsQuery,
} from "../schemas/index.js";

export interface ConnectorRouteDeps {
  connectorService: ConnectorService;
  syncService: SyncService;
  masterKey: Buffer;
  schemaDriftService?: SchemaDriftService;
}

export function createConnectorRoutes(deps: ConnectorRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { connectorService, syncService, masterKey, schemaDriftService } = deps;

  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const raw = c.req.query();
    const parsed = listConnectorsQuery.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters.", parsed.error.issues);
    }

    const q = parsed.data;
    const result = await connectorService.listConnectors(user.tenantId, {
      ...(q.cursor ? { cursor: q.cursor } : {}),
      limit: q.limit,
      ...(q["filter[status][eq]"] ? { filterStatus: q["filter[status][eq]"] } : {}),
      ...(q["filter[pluginId][eq]"] ? { filterPluginId: q["filter[pluginId][eq]"] } : {}),
      sort: q.sort,
    });

    return c.json(result);
  });

  routes.post("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json();
    const parsed = createConnectorRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const d = parsed.data;
    const connector = await connectorService.createConnector(user.tenantId, user.userId, {
      pluginId: d.pluginId,
      name: d.name,
      ...(d.description ? { description: d.description } : {}),
      config: d.config,
      credentials: d.credentials,
      syncMode: d.syncMode,
      ...(d.scheduleCron ? { scheduleCron: d.scheduleCron } : {}),
      isEnabled: d.isEnabled,
    }, masterKey);

    return c.json({ data: connector }, 201);
  });

  routes.get("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const connector = await connectorService.getConnector(user.tenantId, c.req.param("id"));
    return c.json({ data: connector });
  });

  routes.patch("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json();
    const parsed = patchConnectorRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const d = parsed.data;
    const updates: Record<string, unknown> = {};

    if (d.name !== undefined) updates["name"] = d.name;
    if (d.config !== undefined) updates["config"] = d.config;
    if (d.credentials !== undefined) updates["credentials"] = d.credentials;
    if (d.syncMode !== undefined) updates["syncMode"] = d.syncMode;
    if (d.isEnabled !== undefined) updates["isEnabled"] = d.isEnabled;
    // null is a valid value here — it explicitly clears description / scheduleCron.
    if (d.description !== undefined) updates["description"] = d.description;
    if (d.scheduleCron !== undefined) updates["scheduleCron"] = d.scheduleCron;

    const connector = await connectorService.updateConnector(
      user.tenantId,
      c.req.param("id"),
      updates as Parameters<ConnectorService["updateConnector"]>[2],
      masterKey,
    );

    return c.json({ data: connector });
  });

  routes.delete("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const connectorId = c.req.param("id");

    // Cancel any in-flight or queued sync job before deleting the connector so
    // BullMQ workers don't pick up orphaned jobs after the connector row is gone.
    // last_sync_job_id holds the most recent sync job ID — cancel it if it is
    // still in a non-terminal state according to the Redis progress key.
    const { syncState: connectorSyncState } = await connectorService.getConnector(user.tenantId, connectorId);
    const lastJobId = connectorSyncState.last_sync_job_id;
    if (lastJobId !== null) {
      const progress = await syncService.getSyncProgress(lastJobId).catch(() => null);
      if (progress !== null && (progress.status === "queued" || progress.status === "running")) {
        await syncService.cancelSync(lastJobId).catch(() => {
          // Don't block the delete if cancellation fails — the job may have
          // already completed between the read above and this call.
        });
      }
    }

    await connectorService.deleteConnector(user.tenantId, connectorId, masterKey);
    return c.body(null, 204);
  });

  routes.post("/:id/test", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    let overrides: { config?: Record<string, unknown>; credentials?: Record<string, string> } | undefined;
    try {
      const body = await c.req.json();
      const parsed = testConnectorRequest.safeParse(body);
      if (parsed.success && parsed.data) {
        overrides = {};
        if (parsed.data.config) overrides["config"] = parsed.data.config;
        if (parsed.data.credentials) overrides["credentials"] = parsed.data.credentials;
      }
    } catch {
      // empty body is valid for test endpoint
    }

    const result = await connectorService.testConnector(user.tenantId, c.req.param("id"), masterKey, overrides);
    return c.json({ data: result });
  });

  routes.post("/:id/trigger", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    let options: { mode?: "full" | "incremental"; force?: boolean } | undefined;
    try {
      const body = await c.req.json();
      const parsed = triggerSyncRequest.safeParse(body);
      if (parsed.success && parsed.data) {
        options = {
          ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
          ...(parsed.data.force ? { force: parsed.data.force } : {}),
        };
      }
    } catch {
      // empty body uses defaults
    }

    const result = await syncService.triggerSync(c.req.param("id"), user.tenantId, options);
    return c.json({ data: result }, 202);
  });

  routes.get("/:id/syncs", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Verify tenant ownership
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    const raw = c.req.query();
    const parsed = listSyncsQuery.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters.", parsed.error.issues);
    }

    const q = parsed.data;
    const result = await syncService.listSyncs(c.req.param("id"), {
      ...(q.cursor ? { cursor: q.cursor } : {}),
      limit: q.limit,
      ...(q["filter[status][eq]"] ? { filterStatus: q["filter[status][eq]"] } : {}),
    });

    return c.json(result);
  });

  routes.get("/:id/syncs/:syncId/progress", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Verify tenant ownership
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    const progress = await syncService.getSyncProgress(c.req.param("syncId"));
    return c.json({ data: progress });
  });

  // GET /api/v1/connectors/:id/schema-drift
  // Returns the last 10 schema snapshots for the connector, newest first.
  // Callers can diff consecutive entries to reconstruct the full drift history.
  routes.get("/:id/schema-drift", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Ownership check — throws ConnectorNotFoundError (404) for unknown or
    // cross-tenant connector IDs, matching the pattern used by other endpoints.
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    if (schemaDriftService === undefined) {
      // Service not wired — return an empty history rather than 500-ing.
      return c.json({ data: [] });
    }

    const history = await schemaDriftService.getHistory(c.req.param("id"));
    return c.json({ data: history });
  });

  return routes;
}
