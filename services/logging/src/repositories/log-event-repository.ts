import type pg from "pg";
import { encodeCursor, decodeCursor } from "@oneplatform/core";
import type {
  LogEventRow,
  CreateLogEventData,
  LogQueryParams,
} from "./types.js";

export interface ExportQueryOptions {
  service?: string;
  level?: "debug" | "info" | "warn" | "error";
  traceId?: string;
  search?: string;
  from: string;
  to: string;
  chunkSize: number;
  offset: number;
}

// OP_CURSOR_SECRET is validated at startup; the assertion here is a belt-and-
// suspenders guard for the rare case where this module is loaded in isolation.
function getCursorSecret(): string {
  const secret = process.env["OP_CURSOR_SECRET"];
  if (!secret) throw new Error("OP_CURSOR_SECRET is required");
  return secret;
}

export class LogEventRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Bulk insert via unnest — single round-trip for the entire batch.
   * The ON CONFLICT DO NOTHING guard is an idempotency safety net for the rare
   * case where a buffer is flushed twice after a transient Postgres error.
   */
  async insertBatch(events: CreateLogEventData[]): Promise<void> {
    if (events.length === 0) return;

    const traceIds = events.map((e) => e.traceId);
    const services = events.map((e) => e.service);
    const levels = events.map((e) => e.level);
    const messages = events.map((e) => e.message);
    const metadatas = events.map((e) => JSON.stringify(e.metadata));
    const createdAts = events.map((e) => e.createdAt.toISOString());

    await this.db.query(
      `INSERT INTO logging.events
         (trace_id, service, level, message, metadata, created_at)
       SELECT
         unnest($1::text[])        AS trace_id,
         unnest($2::text[])        AS service,
         unnest($3::text[])        AS level,
         unnest($4::text[])        AS message,
         unnest($5::jsonb[])       AS metadata,
         unnest($6::timestamptz[]) AS created_at
       ON CONFLICT DO NOTHING`,
      [traceIds, services, levels, messages, metadatas, createdAts]
    );
  }

  /**
   * Parameterized query builder — user values are always bound as positional
   * parameters, never interpolated into the SQL string.
   */
  async query(
    params: LogQueryParams
  ): Promise<{ data: LogEventRow[]; nextCursor: string | null }> {
    const conditions: string[] = [];
    const args: unknown[] = [];
    let n = 1;

    if (params.service !== undefined) {
      conditions.push(`service = $${n++}`);
      args.push(params.service);
    }
    if (params.level !== undefined) {
      conditions.push(`level = $${n++}`);
      args.push(params.level);
    }
    if (params.traceId !== undefined) {
      conditions.push(`trace_id = $${n++}`);
      args.push(params.traceId);
    }
    if (params.search !== undefined) {
      // plainto_tsquery handles arbitrary user input safely — it normalises
      // tokens and never raises a syntax error on special characters.
      // phraseto_tsquery is used when the user wraps a phrase in quotes.
      if (params.search.startsWith('"') && params.search.endsWith('"')) {
        conditions.push(`search_vec @@ phraseto_tsquery('english', $${n++})`);
        args.push(params.search.slice(1, -1));
      } else {
        conditions.push(`search_vec @@ plainto_tsquery('english', $${n++})`);
        args.push(params.search);
      }
    }
    if (params.from !== undefined) {
      conditions.push(`created_at >= $${n++}`);
      args.push(params.from);
    }
    if (params.to !== undefined) {
      conditions.push(`created_at < $${n++}`);
      args.push(params.to);
    }

    let cursorClause = "";
    if (params.cursor !== undefined) {
      const decoded = await decodeCursor(params.cursor, getCursorSecret());
      cursorClause = `AND (created_at, id) < ($${n++}::timestamptz, $${n++}::uuid)`;
      args.push(decoded["createdAt"] as string, decoded["id"] as string);
    }

    // Fetch one extra row to determine whether another page exists, then strip it.
    const fetchLimit = params.limit + 1;
    args.push(fetchLimit);
    const limitParam = `$${n}`;

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT id, trace_id, service, level, message, metadata, created_at
      FROM logging.events
      ${whereClause} ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}
    `;

    const result = await this.db.query<LogEventRow>(sql, args);
    const rows = result.rows;
    const hasMore = rows.length > params.limit;
    const data = hasMore ? rows.slice(0, params.limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      // lastRow is always defined here — data.length > 0 is asserted above
      nextCursor = await encodeCursor(
        {
          createdAt: (lastRow as LogEventRow).created_at.toISOString(),
          id: (lastRow as LogEventRow).id,
        },
        getCursorSecret()
      );
    }

    return { data, nextCursor };
  }

  /**
   * Fetch a single log event by its UUID primary key.
   * Returns null when no matching row exists (across all partitions).
   */
  async findById(id: string): Promise<LogEventRow | null> {
    const result = await this.db.query<LogEventRow>(
      `SELECT id, trace_id, service, level, message, metadata, created_at
       FROM logging.events
       WHERE id = $1
       LIMIT 1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Fetch a page of rows for streaming export. Ascending order is intentional
   * for export (matches natural write order for log analysis tools).
   * Callers iterate with increasing offset until a page smaller than chunkSize
   * is returned.
   */
  async exportPage(opts: ExportQueryOptions): Promise<LogEventRow[]> {
    const conditions: string[] = [];
    const args: unknown[] = [];
    let n = 1;

    if (opts.service !== undefined) {
      conditions.push(`service = $${n++}`);
      args.push(opts.service);
    }
    if (opts.level !== undefined) {
      conditions.push(`level = $${n++}`);
      args.push(opts.level);
    }
    if (opts.traceId !== undefined) {
      conditions.push(`trace_id = $${n++}`);
      args.push(opts.traceId);
    }
    if (opts.search !== undefined) {
      if (opts.search.startsWith('"') && opts.search.endsWith('"')) {
        conditions.push(`search_vec @@ phraseto_tsquery('english', $${n++})`);
        args.push(opts.search.slice(1, -1));
      } else {
        conditions.push(`search_vec @@ plainto_tsquery('english', $${n++})`);
        args.push(opts.search);
      }
    }
    conditions.push(`created_at >= $${n++}`);
    args.push(opts.from);
    conditions.push(`created_at < $${n++}`);
    args.push(opts.to);

    args.push(opts.chunkSize);
    args.push(opts.offset);

    const whereClause = `WHERE ${conditions.join(" AND ")}`;
    const limitParam = n;
    const offsetParam = n + 1;

    const sql = `
      SELECT id, trace_id, service, level, message, metadata, created_at
      FROM logging.events
      ${whereClause}
      ORDER BY created_at ASC, id ASC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;

    const result = await this.db.query<LogEventRow>(sql, args);
    return result.rows;
  }

  /**
   * Fetch all events for a trace chain across all services.
   * The (trace_id, created_at DESC) partial index makes this efficient;
   * the WHERE trace_id <> '' exclusion means empty-string system events
   * are not indexed and cannot match here.
   */
  async queryByTraceId(traceId: string): Promise<LogEventRow[]> {
    const result = await this.db.query<LogEventRow>(
      `SELECT id, trace_id, service, level, message, metadata, created_at
       FROM logging.events
       WHERE trace_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 500`,
      [traceId]
    );
    return result.rows;
  }
}
