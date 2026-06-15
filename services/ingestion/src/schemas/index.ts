import { z } from "zod";
import { cronExpressionSchema } from "@oneplatform/core";

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
