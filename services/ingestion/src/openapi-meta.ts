/**
 * Ingestion service OpenAPI 3.0.3 route metadata.
 *
 * The Ingestion service manages:
 *   - Connector lifecycle (CRUD, test, trigger sync)
 *   - Sync history and progress tracking
 *   - Inbound webhook receivers (authenticated management + anonymous receive)
 *   - File uploads (CSV, JSON, TSV, NDJSON)
 *
 * Routes excluded:
 *   All routes in internal.ts (/internal/*) are service-to-service routes
 *   protected by X-Service-Token and are not part of the public API.
 *   /health.ts routes (/healthz, /readyz) are infrastructure probes, not API.
 *
 *   POST /api/v1/webhooks/inbound/:id/receive is a public receive-only endpoint
 *   (no auth — HMAC verified by service). It is intentionally excluded from the
 *   public spec to prevent receiver ID enumeration by automated scanners.
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  listConnectorsQuery,
  createConnectorRequest,
  patchConnectorRequest,
  testConnectorRequest,
  triggerSyncRequest,
  listSyncsQuery,
  createWebhookReceiverRequest,
  patchWebhookReceiverRequest,
  rotateWebhookSecretRequest,
  listWebhookReceiversQuery,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Inline response schemas — shapes inferred from route handlers
// ---------------------------------------------------------------------------

const noContentResponse = z.object({}).describe("NoContentResponse");

const connectorResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      tenantId: z.string().uuid(),
      pluginId: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      syncMode: z.enum(["full", "incremental"]),
      scheduleCron: z.string().nullable(),
      isEnabled: z.boolean(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("ConnectorResponse");

const connectorListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        tenantId: z.string().uuid(),
        pluginId: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        syncMode: z.enum(["full", "incremental"]),
        scheduleCron: z.string().nullable(),
        isEnabled: z.boolean(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable() }),
  })
  .describe("ConnectorListResponse");

const connectorTestResponse = z
  .object({
    data: z.object({
      success: z.boolean(),
      message: z.string(),
      durationMs: z.number().int().nullable(),
    }),
  })
  .describe("ConnectorTestResponse");

const triggerSyncResponse = z
  .object({
    data: z.object({
      syncId: z.string().uuid(),
      status: z.literal("queued"),
      mode: z.enum(["full", "incremental"]),
    }),
  })
  .describe("TriggerSyncResponse");

const syncListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        connectorId: z.string().uuid(),
        status: z.enum(["running", "success", "failed", "cancelled"]),
        mode: z.enum(["full", "incremental"]),
        startedAt: z.string().datetime().nullable(),
        completedAt: z.string().datetime().nullable(),
        recordsProcessed: z.number().int().nullable(),
        errorMessage: z.string().nullable(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable() }),
  })
  .describe("SyncListResponse");

const syncProgressResponse = z
  .object({
    data: z.object({
      syncId: z.string().uuid(),
      status: z.enum(["queued", "running", "success", "failed", "cancelled"]),
      recordsProcessed: z.number().int(),
      recordsFailed: z.number().int(),
      percentComplete: z.number().nullable(),
    }),
  })
  .describe("SyncProgressResponse");

const webhookReceiverResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      tenantId: z.string().uuid(),
      name: z.string(),
      description: z.string().nullable(),
      connectorId: z.string().uuid().nullable(),
      hmacAlgorithm: z.enum(["sha256", "sha512"]),
      headerName: z.string(),
      isEnabled: z.boolean(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("WebhookReceiverResponse");

const webhookReceiverCreateResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      tenantId: z.string().uuid(),
      name: z.string(),
      description: z.string().nullable(),
      connectorId: z.string().uuid().nullable(),
      hmacAlgorithm: z.enum(["sha256", "sha512"]),
      headerName: z.string(),
      isEnabled: z.boolean(),
      // secret returned once at creation
      secret: z.string(),
      createdAt: z.string().datetime(),
    }),
  })
  .describe("WebhookReceiverCreateResponse");

const webhookReceiverListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        description: z.string().nullable(),
        connectorId: z.string().uuid().nullable(),
        hmacAlgorithm: z.enum(["sha256", "sha512"]),
        headerName: z.string(),
        isEnabled: z.boolean(),
        createdAt: z.string().datetime(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable() }),
  })
  .describe("WebhookReceiverListResponse");

const rotateSecretResponse = z
  .object({
    data: z.object({
      newSecret: z.string(),
      rotatedAt: z.string().datetime(),
    }),
  })
  .describe("RotateWebhookSecretResponse");

const uploadJobResponse = z
  .object({
    data: z.object({
      uploadJobId: z.string().uuid(),
      status: z.enum(["pending", "processing", "complete", "failed"]),
      filename: z.string(),
      contentType: z.string(),
      fileSizeBytes: z.number().int(),
    }),
  })
  .describe("UploadJobResponse");

const uploadStatusResponse = z
  .object({
    data: z.object({
      uploadJobId: z.string().uuid(),
      status: z.enum(["pending", "processing", "complete", "failed"]),
      filename: z.string(),
      fileSizeBytes: z.number().int(),
      rowsParsed: z.number().int(),
      rowsStaged: z.number().int(),
      rowsFailed: z.number().int(),
      percentComplete: z.number().int(),
      error: z.string().nullable(),
      inferredSchema: z.record(z.unknown()).nullable(),
      createdAt: z.string().datetime(),
      completedAt: z.string().datetime().nullable(),
    }),
  })
  .describe("UploadStatusResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Ingestion Service",
    description:
      "Manages data ingestion into OnePlatform. Provides connector lifecycle management " +
      "(create, configure, sync), inbound webhook receivers for third-party push events, " +
      "and file upload ingestion for CSV, JSON, TSV, and NDJSON files.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    {
      name: "Connectors",
      description:
        "Connector instances — configured plugin integrations that pull data from " +
        "external sources on a schedule or on-demand.",
    },
    {
      name: "Syncs",
      description: "Sync history and real-time progress tracking for connector sync jobs.",
    },
    {
      name: "Webhook Receivers",
      description:
        "Inbound webhook receiver management. Receivers accept push events from external " +
        "systems using HMAC-verified HTTP POST requests.",
    },
    {
      name: "File Uploads",
      description:
        "One-shot file ingestion for CSV, JSON, TSV, and NDJSON. Accepts up to 5GB. " +
        "Files are streamed to object storage and parsed asynchronously.",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // Connectors
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/connectors",
      summary: "List connectors",
      description:
        "Lists all connector instances for the authenticated tenant. Supports filtering " +
        "by status and plugin ID, and sorting.",
      tags: ["Connectors"],
      query: { schema: listConnectorsQuery },
      response: {
        200: connectorListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/connectors",
      summary: "Create connector",
      description:
        "Creates a new connector instance from an installed plugin. Credentials are " +
        "encrypted at rest using AES-256-GCM with the platform master key.",
      tags: ["Connectors"],
      body: {
        schema: createConnectorRequest.describe("CreateConnectorRequest"),
        contentType: "application/json",
      },
      response: {
        201: connectorResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/connectors/{id}",
      summary: "Get connector",
      tags: ["Connectors"],
      params: { id: z.string().uuid().describe("ConnectorId") },
      response: {
        200: connectorResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/connectors/{id}",
      summary: "Update connector",
      description:
        "Partially updates a connector. Passing null for description or scheduleCron " +
        "clears those fields. Credentials are re-encrypted when updated.",
      tags: ["Connectors"],
      params: { id: z.string().uuid().describe("PatchConnectorId") },
      body: {
        schema: patchConnectorRequest.describe("PatchConnectorRequest"),
        contentType: "application/json",
      },
      response: {
        200: connectorResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/connectors/{id}",
      summary: "Delete connector",
      description:
        "Deletes a connector and its stored credentials. Any in-flight sync job is " +
        "cancelled before deletion.",
      tags: ["Connectors"],
      params: { id: z.string().uuid().describe("DeleteConnectorId") },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/connectors/{id}/test",
      summary: "Test connector connection",
      description:
        "Runs a connection test against the external system using the stored (or " +
        "provided override) credentials. Does not ingest data.",
      tags: ["Connectors"],
      params: { id: z.string().uuid().describe("TestConnectorId") },
      body: {
        schema: (testConnectorRequest ?? z.object({})).describe("TestConnectorRequest"),
        contentType: "application/json",
        required: false,
      },
      response: {
        200: connectorTestResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/connectors/{id}/trigger",
      summary: "Trigger connector sync",
      description:
        "Enqueues an immediate sync job for the connector. Useful for ad-hoc pulls " +
        "outside the configured cron schedule.",
      tags: ["Connectors"],
      params: { id: z.string().uuid().describe("TriggerConnectorId") },
      body: {
        schema: (triggerSyncRequest ?? z.object({})).describe("TriggerSyncRequest"),
        contentType: "application/json",
        required: false,
      },
      response: {
        202: triggerSyncResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Syncs
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/connectors/{id}/syncs",
      summary: "List connector syncs",
      description:
        "Returns the sync history for a connector, newest first. Supports filtering " +
        "by status.",
      tags: ["Syncs"],
      params: { id: z.string().uuid().describe("SyncConnectorId") },
      query: { schema: listSyncsQuery },
      response: {
        200: syncListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/connectors/{id}/syncs/{syncId}/progress",
      summary: "Get sync progress",
      description:
        "Returns live progress for a running sync job, including records processed " +
        "and failure count.",
      tags: ["Syncs"],
      params: {
        id: z.string().uuid().describe("ProgressConnectorId"),
        syncId: z.string().uuid().describe("SyncId"),
      },
      response: {
        200: syncProgressResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Webhook Receivers
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/webhooks/inbound",
      summary: "Create webhook receiver",
      description:
        "Creates a new inbound webhook receiver. The HMAC signing secret is returned " +
        "only on creation — store it securely.",
      tags: ["Webhook Receivers"],
      body: {
        schema: createWebhookReceiverRequest.describe("CreateWebhookReceiverRequest"),
        contentType: "application/json",
      },
      response: {
        201: webhookReceiverCreateResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/webhooks/inbound",
      summary: "List webhook receivers",
      tags: ["Webhook Receivers"],
      query: { schema: listWebhookReceiversQuery },
      response: {
        200: webhookReceiverListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/webhooks/inbound/{id}",
      summary: "Get webhook receiver",
      tags: ["Webhook Receivers"],
      params: { id: z.string().uuid().describe("WebhookReceiverId") },
      response: {
        200: webhookReceiverResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/webhooks/inbound/{id}",
      summary: "Update webhook receiver",
      description:
        "Partially updates a webhook receiver. Passing null for description or " +
        "connectorId clears those fields.",
      tags: ["Webhook Receivers"],
      params: { id: z.string().uuid().describe("PatchWebhookReceiverId") },
      body: {
        schema: patchWebhookReceiverRequest.describe("PatchWebhookReceiverRequest"),
        contentType: "application/json",
      },
      response: {
        200: webhookReceiverResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/webhooks/inbound/{id}",
      summary: "Delete webhook receiver",
      tags: ["Webhook Receivers"],
      params: { id: z.string().uuid().describe("DeleteWebhookReceiverId") },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/webhooks/inbound/{id}/rotate-secret",
      summary: "Rotate webhook receiver secret",
      description:
        "Rotates the HMAC signing secret. Requires the current secret to prevent " +
        "accidental rotation. The new secret is returned once — store it securely.",
      tags: ["Webhook Receivers"],
      params: { id: z.string().uuid().describe("RotateSecretReceiverId") },
      body: {
        schema: rotateWebhookSecretRequest.describe("RotateWebhookSecretRequest"),
        contentType: "application/json",
      },
      response: {
        200: rotateSecretResponse,
      },
    },

    // -----------------------------------------------------------------------
    // File Uploads
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/uploads",
      summary: "Upload file for ingestion",
      description:
        "Accepts a multipart/form-data upload of a CSV, JSON, TSV, or NDJSON file " +
        "(up to 5GB). The file is streamed to object storage and parsed asynchronously. " +
        "Returns a job ID to track progress via GET /uploads/:id/status.",
      tags: ["File Uploads"],
      body: {
        schema: z
          .object({
            file: z.any().describe("File binary (multipart field)"),
            filename: z.string().optional(),
            connectorId: z.string().uuid().optional(),
          })
          .describe("FileUploadRequest"),
        contentType: "multipart/form-data",
      },
      response: {
        202: uploadJobResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/uploads/{id}/status",
      summary: "Get upload status",
      description:
        "Returns the current processing status of an upload job, including rows parsed, " +
        "staged, failed, and the inferred schema when available.",
      tags: ["File Uploads"],
      params: { id: z.string().uuid().describe("UploadJobId") },
      response: {
        200: uploadStatusResponse,
      },
    },
  ],
};
