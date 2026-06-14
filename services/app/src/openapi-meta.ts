/**
 * App service OpenAPI 3.0.3 route metadata.
 *
 * The App service manages the full lifecycle of platform-hosted React apps:
 *   - App CRUD and metadata management
 *   - Virtual File System (VFS) — per-app source files with optimistic locking
 *   - Build pipeline — trigger builds, list history, stream live build logs
 *   - Deployment — deploy/rollback to specific build IDs
 *   - App-level roles and cross-tenant sharing
 *   - Environment variables (plain and secret, AES-256 at rest)
 *   - OAuth redirect URI management
 *   - BFF (Backend-for-Frontend) endpoints used by the in-app SDK
 *
 * Routes excluded:
 *   All routes in internal.ts (/internal/*) are service-to-service routes
 *   protected by X-Service-Token.
 *   /health.ts routes (/healthz, /readyz) are infrastructure probes.
 *   /apps/:slug/* (app serving HTML shell + bundle) is a serving endpoint,
 *   not a management API endpoint — it is excluded from the spec.
 *   GenerateAppSchema is an internal scaffolding helper, also excluded.
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  CreateAppSchema,
  PatchAppSchema,
  WriteFileSchema,
  RenameFileSchema,
  TriggerBuildSchema,
  DeploySchema,
  RollbackSchema,
  CreateRoleSchema,
  PatchRoleSchema,
  ShareAppSchema,
  EnvVarSchema,
  PatchOAuthSchema,
  StoragePutSchema,
  PaginationSchema,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Inline response schemas
// ---------------------------------------------------------------------------

const noContentResponse = z.object({}).describe("NoContentResponse");

const appSummary = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  accessMode: z.enum(["platform-user", "public"]),
  currentBuildId: z.string().uuid().nullable(),
  currentBuildVersion: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const appDetail = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  accessMode: z.enum(["platform-user", "public"]),
  currentBuildId: z.string().uuid().nullable(),
  currentBuild: z.null(),
  allowedModules: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string().uuid(),
});

const appListResponse = z
  .object({
    data: z.array(appSummary),
    pagination: z.object({ nextCursor: z.string().nullable(), total: z.number().int().nullable() }),
  })
  .describe("AppListResponse");

const appDetailResponse = z
  .object({ data: appDetail })
  .describe("AppDetailResponse");

const appCreateResponse = z
  .object({ data: appDetail })
  .describe("AppCreateResponse");

const appUpdateResponse = z
  .object({ data: appDetail })
  .describe("AppUpdateResponse");

const fileMetaEntry = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  path: z.string(),
  contentHash: z.string(),
  fileVersion: z.number().int(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().uuid(),
  sizeBytes: z.number().int(),
});

const fileListResponse = z
  .object({ data: z.array(fileMetaEntry) })
  .describe("AppFileListResponse");

const fileContentResponse = z
  .object({
    data: z.object({
      path: z.string(),
      content: z.string(),
      contentHash: z.string(),
      fileVersion: z.number().int(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("AppFileContentResponse");

const fileWriteResponse = z
  .object({ data: fileMetaEntry })
  .describe("AppFileWriteResponse");

const fileRenameResponse = z
  .object({ data: fileMetaEntry })
  .describe("AppFileRenameResponse");

const buildSummary = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  versionNumber: z.number().int(),
  status: z.enum(["pending", "building", "success", "failed"]),
  bundlePath: z.string().nullable(),
  buildManifest: z.record(z.unknown()).nullable(),
  errorMessage: z.string().nullable(),
  builtAt: z.string().datetime().nullable(),
  builtBy: z.string().uuid(),
  createdAt: z.string().datetime(),
});

const buildTriggerResponse = z
  .object({ data: z.object({ buildId: z.string().uuid(), status: z.string() }) })
  .describe("BuildTriggerResponse");

const buildListResponse = z
  .object({
    data: z.array(buildSummary),
    pagination: z.object({ nextCursor: z.string().nullable(), total: z.number().int().nullable() }),
  })
  .describe("BuildListResponse");

const buildDetailResponse = z
  .object({
    data: buildSummary.extend({ errorDetail: z.string().nullable() }),
  })
  .describe("BuildDetailResponse");

// SSE stream for build logs
const buildLogStreamResponse = z
  .object({ message: z.string().describe("text/event-stream — not JSON") })
  .describe("BuildLogStreamResponse");

const deployResponse = z
  .object({
    data: z.object({
      deploymentId: z.string().uuid(),
      appId: z.string().uuid(),
      buildId: z.string().uuid(),
      deployedAt: z.string().datetime(),
    }),
  })
  .describe("DeployResponse");

const rollbackResponse = z
  .object({
    data: z.object({
      deploymentId: z.string().uuid(),
      appId: z.string().uuid(),
      buildId: z.string().uuid(),
      rolledBackAt: z.string().datetime(),
    }),
  })
  .describe("RollbackResponse");

const appRoleResponse = z.object({
  id: z.string().uuid(),
  appId: z.string().uuid(),
  name: z.string(),
  permissions: z.array(
    z.object({
      entity: z.string(),
      actions: z.array(z.enum(["create", "read", "update", "delete", "admin"])),
    })
  ),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const appRoleListResponse = z
  .object({ data: z.array(appRoleResponse) })
  .describe("AppRoleListResponse");

const appRoleCreateResponse = z
  .object({ data: appRoleResponse })
  .describe("AppRoleCreateResponse");

const appRoleUpdateResponse = z
  .object({ data: appRoleResponse })
  .describe("AppRoleUpdateResponse");

const shareResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      appId: z.string().uuid(),
      externalTenantId: z.string().uuid(),
      mappedRoles: z.array(z.string()),
      createdAt: z.string().datetime(),
      createdBy: z.string().uuid(),
    }),
  })
  .describe("AppShareResponse");

const envVarListResponse = z
  .object({
    data: z.array(
      z.object({
        key: z.string(),
        isSecret: z.boolean(),
        updatedAt: z.string().datetime(),
      })
    ),
  })
  .describe("EnvVarListResponse");

const envVarResponse = z
  .object({
    data: z.object({
      key: z.string(),
      isSecret: z.boolean(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("EnvVarResponse");

const oauthUpdateResponse = z
  .object({
    data: z.object({
      appId: z.string().uuid(),
      additionalRedirectUris: z.array(z.string().url()),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("OAuthUpdateResponse");

const typeDeclarationsResponse = z
  .object({
    data: z.object({
      declarations: z.array(
        z.object({
          filename: z.string(),
          content: z.string(),
        })
      ),
    }),
  })
  .describe("TypeDeclarationsResponse");

// BFF response schemas
const bffMeResponse = z
  .object({
    data: z.object({
      userId: z.string().uuid(),
      tenantId: z.string().uuid(),
      appId: z.string().uuid(),
      roles: z.array(z.string()),
      isGuest: z.boolean(),
    }),
  })
  .describe("BffMeResponse");

const bffPermissionsResponse = z
  .object({
    data: z.object({
      appId: z.string().uuid(),
      permissions: z.record(z.array(z.string())),
    }),
  })
  .describe("BffPermissionsResponse");

const bffDataResponse = z
  .object({ data: z.array(z.record(z.unknown())) })
  .describe("BffDataResponse");

const bffDataItemResponse = z
  .object({ data: z.record(z.unknown()) })
  .describe("BffDataItemResponse");

const bffStorageResponse = z
  .object({
    data: z.object({
      key: z.string(),
      value: z.unknown(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("BffStorageResponse");

const bffRuntimeConfigResponse = z
  .object({
    data: z.object({
      appId: z.string().uuid(),
      envVars: z.record(z.string()),
      allowedModules: z.array(z.string()),
    }),
  })
  .describe("BffRuntimeConfigResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "App Service",
    description:
      "Manages the full lifecycle of platform-hosted React applications. Provides a virtual " +
      "file system with optimistic locking, build pipeline with live log streaming, deployment " +
      "and rollback, app-level RBAC, cross-tenant sharing, and a BFF (Backend-for-Frontend) " +
      "layer used by the in-app SDK.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    {
      name: "Apps",
      description: "App CRUD and metadata management.",
    },
    {
      name: "Files",
      description:
        "Virtual File System for app source files. Each file has an optimistic lock version " +
        "to prevent concurrent write conflicts.",
    },
    {
      name: "Builds",
      description:
        "Build pipeline management. Builds bundle the app VFS files via the Execution " +
        "service and store artifacts in object storage.",
    },
    {
      name: "Deployments",
      description: "Deploy a build to production or roll back to a previous build.",
    },
    {
      name: "App Roles",
      description: "App-level RBAC roles and cross-tenant sharing grants.",
    },
    {
      name: "Env Vars",
      description: "Per-app environment variables. Secret values are AES-256 encrypted at rest.",
    },
    {
      name: "BFF",
      description:
        "Backend-for-Frontend endpoints consumed by the in-app SDK (@oneplatform/app-sdk). " +
        "These endpoints enforce app-level auth and proxy requests to internal services.",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // Apps
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/apps",
      summary: "List apps",
      tags: ["Apps"],
      query: { schema: PaginationSchema },
      response: {
        200: appListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/apps",
      summary: "Create app",
      tags: ["Apps"],
      body: {
        schema: CreateAppSchema.describe("CreateAppRequest"),
        contentType: "application/json",
      },
      response: {
        201: appCreateResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/apps/{id}",
      summary: "Get app",
      tags: ["Apps"],
      params: { id: z.string().uuid().describe("AppId") },
      response: {
        200: appDetailResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/apps/{id}",
      summary: "Update app",
      tags: ["Apps"],
      params: { id: z.string().uuid().describe("PatchAppId") },
      body: {
        schema: PatchAppSchema.describe("PatchAppRequest"),
        contentType: "application/json",
      },
      response: {
        200: appUpdateResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/apps/{id}",
      summary: "Delete app",
      description:
        "Permanently deletes the app and all associated files, builds, and deployments.",
      tags: ["Apps"],
      params: { id: z.string().uuid().describe("DeleteAppId") },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/apps/{id}/type-declarations",
      summary: "Get SDK type declarations",
      description:
        "Returns TypeScript declaration files for the @oneplatform/app-sdk, including " +
        "entity-typed hooks. Used by the in-browser editor for IntelliSense.",
      tags: ["Apps"],
      params: { id: z.string().uuid().describe("TypeDeclAppId") },
      response: {
        200: typeDeclarationsResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Virtual File System
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/apps/{id}/files",
      summary: "List app files",
      description: "Returns file metadata (path, hash, version) for all files in the app VFS.",
      tags: ["Files"],
      params: { id: z.string().uuid().describe("FilesAppId") },
      response: {
        200: fileListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/apps/{id}/files/{path}",
      summary: "Get file content",
      tags: ["Files"],
      params: {
        id: z.string().uuid().describe("FileContentAppId"),
        path: z.string().describe("FilePath"),
      },
      response: {
        200: fileContentResponse,
      },
    },
    {
      method: "PUT",
      path: "/api/v1/apps/{id}/files/{path}",
      summary: "Write file",
      description:
        "Creates or updates a file in the app VFS. Use fileVersion=0 to create a new file; " +
        "pass the current fileVersion for optimistic-lock updates (409 on conflict). " +
        "Maximum 1MB per file.",
      tags: ["Files"],
      params: {
        id: z.string().uuid().describe("WriteFileAppId"),
        path: z.string().describe("WriteFilePath"),
      },
      body: {
        schema: WriteFileSchema.describe("WriteFileRequest"),
        contentType: "application/json",
      },
      response: {
        200: fileWriteResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/apps/{id}/files/{path}",
      summary: "Delete file",
      description: "Deletes a file from the VFS. Cannot delete /src/index.tsx (the entrypoint).",
      tags: ["Files"],
      params: {
        id: z.string().uuid().describe("DeleteFileAppId"),
        path: z.string().describe("DeleteFilePath"),
      },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/apps/{id}/files/rename",
      summary: "Rename file",
      description:
        "Atomically renames a file in the VFS. Uses the fileVersion for optimistic locking.",
      tags: ["Files"],
      params: { id: z.string().uuid().describe("RenameFileAppId") },
      body: {
        schema: RenameFileSchema.describe("RenameFileRequest"),
        contentType: "application/json",
      },
      response: {
        200: fileRenameResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Builds
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/apps/{appId}/builds",
      summary: "Trigger app build",
      description:
        "Triggers a build of the current VFS snapshot. Set preview=true for a non-deployable " +
        "preview build that does not replace the active deployment.",
      tags: ["Builds"],
      params: { appId: z.string().uuid().describe("BuildAppId") },
      body: {
        schema: (TriggerBuildSchema ?? z.object({ preview: z.boolean().optional() })).describe(
          "TriggerBuildRequest"
        ),
        contentType: "application/json",
        required: false,
      },
      response: {
        202: buildTriggerResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/apps/{appId}/builds",
      summary: "List app builds",
      tags: ["Builds"],
      params: { appId: z.string().uuid().describe("BuildListAppId") },
      query: { schema: PaginationSchema },
      response: {
        200: buildListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/apps/{appId}/builds/{buildId}",
      summary: "Get build",
      tags: ["Builds"],
      params: {
        appId: z.string().uuid().describe("BuildDetailAppId"),
        buildId: z.string().uuid().describe("BuildId"),
      },
      response: {
        200: buildDetailResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/apps/{appId}/builds/{buildId}/logs/stream",
      summary: "Stream build logs (SSE)",
      description:
        "Opens an SSE stream that emits live build log lines. Replays buffered lines on " +
        "reconnect. Emits 'log' and 'done' event types. Returns text/event-stream.",
      tags: ["Builds"],
      params: {
        appId: z.string().uuid().describe("BuildLogAppId"),
        buildId: z.string().uuid().describe("BuildLogBuildId"),
      },
      response: {
        200: buildLogStreamResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/apps/{appId}/builds/{buildId}",
      summary: "Delete build",
      description:
        "Deletes a build record and its stored artifacts. Cannot delete the currently " +
        "active deployment build.",
      tags: ["Builds"],
      params: {
        appId: z.string().uuid().describe("DeleteBuildAppId"),
        buildId: z.string().uuid().describe("DeleteBuildId"),
      },
      response: {
        204: noContentResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Deployments
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/apps/{appId}/deploy",
      summary: "Deploy app",
      description:
        "Activates a build as the live deployment. If buildId is omitted, the latest " +
        "successful build is used.",
      tags: ["Deployments"],
      params: { appId: z.string().uuid().describe("DeployAppId") },
      body: {
        schema: DeploySchema.describe("DeployRequest"),
        contentType: "application/json",
      },
      response: {
        200: deployResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/apps/{appId}/rollback",
      summary: "Rollback deployment",
      description: "Reverts the active deployment to a specific previous build.",
      tags: ["Deployments"],
      params: { appId: z.string().uuid().describe("RollbackAppId") },
      body: {
        schema: RollbackSchema.describe("RollbackRequest"),
        contentType: "application/json",
      },
      response: {
        200: rollbackResponse,
      },
    },

    // -----------------------------------------------------------------------
    // App Roles and Sharing
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/apps/{id}/roles",
      summary: "List app roles",
      tags: ["App Roles"],
      params: { id: z.string().uuid().describe("AppRolesId") },
      response: {
        200: appRoleListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/apps/{id}/roles",
      summary: "Create app role",
      tags: ["App Roles"],
      params: { id: z.string().uuid().describe("CreateRoleAppId") },
      body: {
        schema: CreateRoleSchema.describe("CreateAppRoleRequest"),
        contentType: "application/json",
      },
      response: {
        201: appRoleCreateResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/apps/{id}/roles/{roleId}",
      summary: "Update app role",
      tags: ["App Roles"],
      params: {
        id: z.string().uuid().describe("UpdateRoleAppId"),
        roleId: z.string().uuid().describe("AppRoleId"),
      },
      body: {
        schema: PatchRoleSchema.describe("PatchAppRoleRequest"),
        contentType: "application/json",
      },
      response: {
        200: appRoleUpdateResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/apps/{id}/roles/{roleId}",
      summary: "Delete app role",
      tags: ["App Roles"],
      params: {
        id: z.string().uuid().describe("DeleteRoleAppId"),
        roleId: z.string().uuid().describe("DeleteAppRoleId"),
      },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/apps/{id}/share",
      summary: "Share app with tenant",
      description:
        "Grants an external tenant access to this app with role mappings.",
      tags: ["App Roles"],
      params: { id: z.string().uuid().describe("ShareAppId") },
      body: {
        schema: ShareAppSchema.describe("ShareAppRequest"),
        contentType: "application/json",
      },
      response: {
        201: shareResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Environment Variables
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/apps/{id}/env-vars",
      summary: "List env vars",
      description:
        "Lists all environment variables for the app. Secret values are not returned " +
        "— only the key and isSecret flag.",
      tags: ["Env Vars"],
      params: { id: z.string().uuid().describe("EnvVarsAppId") },
      response: {
        200: envVarListResponse,
      },
    },
    {
      method: "PUT",
      path: "/api/v1/apps/{id}/env-vars/{key}",
      summary: "Set env var",
      description:
        "Creates or replaces an environment variable. Secret values are AES-256-GCM " +
        "encrypted before storage.",
      tags: ["Env Vars"],
      params: {
        id: z.string().uuid().describe("SetEnvVarAppId"),
        key: z.string().describe("EnvVarKey"),
      },
      body: {
        schema: EnvVarSchema.describe("EnvVarRequest"),
        contentType: "application/json",
      },
      response: {
        200: envVarResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/apps/{id}/env-vars/{key}",
      summary: "Delete env var",
      tags: ["Env Vars"],
      params: {
        id: z.string().uuid().describe("DeleteEnvVarAppId"),
        key: z.string().describe("DeleteEnvVarKey"),
      },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/apps/{id}/oauth",
      summary: "Update OAuth redirect URIs",
      description:
        "Adds additional allowed redirect URIs for the app's OAuth client. " +
        "Dev redirect URIs are managed separately.",
      tags: ["Env Vars"],
      params: { id: z.string().uuid().describe("OAuthAppId") },
      body: {
        schema: PatchOAuthSchema.describe("PatchOAuthRequest"),
        contentType: "application/json",
      },
      response: {
        200: oauthUpdateResponse,
      },
    },

    // -----------------------------------------------------------------------
    // BFF — Backend for Frontend (used by @oneplatform/app-sdk)
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/bff/me",
      summary: "BFF: current user identity",
      description:
        "Returns the current user's identity and resolved app roles. " +
        "Requires X-App-Id header to identify which app context to resolve roles for.",
      tags: ["BFF"],
      response: {
        200: bffMeResponse,
      },
    },
    {
      method: "GET",
      path: "/bff/permissions",
      summary: "BFF: effective permissions",
      description:
        "Returns the aggregated permission map for the current user across all their " +
        "app roles. Used by the SDK's usePermission() hook.",
      tags: ["BFF"],
      response: {
        200: bffPermissionsResponse,
      },
    },
    {
      method: "GET",
      path: "/bff/data/{entity}",
      summary: "BFF: list entity records",
      description:
        "Proxies a data read request through app-level RBAC to the Execution service. " +
        "Requires X-App-Id header.",
      tags: ["BFF"],
      params: { entity: z.string().describe("BffEntity") },
      response: {
        200: bffDataResponse,
      },
    },
    {
      method: "POST",
      path: "/bff/data/{entity}",
      summary: "BFF: create entity record",
      tags: ["BFF"],
      params: { entity: z.string().describe("BffCreateEntity") },
      body: {
        schema: z.record(z.unknown()).describe("BffEntityRecord"),
        contentType: "application/json",
      },
      response: {
        201: bffDataItemResponse,
      },
    },
    {
      method: "POST",
      path: "/bff/data/{entity}/bulk",
      summary: "BFF: bulk create entity records",
      tags: ["BFF"],
      params: { entity: z.string().describe("BffBulkEntity") },
      body: {
        schema: z.object({ records: z.array(z.record(z.unknown())) }).describe("BffBulkCreateRequest"),
        contentType: "application/json",
      },
      response: {
        201: bffDataResponse,
      },
    },
    {
      method: "PATCH",
      path: "/bff/data/{entity}/{id}",
      summary: "BFF: partial update entity record",
      tags: ["BFF"],
      params: {
        entity: z.string().describe("BffPatchEntity"),
        id: z.string().describe("BffPatchItemId"),
      },
      body: {
        schema: z.record(z.unknown()).describe("BffPatchEntityRecord"),
        contentType: "application/json",
      },
      response: {
        200: bffDataItemResponse,
      },
    },
    {
      method: "PUT",
      path: "/bff/data/{entity}/{id}",
      summary: "BFF: replace entity record",
      tags: ["BFF"],
      params: {
        entity: z.string().describe("BffReplaceEntity"),
        id: z.string().describe("BffReplaceItemId"),
      },
      body: {
        schema: z.record(z.unknown()).describe("BffReplaceEntityRecord"),
        contentType: "application/json",
      },
      response: {
        200: bffDataItemResponse,
      },
    },
    {
      method: "DELETE",
      path: "/bff/data/{entity}/{id}",
      summary: "BFF: delete entity record",
      tags: ["BFF"],
      params: {
        entity: z.string().describe("BffDeleteEntity"),
        id: z.string().describe("BffDeleteItemId"),
      },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "GET",
      path: "/bff/storage/{key}",
      summary: "BFF: read user storage",
      description:
        "Reads a per-user per-app storage value. Used by the SDK's useAppStorage() hook.",
      tags: ["BFF"],
      params: { key: z.string().describe("BffStorageKey") },
      response: {
        200: bffStorageResponse,
      },
    },
    {
      method: "PUT",
      path: "/bff/storage/{key}",
      summary: "BFF: write user storage",
      description:
        "Writes a per-user per-app storage value. Maximum 64KB per value.",
      tags: ["BFF"],
      params: { key: z.string().describe("BffWriteStorageKey") },
      body: {
        schema: StoragePutSchema.describe("BffStoragePutRequest"),
        contentType: "application/json",
      },
      response: {
        200: bffStorageResponse,
      },
    },
    {
      method: "DELETE",
      path: "/bff/storage/{key}",
      summary: "BFF: delete user storage",
      tags: ["BFF"],
      params: { key: z.string().describe("BffDeleteStorageKey") },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "GET",
      path: "/bff/runtime-config",
      summary: "BFF: runtime configuration",
      description:
        "Returns non-secret env vars and allowed modules for the app. Used by the SDK " +
        "to initialise without additional round-trips.",
      tags: ["BFF"],
      response: {
        200: bffRuntimeConfigResponse,
      },
    },
  ],
};
