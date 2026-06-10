import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, serviceAuthMiddleware } from "@oneplatform/core";
import type { LogEventRepository } from "../repositories/index.js";
import type { LogQueryParams, CreateLogEventData } from "../repositories/types.js";
import type { LogEventRow } from "../repositories/types.js";
import { internalLogQuerySchema, ingestEventSchema } from "../schemas/index.js";
import type { BatchAccumulator } from "../services/ingestion-service.js";

function mapRow(row: LogEventRow) {
  return {
    id: row.id,
    traceId: row.trace_id,
    service: row.service,
    level: row.level,
    message: row.message,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

export interface InternalRouteDeps {
  logEventRepository: LogEventRepository;
  batchAccumulator: BatchAccumulator;
  servicePublicKeys: Record<string, string>;
}

export function createInternalRoutes(
  deps: InternalRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { logEventRepository, batchAccumulator, servicePublicKeys } = deps;

  // All /internal/* routes require a valid X-Service-Token.
  // Only app-service is in the allowed caller list per ADR-19.
  routes.use(
    "/internal/*",
    serviceAuthMiddleware({
      servicePublicKeys,
      targetService: "logging-service",
    })
  );

  // ---------------------------------------------------------------------------
  // POST /internal/logging/query — App Service fetches logs for trace viewer
  //
  // The `services` array bypasses tenant scope — the App Service is trusted to
  // pass the correct service list for its tenant context.
  // ---------------------------------------------------------------------------
  routes.post("/internal/logging/query", async (c) => {
    const body: unknown = await c.req.json();
    const parsed = internalLogQuerySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid query body", parsed.error.issues);
    }

    const { services, ...rest } = parsed.data;

    // Cursor-based pagination is incompatible with multi-service fan-out because
    // the fan-out merges results from independent queries — there is no single
    // monotonic cursor that maps back to a deterministic position across all
    // of them. Reject the combination so the caller gets a clear error instead
    // of silently getting stale/repeated results.
    if (services !== undefined && services.length > 0 && rest.cursor !== undefined) {
      throw new ValidationError(
        "Cursor pagination cannot be combined with a multi-service fan-out query. " +
          "Remove 'cursor' or remove 'services' from the request.",
        []
      );
    }

    const params: LogQueryParams = {
      limit: rest.limit,
      ...(rest.service !== undefined ? { service: rest.service } : {}),
      ...(rest.level !== undefined ? { level: rest.level } : {}),
      ...(rest.traceId !== undefined ? { traceId: rest.traceId } : {}),
      ...(rest.search !== undefined ? { search: rest.search } : {}),
      ...(rest.from !== undefined ? { from: rest.from } : {}),
      ...(rest.to !== undefined ? { to: rest.to } : {}),
      ...(rest.cursor !== undefined ? { cursor: rest.cursor } : {}),
    };

    let result: { data: LogEventRow[]; nextCursor: string | null };

    if (services !== undefined && services.length > 0) {
      // When the App Service provides an explicit service list, run individual
      // queries per service and merge — the repository query method accepts a
      // single service filter, so we fan out and sort by created_at DESC.
      const perServiceResults = await Promise.all(
        services.map((svc) =>
          logEventRepository.query({ ...params, service: svc })
        )
      );
      const merged = perServiceResults
        .flatMap((r) => r.data)
        .sort(
          (a, b) =>
            b.created_at.getTime() - a.created_at.getTime() ||
            b.id.localeCompare(a.id)
        )
        .slice(0, params.limit);

      result = { data: merged, nextCursor: null };
    } else {
      result = await logEventRepository.query(params);
    }

    return c.json({
      data: result.data.map(mapRow),
      pagination: {
        cursor: result.nextCursor,
        limit: params.limit,
        hasMore: result.nextCursor !== null,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // POST /internal/logging/ingest — direct log injection (service auth)
  //
  // Used by services that cannot publish to Redis pub/sub (e.g., during
  // integration tests or when bypassing the pub/sub pipeline).
  // ---------------------------------------------------------------------------
  routes.post("/internal/logging/ingest", async (c) => {
    const body: unknown = await c.req.json();

    // Accept either a single event object or an array of events, bounded to
    // prevent a single request from exhausting memory or DB write capacity.
    const rawItems = Array.isArray(body) ? body : [body];
    const itemsResult = z.array(z.unknown()).max(1000).safeParse(rawItems);
    if (!itemsResult.success) {
      throw new ValidationError("Request body exceeds maximum of 1000 events", itemsResult.error.issues);
    }
    const items = itemsResult.data;
    const events: CreateLogEventData[] = [];

    for (const item of items) {
      const parsed = ingestEventSchema.safeParse(item);
      if (!parsed.success) {
        throw new ValidationError(
          "Invalid log event in request body",
          parsed.error.issues
        );
      }
      events.push({
        traceId: parsed.data.traceId,
        service: parsed.data.service,
        level: parsed.data.level,
        message: parsed.data.message,
        metadata: parsed.data.metadata,
        createdAt: new Date(parsed.data.timestamp),
      });
    }

    // Route through the batch accumulator so SSE subscribers see these events
    // and retries use the same fallback path as pub/sub ingested events.
    for (const event of events) {
      batchAccumulator.push({
        timestamp: event.createdAt.toISOString(),
        traceId: event.traceId,
        service: event.service,
        level: event.level,
        message: event.message,
        metadata: event.metadata,
      });
    }

    return c.json({ data: { accepted: events.length } }, 202);
  });

  return routes;
}
