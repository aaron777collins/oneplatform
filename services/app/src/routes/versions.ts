import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { BuildService } from "../services/build-service.js";
import type { AppService } from "../services/app-service.js";
import type { Redis } from "ioredis";
import { TriggerBuildSchema, PaginationSchema } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface VersionRouteDeps {
  appService:   AppService;
  buildService: BuildService;
  redis:        Redis;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createVersionRoutes(deps: VersionRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { buildService, redis } = deps;

  // POST /builds — trigger build
  routes.post("/builds", async (c) => {
    const user = c.var.user;
    if (user === undefined) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing appId in route." } }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = TriggerBuildSchema.safeParse(body);
    const preview = parsed.success ? (parsed.data?.preview ?? false) : false;

    const result = await buildService.triggerBuild(user.tenantId, appId, user.userId, { preview });

    return c.json({ data: result }, 202);
  });

  // GET /builds — list builds
  routes.get("/builds", async (c) => {
    const user = c.var.user;
    if (user === undefined) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing appId in route." } }, 400);
    }

    const query = PaginationSchema.safeParse({
      cursor: c.req.query("cursor"),
      limit:  c.req.query("limit"),
    });
    const { cursor, limit } = query.success ? query.data : { cursor: undefined, limit: 20 };
    const filterStatus = c.req.query("filter[status][eq]");

    const result = await buildService.listBuilds(
      user.tenantId, appId,
      {
        ...(cursor !== undefined ? { cursor } : {}),
        limit,
        ...(filterStatus !== undefined ? { filterStatus } : {}),
      }
    );

    return c.json({
      data: result.builds.map(formatBuildSummary),
      pagination: { nextCursor: result.nextCursor, total: result.total },
    });
  });

  // GET /builds/:buildId
  routes.get("/builds/:buildId", async (c) => {
    const user = c.var.user;
    if (user === undefined) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing appId in route." } }, 400);
    }

    const build = await buildService.getBuild(user.tenantId, appId, c.req.param("buildId"));
    return c.json({
      data: {
        ...formatBuildSummary(build),
        errorDetail: build.error_detail ?? null,
      },
    });
  });

  // GET /builds/:buildId/logs/stream — SSE build log stream
  routes.get("/builds/:buildId/logs/stream", async (c) => {
    const user = c.var.user;
    if (user === undefined) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing appId in route." } }, 400);
    }
    const buildId = c.req.param("buildId");

    const LOG_KEY     = `app:build-logs:${buildId}`;
    const LOG_CHANNEL = `app:build:${buildId}:log`;

    // Replay buffered log lines, then subscribe for live events
    const buffered = await redis.lrange(LOG_KEY, 0, -1);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const sendEvent = async (event: string, data: string): Promise<void> => {
      await writer.write(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
    };

    // Start SSE pipeline in the background
    void (async () => {
      try {
        // Replay buffered lines first
        for (const line of buffered) {
          if (line.includes('"type":"done"')) {
            const parsed = JSON.parse(line) as { buildId: string };
            // Fetch final status from DB
            await sendEvent("done", JSON.stringify({ buildId: parsed.buildId }));
            await writer.close();
            return;
          }
          await sendEvent("log", line);
        }

        // Subscribe for live events
        const sub = redis.duplicate();
        await sub.subscribe(LOG_CHANNEL);

        const timeout = setTimeout(() => {
          void sub.quit().then(() => writer.close());
        }, 5 * 60 * 1000);  // 5-minute SSE timeout

        // W12: clean up Redis subscriber when the client disconnects so we
        // don't leak subscriber connections for abandoned SSE streams.
        c.req.raw.signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          void sub.quit().catch(() => { /* best effort */ });
          void writer.close().catch(() => { /* best effort */ });
        });

        sub.on("message", (_channel: string, message: string) => {
          if (message.includes('"type":"done"')) {
            clearTimeout(timeout);
            void sendEvent("done", message).then(() => {
              void sub.quit().then(() => writer.close());
            });
          } else {
            void sendEvent("log", message);
          }
        });

        sub.on("error", () => {
          clearTimeout(timeout);
          void writer.close();
        });
      } catch {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      },
    });
  });

  // DELETE /builds/:buildId
  routes.delete("/builds/:buildId", async (c) => {
    const user = c.var.user;
    if (user === undefined) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);

    const appId = c.req.param("appId") ?? c.req.param("id");
    if (appId === undefined) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Missing appId in route." } }, 400);
    }

    await buildService.deleteBuild(user.tenantId, appId, c.req.param("buildId"));
    return new Response(null, { status: 204 });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Response formatters
// ---------------------------------------------------------------------------

function formatBuildSummary(build: {
  id: string; app_id: string; version_number: number;
  status: string; bundle_path: string | null; build_manifest: Record<string, unknown> | null;
  error_message: string | null; built_at: Date | null; built_by: string; created_at: Date;
}) {
  return {
    id:            build.id,
    appId:         build.app_id,
    versionNumber: build.version_number,
    status:        build.status,
    bundlePath:    build.bundle_path,
    buildManifest: build.build_manifest,
    errorMessage:  build.error_message,
    builtAt:       build.built_at?.toISOString() ?? null,
    builtBy:       build.built_by,
    createdAt:     build.created_at.toISOString(),
  };
}
