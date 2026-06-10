import { z } from "zod";

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

export const createWebhookRequest = z.object({
  url: z.string().url().min(1),
  events: z.array(z.string().min(1)).min(1).max(50),
  description: z.string().max(512).optional(),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
});

export const updateWebhookRequest = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string().min(1)).min(1).max(50).optional(),
  description: z.string().max(512).nullable().optional(),
  headers: z.record(z.string()).nullable().optional(),
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
