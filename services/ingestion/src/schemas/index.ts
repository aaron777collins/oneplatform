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
// Each field is validated both structurally (allowed syntax) and semantically
// (numeric values must fall within the field's accepted range). This catches
// expressions like "99 99 99 99 99" or "0 25 * * *" that are syntactically
// plausible but would fail or silently misbehave at runtime.
//
// Supported syntax per field:
//   *           — any value
//   */n         — step (e.g. */15 means every 15 units)
//   n           — exact value
//   n-m         — range
//   n,m,...     — list of exact values or ranges
//
// Field ranges:
//   minute       0–59
//   hour         0–23
//   day-of-month 1–31
//   month        1–12
//   day-of-week  0–7  (0 and 7 are both Sunday, per POSIX cron)
//
// Examples of valid values:
//   "0 9 * * 1-5"    — every weekday at 09:00
//   "*/15 * * * *"   — every 15 minutes
//   "0 0 1 * *"      — midnight on the 1st of every month
// ---------------------------------------------------------------------------

interface CronFieldSpec {
  min: number;
  max: number;
}

// Ordered to match the 5 cron fields left-to-right.
const CRON_FIELD_SPECS: CronFieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7  }, // day-of-week (0 and 7 both represent Sunday)
];

/**
 * Validate a single numeric token (after splitting on commas) against a field's
 * allowed range. Handles plain integers, step expressions (e.g. *\/15), and
 * hyphenated ranges (e.g. 1-5).
 */
function isCronTokenValid(token: string, spec: CronFieldSpec): boolean {
  // Wildcard — always valid.
  if (token === "*") return true;

  // Step expression: either "*/n" or "base/n"
  if (token.includes("/")) {
    const [base, stepStr, ...extra] = token.split("/");
    if (extra.length > 0) return false; // more than one slash is illegal
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step < 1) return false;
    // The base may be "*" or a plain integer within range.
    if (base !== "*") {
      const baseNum = Number(base);
      if (!Number.isInteger(baseNum) || baseNum < spec.min || baseNum > spec.max) return false;
    }
    return true;
  }

  // Hyphenated range: "n-m"
  if (token.includes("-")) {
    const [startStr, endStr, ...extra] = token.split("-");
    if (extra.length > 0) return false; // more than one hyphen is illegal
    const start = Number(startStr);
    const end = Number(endStr);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < spec.min || start > spec.max) return false;
    if (end < spec.min || end > spec.max) return false;
    if (start > end) return false; // inverted range
    return true;
  }

  // Plain integer.
  const n = Number(token);
  return Number.isInteger(n) && n >= spec.min && n <= spec.max;
}

function isValidCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  return fields.every((field, index) => {
    const spec = CRON_FIELD_SPECS[index];
    // Guard: spec is always defined because we checked fields.length === 5 above.
    if (!spec) return false;

    // A field may be a comma-separated list; each token is validated independently.
    const tokens = field.split(",");
    if (tokens.length === 0 || tokens.some((t) => t === "")) return false;
    return tokens.every((token) => isCronTokenValid(token, spec));
  });
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
