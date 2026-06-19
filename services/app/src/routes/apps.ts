import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, UnauthorizedError } from "@oneplatform/core";
import { sha256hex, validateFilePath } from "../services/app-service.js";
import type { AppService } from "../services/app-service.js";
import type { PermissionService } from "../services/permission-service.js";
import type { VersionRepository } from "../repositories/version-repository.js";
import {
  CreateAppSchema,
  PatchAppSchema,
  WriteFileSchema,
  RenameFileSchema,
  CreateRoleSchema,
  PatchRoleSchema,
  ShareAppSchema,
  EnvVarSchema,
  PatchOAuthSchema,
  PaginationSchema,
  CreateAppFromTemplateSchema,
} from "../schemas/index.js";
import { ALL_TEMPLATES, findTemplateById } from "../templates/index.js";
import {
  AppFileVersionConflictError,
  AppFileTooLargeError,
  AppFileNotFoundError,
  AppCannotDeleteEntrypointError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface AppRouteDeps {
  appService:  AppService;
  permService: PermissionService;
  fileRepo:    VersionRepository;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createAppRoutes(deps: AppRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { appService, permService, fileRepo } = deps;

  // ---------------------------------------------------------------------------
  // App CRUD
  // ---------------------------------------------------------------------------

  // GET / — list apps
  routes.get("/", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const query = PaginationSchema.safeParse({
      cursor: c.req.query("cursor"),
      limit:  c.req.query("limit"),
    });
    const { cursor, limit } = query.success ? query.data : { cursor: undefined, limit: 50 };

    const result = await appService.listApps(user.tenantId, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });

    return c.json({
      data: result.apps.map(formatAppSummary),
      pagination: {
        nextCursor: result.nextCursor,
        total:      result.total,
      },
    });
  });

  // POST / — create app
  routes.post("/", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = CreateAppSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const app = await appService.createApp(user.tenantId, user.userId, {
      name:        parsed.data.name,
      slug:        parsed.data.slug,
      accessMode:  parsed.data.accessMode,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    });

    return c.json({ data: formatAppDetail(app) }, 201);
  });

  // GET /:id
  routes.get("/:id", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const app = await appService.getApp(user.tenantId, c.req.param("id"));
    return c.json({ data: formatAppDetail(app) });
  });

  // PATCH /:id
  routes.patch("/:id", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = PatchAppSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const app = await appService.updateApp(user.tenantId, c.req.param("id"), {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.accessMode !== undefined ? { accessMode: parsed.data.accessMode } : {}),
      ...(parsed.data.allowedModules !== undefined ? { allowedModules: parsed.data.allowedModules } : {}),
    });

    return c.json({ data: formatAppDetail(app) });
  });

  // DELETE /:id
  routes.delete("/:id", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    await appService.deleteApp(user.tenantId, c.req.param("id"));
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Virtual File System — /apps/:id/files
  // ---------------------------------------------------------------------------

  // GET /:id/files
  routes.get("/:id/files", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    // Verify app ownership
    const app = await appService.getApp(user.tenantId, c.req.param("id"));
    const files = await fileRepo.listByApp(app.id);

    return c.json({
      data: files.map((f) => ({
        id:          f.id,
        appId:       f.app_id,
        path:        f.path,
        contentHash: f.content_hash,
        fileVersion: f.file_version,
        updatedAt:   f.updated_at.toISOString(),
        updatedBy:   f.updated_by,
        sizeBytes:   f.size_bytes,
      })),
    });
  });

  // GET /:id/files/:path
  routes.get("/:id/files/:path{.+}", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const app = await appService.getApp(user.tenantId, c.req.param("id"));
    const filePath = `/${decodeURIComponent(c.req.param("path") ?? "")}`;
    const file = await fileRepo.findByAppAndPath(app.id, filePath);
    if (file === null) {
      throw new AppFileNotFoundError(`File "${filePath}" not found.`, { appId: app.id, path: filePath });
    }

    return c.json({
      data: {
        path:        file.path,
        content:     file.content,
        contentHash: file.content_hash,
        fileVersion: file.file_version,
        updatedAt:   file.updated_at.toISOString(),
      },
    });
  });

  // PUT /:id/files/:path
  routes.put("/:id/files/:path{.+}", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = WriteFileSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const app = await appService.getApp(user.tenantId, c.req.param("id"));
    const filePath = `/${decodeURIComponent(c.req.param("path") ?? "")}`;

    // Validate path syntax before DB access
    validateFilePath(filePath);

    const { content, fileVersion } = parsed.data;

    // 1MB per file — checked after Zod but before DB
    if (Buffer.byteLength(content, "utf8") > 1_048_576) {
      throw new AppFileTooLargeError("File content exceeds 1MB limit.", { appId: app.id, path: filePath });
    }

    const contentHash = sha256hex(content);

    let result;
    if (fileVersion === 0) {
      // Create new file
      result = await fileRepo.create({
        app_id:       app.id,
        path:         filePath,
        content,
        content_hash: contentHash,
        updated_by:   user.userId,
      });
      if (result === null) {
        throw new AppFileVersionConflictError(
          `File "${filePath}" already exists. Use fileVersion > 0 to update.`,
          { appId: app.id, path: filePath }
        );
      }
    } else {
      // Optimistic lock update
      result = await fileRepo.updateWithVersionCheck(app.id, filePath, {
        content,
        content_hash: contentHash,
        updated_by:   user.userId,
        file_version: fileVersion,
      });
      if (result === null) {
        throw new AppFileVersionConflictError(
          `File "${filePath}" version conflict. Expected version ${fileVersion}.`,
          { appId: app.id, path: filePath, expectedVersion: fileVersion }
        );
      }
    }

    return c.json({
      data: {
        id:          result.id,
        appId:       result.app_id,
        path:        result.path,
        contentHash: result.content_hash,
        fileVersion: result.file_version,
        updatedAt:   result.updated_at.toISOString(),
        updatedBy:   result.updated_by,
        sizeBytes:   Buffer.byteLength(result.content, "utf8"),
      },
    });
  });

  // DELETE /:id/files/:path
  routes.delete("/:id/files/:path{.+}", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const app = await appService.getApp(user.tenantId, c.req.param("id"));
    const filePath = `/${decodeURIComponent(c.req.param("path") ?? "")}`;

    if (filePath === "/src/index.tsx") {
      throw new AppCannotDeleteEntrypointError(
        "Cannot delete /src/index.tsx — it is the required app entrypoint.",
        { appId: app.id }
      );
    }

    await fileRepo.delete(app.id, filePath);
    return new Response(null, { status: 204 });
  });

  // POST /:id/files/rename
  routes.post("/:id/files/rename", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = RenameFileSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const app = await appService.getApp(user.tenantId, c.req.param("id"));

    validateFilePath(parsed.data.toPath);

    const result = await fileRepo.rename(
      app.id,
      parsed.data.fromPath,
      parsed.data.toPath,
      parsed.data.fileVersion,
      user.userId
    );

    if (result === null) {
      throw new AppFileVersionConflictError(
        `File "${parsed.data.fromPath}" not found or version conflict.`,
        { appId: app.id, path: parsed.data.fromPath }
      );
    }

    return c.json({
      data: {
        id:          result.id,
        appId:       result.app_id,
        path:        result.path,
        contentHash: result.content_hash,
        fileVersion: result.file_version,
        updatedAt:   result.updated_at.toISOString(),
        updatedBy:   result.updated_by,
        sizeBytes:   Buffer.byteLength(result.content, "utf8"),
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Roles — /apps/:id/roles
  // ---------------------------------------------------------------------------

  routes.get("/:id/roles", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const roles = await permService.listRoles(user.tenantId, c.req.param("id"));
    return c.json({ data: roles.map(formatRole) });
  });

  routes.post("/:id/roles", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = CreateRoleSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const role = await permService.createRole(user.tenantId, c.req.param("id"), {
      name:        parsed.data.name,
      permissions: parsed.data.permissions,
    });

    return c.json({ data: formatRole(role) }, 201);
  });

  routes.patch("/:id/roles/:roleId", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = PatchRoleSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const role = await permService.updateRole(
      user.tenantId,
      c.req.param("id"),
      c.req.param("roleId"),
      {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.permissions !== undefined ? { permissions: parsed.data.permissions } : {}),
      }
    );

    return c.json({ data: formatRole(role) });
  });

  routes.delete("/:id/roles/:roleId", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    await permService.deleteRole(user.tenantId, c.req.param("id"), c.req.param("roleId"));
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Sharing — /apps/:id/share
  // ---------------------------------------------------------------------------

  routes.post("/:id/share", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = ShareAppSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const share = await permService.shareApp(
      user.tenantId,
      c.req.param("id"),
      { tenantId: parsed.data.tenantId, mappedRoles: parsed.data.mappedRoles },
      user.userId
    );

    return c.json({
      data: {
        id:               share.id,
        appId:            share.app_id,
        externalTenantId: share.external_tenant_id,
        mappedRoles:      share.mapped_roles,
        createdAt:        share.created_at.toISOString(),
        createdBy:        share.created_by,
      },
    }, 201);
  });

  // ---------------------------------------------------------------------------
  // Env vars — /apps/:id/env-vars
  // ---------------------------------------------------------------------------

  routes.get("/:id/env-vars", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const envVars = await permService.listEnvVars(user.tenantId, c.req.param("id"));
    return c.json({ data: envVars });
  });

  routes.put("/:id/env-vars/:key", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = EnvVarSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const envVar = await permService.upsertEnvVar(
      user.tenantId,
      c.req.param("id"),
      c.req.param("key"),
      { value: parsed.data.value, isSecret: parsed.data.isSecret }
    );

    return c.json({ data: envVar });
  });

  routes.delete("/:id/env-vars/:key", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    await permService.deleteEnvVar(user.tenantId, c.req.param("id"), c.req.param("key"));
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // OAuth management — /apps/:id/oauth
  // ---------------------------------------------------------------------------

  routes.patch("/:id/oauth", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = PatchOAuthSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    // Verify app ownership
    await appService.getApp(user.tenantId, c.req.param("id"));

    // Additional redirect URIs are forwarded to the Auth Service.
    // Implementation: call Auth Service PATCH /internal/oauth/clients/{clientId}/redirect-uris
    // Stubbed for now — returns acknowledgment
    return c.json({
      data: {
        appId:                  c.req.param("id"),
        additionalRedirectUris: parsed.data.additionalRedirectUris,
        updatedAt:              new Date().toISOString(),
      },
    });
  });

  routes.delete("/:id/oauth/dev-redirect-uris", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    await appService.getApp(user.tenantId, c.req.param("id"));
    // Forward to Auth Service to remove dev redirect URIs
    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // Templates — G-075
  // ---------------------------------------------------------------------------

  // GET /templates — list all available templates
  routes.get("/templates", async (c) => {
    return c.json({
      data: ALL_TEMPLATES.map((t) => t.meta),
    });
  });

  // POST /from-template — create an app from a pre-built template
  routes.post("/from-template", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const body = await c.req.json().catch(() => null);
    const parsed = CreateAppFromTemplateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const template = findTemplateById(parsed.data.templateId);
    if (!template) {
      throw new ValidationError(`Unknown template "${parsed.data.templateId}".`, []);
    }

    // Create the app first
    const app = await appService.createApp(user.tenantId, user.userId, {
      name:       parsed.data.name,
      slug:       parsed.data.slug,
      accessMode: parsed.data.accessMode,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    });

    // Render the template files and write them to VFS
    const files = template.render(parsed.data.name, parsed.data.slug);
    for (const [filePath, content] of Object.entries(files)) {
      const contentHash = sha256hex(content);
      await fileRepo.create({
        app_id:       app.id,
        path:         filePath,
        content,
        content_hash: contentHash,
        updated_by:   user.userId,
      });
    }

    return c.json({ data: formatAppDetail(app) }, 201);
  });

  // ---------------------------------------------------------------------------
  // Type declarations — /apps/:id/type-declarations
  // Design spec §13.1
  // ---------------------------------------------------------------------------

  routes.get("/:id/type-declarations", async (c) => {
    const user = c.var.user;
    if (user === undefined) throw new UnauthorizedError("Authentication required.");

    const app = await appService.getApp(user.tenantId, c.req.param("id"));

    // Return accurate SDK type declarations matching actual app-sdk exports.
    // Full ontology-typed generation (per-entity types) requires Ontology
    // Service integration and is planned as a phase 2 enhancement.
    const declarations = [
      {
        filename: "oneplatform-sdk.d.ts",
        content: [
          `declare module "@oneplatform/app-sdk" {`,
          `  export function useUser(): { id: string; email: string | null; displayName: string; tenantId: string; roles: string[]; isGuest: boolean };`,
          `  export function useQuery<T>(entity: string, options?: QueryOptions): QueryResult<T>;`,
          `  export function useMutation<T>(entity: string): MutationResult<T>;`,
          `  export function useSubscription<T>(entity: string, options?: SubscriptionOptions): SubscriptionResult<T>;`,
          `  export function usePermission(action: string, resource: string): boolean;`,
          `  /** Returns [value, setValue]. Value persists per-user per-app in platform storage. */`,
          `  export function useAppStorage<T = unknown>(key: string): [T | null, (value: T) => Promise<void>];`,
          `  export function AppProvider(props: { children: React.ReactNode }): JSX.Element;`,
          `  export interface QueryOptions { filter?: Record<string, unknown>; limit?: number; cursor?: string; }`,
          `  export interface SubscriptionOptions { filter?: Record<string, unknown>; }`,
          `  export interface QueryResult<T> { data: T[]; isLoading: boolean; error: Error | null; refetch: () => void; }`,
          `  export interface MutationResult<T> {`,
          `    create(data: Partial<T>): Promise<T>;`,
          `    update(id: string, data: Partial<T>): Promise<T>;`,
          `    replace(id: string, data: T): Promise<T>;`,
          `    remove(id: string): Promise<void>;`,
          `    isLoading: boolean;`,
          `    error: Error | null;`,
          `  }`,
          `  export interface SubscriptionResult<T> { data: T[]; isConnected: boolean; error: Error | null; }`,
          `}`,
        ].join("\n"),
      },
    ];

    // Suppress unused variable warning — app is verified for access control
    void app;

    return c.json({ data: { declarations } });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Response formatters
// ---------------------------------------------------------------------------

function formatAppSummary(app: {
  id: string; tenant_id: string; name: string; slug: string;
  description: string | null; access_mode: string; current_build_id: string | null;
  created_at: Date; updated_at: Date;
}) {
  return {
    id:                  app.id,
    tenantId:            app.tenant_id,
    name:                app.name,
    slug:                app.slug,
    description:         app.description,
    accessMode:          app.access_mode,
    currentBuildId:      app.current_build_id,
    currentBuildVersion: null,  // populated via JOIN in a future enhancement
    createdAt:           app.created_at.toISOString(),
    updatedAt:           app.updated_at.toISOString(),
  };
}

function formatAppDetail(app: {
  id: string; tenant_id: string; name: string; slug: string;
  description: string | null; access_mode: string; current_build_id: string | null;
  allowed_modules: string[]; created_at: Date; updated_at: Date; created_by: string;
}) {
  return {
    id:             app.id,
    tenantId:       app.tenant_id,
    name:           app.name,
    slug:           app.slug,
    description:    app.description,
    accessMode:     app.access_mode,
    currentBuildId: app.current_build_id,
    currentBuild:   null,
    allowedModules: app.allowed_modules,
    createdAt:      app.created_at.toISOString(),
    updatedAt:      app.updated_at.toISOString(),
    createdBy:      app.created_by,
  };
}

function formatRole(role: {
  id: string; app_id: string; name: string;
  permissions: unknown; created_at: Date; updated_at: Date;
}) {
  return {
    id:          role.id,
    appId:       role.app_id,
    name:        role.name,
    permissions: role.permissions,
    createdAt:   role.created_at.toISOString(),
    updatedAt:   role.updated_at.toISOString(),
  };
}
