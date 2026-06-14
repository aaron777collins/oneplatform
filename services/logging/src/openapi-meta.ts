/**
 * Logging service OpenAPI 3.0.3 route metadata.
 *
 * The Logging service provides:
 *   - Structured log queries with cursor pagination and full-text search
 *   - Single log event retrieval by ID
 *   - Log export to JSONL or CSV (streaming, up to 7-day window)
 *   - Audit event queries (admin-only, tenant-scoped for non-admins)
 *
 * Routes excluded:
 *   All routes in internal.ts (/internal/*) are service-to-service routes
 *   (ingest + internal query with multi-service filtering) protected by
 *   X-Service-Token and are not public API.
 *   There are no health route files in the logging service.
 *
 * Scope requirements (enforced in route handlers):
 *   GET /api/v1/logs*            — logs:read or admin
 *   GET /api/v1/logs/export      — logs:export or admin
 *   GET /api/v1/audit-events     — audit:read or admin
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  logQuerySchema,
  auditQuerySchema,
  exportQuerySchema,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Inline response schemas
// ---------------------------------------------------------------------------

const logEntryResponse = z.object({
  id: z.string().uuid(),
  traceId: z.string(),
  service: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

const logListResponse = z
  .object({
    data: z.array(logEntryResponse),
    pagination: z.object({
      cursor: z.string().nullable(),
      limit: z.number().int(),
      hasMore: z.boolean(),
    }),
  })
  .describe("LogListResponse");

const logDetailResponse = z
  .object({ data: logEntryResponse })
  .describe("LogDetailResponse");

// Export returns a streaming response body (JSONL or CSV), not JSON
const logExportResponse = z
  .object({
    message: z
      .string()
      .describe(
        "Streaming JSONL or CSV body. Content-Type is application/x-ndjson or text/csv."
      ),
  })
  .describe("LogExportResponse");

const auditEntryResponse = z.object({
  id: z.string().uuid(),
  traceId: z.string(),
  actorId: z.string(),
  actorType: z.enum(["user", "service", "system"]),
  tenantId: z.string().uuid(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  result: z.enum(["success", "failure"]),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

const auditListResponse = z
  .object({
    data: z.array(auditEntryResponse),
    pagination: z.object({
      cursor: z.string().nullable(),
      limit: z.number().int(),
      hasMore: z.boolean(),
    }),
  })
  .describe("AuditListResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Logging Service",
    description:
      "Centralized structured log storage and query for OnePlatform. Provides log " +
      "queries with cursor pagination, full-text search, streaming JSONL/CSV export, " +
      "single-event retrieval, and immutable audit event queries for compliance.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    {
      name: "Logs",
      description:
        "Structured log query and export. Requires logs:read scope for query and " +
        "logs:export scope for the streaming export endpoint.",
    },
    {
      name: "Audit Events",
      description:
        "Immutable audit trail of all platform actions. Non-admin callers are automatically " +
        "scoped to their own tenant. Requires audit:read scope.",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // Logs
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/logs",
      summary: "Query logs",
      description:
        "Queries structured logs with optional filters (service, level, traceId, " +
        "full-text search, time range) and cursor-based pagination. " +
        "Requires logs:read or admin scope.",
      tags: ["Logs"],
      query: { schema: logQuerySchema },
      response: {
        200: logListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/logs/export",
      summary: "Export logs (streaming)",
      description:
        "Exports logs in JSONL (default) or CSV format as a streaming response. " +
        "Both 'from' and 'to' are required; the window cannot exceed 7 days " +
        "(OP_EXPORT_MAX_WINDOW_DAYS). Use multiple narrower requests for larger ranges. " +
        "Requires logs:export or admin scope.",
      tags: ["Logs"],
      query: { schema: exportQuerySchema },
      response: {
        200: logExportResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/logs/{id}",
      summary: "Get log event",
      description:
        "Returns a single log event by its UUID. Requires logs:read or admin scope.",
      tags: ["Logs"],
      params: { id: z.string().uuid().describe("LogEventId") },
      response: {
        200: logDetailResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Audit Events
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/audit-events",
      summary: "Query audit events",
      description:
        "Queries the immutable audit trail. Non-admin callers are scoped to their own " +
        "tenant regardless of the tenantId filter — the JWT tenant is authoritative. " +
        "Admin callers may query across tenants. Requires audit:read or admin scope.",
      tags: ["Audit Events"],
      query: { schema: auditQuerySchema },
      response: {
        200: auditListResponse,
      },
    },
  ],
};
