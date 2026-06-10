import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError, NotFoundError } from "@oneplatform/core";
import type { LogEventRepository } from "../repositories/index.js";
import type { LogQueryParams, LogEventRow } from "../repositories/types.js";
import { logQuerySchema, exportQuerySchema } from "../schemas/index.js";
import { ExportTooLargeError } from "../services/errors.js";

const EXPORT_MAX_WINDOW_DAYS = (): number =>
  parseInt(process.env["OP_EXPORT_MAX_WINDOW_DAYS"] ?? "7", 10);

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

export interface LogRouteDeps {
  logEventRepository: LogEventRepository;
}

export function createLogRoutes(
  deps: LogRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { logEventRepository } = deps;

  // ---------------------------------------------------------------------------
  // GET /api/v1/logs — query with cursor pagination
  // ---------------------------------------------------------------------------
  routes.get("/api/v1/logs", async (c) => {
    const user = c.var.user;
    if (
      !user.scopes.includes("logs:read") &&
      !user.scopes.includes("admin")
    ) {
      throw new ForbiddenError("logs:read scope is required");
    }

    const parsed = logQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.issues);
    }

    const params: LogQueryParams = {
      limit: parsed.data.limit,
      ...(parsed.data.service !== undefined ? { service: parsed.data.service } : {}),
      ...(parsed.data.level !== undefined ? { level: parsed.data.level } : {}),
      ...(parsed.data.traceId !== undefined ? { traceId: parsed.data.traceId } : {}),
      ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
      ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
      ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    };

    const result = await logEventRepository.query(params);

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
  // GET /api/v1/logs/:id — single log event by ID
  // ---------------------------------------------------------------------------
  routes.get("/api/v1/logs/:id", async (c) => {
    const user = c.var.user;
    if (
      !user.scopes.includes("logs:read") &&
      !user.scopes.includes("admin")
    ) {
      throw new ForbiddenError("logs:read scope is required");
    }

    const id = c.req.param("id");
    const row = await logEventRepository.findById(id);

    if (row === null) {
      throw new NotFoundError(`Log event ${id} not found`);
    }

    return c.json({ data: mapRow(row) });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/logs/export — JSONL or CSV streaming export
  // ---------------------------------------------------------------------------
  routes.get("/api/v1/logs/export", async (c) => {
    const user = c.var.user;
    if (
      !user.scopes.includes("logs:export") &&
      !user.scopes.includes("admin")
    ) {
      throw new ForbiddenError("logs:export scope is required");
    }

    const parsed = exportQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!parsed.success) {
      throw new ValidationError("Invalid export parameters", parsed.error.issues);
    }

    const params = parsed.data;
    const windowMs =
      new Date(params.to).getTime() - new Date(params.from).getTime();
    const maxWindowMs = EXPORT_MAX_WINDOW_DAYS() * 24 * 60 * 60 * 1000;

    if (windowMs <= 0) {
      throw new ValidationError("'to' must be after 'from'", []);
    }
    if (windowMs > maxWindowMs) {
      throw new ExportTooLargeError(
        `Export window exceeds ${EXPORT_MAX_WINDOW_DAYS()} days. Use multiple requests with narrower windows.`
      );
    }

    const format = params.format;
    const contentType =
      format === "csv" ? "text/csv" : "application/x-ndjson";
    const filename = `logs-${params.from}-${params.to}.${format === "csv" ? "csv" : "jsonl"}`;

    c.header("Content-Type", contentType);
    c.header(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    c.header("Transfer-Encoding", "chunked");

    const encoder = new TextEncoder();
    const CSV_HEADER = "id,trace_id,service,level,message,created_at,metadata";
    const exportChunkSize = parseInt(
      process.env["OP_EXPORT_CHUNK_SIZE"] ?? "1000",
      10
    );

    const exportOpts = {
      from: params.from,
      to: params.to,
      chunkSize: exportChunkSize,
      ...(params.service !== undefined ? { service: params.service } : {}),
      ...(params.level !== undefined ? { level: params.level } : {}),
      ...(params.traceId !== undefined ? { traceId: params.traceId } : {}),
      ...(params.search !== undefined ? { search: params.search } : {}),
    };

    const stream = new ReadableStream({
      async start(controller) {
        if (format === "csv") {
          controller.enqueue(encoder.encode(CSV_HEADER + "\n"));
        }

        // Stream rows in pages to keep memory flat regardless of export size
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
          const rows = await logEventRepository.exportPage({
            ...exportOpts,
            offset,
          });

          for (const row of rows) {
            let line: string;
            if (format === "csv") {
              const meta = JSON.stringify(row.metadata).replace(/"/g, '""');
              line = [
                row.id,
                row.trace_id,
                row.service,
                row.level,
                `"${row.message.replace(/"/g, '""')}"`,
                row.created_at.toISOString(),
                `"${meta}"`,
              ].join(",");
            } else {
              line = JSON.stringify(mapRow(row));
            }
            controller.enqueue(encoder.encode(line + "\n"));
          }

          hasMore = rows.length === exportChunkSize;
          offset += rows.length;
        }

        controller.close();
      },
    });

    return c.body(stream);
  });

  return routes;
}
