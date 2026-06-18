import { z } from "zod";

// ---------------------------------------------------------------------------
// Log query — used by GET /api/v1/logs and POST /internal/logging/query
// ---------------------------------------------------------------------------

export const logQuerySchema = z.object({
  service: z.string().min(1).max(64).optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  traceId: z.string().max(128).optional(),
  search: z.string().max(512).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type LogQueryInput = z.infer<typeof logQuerySchema>;

// ---------------------------------------------------------------------------
// Audit query — used by GET /api/v1/audit-events
// ---------------------------------------------------------------------------

export const auditQuerySchema = z.object({
  actorId: z.string().max(255).optional(),
  actorType: z.enum(["user", "service", "system"]).optional(),
  tenantId: z.string().max(255).optional(),
  action: z.string().max(255).optional(),
  resourceType: z.string().max(255).optional(),
  resourceId: z.string().max(255).optional(),
  result: z.enum(["success", "failure"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type AuditQueryInput = z.infer<typeof auditQuerySchema>;

// ---------------------------------------------------------------------------
// Export query — extends log query with required time range and output format
// ---------------------------------------------------------------------------

export const exportQuerySchema = logQuerySchema
  .extend({
    // Required for export to prevent unbounded full-table scans
    from: z.string().datetime(),
    to: z.string().datetime(),
    format: z.enum(["jsonl", "csv"]).default("jsonl"),
  })
  .omit({ cursor: true });

export type ExportQueryInput = z.infer<typeof exportQuerySchema>;

// ---------------------------------------------------------------------------
// Internal log query — extends logQuerySchema with a services array parameter
// that the App Service uses to fetch logs for multiple services in one call
// ---------------------------------------------------------------------------

export const internalLogQuerySchema = logQuerySchema.extend({
  services: z.array(z.string().min(1).max(64)).max(9).optional(),
});

export type InternalLogQueryInput = z.infer<typeof internalLogQuerySchema>;

// ---------------------------------------------------------------------------
// Field audit query schemas (G-125)
// ---------------------------------------------------------------------------

export const fieldHistoryQuerySchema = z.object({
  fieldName: z.string().min(1).max(255).optional(),
  userId: z.string().max(255).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type FieldHistoryQueryInput = z.infer<typeof fieldHistoryQuerySchema>;

export const entityAccessQuerySchema = z.object({
  userId: z.string().max(255).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type EntityAccessQueryInput = z.infer<typeof entityAccessQuerySchema>;

// ---------------------------------------------------------------------------
// Direct ingest schema — for POST /internal/logging/ingest
// ---------------------------------------------------------------------------

export const ingestEventSchema = z.object({
  timestamp: z.string().datetime(),
  tenantId: z.string().default(""),
  traceId: z.string().default(""),
  service: z.string().min(1).max(64),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().max(32_768),
  metadata: z.record(z.unknown()).default({}),
});

export type IngestEventInput = z.infer<typeof ingestEventSchema>;
