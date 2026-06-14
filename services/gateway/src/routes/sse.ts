import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import { sseQuery } from "../schemas/index.js";
import type { SseService } from "../services/sse-service.js";

export interface SseRouteDeps {
  sseService: SseService;
  maxConnectionsPerKey: number;
}

export function createSseRoutes(deps: SseRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { sseService, maxConnectionsPerKey } = deps;
  // Moved inside factory (W10) so each Hono router instance has its own map.
  const activeConnectionsByKey = new Map<string, number>();

  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const query = sseQuery.safeParse(c.req.query());
    if (!query.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: query.error.flatten() },
      }, 400);
    }

    const connectionKey = user.userId ?? user.tenantId;
    const currentConnections = activeConnectionsByKey.get(connectionKey) ?? 0;
    if (currentConnections >= maxConnectionsPerKey) {
      return c.json({
        error: {
          code: "GATEWAY_SSE_CONNECTION_LIMIT",
          message: `Maximum ${maxConnectionsPerKey} concurrent SSE connections per API key.`,
        },
      }, 429);
    }
    const patterns = query.data.events.split(",").map((s) => s.trim()).filter(Boolean);
    if (patterns.length === 0) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "At least one event pattern is required in the 'events' parameter." },
      }, 400);
    }

    // Increment immediately after all validation passes, closing the TOCTOU
    // window — concurrent requests that pass the limit check simultaneously
    // must not both be allowed to open connections past the cap.
    activeConnectionsByKey.set(connectionKey, currentConnections + 1);

    const lastEventId = query.data["Last-Event-ID"] ?? c.req.header("Last-Event-ID");

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    return stream(c, async (streamInstance) => {
      let unsubscribe: (() => void) | null = null;

      try {
        if (lastEventId) {
          const replay = sseService.replay(user.tenantId, lastEventId, patterns);
          if (replay === "overflow") {
            await streamInstance.write(`event: overflow\ndata: {"message":"Event buffer overflow — some events may have been missed."}\n\n`);
          } else {
            for (const event of replay) {
              await streamInstance.write(formatSseEvent(event));
            }
          }
        }

        await streamInstance.write(`:ok\n\n`);

        unsubscribe = sseService.subscribe({
          tenantId: user.tenantId,
          patterns,
          write: (data) => {
            void streamInstance.write(data);
            return true;
          },
          close: () => {
            void streamInstance.close();
          },
        });

        await new Promise<void>((resolve) => {
          streamInstance.onAbort(() => resolve());
        });
      } finally {
        if (unsubscribe) unsubscribe();
        const count = activeConnectionsByKey.get(connectionKey) ?? 1;
        if (count <= 1) {
          activeConnectionsByKey.delete(connectionKey);
        } else {
          activeConnectionsByKey.set(connectionKey, count - 1);
        }
      }
    });
  });

  return routes;
}

function formatSseEvent(event: { eventId: string; eventType: string }): string {
  return [
    `id: ${event.eventId}`,
    `event: ${event.eventType}`,
    `data: ${JSON.stringify(event)}`,
    `retry: 5000`,
    "",
    "",
  ].join("\n");
}
