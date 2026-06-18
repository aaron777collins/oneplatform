import { z } from "zod";

// ---------------------------------------------------------------------------
// App management schemas — design spec §3.1
// ---------------------------------------------------------------------------

export const CreateAppSchema = z.object({
  name:        z.string().min(1).max(128),
  slug:        z.string().min(1).max(64).regex(
                 /^[a-z0-9-]+$/,
                 "slug must be lowercase alphanumeric with hyphens"
               ),
  description: z.string().max(512).optional(),
  accessMode:  z.enum(["platform-user", "public"]).default("platform-user"),
});

export type CreateAppInput = z.infer<typeof CreateAppSchema>;

export const PatchAppSchema = z.object({
  name:           z.string().min(1).max(128).optional(),
  slug:           z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  description:    z.string().max(512).nullable().optional(),
  accessMode:     z.enum(["platform-user", "public"]).optional(),
  allowedModules: z.array(z.string()).max(20).optional(),
}).strict();

export type PatchAppInput = z.infer<typeof PatchAppSchema>;

// ---------------------------------------------------------------------------
// VFS schemas — design spec §3.2
// ---------------------------------------------------------------------------

export const WriteFileSchema = z.object({
  content:     z.string().max(1_048_576),   // 1MB per file
  fileVersion: z.number().int().min(0),     // 0 = create new
});

export type WriteFileInput = z.infer<typeof WriteFileSchema>;

export const RenameFileSchema = z.object({
  fromPath:    z.string(),
  toPath:      z.string(),
  fileVersion: z.number().int().min(1),
});

export type RenameFileInput = z.infer<typeof RenameFileSchema>;

// ---------------------------------------------------------------------------
// Build pipeline schemas — design spec §3.3
// ---------------------------------------------------------------------------

export const TriggerBuildSchema = z.object({
  preview: z.boolean().default(false),
}).optional();

export type TriggerBuildInput = z.infer<typeof TriggerBuildSchema>;

// ---------------------------------------------------------------------------
// Deployment schemas — design spec §3.4
// ---------------------------------------------------------------------------

export const DeploySchema = z.object({
  buildId: z.string().uuid().optional(),
});

export type DeployInput = z.infer<typeof DeploySchema>;

export const RollbackSchema = z.object({
  buildId: z.string().uuid(),
});

export type RollbackInput = z.infer<typeof RollbackSchema>;

// ---------------------------------------------------------------------------
// Roles and sharing schemas — design spec §3.5
// ---------------------------------------------------------------------------

export const CreateRoleSchema = z.object({
  name: z.string().min(1).max(64),
  permissions: z.array(z.object({
    entity:  z.string(),
    actions: z.array(z.enum(["create", "read", "update", "delete", "admin"])),
  })).max(50),
});

export type CreateRoleInput = z.infer<typeof CreateRoleSchema>;

export const PatchRoleSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  permissions: z.array(z.object({
    entity:  z.string(),
    actions: z.array(z.enum(["create", "read", "update", "delete", "admin"])),
  })).max(50).optional(),
}).strict();

export type PatchRoleInput = z.infer<typeof PatchRoleSchema>;

export const ShareAppSchema = z.object({
  tenantId:    z.string().uuid(),
  mappedRoles: z.array(z.string()).min(1),
});

export type ShareAppInput = z.infer<typeof ShareAppSchema>;

// ---------------------------------------------------------------------------
// Environment variable schemas — design spec §3.6
// ---------------------------------------------------------------------------

export const EnvVarSchema = z.object({
  value:    z.string().max(4096),
  isSecret: z.boolean().default(false),
});

export type EnvVarInput = z.infer<typeof EnvVarSchema>;

// ---------------------------------------------------------------------------
// OAuth management schemas — design spec §3.7
// ---------------------------------------------------------------------------

export const PatchOAuthSchema = z.object({
  additionalRedirectUris: z.array(z.string().url()).max(10),
});

export type PatchOAuthInput = z.infer<typeof PatchOAuthSchema>;

// ---------------------------------------------------------------------------
// App generation schema — design spec §3.8
// ---------------------------------------------------------------------------

export const GenerateAppSchema = z.object({
  appName:     z.string().min(1).max(128),
  slug:        z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  entityTypes: z.array(z.string()).min(1).max(10),
});

export type GenerateAppInput = z.infer<typeof GenerateAppSchema>;

// ---------------------------------------------------------------------------
// BFF user storage schemas — design spec §3.9
// ---------------------------------------------------------------------------

export const StoragePutSchema = z.object({
  value: z.unknown(),
});

export type StoragePutInput = z.infer<typeof StoragePutSchema>;

// ---------------------------------------------------------------------------
// App-from-template schema — G-075
// ---------------------------------------------------------------------------

export const CreateAppFromTemplateSchema = z.object({
  templateId:  z.string().min(1),
  name:        z.string().min(1).max(128),
  slug:        z.string().min(1).max(64).regex(
                 /^[a-z0-9-]+$/,
                 "slug must be lowercase alphanumeric with hyphens"
               ),
  description: z.string().max(512).optional(),
  accessMode:  z.enum(["platform-user", "public"]).default("platform-user"),
});

export type CreateAppFromTemplateInput = z.infer<typeof CreateAppFromTemplateSchema>;

// ---------------------------------------------------------------------------
// Shared pagination query schema
// ---------------------------------------------------------------------------

export const PaginationSchema = z.object({
  cursor: z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(50),
});

export type PaginationInput = z.infer<typeof PaginationSchema>;
