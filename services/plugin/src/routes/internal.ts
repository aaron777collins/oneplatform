import { Hono, type Context } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { BundleService } from "../services/bundle-service.js";
import type { HookService } from "../services/hook-service.js";
import type { CacheRepository } from "../repositories/cache-repository.js";
import type { InstanceRepository } from "../repositories/instance-repository.js";
import type { PluginRepository } from "../repositories/plugin-repository.js";
import type { UpgradeService } from "../services/upgrade-service.js";
import {
  CachePutBodySchema,
  DrainCompleteRequestSchema,
} from "../schemas/index.js";

export interface InternalRouteDeps {
  bundleService: BundleService;
  hookService: HookService;
  cacheRepo: CacheRepository;
  instanceRepo: InstanceRepository;
  pluginRepo: PluginRepository;
  upgradeService: UpgradeService;
}

// Convenience type for Hono context with our variables
type AppContext = Context<{ Variables: AppVariables }>;

export function createInternalRoutes(
  deps: InternalRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const {
    bundleService,
    hookService,
    cacheRepo,
    instanceRepo,
    pluginRepo,
    upgradeService,
  } = deps;

  // W3 fix: return 401 (not 403) when the service token is absent or invalid.
  // 403 means "authenticated but not authorised"; 401 means "not authenticated".
  // Internal callers that lack a valid service token are unauthenticated.
  function requireServiceToken(c: AppContext): boolean {
    const user = c.var.user;
    return user?.isService === true;
  }

  function unauthorizedResponse(c: AppContext): Response {
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Valid service token required.", requestId: c.var.requestId } },
      401
    ) as Response;
  }

  // ---------------------------------------------------------------------------
  // GET /internal/plugins/:pluginId/bundle — bundle delivery (spec §8.1)
  // ---------------------------------------------------------------------------
  routes.get("/plugins/:pluginId/bundle", async (c) => {
    if (!requireServiceToken(c)) {
      return unauthorizedResponse(c);
    }

    const pluginId = c.req.param("pluginId");
    const version = new URL(c.req.url).searchParams.get("version");

    let plugin = version
      ? await pluginRepo.findByManifestIdAndVersion(pluginId, version)
      : await pluginRepo.findActiveByManifestId(pluginId);

    if (plugin === null) {
      return c.json(
        { error: { code: "PLUGIN_NOT_FOUND", message: `Plugin '${pluginId}' not found.`, requestId: c.var.requestId } },
        404
      );
    }

    if (plugin.status === "uninstalled" || plugin.bundle_key === null) {
      return c.json(
        { error: { code: "PLUGIN_NOT_FOUND", message: "Plugin bundle unavailable.", requestId: c.var.requestId } },
        404
      );
    }

    const { stream, checksum } = await bundleService.download(
      plugin.bundle_bucket,
      plugin.bundle_key
    );

    // Stream directly — no in-memory buffering (spec §12.3).
    const { Readable } = await import("node:stream");
    const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Plugin-Version": plugin.version,
        "X-Plugin-Checksum": checksum,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // GET /internal/plugins/connectors — connector list (spec §8.2)
  // ---------------------------------------------------------------------------
  routes.get("/plugins/connectors", async (c) => {
    if (!requireServiceToken(c)) {
      return unauthorizedResponse(c);
    }

    const tenantId = new URL(c.req.url).searchParams.get("tenantId");
    if (!tenantId) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "tenantId query parameter is required.", requestId: c.var.requestId } },
        400
      );
    }

    const instances = await instanceRepo.findEnabledConnectorsByTenant(tenantId, "connector");

    const connectors = await Promise.all(
      instances.map(async (inst) => {
        const plugin = await pluginRepo.findById(inst.plugin_id);
        if (plugin === null) return null;
        return {
          instanceId: inst.id,
          pluginId: inst.plugin_manifest_id,
          tenantId: inst.tenant_id,
          displayName: inst.display_name,
          metadata: (plugin.manifest as Record<string, unknown>)["connectorMetadata"] ?? {},
          version: plugin.version,
          bundleBucket: plugin.bundle_bucket,
          bundleKey: plugin.bundle_key,
        };
      })
    );

    return c.json({ connectors: connectors.filter(Boolean) });
  });

  // ---------------------------------------------------------------------------
  // GET /internal/plugins/hooks — hook chain resolution (spec §8.3)
  // ---------------------------------------------------------------------------
  routes.get("/plugins/hooks", async (c) => {
    if (!requireServiceToken(c)) {
      return unauthorizedResponse(c);
    }

    const params = new URL(c.req.url).searchParams;
    const stage = params.get("stage");
    const tenantId = params.get("tenantId");

    if (!stage || !tenantId) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "stage and tenantId are required.", requestId: c.var.requestId } },
        400
      );
    }

    const hooks = await hookService.resolveChain(stage, tenantId);
    return c.json({ hooks });
  });

  // ---------------------------------------------------------------------------
  // Plugin cache API (spec §8.4)
  // GET  /internal/plugins/cache/:tenantId/:pluginId/:key
  // PUT  /internal/plugins/cache/:tenantId/:pluginId/:key
  // DELETE /internal/plugins/cache/:tenantId/:pluginId/:key
  // ---------------------------------------------------------------------------
  routes.get("/plugins/cache/:tenantId/:pluginId/:key", async (c) => {
    if (!requireServiceToken(c)) {
      return unauthorizedResponse(c);
    }

    const tenantId = c.req.param("tenantId");
    const pluginId = c.req.param("pluginId");
    const key = c.req.param("key");

    if (key.length > 256 || !/^[\w\-.:]+$/.test(key)) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "key must be max 256 URL-safe chars.", requestId: c.var.requestId } },
        400
      );
    }

    const value = await cacheRepo.get(tenantId, pluginId, key);
    if (value === null) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Cache key not found or expired.", requestId: c.var.requestId } },
        404
      );
    }

    return c.json({ value });
  });

  routes.put("/plugins/cache/:tenantId/:pluginId/:key", async (c) => {
    if (!requireServiceToken(c)) {
      return unauthorizedResponse(c);
    }

    const tenantId = c.req.param("tenantId");
    const pluginId = c.req.param("pluginId");
    const key = c.req.param("key");

    if (key.length > 256 || !/^[\w\-.:]+$/.test(key)) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "key must be max 256 URL-safe chars.", requestId: c.var.requestId } },
        400
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Request body must be JSON.", requestId: c.var.requestId } },
        400
      );
    }

    const parsed = CachePutBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid body.", requestId: c.var.requestId, details: parsed.error.flatten() } },
        400
      );
    }

    await cacheRepo.set(tenantId, pluginId, key, parsed.data.value, parsed.data.ttlSeconds);
    return c.json({ stored: true });
  });

  routes.delete("/plugins/cache/:tenantId/:pluginId/:key", async (c) => {
    if (!requireServiceToken(c)) {
      return unauthorizedResponse(c);
    }

    const tenantId = c.req.param("tenantId");
    const pluginId = c.req.param("pluginId");
    const key = c.req.param("key");

    // Apply the same key validation used by GET and PUT — consistency prevents
    // malformed keys from being injected into the Redis key string
    // (plugin:cache:{tenantId}:{pluginId}:{key}).
    if (key.length > 256 || !/^[\w\-.:]+$/.test(key)) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "key must be max 256 URL-safe chars.", requestId: c.var.requestId } },
        400
      );
    }

    await cacheRepo.delete(tenantId, pluginId, key);
    return c.json({ deleted: true });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/plugins/:manifestId/drain-complete — drain callback (spec §8.5)
  // ---------------------------------------------------------------------------
  routes.post("/plugins/:manifestId/drain-complete", async (c) => {
    if (!requireServiceToken(c)) {
      return unauthorizedResponse(c);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Request body must be JSON.", requestId: c.var.requestId } },
        400
      );
    }

    const parsed = DrainCompleteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid drain-complete payload.", requestId: c.var.requestId, details: parsed.error.flatten() } },
        400
      );
    }

    // W10 fix: signal the pending upgrade that drain is complete so the atomic
    // swap can proceed immediately rather than waiting for the 62s fallback.
    upgradeService.signalDrainComplete(parsed.data.manifestId);
    return c.json({ received: true });
  });

  // ---------------------------------------------------------------------------
  // GET /internal/plugins/widgets — widget list (spec §8.5)
  // ---------------------------------------------------------------------------
  routes.get("/plugins/widgets", async (c) => {
    if (!requireServiceToken(c)) {
      return unauthorizedResponse(c);
    }

    const tenantId = new URL(c.req.url).searchParams.get("tenantId");
    if (!tenantId) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "tenantId query parameter is required.", requestId: c.var.requestId } },
        400
      );
    }

    const instances = await instanceRepo.findEnabledConnectorsByTenant(tenantId, "widget");

    const widgets = await Promise.all(
      instances.map(async (inst) => {
        const plugin = await pluginRepo.findById(inst.plugin_id);
        if (plugin === null) return null;
        return {
          instanceId: inst.id,
          pluginId: inst.plugin_manifest_id,
          displayName: inst.display_name,
          metadata: (plugin.manifest as Record<string, unknown>)["widgetMetadata"] ?? {},
          version: plugin.version,
          bundleBucket: plugin.bundle_bucket,
          bundleKey: plugin.bundle_key,
        };
      })
    );

    return c.json({ widgets: widgets.filter(Boolean) });
  });

  return routes;
}
