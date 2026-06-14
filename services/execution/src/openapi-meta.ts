/**
 * Execution service OpenAPI 3.0.3 route metadata.
 *
 * The Execution service runs sandboxed code on behalf of tenants. It manages:
 *   - User-facing code execution (JS/TS only, 30s timeout cap)
 *   - Execution history with status and metadata
 *   - SSE log streaming for live execution output
 *
 * Routes excluded:
 *   All routes in internal.ts (/internal/*) are service-to-service routes
 *   (Pipeline Service, Ingestion Service, Plugin Service) protected by
 *   X-Service-Token. They support additional languages (Python, Go), higher
 *   timeouts, and multi-file app-build payloads not exposed to end users.
 *   /health.ts routes (/healthz, /readyz) are infrastructure probes.
 *
 * Scope requirements (enforced in route handlers):
 *   POST /exec/run    — execution:run
 *   GET  /exec/*      — execution:read
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  RunRequestSchema,
  RunResponseSchema,
  ExecutionResponseSchema,
  ListExecutionsQuery,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Inline response schemas
// ---------------------------------------------------------------------------

// SSE stream for execution logs — content is text/event-stream
const execLogStreamResponse = z
  .object({
    message: z.string().describe("Server-Sent Events text/event-stream — not a JSON body"),
  })
  .describe("ExecLogStreamResponse");

const executionListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        tenantId: z.string().uuid(),
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
        traceId: z.string(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable(), total: z.null() }),
  })
  .describe("ExecutionListResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Execution Service",
    description:
      "Runs sandboxed code snippets on behalf of tenants. User-facing endpoints support " +
      "JavaScript and TypeScript with a 30-second timeout cap. Execution logs are streamed " +
      "in real time via Server-Sent Events. Error stacks are never returned to callers.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    {
      name: "Executions",
      description:
        "Code execution management. Submit snippets, poll status, and stream live logs. " +
        "Requires execution:run to submit and execution:read to query.",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // Code Execution
    // -----------------------------------------------------------------------
    {
      method: "POST",
      path: "/api/v1/exec/run",
      summary: "Submit code for execution",
      description:
        "Submits a JavaScript or TypeScript snippet for sandboxed execution. Returns " +
        "202 Accepted with an executionId immediately — the run is asynchronous. " +
        "Poll GET /exec/:id or stream GET /exec/:id/logs for results. " +
        "Requires execution:run scope.",
      tags: ["Executions"],
      body: {
        schema: RunRequestSchema.describe("RunRequest"),
        contentType: "application/json",
      },
      response: {
        202: RunResponseSchema.describe("RunResponse"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/exec",
      summary: "List executions",
      description:
        "Returns paginated execution history for the authenticated tenant. " +
        "Supports filtering by status and type. Requires execution:read scope.",
      tags: ["Executions"],
      query: { schema: ListExecutionsQuery },
      response: {
        200: executionListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/exec/{id}",
      summary: "Get execution",
      description:
        "Returns the status and metadata for a single execution. errorStack is never " +
        "returned to callers per security policy. Requires execution:read scope.",
      tags: ["Executions"],
      params: { id: z.string().uuid().describe("ExecutionId") },
      response: {
        200: ExecutionResponseSchema.describe("ExecutionResponse"),
      },
    },
    {
      method: "GET",
      path: "/api/v1/exec/{id}/logs",
      summary: "Stream execution logs (SSE)",
      description:
        "Opens a Server-Sent Events stream that emits log lines in real time as the " +
        "sandbox writes to stdout/stderr. Emits 'log', 'complete', and 'error' event types. " +
        "Supports Last-Event-ID for reconnection. Returns text/event-stream, not JSON. " +
        "Requires execution:read scope.",
      tags: ["Executions"],
      params: { id: z.string().uuid().describe("LogStreamExecutionId") },
      response: {
        200: execLogStreamResponse,
      },
    },
  ],
};
