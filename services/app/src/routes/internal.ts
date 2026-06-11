import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { AppService } from "../services/app-service.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type { PermissionRepository } from "../repositories/permission-repository.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface InternalRouteDeps {
  appService: AppService;
  appRepo:    AppRepository;
  permRepo:   PermissionRepository;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createInternalRoutes(deps: InternalRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { appRepo, permRepo } = deps;

  // Validate service token on every internal request
  function requireServiceToken(c: { var: { user?: { isService?: boolean } } }): boolean {
    return c.var.user?.isService === true;
  }

  // GET /internal/app/apps/:appId
  // Used by Pipeline Service to fetch app metadata for pipeline-triggered builds.
  // Design spec §3.12
  //
  // Internal cross-tenant lookup — tenant scoping is skipped because the
  // caller holds a valid service token (ADR-19). AppRepository.findById()
  // performs a direct lookup without tenant filtering (B7 fix).
  routes.get("/app/apps/:appId", async (c) => {
    if (!requireServiceToken(c)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Service token required." } }, 403);
    }

    const appId = c.req.param("appId");
    const app   = await appRepo.findById(appId);

    if (app === null) {
      return c.json({ error: { code: "APP_NOT_FOUND", message: `App "${appId}" not found.` } }, 404);
    }

    return c.json({
      data: {
        id:             app.id,
        tenantId:       app.tenant_id,
        name:           app.name,
        slug:           app.slug,
        accessMode:     app.access_mode,
        currentBuildId: app.current_build_id,
        allowedModules: app.allowed_modules,
        createdAt:      app.created_at.toISOString(),
        updatedAt:      app.updated_at.toISOString(),
      },
    });
  });

  // GET /internal/app/runtime-config/:appId
  // Returns non-secret env var keys for internal service use (encrypted blobs).
  // The BFF /bff/runtime-config handler owns decryption — this endpoint
  // intentionally returns encrypted values for service-to-service callers that
  // manage their own decryption keys.
  // Design spec §12.3
  routes.get("/app/runtime-config/:appId", async (c) => {
    if (!requireServiceToken(c)) {
      return c.json({ error: { code: "FORBIDDEN", message: "Service token required." } }, 403);
    }

    const appId      = c.req.param("appId");
    const envVarRows = await permRepo.listEnvVarsByApp(appId);

    // Non-secret vars only — secrets are never exposed even to internal callers
    const envVars: Record<string, string> = {};
    for (const ev of envVarRows) {
      if (!ev.is_secret) {
        envVars[ev.key] = ev.value;  // encrypted blob; caller decrypts with its own key
      }
    }

    return c.json({ data: { appId, envVars } });
  });

  return routes;
}
