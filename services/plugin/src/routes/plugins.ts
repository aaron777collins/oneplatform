import { Hono } from "hono";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AppVariables } from "@oneplatform/core";
import type { PluginService } from "../services/plugin-service.js";
import {
  ListPluginsQuerySchema,
  UninstallQuerySchema,
} from "../schemas/index.js";
import type { PluginRow } from "../repositories/types.js";

export interface PluginRouteDeps {
  pluginService: PluginService;
}

function formatPlugin(plugin: PluginRow, instanceCount: number) {
  return {
    id: plugin.id,
    manifestId: plugin.manifest_id,
    name: plugin.name,
    version: plugin.version,
    type: plugin.type,
    status: plugin.status,
    description: plugin.manifest.description,
    author: plugin.manifest.author,
    installedAt: plugin.installed_at.toISOString(),
    instanceCount,
  };
}

export function createPluginRoutes(
  deps: PluginRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { pluginService } = deps;

  // GET /api/v1/plugins — list plugins (spec §3.2)
  routes.get("/", async (c) => {
    const query = ListPluginsQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!query.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid query parameters",
            requestId: c.var.requestId,
            details: query.error.flatten(),
          },
        },
        400
      );
    }

    const { type, status, q, cursor, limit } = query.data;
    const { rows, total } = await pluginService.listPlugins({
      ...(type !== undefined ? { type } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });

    const items = rows.map((p) => formatPlugin(p, 0));
    const lastItem = rows[rows.length - 1];
    const nextCursor = rows.length === limit ? (lastItem?.id ?? null) : null;

    return c.json({ items, nextCursor, total });
  });

  // POST /api/v1/plugins — install plugin (spec §3.2)
  //
  // When ?devMode=true is present, the endpoint applies relaxed authorization:
  // - Requires plugins:manage scope instead of platform-admin role.
  // - Forces tenantId to the caller's own tenant (never trusted from request body).
  // - Sets dev: true and expiresAt: 7 days from now on the installation record.
  routes.post("/", async (c) => {
    const user = c.var.user;
    const isDevMode = new URL(c.req.url).searchParams.get("devMode") === "true";

    if (isDevMode) {
      // Dev-mode: requires only plugins:manage scope, not platform-admin.
      const hasManageScope =
        user?.scopes?.includes("plugins:manage") ||
        user?.scopes?.includes("admin") ||
        user?.roles?.includes("admin");
      if (!hasManageScope) {
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "plugins:manage scope is required for dev-mode plugin installation.",
              requestId: c.var.requestId,
            },
          },
          403,
        );
      }
    } else {
      // Normal install: requires platform-admin role.
      if (!user?.roles.includes("platform-admin")) {
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Platform admin role required to install plugins.",
              requestId: c.var.requestId,
            },
          },
          403,
        );
      }
    }

    // Parse multipart form — bundle file is required.
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request must be multipart/form-data",
            requestId: c.var.requestId,
          },
        },
        400,
      );
    }

    if (isDevMode) {
      // Tenant enforcement: reject any attempt to install for a different tenant.
      // tenantId in the body is optional; if present it MUST match the caller's own tenant.
      // This prevents cross-tenant dev plugin installation even if the caller constructs
      // a raw HTTP request with a different tenantId field.
      const requestedTenantId = formData.get("tenantId");
      if (
        requestedTenantId !== null &&
        typeof requestedTenantId === "string" &&
        requestedTenantId !== user!.tenantId
      ) {
        return c.json(
          {
            error: {
              code: "FORBIDDEN",
              message:
                `Dev-mode plugins can only be installed for your own tenant. ` +
                `Requested tenantId "${requestedTenantId}" does not match ` +
                `authenticated tenantId "${user!.tenantId}".`,
              requestId: c.var.requestId,
            },
          },
          403,
        );
      }
    }

    const bundleFile = formData.get("bundle");
    if (!(bundleFile instanceof File)) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "bundle field is required (multipart File)",
            requestId: c.var.requestId,
          },
        },
        400,
      );
    }

    const approveUrls = formData.get("approveUrls") === "true";
    // Dev-mode installations are always tenant-scoped (not platform-wide).
    const platformWide = !isDevMode && formData.get("platformWide") === "true";

    // Write bundle to a temp file so bundle-service can stream it.
    const tmpDir = join("/tmp", "oneplatform-plugins", randomUUID());
    await mkdir(tmpDir, { recursive: true });
    const bundlePath = join(tmpDir, "upload.oppkg");
    const bytes = await bundleFile.arrayBuffer();
    await writeFile(bundlePath, Buffer.from(bytes));

    // For dev-mode installs, tenantId is always the caller's own tenant —
    // derived from the authenticated JWT, never from the request body.
    const expiresAt = isDevMode
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      : undefined;

    const { plugin, approvedUrls, requiresUrlApproval, urlPatterns } =
      await pluginService.installPlugin({
        bundlePath,
        approveUrls,
        platformWide,
        installedBy: user!.userId,
        ...(isDevMode
          ? {
              tenantId: user!.tenantId,
              dev: true,
              expiresAt,
            }
          : {}),
      });

    if (requiresUrlApproval) {
      return c.json(
        {
          status: "approval_required",
          manifestId: plugin.manifest_id,
          requiredApprovals: urlPatterns.map((p) => ({
            urlPattern: p,
            reason: "Declared in manifest.requiredExternalUrls",
          })),
          message: "Resubmit with approveUrls=true to install.",
        },
        202,
      );
    }

    return c.json(
      {
        id: plugin.id,
        manifestId: plugin.manifest_id,
        name: plugin.name,
        version: plugin.version,
        type: plugin.type,
        status: plugin.status,
        ...(isDevMode
          ? {
              dev: true,
              expiresAt: expiresAt!.toISOString(),
              tenantId: user!.tenantId,
            }
          : {}),
        ...(approvedUrls.length > 0
          ? {
              requiredApprovals: approvedUrls.map((u) => ({
                urlPattern: u.url_pattern,
                reason: "Declared in manifest.requiredExternalUrls",
              })),
            }
          : {}),
      },
      201,
    );
  });

  // GET /api/v1/plugins/:id — get single plugin (spec §3.2)
  routes.get("/:id", async (c) => {
    const id = c.req.param("id");
    const plugin = await pluginService.getPlugin(id);
    const approvedUrls = await pluginService.getApprovedUrls(plugin.id);

    return c.json({
      id: plugin.id,
      manifestId: plugin.manifest_id,
      name: plugin.name,
      version: plugin.version,
      type: plugin.type,
      status: plugin.status,
      manifest: plugin.manifest,
      bundleSizeBytes: 0,
      installedAt: plugin.installed_at.toISOString(),
      installedBy: plugin.installed_by,
      gpgFingerprint: plugin.gpg_fingerprint,
      approvedUrls: approvedUrls.map((u) => u.url_pattern),
      instances: [],
    });
  });

  // DELETE /api/v1/plugins/:id — uninstall plugin (spec §3.2)
  routes.delete("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.roles.includes("platform-admin")) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Platform admin role required to uninstall plugins.",
            requestId: c.var.requestId,
          },
        },
        403
      );
    }

    const id = c.req.param("id");
    const query = UninstallQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const confirmOrphan = query.success ? query.data.confirmOrphan : false;

    const result = await pluginService.uninstallPlugin({
      id,
      confirmOrphan,
      uninstalledBy: user.userId,
    });

    return c.json(result);
  });

  return routes;
}
