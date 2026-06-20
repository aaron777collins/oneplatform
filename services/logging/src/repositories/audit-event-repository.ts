import type pg from "pg";
import { z } from "zod";
import { encodeCursor, decodeCursor } from "@oneplatform/core";
import type {
  AuditEventRow,
  CreateAuditEventData,
  AuditQueryParams,
} from "./types.js";

function getCursorSecret(): string {
  const secret = process.env["OP_CURSOR_SECRET"];
  if (!secret) throw new Error("OP_CURSOR_SECRET is required");
  return secret;
}

// Validated shape of a decoded pagination cursor. Casting the raw decoded
// object directly to string fields is unsafe — a tampered or malformed cursor
// must fail loudly rather than produce a SQL type error at query time.
const CursorPayloadSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});

export class AuditEventRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Insert a single audit event. Returns the created row so the caller has
   * the generated id and created_at for response mapping.
   * ON CONFLICT (job_id) DO NOTHING enforces BullMQ replay idempotency.
   */
  async insert(event: CreateAuditEventData): Promise<AuditEventRow> {
    const result = await this.db.query<AuditEventRow>(
      `INSERT INTO logging.audit_events
         (trace_id, actor_id, actor_type, tenant_id, action, resource_type,
          resource_id, result, metadata, created_at, job_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (job_id) DO NOTHING
       RETURNING
         id, trace_id, actor_id, actor_type, tenant_id, action,
         resource_type, resource_id, result, metadata, created_at,
         archived, job_id`,
      [
        event.traceId,
        event.actorId,
        event.actorType,
        event.tenantId,
        event.action,
        event.resourceType,
        event.resourceId,
        event.result,
        JSON.stringify(event.metadata),
        event.createdAt.toISOString(),
        event.jobId,
      ]
    );

    // ON CONFLICT DO NOTHING returns 0 rows for duplicates. Fetch the existing
    // row so callers always get a non-null return value.
    if (result.rows.length === 0 && event.jobId !== null) {
      const existing = await this.db.query<AuditEventRow>(
        `SELECT id, trace_id, actor_id, actor_type, tenant_id, action,
                resource_type, resource_id, result, metadata, created_at,
                archived, job_id
         FROM logging.audit_events
         WHERE job_id = $1`,
        [event.jobId]
      );
      const row = existing.rows[0];
      if (!row) {
        throw new Error(
          `Audit event with job_id=${event.jobId} not found after upsert conflict`
        );
      }
      return row;
    }

    const row = result.rows[0];
    if (!row) {
      throw new Error("Audit event insert returned no rows unexpectedly");
    }
    return row;
  }

  async query(
    params: AuditQueryParams
  ): Promise<{ data: AuditEventRow[]; nextCursor: string | null }> {
    const conditions: string[] = [];
    const args: unknown[] = [];
    let n = 1;

    if (params.actorId !== undefined) {
      conditions.push(`actor_id = $${n++}`);
      args.push(params.actorId);
    }
    if (params.actorType !== undefined) {
      conditions.push(`actor_type = $${n++}`);
      args.push(params.actorType);
    }
    if (params.tenantId !== undefined) {
      conditions.push(`tenant_id = $${n++}`);
      args.push(params.tenantId);
    }
    if (params.action !== undefined) {
      conditions.push(`action = $${n++}`);
      args.push(params.action);
    }
    if (params.resourceType !== undefined) {
      conditions.push(`resource_type = $${n++}`);
      args.push(params.resourceType);
    }
    if (params.resourceId !== undefined) {
      conditions.push(`resource_id = $${n++}`);
      args.push(params.resourceId);
    }
    if (params.result !== undefined) {
      conditions.push(`result = $${n++}`);
      args.push(params.result);
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
      const raw = await decodeCursor(params.cursor, getCursorSecret());
      const cursor = CursorPayloadSchema.parse(raw);
      const keyword = conditions.length > 0 ? "AND" : "WHERE";
      cursorClause = `${keyword} (created_at, id) < ($${n++}::timestamptz, $${n++}::uuid)`;
      args.push(cursor.createdAt, cursor.id);
    }

    const fetchLimit = params.limit + 1;
    args.push(fetchLimit);
    const limitParam = `$${n}`;

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT id, trace_id, actor_id, actor_type, tenant_id, action,
             resource_type, resource_id, result, metadata, created_at,
             archived, job_id
      FROM logging.audit_events
      ${whereClause} ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}
    `;

    const result = await this.db.query<AuditEventRow>(sql, args);
    const rows = result.rows;
    const hasMore = rows.length > params.limit;
    const data = hasMore ? rows.slice(0, params.limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastRow = data[data.length - 1];
      nextCursor = await encodeCursor(
        {
          createdAt: (lastRow as AuditEventRow).created_at.toISOString(),
          id: (lastRow as AuditEventRow).id,
        },
        getCursorSecret()
      );
    }

    return { data, nextCursor };
  }

  /**
   * Fetch all audit events for a specific resource — primary access pattern
   * for compliance queries (e.g., "who did what to tenant X's resource Y?").
   */
  async queryByResource(
    resourceType: string,
    resourceId: string
  ): Promise<AuditEventRow[]> {
    const result = await this.db.query<AuditEventRow>(
      `SELECT id, trace_id, actor_id, actor_type, tenant_id, action,
              resource_type, resource_id, result, metadata, created_at,
              archived, job_id
       FROM logging.audit_events
       WHERE resource_type = $1
         AND resource_id = $2
       ORDER BY created_at DESC
       LIMIT 500`,
      [resourceType, resourceId]
    );
    return result.rows;
  }
}
