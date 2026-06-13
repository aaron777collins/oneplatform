import { z } from "zod";

// ---------------------------------------------------------------------------
// Connector management
// ---------------------------------------------------------------------------

export const listConnectorsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  "filter[status][eq]": z.enum(["enabled", "disabled"]).optional(),
  "filter[pluginId][eq]": z.string().optional(),
  sort: z.string().default("-createdAt"),
});

// ---------------------------------------------------------------------------
// Cron expression validation
//
// A valid standard cron expression has exactly 5 space-separated fields:
//   minute  hour  day-of-month  month  day-of-week
//
// Each field is a non-empty sequence of digits, *, /, -, and comma characters.
// This regex is intentionally permissive for the character set within each
// field — semantic validation (e.g. minute 0-59) is left to the scheduler,
// which provides better error messages than a generic regex.
//
// Examples of valid values:
//   "0 9 * * 1-5"    — every weekday at 09:00
//   "*/15 * * * *"   — every 15 minutes
//   "0 0 1 * *"      — midnight on the 1st of every month
// ---------------------------------------------------------------------------

const CRON_FIELD_RE = /^(\*|[0-9][0-9,\-/]*)$/;

function isValidCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field) => CRON_FIELD_RE.test(field));
}

const cronExpressionSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidCronExpression, {
    message:
      "Invalid cron expression. Expected 5 space-separated fields: minute hour day-of-month month day-of-week. Example: '0 9 * * 1-5'",
  });

export const createConnectorRequest = z.object({
  pluginId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  config: z.record(z.unknown()),
  credentials: z.record(z.string()),
  syncMode: z.enum(["full", "incremental"]).default("incremental"),
  scheduleCron: cronExpressionSchema.optional(),
  isEnabled: z.boolean().default(true),
});

export const patchConnectorRequest = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  config: z.record(z.unknown()).optional(),
  credentials: z.record(z.string()).optional(),
  syncMode: z.enum(["full", "incremental"]).optional(),
  scheduleCron: cronExpressionSchema.nullable().optional(),
  isEnabled: z.boolean().optional(),
});

export const testConnectorRequest = z.object({
  config: z.record(z.unknown()).optional(),
  credentials: z.record(z.string()).optional(),
}).optional();

export const triggerSyncRequest = z.object({
  mode: z.enum(["full", "incremental"]).optional(),
  force: z.boolean().default(false),
}).optional();

export const listSyncsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  "filter[status][eq]": z.enum(["running", "success", "failed", "cancelled"]).optional(),
});

// ---------------------------------------------------------------------------
// Webhook receiver management
// ---------------------------------------------------------------------------

export const createWebhookReceiverRequest = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  connectorId: z.string().uuid().optional(),
  hmacAlgorithm: z.enum(["sha256", "sha512"]).default("sha256"),
  headerName: z.string().default("X-Webhook-Signature"),
});

export const patchWebhookReceiverRequest = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  connectorId: z.string().uuid().nullable().optional(),
  hmacAlgorithm: z.enum(["sha256", "sha512"]).optional(),
  headerName: z.string().optional(),
  isEnabled: z.boolean().optional(),
});

export const rotateWebhookSecretRequest = z.object({
  currentSecret: z.string().min(1),
});

export const listWebhookReceiversQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

export const uploadStatusQuery = z.object({
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Internal endpoints
// ---------------------------------------------------------------------------

export const registerConnectorPluginRequest = z.object({
  pluginId: z.string(),
  instanceId: z.string().uuid(),
  tenantId: z.string().uuid(),
  displayName: z.string().min(1).max(255),
  version: z.string().min(1),
  metadata: z.record(z.unknown()),
});

export const internalSyncRequest = z.object({
  connectorInstanceId: z.string().uuid(),
  syncMode: z.enum(["full", "incremental"]).optional(),
  tenantId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  stepId: z.string().optional(),
  waitForCompletion: z.boolean().default(true),
});
