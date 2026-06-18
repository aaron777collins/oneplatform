/**
 * Streaming API routes — mounted under /api/v1/connectors/:id/stream
 *
 * POST  /api/v1/connectors/:id/stream/start   — start consuming from topics
 * POST  /api/v1/connectors/:id/stream/stop    — stop consuming
 * GET   /api/v1/connectors/:id/stream/status  — consumer lag, connected topics,
 *                                               messages consumed
 *
 * All endpoints require a valid tenant-scoped JWT. The connector must belong to
 * the authenticated tenant; unknown or cross-tenant IDs return 404.
 *
 * The caller is responsible for providing a pre-constructed StreamingConnector
 * instance (typically a MockKafkaConnector in tests or a real KafkaConnector in
 * production). The routes delegate to StreamingIngestionService which manages
 * the lifecycle and status persistence.
 */

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import { z } from "zod";
import type { ConnectorService } from "../services/connector-service.js";
import type {
  StreamingIngestionService,
  StartStreamOptions,
} from "../services/streaming-ingestion-service.js";
import type { StreamingConnector } from "@oneplatform/plugin-sdk";

export interface StreamingRouteDeps {
  connectorService: ConnectorService;
  streamingIngestionService: StreamingIngestionService;
  /**
   * Factory that constructs a StreamingConnector for the given connector ID.
   * The route layer is decoupled from the concrete connector type — callers
   * inject the factory so the service can be wired to different broker
   * implementations (Kafka, NATS, mock) without changing route logic.
   */
  connectorFactory: (connectorId: string) => StreamingConnector | null;
}

// ---------------------------------------------------------------------------
// Zod schemas for request bodies
// ---------------------------------------------------------------------------

const startStreamRequest = z.object({
  /** Topics to subscribe to. At least one required. */
  topics: z.array(z.string().min(1)).min(1, "At least one topic is required"),
  /** Consumer group identifier. Defaults to "oneplatform-{connectorId}". */
  groupId: z.string().min(1).optional(),
  /**
   * Where to start consuming when no committed offset exists.
   * "earliest" | "latest" | a connector-specific cursor string.
   * Omit to resume from the last persisted cursor.
   */
  startOffset: z.string().optional(),
  /** Messages per batch. 1–10 000. */
  maxBatchSize: z.number().int().min(1).max(10_000).optional(),
  /** Max ms to wait for a full batch before flushing a partial one. 100–60 000. */
  maxWaitMs: z.number().int().min(100).max(60_000).optional(),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createStreamingRoutes(
  deps: StreamingRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { connectorService, streamingIngestionService, connectorFactory } = deps;

  // -------------------------------------------------------------------------
  // POST /:id/stream/start
  // -------------------------------------------------------------------------
  routes.post("/:id/stream/start", async (c) => {
    const user = c.var.user;
    if (user?.tenantId === undefined || user.tenantId === "") {
      throw new UnauthorizedError("Authentication required.");
    }

    const connectorId = c.req.param("id");

    // Ownership check — throws ConnectorNotFoundError (404) for unknown or
    // cross-tenant IDs, consistent with the CDC and sync endpoints.
    await connectorService.getConnector(user.tenantId, connectorId);

    // Parse and validate the request body.
    let body: z.infer<typeof startStreamRequest>;
    try {
      const raw = await c.req.json();
      const parsed = startStreamRequest.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError("Invalid request body.", parsed.error.issues);
      }
      body = parsed.data;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError("Request body must be a valid JSON object.", []);
    }

    // Resolve the streaming connector for this connector ID.
    const connector = connectorFactory(connectorId);
    if (connector === null) {
      throw new ValidationError(
        `Connector ${connectorId} does not support streaming ingestion.`,
        [],
      );
    }

    // Build options without setting optional keys to `undefined` because the
    // project is compiled with exactOptionalPropertyTypes.
    const startOptions: StartStreamOptions = {
      topics: body.topics,
      ...(body.groupId !== undefined ? { groupId: body.groupId } : {}),
      ...(body.startOffset !== undefined ? { startOffset: body.startOffset } : {}),
      ...(body.maxBatchSize !== undefined ? { maxBatchSize: body.maxBatchSize } : {}),
      ...(body.maxWaitMs !== undefined ? { maxWaitMs: body.maxWaitMs } : {}),
    };

    await streamingIngestionService.startStream(
      connectorId,
      user.tenantId,
      connector,
      startOptions,
    );

    return c.json(
      {
        data: {
          connectorId,
          status: "running",
          topics: body.topics,
          message: "Streaming ingestion started.",
        },
      },
      202,
    );
  });

  // -------------------------------------------------------------------------
  // POST /:id/stream/stop
  // -------------------------------------------------------------------------
  routes.post("/:id/stream/stop", async (c) => {
    const user = c.var.user;
    if (user?.tenantId === undefined || user.tenantId === "") {
      throw new UnauthorizedError("Authentication required.");
    }

    const connectorId = c.req.param("id");
    await connectorService.getConnector(user.tenantId, connectorId);
    await streamingIngestionService.stopStream(connectorId);

    return c.json(
      {
        data: {
          connectorId,
          status: "stopped",
          message: "Streaming ingestion stop requested.",
        },
      },
      200,
    );
  });

  // -------------------------------------------------------------------------
  // GET /:id/stream/status
  // -------------------------------------------------------------------------
  routes.get("/:id/stream/status", async (c) => {
    const user = c.var.user;
    if (user?.tenantId === undefined || user.tenantId === "") {
      throw new UnauthorizedError("Authentication required.");
    }

    const connectorId = c.req.param("id");
    await connectorService.getConnector(user.tenantId, connectorId);
    const status = await streamingIngestionService.getStreamStatus(connectorId);

    if (status === null) {
      return c.json(
        {
          data: {
            connectorId,
            status: "stopped",
            topics: [],
            lag: {},
            messagesConsumed: 0,
            startedAt: null,
            lastCommittedAt: null,
            lastError: null,
          },
        },
        200,
      );
    }

    return c.json({ data: status }, 200);
  });

  return routes;
}
