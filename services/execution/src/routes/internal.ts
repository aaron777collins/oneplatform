import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { ExecutionService } from "../services/execution-service.js";
import {
  InternalRunRequestSchema,
  ConnectorRunRequestSchema,
  PluginDrainRequestSchema,
  CachePrefetchRequestSchema,
  CacheInvalidateRequestSchema,
} from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Internal service-to-service routes — design spec §4.4 – §4.8
//
// All routes require a valid service token (isService = true).
// Service RBAC is enforced by the serviceAuthMiddleware in the core library.
//
// POST /internal/execution/run                    — async execution (202)
// POST /internal/execution/connector-run          — synchronous connector invocation (200)
// POST /internal/execution/plugin-drain           — graceful plugin shutdown (200)
// POST /internal/execution/plugin-cache-prefetch  — bundle pre-warming (200)
// POST /internal/execution/plugin-cache-invalidate — cache eviction (200)
// ---------------------------------------------------------------------------

export interface InternalRouteDeps {
  executionService: ExecutionService;
}

export function createInternalRoutes(
  deps: InternalRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { executionService } = deps;

  // ---------------------------------------------------------------------------
  // POST /internal/execution/run
  // ---------------------------------------------------------------------------

  routes.post("/execution/run", async (c) => {
    if (c.var.user?.isService !== true) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Service token required.", requestId: c.var.requestId } },
        403,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = InternalRunRequestSchema.safeParse(body);
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

    const result = await executionService.runInternalExecution(parsed.data);

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
  // POST /internal/execution/connector-run
  // Synchronous — waits for completion (spec §4.5)
  // ---------------------------------------------------------------------------

  routes.post("/execution/connector-run", async (c) => {
    if (c.var.user?.isService !== true) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Service token required.", requestId: c.var.requestId } },
        403,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = ConnectorRunRequestSchema.safeParse(body);
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

    const result = await executionService.runConnectorExecution(parsed.data);

    return c.json({
      data: {
        executionId: result.executionId,
        status: result.status,
        result: result.result,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        durationMs: result.durationMs,
        memoryPeakMb: result.memoryPeakMb,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/execution/plugin-drain
  // ---------------------------------------------------------------------------

  routes.post("/execution/plugin-drain", async (c) => {
    if (c.var.user?.isService !== true) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Service token required.", requestId: c.var.requestId } },
        403,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = PluginDrainRequestSchema.safeParse(body);
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

    const result = await executionService.drainPlugin(parsed.data);

    return c.json({
      data: {
        pluginId: result.pluginId,
        drainedAt: result.drainedAt,
        inflightAtDrainStart: result.inflightAtDrainStart,
        inflightAtCompletion: result.inflightAtCompletion,
        killedExecutions: result.killedExecutions,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/execution/plugin-cache-prefetch
  // ---------------------------------------------------------------------------

  routes.post("/execution/plugin-cache-prefetch", async (c) => {
    if (c.var.user?.isService !== true) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Service token required.", requestId: c.var.requestId } },
        403,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = CachePrefetchRequestSchema.safeParse(body);
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

    const result = await executionService.prefetchPluginBundle(parsed.data);

    return c.json({
      data: {
        pluginId: result.pluginId,
        version: result.version,
        cached: result.cached,
        bundleSizeBytes: result.bundleSizeBytes,
        fetchDurationMs: result.fetchDurationMs,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/execution/plugin-cache-invalidate
  // Only Plugin Service is allowed by the RBAC matrix.
  // ---------------------------------------------------------------------------

  routes.post("/execution/plugin-cache-invalidate", async (c) => {
    if (c.var.user?.isService !== true) {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Service token required.", requestId: c.var.requestId } },
        403,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = CacheInvalidateRequestSchema.safeParse(body);
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

    const result = await executionService.invalidatePluginCache(parsed.data);

    return c.json({
      data: {
        evicted: result.evicted,
        pluginId: result.pluginId,
      },
    });
  });

  return routes;
}
