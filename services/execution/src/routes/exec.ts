import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ExecutionNotFoundError } from "../services/errors.js";
import type { ExecutionService } from "../services/execution-service.js";
import type { SseManager } from "../services/sse-manager.js";
import {
  RunRequestSchema,
  ListExecutionsQuery,
} from "../schemas/index.js";

// ---------------------------------------------------------------------------
// User-facing execution routes — design spec §4.1 / §4.2 / §4.3
//
// POST /api/v1/exec/run        — 202 Accepted, returns executionId + logsUrl
// GET  /api/v1/exec/:id        — 200 OK, execution record
// GET  /api/v1/exec/:id/logs   — SSE stream of log lines
// ---------------------------------------------------------------------------

export interface ExecRouteDeps {
  executionService: ExecutionService;
  sseManager: SseManager;
}

export function createExecRoutes(
  deps: ExecRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { executionService, sseManager } = deps;

  // ---------------------------------------------------------------------------
  // POST /api/v1/exec/run
  // Requires scope: execution:run
  // ---------------------------------------------------------------------------

  routes.post("/run", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required.", requestId: c.var.requestId } },
        401,
      );
    }

    if (!user.scopes.includes("execution:run")) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Scope 'execution:run' is required.", requestId: c.var.requestId } },
        403,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body.",
            details: parsed.error.flatten(),
            requestId: c.var.requestId,
          },
        },
        400,
      );
    }

    const result = await executionService.runExecution(parsed.data, user);

    return c.json(
      {
        data: {
          executionId: result.executionId,
          status: result.status,
          logsUrl: result.logsUrl,
        },
      },
      202,
    );
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/exec/:id
  // Requires scope: execution:read
  // ---------------------------------------------------------------------------

  routes.get("/:id", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required.", requestId: c.var.requestId } },
        401,
      );
    }

    if (!user.scopes.includes("execution:read")) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Scope 'execution:read' is required.", requestId: c.var.requestId } },
        403,
      );
    }

    const id = c.req.param("id");

    // getExecution throws ExecutionNotFoundError when the record is absent or
    // belongs to a different tenant (responses are identical to avoid leaking
    // cross-tenant existence). Core's global error handler catches AppError
    // subclasses, but we handle this explicitly here to return the correct 404
    // body shape with the request ID already in scope.
    let execution: Awaited<ReturnType<typeof executionService.getExecution>>;
    try {
      execution = await executionService.getExecution(user.tenantId, id);
    } catch (err) {
      if (err instanceof ExecutionNotFoundError) {
        return c.json(
          { error: { code: "EXECUTION_NOT_FOUND", message: `Execution ${id} not found.`, requestId: c.var.requestId } },
          404,
        );
      }
      throw err;
    }

    return c.json({
      data: {
        id: execution.id,
        tenantId: execution.tenant_id,
        type: execution.type,
        status: execution.status,
        language: execution.language,
        startedAt: execution.started_at.toISOString(),
        completedAt: execution.completed_at?.toISOString() ?? null,
        durationMs: execution.duration_ms,
        memoryPeakMb: execution.memory_peak_mb,
        exitCode: execution.exit_code,
        errorCode: execution.error_code,
        errorMessage: execution.error_message,
        // errorStack intentionally omitted from user-facing response (spec §4.2)
        traceId: execution.trace_id,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/exec/:id/logs — SSE stream
  // Requires scope: execution:read
  // Design spec §4.3
  // ---------------------------------------------------------------------------

  routes.get("/:id/logs", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required.", requestId: c.var.requestId } },
        401,
      );
    }

    if (!user.scopes.includes("execution:read")) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Scope 'execution:read' is required.", requestId: c.var.requestId } },
        403,
      );
    }

    const id = c.req.param("id");

    // Validate execution belongs to this tenant
    let execution: Awaited<ReturnType<typeof executionService.getExecution>>;
    try {
      execution = await executionService.getExecution(user.tenantId, id);
    } catch (err) {
      if (err instanceof ExecutionNotFoundError) {
        return c.json(
          { error: { code: "EXECUTION_NOT_FOUND", message: `Execution ${id} not found.`, requestId: c.var.requestId } },
          404,
        );
      }
      throw err;
    }

    // Last-Event-ID support for stream resume — spec §4.3
    const lastEventId = c.req.header("Last-Event-ID");
    const lastLineNumber = lastEventId !== undefined ? parseInt(lastEventId, 10) : 0;
    const resumeFrom = Number.isFinite(lastLineNumber) ? lastLineNumber : 0;

    const subscription = sseManager.subscribe(execution.id, resumeFrom);

    // SSE stream — Readable stream response for Hono
    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        const iterator = subscription.asyncIterator();

        // Maximum SSE stream duration = execution timeout + 5s buffer (spec §4.3).
        // For simplicity we use a hard 305s limit covering the longest connector timeout.
        const streamTimeoutMs = 305_000;
        const streamTimer = setTimeout(() => {
          subscription.close();
        }, streamTimeoutMs);

        try {
          for await (const event of iterator) {
            let sseText: string;

            if (event.type === "log") {
              sseText = `event: log\ndata: ${JSON.stringify({
                line: event.line,
                level: event.level,
                stream: event.stream,
                message: event.message,
                timestamp: event.timestamp,
              })}\nid: ${event.line}\n\n`;
            } else if (event.type === "complete") {
              sseText = `event: complete\ndata: ${JSON.stringify({
                status: event.status,
                durationMs: event.durationMs,
                exitCode: event.exitCode,
              })}\n\n`;
            } else {
              // error event
              sseText = `event: error\ndata: ${JSON.stringify({
                status: event.status,
                errorCode: event.errorCode,
                errorMessage: event.errorMessage,
              })}\n\n`;
            }

            controller.enqueue(encoder.encode(sseText));

            // After terminal event, close the stream
            if (event.type === "complete" || event.type === "error") {
              break;
            }
          }
        } finally {
          clearTimeout(streamTimer);
          controller.close();
        }
      },
      cancel() {
        subscription.close();
      },
    });

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      },
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/exec  — list executions (paginated)
  // ---------------------------------------------------------------------------

  routes.get("/", async (c) => {
    const user = c.var.user;
    if (user === undefined) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required.", requestId: c.var.requestId } },
        401,
      );
    }

    if (!user.scopes.includes("execution:read")) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Scope 'execution:read' is required.", requestId: c.var.requestId } },
        403,
      );
    }

    const queryParsed = ListExecutionsQuery.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!queryParsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid query parameters.",
            details: queryParsed.error.flatten(),
            requestId: c.var.requestId,
          },
        },
        400,
      );
    }

    const rows = await executionService.listExecutions(user.tenantId, queryParsed.data);

    const data = rows.map((e) => ({
      id: e.id,
      tenantId: e.tenant_id,
      type: e.type,
      status: e.status,
      language: e.language,
      startedAt: e.started_at.toISOString(),
      completedAt: e.completed_at?.toISOString() ?? null,
      durationMs: e.duration_ms,
      memoryPeakMb: e.memory_peak_mb,
      exitCode: e.exit_code,
      errorCode: e.error_code,
      errorMessage: e.error_message,
      traceId: e.trace_id,
    }));

    const lastRow = rows[rows.length - 1];
    const nextCursor = rows.length === queryParsed.data.limit && lastRow !== undefined
      ? lastRow.id
      : null;

    return c.json({
      data,
      pagination: { nextCursor, total: null },
    });
  });

  return routes;
}
