import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ForbiddenError } from "@oneplatform/core";
import type { ConnectorService, SyncService, CredentialService } from "../services/index.js";
import type { ConnectorRepository } from "../services/connector-service.js";
import {
  registerConnectorPluginRequest,
  internalSyncRequest,
} from "../schemas/index.js";

export interface InternalRouteDeps {
  connectorService: ConnectorService;
  connectorRepo: ConnectorRepository;
  credentialService: CredentialService;
  syncService: SyncService;
  masterKey: Buffer;
}

export function createInternalRoutes(deps: InternalRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { connectorService, connectorRepo, credentialService, syncService, masterKey } = deps;

  routes.post("/ingestion/connectors", async (c) => {
    const user = c.var.user;
    if (!user?.isService) {
      throw new ForbiddenError("Service token required.");
    }

    const body = await c.req.json();
    const parsed = registerConnectorPluginRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
    }

    const d = parsed.data;
    await connectorService.createConnector(d.tenantId, d.tenantId, {
      pluginId: d.pluginId,
      name: d.displayName,
      config: d.metadata,
      credentials: {},
      syncMode: "incremental",
      isEnabled: true,
    }, masterKey);

    return c.json({ registered: true });
  });

  routes.delete("/ingestion/connectors/instance/:instanceId", async (c) => {
    const user = c.var.user;
    if (!user?.isService) {
      throw new ForbiddenError("Service token required.");
    }

    const instanceId = c.req.param("instanceId");
    // Disable (not delete) so existing connector rows remain visible in the UI
    // with is_enabled=false rather than disappearing. Hard delete is reserved
    // for tenant-initiated connector removal.
    const disabledCount = await connectorRepo.disableByInstanceId(instanceId);
    return c.json({ disabledCount });
  });

  routes.delete("/ingestion/connectors/plugin/:pluginId", async (c) => {
    const user = c.var.user;
    if (!user?.isService) {
      throw new ForbiddenError("Service token required.");
    }

    const pluginId = c.req.param("pluginId");
    const list = await connectorService.listConnectors("*", {
      limit: 1000,
      filterPluginId: pluginId,
      sort: "-createdAt",
    });

    let disabledCount = 0;
    for (const item of list.data) {
      await connectorService.updateConnector(item.connector.tenant_id, item.connector.id, { isEnabled: false }, masterKey);
      disabledCount++;
    }

    return c.json({ disabledCount });
  });

  routes.get("/ingestion/credentials/:credentialBundleId/field/:key", async (c) => {
    const user = c.var.user;
    if (!user?.isService) {
      throw new ForbiddenError("Service token required.");
    }
    // Credentials are decrypted on behalf of the Execution Service only.
    // user.userId carries the service name for service-to-service tokens
    // (claims.sub = the caller's service identity, set in serviceAuthMiddleware).
    // Any other internal caller is denied to enforce least-privilege access.
    if (user.userId !== "execution-service") {
      throw new ForbiddenError("Credential access is restricted to execution-service.");
    }

    const connectorId = c.req.param("credentialBundleId");
    const fieldName = c.req.param("key");

    const value = await credentialService.getDecryptedCredential(connectorId, fieldName, masterKey);
    return c.json({ value });
  });

  routes.post("/ingestion/sync", async (c) => {
    const user = c.var.user;
    if (!user?.isService) {
      throw new ForbiddenError("Service token required.");
    }

    const body = await c.req.json();
    const parsed = internalSyncRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
    }

    const d = parsed.data;
    const result = await syncService.triggerSync(d.connectorInstanceId, d.tenantId, {
      ...(d.syncMode ? { mode: d.syncMode } : {}),
    });

    if (d.waitForCompletion) {
      const pollInterval = 2000;
      const maxWait = 600_000;
      const startTime = Date.now();

      let progress = await syncService.getSyncProgress(result.syncJobId);
      while (
        progress &&
        !["success", "failed", "cancelled"].includes(progress.status) &&
        Date.now() - startTime < maxWait
      ) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        progress = await syncService.getSyncProgress(result.syncJobId);
      }

      return c.json({
        syncJobId: result.syncJobId,
        status: progress?.status ?? "queued",
        ...(progress?.processedRecords !== undefined ? { rowsIngested: progress.processedRecords } : {}),
        ...(progress?.completedAt && progress.startedAt
          ? { durationMs: new Date(progress.completedAt).getTime() - new Date(progress.startedAt).getTime() }
          : {}),
        ...(progress && progress.errors.length > 0 ? { error: progress.errors[0]?.message ?? null } : { error: null }),
      });
    }

    return c.json({
      syncJobId: result.syncJobId,
      status: "queued" as const,
      error: null,
    });
  });

  return routes;
}
