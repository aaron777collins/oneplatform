import { Hono } from "hono";
import type { AppVariables, ServiceTokenSigner } from "@oneplatform/core";
import { decrypt, ValidationError, UnauthorizedError, ForbiddenError } from "@oneplatform/core";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import type { AppRepository } from "../repositories/app-repository.js";
import type { PermissionRepository } from "../repositories/permission-repository.js";
import type { PermissionService } from "../services/permission-service.js";
import { StoragePutSchema } from "../schemas/index.js";
import {
  AppNotFoundError,
  AppStorageKeyNotFoundError,
  AppStorageValueTooLargeError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// BFF — Backend-for-Frontend routes
// Design spec §§3.9, 8
//
// These endpoints are called by the in-app SDK running inside user apps.
// They aggregate data from multiple internal sources and enforce app-level
// permission checks so the SDK does not need to call each service directly.
// ---------------------------------------------------------------------------

export interface BffRouteDeps {
  appRepo:        AppRepository;
  permRepo:       PermissionRepository;
  permService:    PermissionService;
  authServiceUrl: string;
  // masterKey injected once at startup — never call loadMasterKey() per-request (W10)
  masterKey:      Buffer;
  redis:          Redis;
  logger:         Logger;
  serviceTokenSigner: ServiceTokenSigner;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBffRoutes(deps: BffRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { appRepo, permRepo, permService, authServiceUrl, masterKey, redis, logger, serviceTokenSigner } = deps;

  // ---------------------------------------------------------------------------
  // V5-017 — Entity-level RBAC enforcement for data proxy routes
  //
  // Before forwarding any data request to the Execution Service, verify that the
  // authenticated user holds at least one app role whose permissions include the
  // required action on the target entity.  Users with the "admin" action on an
  // entity are implicitly allowed all operations on that entity.
  // ---------------------------------------------------------------------------

  type EntityAction = "create" | "read" | "update" | "delete";

  async function assertEntityPermission(
    appId: string,
    userRoles: string[],
    entity: string,
    requiredAction: EntityAction
  ): Promise<void> {
    // Resolve the user's app-level roles and their permission grants.
    const allAppRoles = await permRepo.listRolesByApp(appId);
    const userRoleNames = new Set(userRoles);
    const matchedRoles = allAppRoles.filter((r) => userRoleNames.has(r.name));

    // Check if any matched role grants the required action (or "admin") on the entity.
    for (const role of matchedRoles) {
      const perms = role.permissions as Array<{ entity: string; actions: string[] }>;
      for (const perm of perms) {
        // Match the entity name (case-insensitive to tolerate casing mismatches
        // between URL path segments and role definitions) or the wildcard "*".
        if (
          perm.entity === "*" ||
          perm.entity.toLowerCase() === entity.toLowerCase()
        ) {
          if (
            perm.actions.includes(requiredAction) ||
            perm.actions.includes("admin")
          ) {
            return; // Permitted
          }
        }
      }
    }

    // No matching permission found — deny access.
    throw new ForbiddenError(
      `Permission denied: action "${requiredAction}" on entity "${entity}" is not allowed.`,
      { appId, entity, requiredAction }
    );
  }

  // -------------------------------------------------------------------------
  // GET /bff/me
  // Returns the current user's identity and resolved app roles.
  // Design spec §8.1
  // -------------------------------------------------------------------------
  routes.get("/me", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Fetch roles for the app identified by the X-App-Id header.
    // The SDK sets this header on every BFF request.
    const appId = c.req.header("x-app-id");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    // Verify the app belongs to the user's tenant (or is accessible via share)
    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // Resolve roles for this user within the app.
    // listRolesByApp returns all roles defined for the app; filter to only the
    // roles the authenticated user actually holds (user.roles carries the names
    // embedded in the session token by the Auth Service).
    const allAppRoles = await permRepo.listRolesByApp(appId);
    const userRoleNames = new Set(user.roles);
    const roles = allAppRoles.filter((r) => userRoleNames.has(r.name));

    // Map userId → id and provide email/displayName placeholders so the
    // response matches the app-sdk UserContext interface (id, email, displayName).
    // The core UserContext only carries userId; email/displayName require a
    // lookup against the Auth Service user profile — a future enhancement.
    return c.json({
      data: {
        id:          user.userId,
        email:       null,
        displayName: "User",
        tenantId:    user.tenantId,
        appId,
        // User's roles within the app — the SDK uses this for permission checks
        roles:       roles.map((r) => r.name),
        isGuest:     user.isGuest,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /bff/permissions
  // Returns the effective permission set for the current user within the app.
  // Design spec §8.2
  // -------------------------------------------------------------------------
  routes.get("/permissions", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId = c.req.header("x-app-id");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // Filter to only the roles the authenticated user holds before aggregating
    // permissions — without this filter every user would see every role's
    // permissions regardless of their actual assignments.
    const allAppRoles = await permRepo.listRolesByApp(appId);
    const userRoleNames = new Set(user.roles);
    const roles = allAppRoles.filter((r) => userRoleNames.has(r.name));

    // Aggregate permissions across the user's roles only — the SDK uses this
    // flat map for permission checks without needing to understand role hierarchy.
    const permissionMap: Record<string, string[]> = {};
    for (const role of roles) {
      const perms = role.permissions as Array<{ entity: string; actions: string[] }>;
      for (const perm of perms) {
        const existing = permissionMap[perm.entity] ?? [];
        for (const action of perm.actions) {
          if (!existing.includes(action)) {
            existing.push(action);
          }
        }
        permissionMap[perm.entity] = existing;
      }
    }

    return c.json({ data: { appId, permissions: permissionMap } });
  });

  // -------------------------------------------------------------------------
  // GET  /bff/data/:entity — list entity records via Execution Service proxy
  // POST /bff/data/:entity — create / query entity records
  // Design spec §8.3
  //
  // The BFF acts as a secure proxy: it validates the session, enforces app-level
  // RBAC, then forwards the request to the Execution Service which owns the
  // actual data layer. This keeps the SDK decoupled from the internal topology.
  // -------------------------------------------------------------------------
  routes.get("/data/:entity", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId  = c.req.header("x-app-id");
    const entity = c.req.param("entity");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // V5-017: enforce entity-level RBAC before forwarding to execution service
    await assertEntityPermission(appId, user.roles, entity, "read");

    const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";

    const queryParams = new URLSearchParams(c.req.query()).toString();
    const upstreamUrl = `${executionServiceUrl}/internal/data/${user.tenantId}/${appId}/${entity}${queryParams ? `?${queryParams}` : ""}`;

    // W3: include service token on inter-service calls
    const resp = await fetch(upstreamUrl, {
      headers: {
        "X-Service-Token": await serviceTokenSigner.sign(),
        "X-User-Id":       user.userId,
        "X-Tenant-Id":     user.tenantId,
      },
    }).catch(() => null);

    if (resp === null || !resp.ok) {
      const status = resp?.status ?? 503;
      return c.json(
        { error: { code: "UPSTREAM_ERROR", message: `Data service returned ${status}.` } },
        status >= 400 && status < 600 ? (status as 400) : 503
      );
    }

    // The execution service already returns a `{ data: [...] }` envelope.
    // Pass it through directly to avoid double-wrapping as `{ data: { data: [...] } }`.
    const envelope = await resp.json() as unknown;
    return c.json(envelope);
  });

  routes.post("/data/:entity", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId  = c.req.header("x-app-id");
    const entity = c.req.param("entity");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // V5-017: enforce entity-level RBAC before forwarding to execution service
    await assertEntityPermission(appId, user.roles, entity, "create");

    const body = await c.req.json().catch(() => null);

    const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
    const upstreamUrl = `${executionServiceUrl}/internal/data/${user.tenantId}/${appId}/${entity}`;

    const resp = await fetch(upstreamUrl, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Service-Token": await serviceTokenSigner.sign(),
        "X-User-Id":       user.userId,
        "X-Tenant-Id":     user.tenantId,
      },
      body: JSON.stringify(body),
    }).catch(() => null);

    if (resp === null || !resp.ok) {
      const status = resp?.status ?? 503;
      return c.json(
        { error: { code: "UPSTREAM_ERROR", message: `Data service returned ${status}.` } },
        status >= 400 && status < 600 ? (status as 400) : 503
      );
    }

    // Pass through the execution service envelope unchanged (single `{ data: ... }` layer).
    const envelope = await resp.json() as unknown;
    return c.json(envelope, 201);
  });

  // -------------------------------------------------------------------------
  // PATCH /bff/data/:entity/:id  — update entity record (partial update)
  // PUT   /bff/data/:entity/:id  — replace entity record (full update)
  // DELETE /bff/data/:entity/:id — delete entity record
  // POST  /bff/data/:entity/bulk — bulk create entity records
  // Design spec §8.3
  //
  // useMutation() in the app-sdk calls these endpoints. They follow the same
  // auth+tenant+proxy pattern as GET/POST above.
  // -------------------------------------------------------------------------

  routes.patch("/data/:entity/:id", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId  = c.req.header("x-app-id");
    const entity = c.req.param("entity");
    const itemId = c.req.param("id");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // V5-017: enforce entity-level RBAC before forwarding to execution service
    await assertEntityPermission(appId, user.roles, entity, "update");

    const body = await c.req.json().catch(() => null);
    const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
    const upstreamUrl = `${executionServiceUrl}/internal/data/${user.tenantId}/${appId}/${entity}/${encodeURIComponent(itemId)}`;

    const resp = await fetch(upstreamUrl, {
      method:  "PATCH",
      headers: {
        "Content-Type":    "application/json",
        "X-Service-Token": await serviceTokenSigner.sign(),
        "X-User-Id":       user.userId,
        "X-Tenant-Id":     user.tenantId,
      },
      body: JSON.stringify(body),
    }).catch(() => null);

    if (resp === null || !resp.ok) {
      const status = resp?.status ?? 503;
      return c.json(
        { error: { code: "UPSTREAM_ERROR", message: `Data service returned ${status}.` } },
        status >= 400 && status < 600 ? (status as 400) : 503
      );
    }

    // Pass through the execution service envelope unchanged (single `{ data: ... }` layer).
    const envelope = await resp.json() as unknown;
    return c.json(envelope);
  });

  routes.put("/data/:entity/:id", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId  = c.req.header("x-app-id");
    const entity = c.req.param("entity");
    const itemId = c.req.param("id");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // V5-017: enforce entity-level RBAC before forwarding to execution service
    await assertEntityPermission(appId, user.roles, entity, "update");

    const body = await c.req.json().catch(() => null);
    const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
    const upstreamUrl = `${executionServiceUrl}/internal/data/${user.tenantId}/${appId}/${entity}/${encodeURIComponent(itemId)}`;

    const resp = await fetch(upstreamUrl, {
      method:  "PUT",
      headers: {
        "Content-Type":    "application/json",
        "X-Service-Token": await serviceTokenSigner.sign(),
        "X-User-Id":       user.userId,
        "X-Tenant-Id":     user.tenantId,
      },
      body: JSON.stringify(body),
    }).catch(() => null);

    if (resp === null || !resp.ok) {
      const status = resp?.status ?? 503;
      return c.json(
        { error: { code: "UPSTREAM_ERROR", message: `Data service returned ${status}.` } },
        status >= 400 && status < 600 ? (status as 400) : 503
      );
    }

    // Pass through the execution service envelope unchanged (single `{ data: ... }` layer).
    const envelope = await resp.json() as unknown;
    return c.json(envelope);
  });

  routes.delete("/data/:entity/:id", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId  = c.req.header("x-app-id");
    const entity = c.req.param("entity");
    const itemId = c.req.param("id");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // V5-017: enforce entity-level RBAC before forwarding to execution service
    await assertEntityPermission(appId, user.roles, entity, "delete");

    const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
    const upstreamUrl = `${executionServiceUrl}/internal/data/${user.tenantId}/${appId}/${entity}/${encodeURIComponent(itemId)}`;

    const resp = await fetch(upstreamUrl, {
      method:  "DELETE",
      headers: {
        "X-Service-Token": await serviceTokenSigner.sign(),
        "X-User-Id":       user.userId,
        "X-Tenant-Id":     user.tenantId,
      },
    }).catch(() => null);

    if (resp === null || !resp.ok) {
      const status = resp?.status ?? 503;
      return c.json(
        { error: { code: "UPSTREAM_ERROR", message: `Data service returned ${status}.` } },
        status >= 400 && status < 600 ? (status as 400) : 503
      );
    }

    return new Response(null, { status: 204 });
  });

  // Bulk create — POST /bff/data/:entity/bulk
  // Must be registered before the /:id wildcard that would match "bulk" as an ID.
  routes.post("/data/:entity/bulk", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId  = c.req.header("x-app-id");
    const entity = c.req.param("entity");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // V5-017: enforce entity-level RBAC before forwarding to execution service
    await assertEntityPermission(appId, user.roles, entity, "create");

    const body = await c.req.json().catch(() => null);
    const executionServiceUrl = process.env["EXECUTION_SERVICE_URL"] ?? "http://execution-service:3005";
    const upstreamUrl = `${executionServiceUrl}/internal/data/${user.tenantId}/${appId}/${entity}/bulk`;

    const resp = await fetch(upstreamUrl, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Service-Token": await serviceTokenSigner.sign(),
        "X-User-Id":       user.userId,
        "X-Tenant-Id":     user.tenantId,
      },
      body: JSON.stringify(body),
    }).catch(() => null);

    if (resp === null || !resp.ok) {
      const status = resp?.status ?? 503;
      return c.json(
        { error: { code: "UPSTREAM_ERROR", message: `Data service returned ${status}.` } },
        status >= 400 && status < 600 ? (status as 400) : 503
      );
    }

    // Pass through the execution service envelope unchanged (single `{ data: ... }` layer).
    const envelope = await resp.json() as unknown;
    return c.json(envelope, 201);
  });

  // -------------------------------------------------------------------------
  // GET    /bff/storage/:key  — read per-user app storage
  // PUT    /bff/storage/:key  — write per-user app storage
  // DELETE /bff/storage/:key  — delete per-user app storage
  // Design spec §8.4
  // -------------------------------------------------------------------------
  routes.get("/storage/:key", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId = c.req.header("x-app-id");
    const key   = c.req.param("key");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }
    if (key === "" || key === undefined) {
      throw new ValidationError("Storage key is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    const row = await permRepo.findUserStorage(appId, user.userId, key);
    if (row === null) {
      throw new AppStorageKeyNotFoundError(
        `Storage key "${key}" not found for user "${user.userId}" in app "${appId}".`,
        { appId, userId: user.userId, key }
      );
    }

    return c.json({
      data: {
        key,
        value:     row.value,
        updatedAt: row.updated_at.toISOString(),
      },
    });
  });

  routes.put("/storage/:key", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId = c.req.header("x-app-id");
    const key   = c.req.param("key");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }
    if (key === "" || key === undefined) {
      throw new ValidationError("Storage key is required.");
    }

    const body   = await c.req.json().catch(() => null);
    const parsed = StoragePutSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // Enforce 64KB value limit — check serialised size before DB write
    const serialised = JSON.stringify(parsed.data.value);
    if (Buffer.byteLength(serialised, "utf8") > 65_536) {
      throw new AppStorageValueTooLargeError(
        `Storage value for key "${key}" exceeds 64KB limit.`,
        { appId, key }
      );
    }

    const row = await permRepo.upsertUserStorage({
      app_id:  appId,
      user_id: user.userId,
      key,
      value:   parsed.data.value,
    });

    logger.info("BFF storage upserted", { appId, userId: user.userId, key });

    return c.json({
      data: {
        key,
        value:     row.value,
        updatedAt: row.updated_at.toISOString(),
      },
    });
  });

  routes.delete("/storage/:key", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId = c.req.header("x-app-id");
    const key   = c.req.param("key");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }
    if (key === "" || key === undefined) {
      throw new ValidationError("Storage key is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    await permRepo.deleteUserStorage(appId, user.userId, key);
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // GET /bff/runtime-config
  // Returns non-secret env vars for the app — used to initialise the SDK
  // without requiring a round-trip to the internal runtime-config endpoint.
  // Design spec §8.5
  // -------------------------------------------------------------------------
  routes.get("/runtime-config", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      throw new UnauthorizedError("Authentication required.");
    }

    const appId = c.req.header("x-app-id");
    if (appId === undefined || appId === "") {
      throw new ValidationError("X-App-Id header is required.");
    }

    const accessible = await permService.canTenantAccessApp(appId, user.tenantId);
    if (!accessible) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId: user.tenantId });
    }

    // Check Redis cache before hitting the DB. The cache is written below on
    // every miss with a 60 s TTL, so back-to-back SDK init calls share one DB
    // round-trip per minute per app rather than one per request.
    const cacheKey = `bff:runtime-config:${user.tenantId}:${appId}`;
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached !== null) {
      try {
        const { envVars, allowedModules } = JSON.parse(cached) as {
          envVars: Record<string, string>;
          allowedModules: unknown;
        };
        return c.json({ data: { appId, envVars, allowedModules } });
      } catch {
        // Malformed cache entry — fall through to DB path and overwrite it.
      }
    }

    const app = await appRepo.findById(appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId });
    }

    const envVarRows = await permRepo.listEnvVarsByApp(appId);

    // Decrypt non-secret env vars using the injected masterKey (W10 — no
    // loadMasterKey() call here).  Secret vars are never exposed to the SDK.
    const envVars: Record<string, string> = {};
    await Promise.all(
      envVarRows
        .filter((ev) => !ev.is_secret)
        .map(async (ev) => {
          try {
            const plaintext = await decrypt(ev.value, masterKey);
            envVars[ev.key] = plaintext;
          } catch {
            // Silently skip env vars that cannot be decrypted rather than
            // crashing the entire config response.
          }
        })
    );

    // Cache both envVars and allowedModules for 60 s so cache hits return a
    // complete response without touching the DB.
    void redis.setex(cacheKey, 60, JSON.stringify({ envVars, allowedModules: app.allowed_modules })).catch(() => {
      /* non-fatal */
    });

    return c.json({
      data: {
        appId,
        envVars,
        allowedModules: app.allowed_modules,
      },
    });
  });

  return routes;
}
