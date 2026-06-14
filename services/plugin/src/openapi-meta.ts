/**
 * Plugin service OpenAPI 3.0.3 route metadata.
 *
 * The Plugin service manages the plugin registry lifecycle:
 *   - Plugin installation (multipart bundle upload, manifest validation)
 *   - Plugin listing and inspection
 *   - Plugin uninstallation (orphan guard)
 *   - Per-tenant plugin instances (enable, configure, patch)
 *   - Platform-admin-only upgrade and rollback
 *   - Hook chain query for a specific plugin and stage
 *
 * Routes excluded:
 *   All routes in internal.ts (/internal/*) are service-to-service routes
 *   protected by X-Service-Token (hook chain query, cache, drain-complete).
 *   /health.ts routes (/healthz, /readyz) are infrastructure probes.
 *
 * Authorization notes:
 *   GET /plugins, GET /plugins/:id          — public (no auth required)
 *   POST /plugins, DELETE /plugins/:id       — platform-admin role required
 *   POST/PATCH /plugins/:id/instances        — authenticated tenant user
 *   POST /plugins/:manifestId/upgrade        — platform-admin role required
 *   POST /plugins/:manifestId/rollback       — platform-admin role required
 *   GET /plugins/:id/hooks                   — authenticated tenant user
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  ListPluginsQuerySchema,
  UninstallQuerySchema,
  CreateInstanceSchema,
  PatchInstanceSchema,
  UpgradeSchema,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Inline response schemas
// ---------------------------------------------------------------------------

const pluginSummary = z.object({
  id: z.string().uuid(),
  manifestId: z.string(),
  name: z.string(),
  version: z.string(),
  type: z.enum(["connector", "transformer", "destination", "auth-provider", "widget"]),
  status: z.enum(["installed", "active", "disabled", "uninstalled"]),
  description: z.string(),
  author: z.string(),
  installedAt: z.string().datetime(),
  instanceCount: z.number().int(),
});

const pluginListResponse = z
  .object({
    items: z.array(pluginSummary),
    nextCursor: z.string().nullable(),
    total: z.number().int(),
  })
  .describe("PluginListResponse");

const pluginDetailResponse = z
  .object({
    id: z.string().uuid(),
    manifestId: z.string(),
    name: z.string(),
    version: z.string(),
    type: z.enum(["connector", "transformer", "destination", "auth-provider", "widget"]),
    status: z.enum(["installed", "active", "staged", "draining", "disabled", "uninstalled"]),
    manifest: z.record(z.unknown()),
    bundleSizeBytes: z.number().int(),
    installedAt: z.string().datetime(),
    installedBy: z.string().uuid(),
    gpgFingerprint: z.string().nullable(),
    approvedUrls: z.array(z.string()),
    instances: z.array(z.record(z.unknown())),
  })
  .describe("PluginDetailResponse");

const pluginInstallResponse = z
  .object({
    id: z.string().uuid(),
    manifestId: z.string(),
    name: z.string(),
    version: z.string(),
    type: z.enum(["connector", "transformer", "destination", "auth-provider", "widget"]),
    status: z.enum(["installed", "active"]),
    requiredApprovals: z
      .array(z.object({ urlPattern: z.string(), reason: z.string() }))
      .optional(),
  })
  .describe("PluginInstallResponse");

const pluginInstallApprovalResponse = z
  .object({
    status: z.literal("approval_required"),
    manifestId: z.string(),
    requiredApprovals: z.array(
      z.object({ urlPattern: z.string(), reason: z.string() })
    ),
    message: z.string(),
  })
  .describe("PluginInstallApprovalResponse");

const pluginUninstallResponse = z
  .object({
    uninstalled: z.boolean(),
    pluginId: z.string().uuid(),
    manifestId: z.string(),
  })
  .describe("PluginUninstallResponse");

const instanceSummary = z.object({
  instanceId: z.string().uuid(),
  pluginManifestId: z.string(),
  pluginId: z.string().uuid(),
  tenantId: z.string().uuid(),
  displayName: z.string(),
  config: z.record(z.unknown()),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const instanceListResponse = z
  .object({ items: z.array(instanceSummary) })
  .describe("PluginInstanceListResponse");

const instanceCreateResponse = z
  .object({
    instanceId: z.string().uuid(),
    pluginManifestId: z.string(),
    tenantId: z.string().uuid(),
    displayName: z.string(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .describe("PluginInstanceCreateResponse");

const instanceUpdateResponse = z
  .object({
    instanceId: z.string().uuid(),
    pluginManifestId: z.string(),
    pluginId: z.string().uuid(),
    tenantId: z.string().uuid(),
    displayName: z.string(),
    config: z.record(z.unknown()),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe("PluginInstanceUpdateResponse");

const upgradeResponse = z
  .object({
    manifestId: z.string(),
    fromVersion: z.string(),
    toVersion: z.string(),
    status: z.enum(["staged", "active"]),
    upgradedAt: z.string().datetime(),
  })
  .describe("PluginUpgradeResponse");

const rollbackResponse = z
  .object({
    manifestId: z.string(),
    rolledBackTo: z.string(),
    status: z.enum(["active"]),
    rolledBackAt: z.string().datetime(),
  })
  .describe("PluginRollbackResponse");

const hookChainResponse = z
  .object({
    hooks: z.array(
      z.object({
        pluginManifestId: z.string(),
        stage: z.string(),
        criticality: z.enum(["critical", "advisory"]),
        priority: z.number().int(),
        entrypoint: z.string(),
        timeout: z.number().int().nullable(),
      })
    ),
  })
  .describe("PluginHookChainResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Plugin Service",
    description:
      "Manages the OnePlatform plugin registry. Plugins extend the platform with custom " +
      "connectors, transformers, destinations, auth providers, and widgets. Includes " +
      "installation, instance management per tenant, versioned upgrades with drain-based " +
      "rollouts, and hook chain resolution.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    {
      name: "Plugins",
      description:
        "Plugin registry management. Installation and uninstallation require the " +
        "platform-admin role.",
    },
    {
      name: "Plugin Instances",
      description:
        "Per-tenant plugin instances. Creating an instance enables the plugin for a " +
        "specific tenant with custom configuration.",
    },
    {
      name: "Plugin Upgrades",
      description:
        "Versioned upgrade and rollback for installed plugins. Requires platform-admin role.",
    },
    {
      name: "Plugin Hooks",
      description:
        "Hook chain query for a plugin at a specific lifecycle stage.",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // Plugins
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/plugins",
      summary: "List plugins",
      description:
        "Lists all plugins in the registry. Supports filtering by type, status, and " +
        "full-text search (q). No authentication required.",
      tags: ["Plugins"],
      security: [],
      query: { schema: ListPluginsQuerySchema },
      response: {
        200: pluginListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/plugins",
      summary: "Install plugin",
      description:
        "Installs a plugin from a signed .oppkg bundle. The request must be " +
        "multipart/form-data with a 'bundle' file field. If the manifest declares " +
        "external URLs and approveUrls is false, the installation is paused and returns " +
        "202 with a list of URLs requiring approval. Resubmit with approveUrls=true to proceed. " +
        "Requires platform-admin role.",
      tags: ["Plugins"],
      body: {
        schema: z
          .object({
            bundle: z.any().describe("Plugin .oppkg bundle file"),
            approveUrls: z.coerce.boolean().default(false),
            platformWide: z.coerce.boolean().default(false),
          })
          .describe("InstallPluginRequest"),
        contentType: "multipart/form-data",
      },
      response: {
        201: pluginInstallResponse,
        202: pluginInstallApprovalResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/plugins/{id}",
      summary: "Get plugin",
      description:
        "Returns full plugin details including the manifest, approved URLs, and current " +
        "instances. No authentication required.",
      tags: ["Plugins"],
      security: [],
      params: { id: z.string().describe("PluginId") },
      response: {
        200: pluginDetailResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/plugins/{id}",
      summary: "Uninstall plugin",
      description:
        "Uninstalls a plugin. If active instances exist, pass confirmOrphan=true to " +
        "acknowledge that those instances will be orphaned. Requires platform-admin role.",
      tags: ["Plugins"],
      params: { id: z.string().describe("UninstallPluginId") },
      query: { schema: UninstallQuerySchema },
      response: {
        200: pluginUninstallResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Plugin Instances
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/plugins/{id}/instances",
      summary: "List plugin instances",
      description:
        "Lists instances of a plugin. Non-admin callers see only their own tenant's " +
        "instances. Platform-admin callers see all tenants.",
      tags: ["Plugin Instances"],
      params: { id: z.string().describe("InstanceListPluginId") },
      response: {
        200: instanceListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/plugins/{id}/instances",
      summary: "Create plugin instance",
      description:
        "Enables a plugin for the caller's tenant with the provided configuration.",
      tags: ["Plugin Instances"],
      params: { id: z.string().describe("CreateInstancePluginId") },
      body: {
        schema: CreateInstanceSchema.describe("CreatePluginInstanceRequest"),
        contentType: "application/json",
      },
      response: {
        201: instanceCreateResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/plugins/{id}/instances/{instanceId}",
      summary: "Update plugin instance",
      description:
        "Partially updates a plugin instance's display name, config, or enabled state.",
      tags: ["Plugin Instances"],
      params: {
        id: z.string().describe("PatchInstancePluginId"),
        instanceId: z.string().uuid().describe("PluginInstanceId"),
      },
      body: {
        schema: PatchInstanceSchema.describe("PatchPluginInstanceRequest"),
        contentType: "application/json",
      },
      response: {
        200: instanceUpdateResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Plugin Upgrades and Rollback
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/plugins/{manifestId}/upgrade",
      summary: "Upgrade plugin",
      description:
        "Initiates a version upgrade for an installed plugin using a drain-based rollout. " +
        "The new bundle is staged and existing executions are drained before the switch. " +
        "Requires platform-admin role.",
      tags: ["Plugin Upgrades"],
      params: { manifestId: z.string().describe("UpgradePluginManifestId") },
      body: {
        schema: UpgradeSchema.describe("PluginUpgradeRequest"),
        contentType: "application/json",
      },
      response: {
        200: upgradeResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/plugins/{manifestId}/rollback",
      summary: "Rollback plugin",
      description:
        "Rolls back a plugin to its previously active version. Requires platform-admin role.",
      tags: ["Plugin Upgrades"],
      params: { manifestId: z.string().describe("RollbackPluginManifestId") },
      response: {
        200: rollbackResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Plugin Hooks
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/plugins/{id}/hooks",
      summary: "Get hook chain for plugin",
      description:
        "Returns the ordered hook chain registered by this plugin for a specific lifecycle " +
        "stage (e.g. 'before:ingestion:batch'). The stage query parameter is required.",
      tags: ["Plugin Hooks"],
      params: { id: z.string().describe("HooksPluginId") },
      response: {
        200: hookChainResponse,
      },
    },
  ],
};
