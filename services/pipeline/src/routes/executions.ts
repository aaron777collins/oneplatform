// Execution status routes — real-time pipeline execution visualization.
//
// These routes sit under /api/v1/pipelines/:pipelineId/executions and provide:
//   GET  /                         list recent executions (history)
//   GET  /:executionId             get current execution status snapshot
//   GET  /:executionId/stream      SSE stream of step-level events
//
// The in-memory ExecutionTracker holds live state. History is kept in the same
// tracker after execution completes (up to DEFAULT_HISTORY_LIMIT per pipeline).
// For full run details and logs the caller should use the existing runs routes.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import type { ExecutionTracker } from "../services/execution-tracker.js";
import { PipelineNotFoundError } from "../services/errors.js";
import type { PipelineService } from "../services/pipeline-service.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface ExecutionRouteDeps {
  executionTracker: ExecutionTracker;
  pipelineService: PipelineService;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createExecutionRoutes(
  deps: ExecutionRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { executionTracker, pipelineService } = deps;

  // -------------------------------------------------------------------------
  // GET /api/v1/pipelines/:pipelineId/executions
  // List recent executions for the given pipeline (history from in-memory store).
  // Query params:
  //   limit — max number to return (1–100, default 20)
  // -------------------------------------------------------------------------

  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const pipelineId = c.req.param("pipelineId");
    if (pipelineId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing pipelineId path parameter." } }, 400);
    }

    // Verify the pipeline exists and belongs to this tenant before returning data.
    await pipelineService.getPipeline(user.tenantId, pipelineId);

    const rawLimit = c.req.query("limit");
    const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 20;

    if (isNaN(limit) || limit < 1 || limit > 100) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Query parameter 'limit' must be an integer between 1 and 100.",
          },
        },
        400,
      );
    }

    const executions = executionTracker.getExecutionHistory(pipelineId, limit);

    return c.json({ data: executions });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/pipelines/:pipelineId/executions/:executionId
  // Snapshot of the current execution state (step statuses + progress).
  // -------------------------------------------------------------------------

  routes.get("/:executionId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const pipelineId = c.req.param("pipelineId");
    const executionId = c.req.param("executionId");
    if (pipelineId === undefined || executionId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing path parameters." } }, 400);
    }

    // Tenant guard: verify the pipeline belongs to this tenant.
    await pipelineService.getPipeline(user.tenantId, pipelineId);

    const status = executionTracker.getExecutionStatus(executionId);
    if (status === null) {
      return c.json(
        {
          error: {
            code: "EXECUTION_NOT_FOUND",
            message: `Execution "${executionId}" was not found. It may have expired from the in-memory store.`,
          },
        },
        404,
      );
    }

    // Confirm the execution belongs to the requested pipeline.
    if (status.pipelineId !== pipelineId) {
      return c.json(
        {
          error: {
            code: "EXECUTION_NOT_FOUND",
            message: `Execution "${executionId}" does not belong to pipeline "${pipelineId}".`,
          },
        },
        404,
      );
    }

    return c.json({ data: status });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/pipelines/:pipelineId/executions/:executionId/stream
  //
  // SSE stream that emits step-level events as they occur.
  //
  // Event types:
  //   step:start       — a step transitioned to running
  //   step:complete    — a step completed, was skipped, or was cancelled
  //   step:error       — a step failed
  //   execution:complete — the whole pipeline finished (stream closes after this)
  //
  // If the execution is already terminal when the client connects, the handler
  // returns the final snapshot as a single execution:complete event then closes.
  // -------------------------------------------------------------------------

  routes.get("/:executionId/stream", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const pipelineId = c.req.param("pipelineId");
    const executionId = c.req.param("executionId");
    if (pipelineId === undefined || executionId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing path parameters." } }, 400);
    }

    // Tenant guard.
    await pipelineService.getPipeline(user.tenantId, pipelineId);

    const currentStatus = executionTracker.getExecutionStatus(executionId);
    if (currentStatus === null) {
      return c.json(
        {
          error: {
            code: "EXECUTION_NOT_FOUND",
            message: `Execution "${executionId}" was not found. It may have expired from the in-memory store.`,
          },
        },
        404,
      );
    }

    if (currentStatus.pipelineId !== pipelineId) {
      return c.json(
        {
          error: {
            code: "EXECUTION_NOT_FOUND",
            message: `Execution "${executionId}" does not belong to pipeline "${pipelineId}".`,
          },
        },
        404,
      );
    }

    // Capture the abort signal before entering the ReadableStream constructor so
    // it is accessible inside the cancel callback closure.
    const abortSignal = c.req.raw.signal;

    let unsubscribe: (() => void) | undefined;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        function sendEvent(eventType: string, data: unknown): void {
          const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        }

        // If the execution is already terminal, emit the final snapshot and close.
        // This handles the case where the SSE client reconnects after the run finished.
        const TERMINAL_STATUS = new Set(["completed", "failed"]);
        if (TERMINAL_STATUS.has(currentStatus.status)) {
          sendEvent("execution:complete", { executionId, status: currentStatus });
          controller.close();
          return;
        }

        // Send the current snapshot as an initial "execution:snapshot" event so
        // the client can render whatever steps have already completed before it
        // connected.
        sendEvent("execution:snapshot", currentStatus);

        // Subscribe to live events.
        unsubscribe = executionTracker.subscribe(executionId, (event) => {
          sendEvent(event.type, event);

          // Close the stream after the execution finishes.
          if (event.type === "execution:complete") {
            unsubscribe?.();
            controller.close();
          }
        });

        // Release the subscription immediately if the request was already aborted
        // before we finished setting up (race condition guard).
        if (abortSignal.aborted) {
          unsubscribe();
          unsubscribe = undefined;
        } else {
          abortSignal.addEventListener("abort", () => {
            unsubscribe?.();
            unsubscribe = undefined;
          }, { once: true });
        }
      },

      cancel() {
        // Called when the client disconnects before the execution:complete event
        // is emitted. Releasing the subscription prevents the tracker from holding
        // a reference to the closed controller indefinitely.
        unsubscribe?.();
        unsubscribe = undefined;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
      },
    });
  });

  return routes;
}
