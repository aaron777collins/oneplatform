/**
 * Gateway service OpenAPI 3.0.3 route metadata.
 *
 * The Gateway is the single entry point for all external traffic. It handles:
 *   - Outbound webhook subscriptions (tenant-managed destinations)
 *   - Server-Sent Events for real-time platform event delivery
 *   - Dynamic entity data proxy (routes /api/v1/data/* to Ingestion)
 *   - Rate limit configuration for platform admins
 *   - Transparent reverse-proxy for all other /api/v1/* service routes
 *
 * Routes excluded:
 *   /healthz and /readyz are infrastructure health probes and are not public API.
 *   /internal/* routes are blocked at the gateway boundary (404) and never
 *   documented in the public spec.
 *
 *   The proxy wildcard (/* → upstream) is not documented here because it has
 *   no schema of its own — each upstream service owns its own meta file.
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  createWebhookRequest,
  updateWebhookRequest,
  listWebhooksQuery,
  listDeliveriesQuery,
  sseQuery,
  updateRateLimitConfigRequest,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Shared inline response schemas — shapes inferred from route handlers
// ---------------------------------------------------------------------------

const noContentResponse = z.object({}).describe("NoContentResponse");

const webhookResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      tenantId: z.string().uuid(),
      url: z.string().url(),
      events: z.array(z.string()),
      description: z.string().nullable(),
      enabled: z.boolean(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("WebhookResponse");

const webhookCreateResponse = z
  .object({
    data: z.object({
      id: z.string().uuid(),
      tenantId: z.string().uuid(),
      url: z.string().url(),
      events: z.array(z.string()),
      description: z.string().nullable(),
      enabled: z.boolean(),
      // secret is only returned on creation
      secret: z.string(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  })
  .describe("WebhookCreateResponse");

const webhookListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        tenantId: z.string().uuid(),
        url: z.string().url(),
        events: z.array(z.string()),
        description: z.string().nullable(),
        enabled: z.boolean(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
    ),
  })
  .describe("WebhookListResponse");

const webhookDeliveryListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        webhookId: z.string().uuid(),
        eventType: z.string(),
        statusCode: z.number().int().nullable(),
        success: z.boolean(),
        durationMs: z.number().int().nullable(),
        deliveredAt: z.string().datetime(),
      })
    ),
  })
  .describe("WebhookDeliveryListResponse");

const webhookTestResponse = z
  .object({
    data: z.object({
      delivered: z.boolean(),
      statusCode: z.number().int().nullable(),
      durationMs: z.number().int().nullable(),
    }),
  })
  .describe("WebhookTestResponse");

const webhookDeleteResponse = z
  .object({ data: z.object({ deleted: z.boolean() }) })
  .describe("WebhookDeleteResponse");

// SSE is a streaming response — document the connection as returning text/event-stream
const sseStreamResponse = z
  .object({
    message: z.string().describe("Server-Sent Events text/event-stream — not a JSON body"),
  })
  .describe("SseStreamResponse");

const rateLimitConfigResponse = z
  .object({
    data: z.object({
      tierName: z.enum(["standard", "pro", "enterprise", "custom"]),
      reqPerMinTenant: z.number().int().nullable(),
      reqPerMinApiKey: z.number().int().nullable(),
      burstMultiplier: z.number().nullable(),
      burstDurationSec: z.number().int().nullable(),
    }),
  })
  .describe("RateLimitConfigResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Gateway Service",
    description:
      "Single entry point for all OnePlatform external traffic. Handles outbound webhook " +
      "subscriptions, Server-Sent Event streams, dynamic entity data routing, and tenant " +
      "rate-limit configuration. All other /api/v1/* paths are transparently proxied to " +
      "the appropriate upstream service.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (direct)" }],
  tags: [
    {
      name: "Meta",
      description:
        "OpenAPI spec endpoints. Serve the pre-built merged spec and, for " +
        "authenticated requests, a tenant-specific overlay with concrete entity paths.",
    },
    {
      name: "Webhooks",
      description:
        "Outbound webhook subscriptions. The platform delivers events to registered URLs " +
        "with HMAC-SHA256 signatures.",
    },
    {
      name: "Events",
      description:
        "Server-Sent Event stream for real-time tenant-scoped event delivery.",
    },
    {
      name: "Data",
      description:
        "Dynamic entity data proxy. Routes requests to the Ingestion service for any " +
        "entity type defined in the tenant's ontology.",
    },
    {
      name: "Admin",
      description:
        "Rate limit configuration. Requires the admin scope (platform-admin role only).",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // OpenAPI spec endpoints (self-documenting)
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/openapi.json",
      summary: "Combined OpenAPI spec (tenant-specific)",
      description:
        "When called with a valid Bearer token, returns the platform OpenAPI spec " +
        "merged with auto-generated paths for the requesting tenant's ontology entity " +
        "types. Without authentication, returns the static base spec with generic " +
        "templated data paths. `op sdk generate` calls this endpoint with the stored " +
        "Bearer token to receive the full tenant-specific spec.",
      tags: ["Meta"],
      security: [],
      response: {
        200: z.unknown().describe("OpenAPI303Document"),
        503: z.object({ error: z.object({ code: z.string(), message: z.string() }) })
          .describe("SpecNotGeneratedError"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/openapi/base.json",
      summary: "Static base OpenAPI spec",
      description:
        "Returns the static merged OpenAPI spec for all platform-owned routes. " +
        "No tenant overlay applied. No authentication required. " +
        "Suitable for the Scalar API explorer in the docs site and for SDK " +
        "generation without tenant context.",
      tags: ["Meta"],
      security: [],
      response: {
        200: z.unknown().describe("OpenAPI303BaseDocument"),
        503: z.object({ error: z.object({ code: z.string(), message: z.string() }) })
          .describe("BaseSpecNotGeneratedError"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/openapi/{service}.json",
      summary: "Per-service OpenAPI spec",
      description:
        "Returns the OpenAPI spec for a single platform service. " +
        "Allowed values: gateway, auth, ingestion, ontology, pipeline, execution, " +
        "app, logging, plugin. No authentication required.",
      tags: ["Meta"],
      security: [],
      params: {
        service: z.enum([
          "gateway", "auth", "ingestion", "ontology", "pipeline",
          "execution", "app", "logging", "plugin",
        ]).describe("ServiceName"),
      },
      response: {
        200: z.unknown().describe("ServiceOpenAPI303Document"),
        404: z.object({ error: z.object({ code: z.string(), message: z.string() }) })
          .describe("UnknownServiceError"),
        503: z.object({ error: z.object({ code: z.string(), message: z.string() }) })
          .describe("ServiceSpecNotGeneratedError"),
      },
    },

    // -----------------------------------------------------------------------
    // Outbound Webhooks
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/webhooks",
      summary: "Create webhook",
      description:
        "Registers a new outbound webhook endpoint. The signing secret is returned " +
        "only on creation — store it securely. Custom headers cannot override " +
        "platform-set headers (x-oneplatform-signature, etc.).",
      tags: ["Webhooks"],
      body: {
        schema: createWebhookRequest.describe("CreateWebhookRequest"),
        contentType: "application/json",
      },
      response: {
        201: webhookCreateResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/webhooks",
      summary: "List webhooks",
      description: "Lists all outbound webhook subscriptions for the authenticated tenant.",
      tags: ["Webhooks"],
      query: { schema: listWebhooksQuery },
      response: {
        200: webhookListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/webhooks/{webhookId}",
      summary: "Get webhook",
      tags: ["Webhooks"],
      params: { webhookId: z.string().uuid().describe("WebhookId") },
      response: {
        200: webhookResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/webhooks/{webhookId}",
      summary: "Update webhook",
      description:
        "Partially updates a webhook. Passing null for description or headers clears " +
        "those fields. Events array is replaced in full when provided.",
      tags: ["Webhooks"],
      params: { webhookId: z.string().uuid().describe("PatchWebhookId") },
      body: {
        schema: updateWebhookRequest.describe("UpdateWebhookRequest"),
        contentType: "application/json",
      },
      response: {
        200: webhookResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/webhooks/{webhookId}",
      summary: "Delete webhook",
      description: "Permanently deletes a webhook subscription. Pending deliveries are abandoned.",
      tags: ["Webhooks"],
      params: { webhookId: z.string().uuid().describe("DeleteWebhookId") },
      response: {
        200: webhookDeleteResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/webhooks/{webhookId}/deliveries",
      summary: "List webhook deliveries",
      description:
        "Returns recent delivery attempts for a webhook, including status codes and " +
        "durations. Useful for debugging delivery failures.",
      tags: ["Webhooks"],
      params: { webhookId: z.string().uuid().describe("DeliveriesWebhookId") },
      query: { schema: listDeliveriesQuery },
      response: {
        200: webhookDeliveryListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/webhooks/{webhookId}/test",
      summary: "Send test delivery",
      description:
        "Fires a test event to the webhook URL to verify reachability and signature " +
        "validation before going live.",
      tags: ["Webhooks"],
      params: { webhookId: z.string().uuid().describe("TestWebhookId") },
      response: {
        200: webhookTestResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Server-Sent Events
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/events",
      summary: "Subscribe to platform events (SSE)",
      description:
        "Opens a persistent Server-Sent Events stream. The client receives events " +
        "matching the comma-separated patterns in the 'events' query parameter. " +
        "Supports Last-Event-ID for stream resume after reconnection. " +
        "Returns text/event-stream, not JSON.",
      tags: ["Events"],
      query: { schema: sseQuery },
      response: {
        200: sseStreamResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Dynamic Data Proxy
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/data/{entityType}",
      summary: "List entity records",
      description:
        "Proxies the request to the Ingestion service for any entity type defined in " +
        "the tenant's ontology. Query parameters are forwarded as-is. Returns 404 if " +
        "the entity type is not defined.",
      tags: ["Data"],
      params: { entityType: z.string().describe("EntityType") },
      response: {
        200: z
          .object({ data: z.array(z.record(z.unknown())) })
          .describe("EntityRecordListResponse"),
      },
    },

    // -----------------------------------------------------------------------
    // Admin: Rate Limiting
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/admin/rate-limits",
      summary: "Get rate limit configuration",
      description:
        "Returns the current rate limit tier configuration for the caller's tenant. " +
        "Requires the admin scope.",
      tags: ["Admin"],
      response: {
        200: rateLimitConfigResponse,
      },
    },
    {
      method: "PUT",
      path: "/api/v1/admin/rate-limits",
      summary: "Update rate limit configuration",
      description:
        "Replaces the rate limit configuration for the caller's tenant. Requires the " +
        "admin scope. Upserts — creates the record if it does not yet exist.",
      tags: ["Admin"],
      body: {
        schema: updateRateLimitConfigRequest.describe("UpdateRateLimitConfigRequest"),
        contentType: "application/json",
      },
      response: {
        200: rateLimitConfigResponse,
      },
    },
  ],
};
