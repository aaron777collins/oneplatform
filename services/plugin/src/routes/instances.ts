import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { InstanceService } from "../services/instance-service.js";
import { CreateInstanceSchema, PatchInstanceSchema } from "../schemas/index.js";

export interface InstanceRouteDeps {
  instanceService: InstanceService;
}

export function createInstanceRoutes(
  deps: InstanceRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { instanceService } = deps;

  // GET /api/v1/plugins/:id/instances (spec §3.2)
  routes.get("/:id/instances", async (c) => {
    const user = c.var.user;
    const id = c.req.param("id");
    const isPlatformAdmin = user?.roles.includes("platform-admin") ?? false;

    const items = await instanceService.listInstances({
      pluginIdOrManifestId: id,
      tenantId: user?.tenantId,
      isPlatformAdmin,
    });

    return c.json({
      items: items.map((inst) => ({
        instanceId: inst.id,
        pluginManifestId: inst.plugin_manifest_id,
        pluginId: inst.plugin_id,
        tenantId: inst.tenant_id,
        displayName: inst.display_name,
        config: inst.config,
        enabled: inst.enabled,
        createdAt: inst.created_at.toISOString(),
        updatedAt: inst.updated_at.toISOString(),
      })),
    });
  });

  // POST /api/v1/plugins/:id/instances — enable plugin for tenant (spec §3.2)
  routes.post("/:id/instances", async (c) => {
    const user = c.var.user;
    if (!user) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
            requestId: c.var.requestId,
          },
        },
        401
      );
    }

    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request body must be JSON",
            requestId: c.var.requestId,
          },
        },
        400
      );
    }

    const parsed = CreateInstanceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            requestId: c.var.requestId,
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const { displayName, config } = parsed.data;
    const instance = await instanceService.createInstance({
      pluginIdOrManifestId: id,
      tenantId: user.tenantId,
      displayName,
      config,
      createdBy: user.userId,
    });

    return c.json(
      {
        instanceId: instance.id,
        pluginManifestId: instance.plugin_manifest_id,
        tenantId: instance.tenant_id,
        displayName: instance.display_name,
        enabled: instance.enabled,
        createdAt: instance.created_at.toISOString(),
      },
      201
    );
  });

  // PATCH /api/v1/plugins/:id/instances/:instanceId (spec §3.2)
  routes.patch("/:id/instances/:instanceId", async (c) => {
    const user = c.var.user;
    if (!user) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
            requestId: c.var.requestId,
          },
        },
        401
      );
    }

    const instanceId = c.req.param("instanceId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request body must be JSON",
            requestId: c.var.requestId,
          },
        },
        400
      );
    }

    const parsed = PatchInstanceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            requestId: c.var.requestId,
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const { displayName, config, enabled } = parsed.data;
    const instance = await instanceService.patchInstance({
      instanceId,
      tenantId: user.tenantId,
      updatedBy: user.userId,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });

    return c.json({
      instanceId: instance.id,
      pluginManifestId: instance.plugin_manifest_id,
      pluginId: instance.plugin_id,
      tenantId: instance.tenant_id,
      displayName: instance.display_name,
      config: instance.config,
      enabled: instance.enabled,
      createdAt: instance.created_at.toISOString(),
      updatedAt: instance.updated_at.toISOString(),
    });
  });

  return routes;
}
