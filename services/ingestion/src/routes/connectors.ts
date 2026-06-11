import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type {
  ConnectorService,
  SyncService,
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
}

export function createConnectorRoutes(deps: ConnectorRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { connectorService, syncService, masterKey } = deps;

  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const raw = c.req.query();
    const parsed = listConnectorsQuery.safeParse(raw);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() },
      }, 400);
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
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const body = await c.req.json();
    const parsed = createConnectorRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
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
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const connector = await connectorService.getConnector(user.tenantId, c.req.param("id"));
    return c.json({ data: connector });
  });

  routes.patch("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const body = await c.req.json();
    const parsed = patchConnectorRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
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
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    await connectorService.deleteConnector(user.tenantId, c.req.param("id"), masterKey);
    return c.body(null, 204);
  });

  routes.post("/:id/test", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
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
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
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
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    // Verify tenant ownership
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    const raw = c.req.query();
    const parsed = listSyncsQuery.safeParse(raw);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() },
      }, 400);
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
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    // Verify tenant ownership
    await connectorService.getConnector(user.tenantId, c.req.param("id"));

    const progress = await syncService.getSyncProgress(c.req.param("syncId"));
    return c.json({ data: progress });
  });

  return routes;
}
