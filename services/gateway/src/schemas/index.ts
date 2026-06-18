import { z } from "zod";

// ---------------------------------------------------------------------------
// Webhook custom header validation
//
// Callers must not be able to inject platform headers (signature, delivery ID,
// etc.) via custom_headers — those are always set by the delivery worker.
// This denylist is case-insensitive to match HTTP header semantics.
// ---------------------------------------------------------------------------

// Headers that the delivery worker always sets and must not be overridden by
// caller-supplied custom_headers. Checked case-insensitively.
const DENIED_HEADER_KEYS = new Set([
  "x-oneplatform-signature",
  "x-oneplatform-event",
  "x-oneplatform-delivery",
  "x-oneplatform-timestamp",
  "content-type",
  "content-length",
  "host",
  "connection",
]);

function isDeniedHeaderKey(key: string): boolean {
  return DENIED_HEADER_KEYS.has(key.toLowerCase());
}

const customHeadersSchema = z.record(z.string()).superRefine((headers, ctx) => {
  for (const key of Object.keys(headers)) {
    if (isDeniedHeaderKey(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Custom header key "${key}" is reserved and cannot be overridden.`,
        path: [key],
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

export const createWebhookRequest = z.object({
  url: z.string().url().min(1),
  events: z.array(z.string().min(1)).min(1).max(50),
  description: z.string().max(512).optional(),
  headers: customHeadersSchema.optional(),
  enabled: z.boolean().default(true),
});

export const updateWebhookRequest = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string().min(1)).min(1).max(50).optional(),
  description: z.string().max(512).nullable().optional(),
  headers: customHeadersSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

export const listWebhooksQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const listDeliveriesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// SSE endpoint
// ---------------------------------------------------------------------------

export const sseQuery = z.object({
  events: z.string().min(1),
  "Last-Event-ID": z.string().optional(),
});

// ---------------------------------------------------------------------------
// GDPR data subject requests
// ---------------------------------------------------------------------------

export const gdprAccessRequestSchema = z.object({
  // Platform-admin submitting on behalf of a user must pass userId explicitly.
  // A regular user may omit it — the route infers it from the auth token.
  userId: z.string().uuid().optional(),
});

export const gdprDeletionRequestSchema = z.object({
  userId: z.string().uuid().optional(),
});

export const gdprExportRequestSchema = z.object({
  userId: z.string().uuid().optional(),
});

export const listGdprRequestsQuery = z.object({
  userId: z.string().uuid().optional(),
  status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// Data residency
// ---------------------------------------------------------------------------

const dataRegionEnum = z.enum([
  "US_EAST",
  "US_WEST",
  "EU_WEST",
  "EU_CENTRAL",
  "AP_SOUTHEAST",
  "AP_NORTHEAST",
]);

const storageClassEnum = z.enum(["standard", "reduced_redundancy", "archive"]);

const replicationPolicyEnum = z.enum(["single_region", "multi_az", "cross_region_backup"]);

const transferPolicyEnum = z.enum(["allow", "deny", "audit"]);

export const upsertResidencyPolicyRequest = z.object({
  region: dataRegionEnum,
  storageClass: storageClassEnum.optional(),
  replicationPolicy: replicationPolicyEnum.optional(),
});

export const createTransferRuleRequest = z.object({
  sourceRegion: dataRegionEnum,
  targetRegion: dataRegionEnum,
  policy: transferPolicyEnum,
  justificationRequired: z.boolean().optional(),
});

export const queryAuditLogParams = z.object({
  region: dataRegionEnum.optional(),
  service: z.string().min(1).optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// Rate limit config (admin)
// ---------------------------------------------------------------------------

export const updateRateLimitConfigRequest = z.object({
  tierName: z.enum(["standard", "pro", "enterprise", "custom"]),
  reqPerMinTenant: z.number().int().positive().optional(),
  reqPerMinApiKey: z.number().int().positive().optional(),
  burstMultiplier: z.number().min(1.0).max(10.0).optional(),
  burstDurationSec: z.number().int().min(1).max(60).optional(),
  apiKeyOverrides: z.record(z.object({
    req_per_min: z.number().int().positive(),
  })).optional(),
});
