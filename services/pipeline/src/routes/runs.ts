import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import type { RunService } from "../services/run-service.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface RunRouteDeps {
  runService: RunService;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createRunRoutes(deps: RunRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { runService } = deps;

  // GET /api/v1/pipeline-runs/:runId
  routes.get("/:runId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const result = await runService.getRun(user.tenantId, c.req.param("runId"));
    return c.json({ data: result });
  });

  // POST /api/v1/pipeline-runs/:runId/cancel
  routes.post("/:runId/cancel", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    await runService.cancelRun(user.tenantId, c.req.param("runId"));
    return c.json({ data: { runId: c.req.param("runId"), status: "cancellation_requested" } });
  });

  // GET /api/v1/pipeline-runs/:runId/logs — SSE stream (design spec §11)
  routes.get("/:runId/logs", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const runId = c.req.param("runId");

    // Verify the run belongs to this tenant
    const { run } = await runService.getRun(user.tenantId, runId);

    // Parse cursor from query params or Last-Event-ID header (SSE reconnection)
    const lastEventIdHeader = c.req.header("Last-Event-ID");
    const lastEventIdQuery = c.req.query("lastEventId");
    const rawLastId = lastEventIdHeader ?? lastEventIdQuery;
    const lastSeenId = rawLastId !== undefined ? parseInt(rawLastId, 10) : 0;

    const follow = c.req.query("follow") !== "false"; // default true

    // SSE headers required by the spec and Nginx (design spec §11.3)
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    c.header("Connection", "keep-alive");

    // Use a ReadableStream to push SSE events to the client
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function sendEvent(id: number, eventName: string, data: unknown): void {
          const payload =
            `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        }

        let cursor = isNaN(lastSeenId) ? 0 : lastSeenId;

        // Terminal statuses — when the run reaches one of these and there are
        // no more log entries, we close the stream.
        const TERMINAL = new Set(["completed", "failed", "cancelled"]);

        // Initial check: if run is already terminal and follow=false, return existing logs
        // and close immediately.
        const initialLogs = await runService.getRunLogs(runId, cursor > 0 ? cursor : undefined);
        for (const entry of initialLogs) {
          sendEvent(entry.id, "log", {
            id: entry.id,
            runId: entry.run_id,
            ...(entry.step_id !== null ? { stepId: entry.step_id } : {}),
            level: entry.level,
            message: entry.message,
            ...(entry.details !== null ? { details: entry.details } : {}),
            createdAt: entry.created_at instanceof Date
              ? entry.created_at.toISOString()
              : String(entry.created_at),
          });
          cursor = entry.id;
        }

        // Re-fetch the run status rather than relying on the snapshot fetched
        // before log retrieval — the run may have transitioned to terminal
        // between the initial getRun call and the log fetch completing.
        let currentRunForCheck = run;
        try {
          const freshResult = await runService.getRun(user.tenantId, runId);
          currentRunForCheck = freshResult.run;
        } catch {
          // If we cannot refresh, fall back to the initial snapshot.
          // The polling loop will pick up the terminal status on the next tick.
        }

        if (!follow || TERMINAL.has(currentRunForCheck.status)) {
          if (TERMINAL.has(currentRunForCheck.status)) {
            const durationMs =
              currentRunForCheck.started_at !== null && currentRunForCheck.completed_at !== null
                ? currentRunForCheck.completed_at.getTime() - currentRunForCheck.started_at.getTime()
                : null;
            sendEvent(cursor, "done", {
              runId,
              status: currentRunForCheck.status,
              ...(durationMs !== null ? { durationMs } : {}),
            });
          }
          controller.close();
          return;
        }

        // Polling loop — 500ms interval per design spec §11.3
        let isStreamActive = true;

        // Stop the polling loop when the client disconnects. executions.ts uses
        // c.req.raw.signal the same way. Without this, a disconnected client leaks
        // a DB polling connection until the run reaches a terminal state.
        const abortSignal = c.req.raw.signal;
        const onAbort = (): void => {
          isStreamActive = false;
        };
        abortSignal.addEventListener("abort", onAbort, { once: true });

        while (isStreamActive) {
          await new Promise<void>((resolve) => setTimeout(resolve, 500));

          if (!isStreamActive) break;

          // Fetch new log entries since last cursor
          let newLogs;
          try {
            newLogs = await runService.getRunLogs(runId, cursor > 0 ? cursor : undefined);
          } catch {
            // DB error — stop streaming
            break;
          }

          for (const entry of newLogs) {
            sendEvent(entry.id, "log", {
              id: entry.id,
              runId: entry.run_id,
              ...(entry.step_id !== null ? { stepId: entry.step_id } : {}),
              level: entry.level,
              message: entry.message,
              ...(entry.details !== null ? { details: entry.details } : {}),
              createdAt: entry.created_at instanceof Date
                ? entry.created_at.toISOString()
                : String(entry.created_at),
            });
            cursor = entry.id;
          }

          // Check run status to determine if we should close the stream
          let currentRun;
          try {
            const result = await runService.getRun(user.tenantId, runId);
            currentRun = result.run;
          } catch {
            break;
          }

          if (TERMINAL.has(currentRun.status) && newLogs.length === 0) {
            const durationMs =
              currentRun.started_at !== null && currentRun.completed_at !== null
                ? currentRun.completed_at.getTime() - currentRun.started_at.getTime()
                : null;

            sendEvent(cursor, "done", {
              runId,
              status: currentRun.status,
              ...(durationMs !== null ? { durationMs } : {}),
            });

            isStreamActive = false;
          }
        }

        abortSignal.removeEventListener("abort", onAbort);
        controller.close();
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
