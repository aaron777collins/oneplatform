import { z } from "zod";

// ---------------------------------------------------------------------------
// Manifest sub-schemas — spec §4.3
// ---------------------------------------------------------------------------

export const HookDeclarationSchema = z.object({
  stage: z.string().regex(
    /^(before|after):\w[\w.]*(?::\w+)?$/,
    "Stage must be 'before:{name}' or 'after:{name}'"
  ),
  criticality: z.enum(["critical", "advisory"]),
  priority: z.number().int().min(0).max(999).default(100),
  timeout: z.number().int().min(1).max(300).optional(),
  entrypoint: z.string().min(1),
});

export const PluginManifestSchema = z.object({
  manifestVersion: z.literal("1"),
  id: z.string().regex(
    /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/,
    "Must be reverse-domain format"
  ),
  name: z.string().min(1).max(100),
  version: z.string().regex(
    /^\d+\.\d+\.\d+(?:[-+].+)?$/,
    "Must be SemVer"
  ),
  type: z.enum(["connector", "transformer", "destination", "auth-provider", "widget"]),
  description: z.string().max(200),
  author: z.string().min(1),
  supportUrl: z.string().url().optional(),
  homepageUrl: z.string().url().optional(),
  icon: z.string().optional(),
  minPlatformVersion: z.string().regex(/^\d+\.\d+\.\d+/, "Must be SemVer"),
  entrypoint: z.string().min(1),
  configSchema: z.record(z.unknown()),
  hooks: z.array(HookDeclarationSchema),
  requiredExternalUrls: z.array(z.string()),
  requiredApis: z.array(
    z.enum(["credentials", "fetch", "cache", "ontology", "tracing"])
  ),
  requiredCredentials: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      type: z.enum(["secret", "password", "token", "certificate"]),
      required: z.boolean(),
    })
  ),
  bundleChecksum: z.string().regex(
    /^[0-9a-f]{64}$/,
    "Must be 64-char hex SHA-256"
  ),
  gpgFingerprint: z.string().optional(),
  tags: z.array(z.string()).optional(),
  license: z.string().min(1),
  changelog: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Public API request schemas — spec §3.2
// ---------------------------------------------------------------------------

// POST /api/v1/plugins — multipart form fields (not the binary bundle)
export const InstallPluginSchema = z.object({
  approveUrls: z.coerce.boolean().default(false),
  platformWide: z.coerce.boolean().default(false),
});

// GET /api/v1/plugins — query parameters
export const ListPluginsQuerySchema = z.object({
  type: z.enum(["connector", "transformer", "destination", "auth-provider", "widget"]).optional(),
  status: z.enum(["installed", "active", "disabled", "uninstalled"]).optional(),
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// DELETE /api/v1/plugins/{id} — query parameter
export const UninstallQuerySchema = z.object({
  confirmOrphan: z.coerce.boolean().default(false),
});

// POST /api/v1/plugins/{id}/instances
export const CreateInstanceSchema = z.object({
  displayName: z.string().min(1).max(255),
  config: z.record(z.unknown()).default({}),
});

// PATCH /api/v1/plugins/{id}/instances/{instanceId}
export const PatchInstanceSchema = z
  .object({
    displayName: z.string().min(1).max(255).optional(),
    config: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// POST /api/v1/plugins/{manifestId}/upgrade
export const UpgradeSchema = z.object({
  toVersion: z.string(),
  scheduledAt: z.string().datetime().optional(),
});

// POST /api/v1/plugins/{manifestId}/rollback — no body required
export const RollbackSchema = z.object({}).optional();

// ---------------------------------------------------------------------------
// Internal endpoint schemas — spec §8
// ---------------------------------------------------------------------------

// PUT /internal/plugins/cache/:tenantId/:pluginId/:key
export const CachePutBodySchema = z.object({
  value: z.unknown(),
  ttlSeconds: z.number().int().min(1).max(86400).optional().default(3600),
});

// POST /internal/plugins/:manifestId/drain-complete
export const DrainCompleteRequestSchema = z.object({
  manifestId: z.string(),
  drainedAt: z.string().datetime(),
  inflightAtDrainStart: z.number().int(),
  inflightAtCompletion: z.number().int(),
  killedExecutions: z.array(z.string().uuid()),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type HookDeclaration = z.infer<typeof HookDeclarationSchema>;
export type InstallPluginInput = z.infer<typeof InstallPluginSchema>;
export type ListPluginsQuery = z.infer<typeof ListPluginsQuerySchema>;
export type CreateInstanceInput = z.infer<typeof CreateInstanceSchema>;
export type PatchInstanceInput = z.infer<typeof PatchInstanceSchema>;
export type UpgradeInput = z.infer<typeof UpgradeSchema>;
export type CachePutBody = z.infer<typeof CachePutBodySchema>;
export type DrainCompleteRequest = z.infer<typeof DrainCompleteRequestSchema>;

// Plugin types and statuses — used across layers
export type PluginType = "connector" | "transformer" | "destination" | "auth-provider" | "widget";
export type PluginStatus = "installed" | "active" | "staged" | "draining" | "disabled" | "uninstalled";
export type InstanceStatus = "enabled" | "disabling" | "disabled";
export type HookState = "inactive" | "active" | "staged" | "disabled";
