import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const UUIDSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// RunRequestSchema — §4.1 POST /api/v1/exec/run (user-facing)
//
// Restricted to JS/TS only; code capped at 512 KB; timeout capped at 30 s.
// ---------------------------------------------------------------------------

export const RunRequestSchema = z.object({
  code: z.string().min(1).max(524_288),       // max 512 KB
  language: z.enum(["js", "ts"]),             // user-facing: JS/TS only
  timeout: z.number().int().min(1000).max(30_000).optional().default(30_000),
  context: z.record(z.unknown()).optional().default({}),
  label: z.string().max(128).optional(),
});

// ---------------------------------------------------------------------------
// InternalRunRequestSchema — §4.4 POST /internal/execution/run
//
// Service-to-service: supports all languages; code up to 10 MB; timeout up
// to 5 minutes. Files + entrypoint are used for app-build payloads.
// ---------------------------------------------------------------------------

export const InternalRunRequestSchema = z.object({
  tenantId: UUIDSchema,
  type: z.enum(["code", "connector-run", "app-build", "expression"]),
  language: z.enum(["js", "ts", "python", "go"]),
  code: z.string().min(1).max(10_485_760),    // max 10 MB
  timeout: z.number().int().min(1000).max(300_000),
  context: z.object({
    pluginId: UUIDSchema.optional(),
    pipelineId: UUIDSchema.optional(),
    pipelineRunId: UUIDSchema.optional(),
    // hookContext is set by Pipeline Service for hook executions; stripped before
    // passing to the sandbox so user code cannot detect it.
    hookContext: z.boolean().optional().default(false),
    traceId: z.string(),
    tenantId: UUIDSchema,
    label: z.string().max(128).optional(),
    ontologySnapshot: z.unknown().optional(),
    credentialBundleId: UUIDSchema.optional(),
  }),
  // app-build: pass source files as path → content map
  files: z
    .record(z.string().max(262_144))          // max 256 KB per file
    .refine((files) => Object.keys(files).length <= 100, {
      message: "files map may not exceed 100 entries",
    })
    .optional(),
  entrypoint: z.string().optional(),
});

// ---------------------------------------------------------------------------
// ConnectorRunRequestSchema — §4.5 POST /internal/execution/connector-run
// ---------------------------------------------------------------------------

export const ConnectorRunRequestSchema = z.object({
  tenantId: UUIDSchema,
  pluginId: UUIDSchema,
  method: z.enum(["fetchBatch", "push", "getSchema", "testConnection"]),
  cursor: z.string().nullable(),
  credentialBundleId: UUIDSchema,
  timeout: z.number().int().min(5000).max(300_000).default(300_000),
  traceId: z.string(),
  pipelineRunId: UUIDSchema.optional(),
});

// ---------------------------------------------------------------------------
// PluginDrainRequestSchema — §4.6 POST /internal/execution/plugin-drain
// ---------------------------------------------------------------------------

export const PluginDrainRequestSchema = z.object({
  pluginId: z.string(),                       // plugin manifest_id, not UUID
  tenantId: UUIDSchema.nullable(),            // null = platform-wide drain
  instanceId: UUIDSchema.optional(),
  gracePeriodMs: z.number().int().min(1000).max(120_000).default(60_000),
});

// ---------------------------------------------------------------------------
// CachePrefetchRequestSchema — §4.7 POST /internal/execution/plugin-cache-prefetch
// ---------------------------------------------------------------------------

export const CachePrefetchRequestSchema = z.object({
  pluginId: UUIDSchema,
  tenantId: UUIDSchema.optional(),            // absent = platform-wide (all tenants)
  version: z.string(),
});

// ---------------------------------------------------------------------------
// CacheInvalidateRequestSchema — §4.8 POST /internal/execution/plugin-cache-invalidate
// ---------------------------------------------------------------------------

export const CacheInvalidateRequestSchema = z.object({
  pluginId: z.string(),                       // plugin manifest_id, not UUID
  tenantId: UUIDSchema.nullable(),            // null = invalidate across all tenants
  newBundleVersion: z.string(),
});

// ---------------------------------------------------------------------------
// Response schemas — §4.1 / §4.2 / §4.5 / §4.6 / §4.7 / §4.8
// ---------------------------------------------------------------------------

// 202 response for async run endpoints (user-facing and internal /run)
export const RunResponseSchema = z.object({
  data: z.object({
    executionId: UUIDSchema,
    status: z.literal("pending"),
    logsUrl: z.string().url(),
  }),
});

// 200 response for GET /api/v1/exec/{id}
export const ExecutionResponseSchema = z.object({
  data: z.object({
    id: UUIDSchema,
    tenantId: UUIDSchema,
    type: z.enum(["code", "connector-run", "app-build", "expression", "plugin-drain"]),
    status: z.enum(["pending", "running", "success", "error", "timeout", "killed"]),
    language: z.enum(["js", "ts", "python", "go"]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    durationMs: z.number().int().nullable(),
    memoryPeakMb: z.number().nullable(),
    exitCode: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    // errorStack intentionally omitted — never returned to users (§14.4)
    traceId: z.string(),
  }),
});

// 200 response for synchronous connector-run
export const ConnectorRunResponseSchema = z.object({
  data: z.object({
    executionId: UUIDSchema,
    status: z.enum(["success", "error", "timeout"]),
    result: z.unknown().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    durationMs: z.number().int(),
    memoryPeakMb: z.number().nullable(),
  }),
});

export const PluginDrainResponseSchema = z.object({
  data: z.object({
    pluginId: UUIDSchema,
    drainedAt: z.string().datetime(),
    inflightAtDrainStart: z.number().int(),
    inflightAtCompletion: z.number().int(),
    killedExecutions: z.array(UUIDSchema),
  }),
});

export const CachePrefetchResponseSchema = z.object({
  data: z.object({
    pluginId: UUIDSchema,
    version: z.string(),
    cached: z.boolean(),
    bundleSizeBytes: z.number().int(),
    fetchDurationMs: z.number().int(),
  }),
});

export const CacheInvalidateResponseSchema = z.object({
  data: z.object({
    evicted: z.boolean(),
    pluginId: UUIDSchema,
  }),
});

// ---------------------------------------------------------------------------
// ListExecutionsQuery — paginated tenant-scoped execution history
// ---------------------------------------------------------------------------

export const ListExecutionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  "filter[status][eq]": z
    .enum(["pending", "running", "success", "error", "timeout", "killed"])
    .optional(),
  "filter[type][eq]": z
    .enum(["code", "connector-run", "app-build", "expression", "plugin-drain"])
    .optional(),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type RunRequest = z.infer<typeof RunRequestSchema>;
export type InternalRunRequest = z.infer<typeof InternalRunRequestSchema>;
export type ConnectorRunRequest = z.infer<typeof ConnectorRunRequestSchema>;
export type PluginDrainRequest = z.infer<typeof PluginDrainRequestSchema>;
export type CachePrefetchRequest = z.infer<typeof CachePrefetchRequestSchema>;
export type CacheInvalidateRequest = z.infer<typeof CacheInvalidateRequestSchema>;

export type RunResponse = z.infer<typeof RunResponseSchema>;
export type ExecutionResponse = z.infer<typeof ExecutionResponseSchema>;
export type ConnectorRunResponse = z.infer<typeof ConnectorRunResponseSchema>;
export type PluginDrainResponse = z.infer<typeof PluginDrainResponseSchema>;
export type CachePrefetchResponse = z.infer<typeof CachePrefetchResponseSchema>;
export type CacheInvalidateResponse = z.infer<typeof CacheInvalidateResponseSchema>;

export type ListExecutionsQueryInput = z.infer<typeof ListExecutionsQuery>;
