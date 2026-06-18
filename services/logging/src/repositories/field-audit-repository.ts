import type pg from "pg";
import { z } from "zod";
import { encodeCursor, decodeCursor } from "@oneplatform/core";
import type {
  FieldChangeEntry,
  FieldAccessEntry,
  FieldChangeRow,
  FieldAccessRow,
  FieldHistoryQueryParams,
  FieldAccessQueryParams,
} from "./types.js";

function getCursorSecret(): string {
  const secret = process.env["OP_CURSOR_SECRET"];
  if (!secret) throw new Error("OP_CURSOR_SECRET is required");
  return secret;
}

// Validated cursor payload for field audit pagination. Both tables sort by
// (changed_at/accessed_at DESC, id DESC) so the cursor carries both columns.
const CursorPayloadSchema = z.object({
  ts: z.string().datetime(),
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Sensitive field detection
//
// Field names that contain any of these substrings (case-insensitive) are
// redacted before writing to the DB. The check is performed here in the
// repository rather than only in the service so that no code path can bypass
// it by calling the repository directly.
// ---------------------------------------------------------------------------
const SENSITIVE_SUBSTRINGS = ["password", "secret", "token", "key", "credential"] as const;

/** Returns true if the field name refers to a sensitive value that must be redacted. */
export function isSensitiveField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return SENSITIVE_SUBSTRINGS.some((sub) => lower.includes(sub));
}

const REDACTED_SENTINEL = "[REDACTED]";

function redactIfSensitive(fieldName: string, value: unknown): unknown {
  if (isSensitiveField(fieldName) && value !== undefined && value !== null) {
    return REDACTED_SENTINEL;
  }
  return value;
}

export class FieldAuditRepository {
  constructor(private readonly db: pg.Pool) {}

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Insert a field change record. Sensitive field values are redacted before
   * insertion — the actual value is never written to the audit table.
   */
  async insertFieldChange(entry: FieldChangeEntry): Promise<FieldChangeRow> {
    const safeOld = redactIfSensitive(entry.fieldName, entry.oldValue);
    const safeNew = redactIfSensitive(entry.fieldName, entry.newValue);

    const result = await this.db.query<FieldChangeRow>(
      `INSERT INTO logging.field_changes
         (tenant_id, user_id, entity_type, entity_id, field_name,
          old_value, new_value, action, source, changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)
       RETURNING id, tenant_id, user_id, entity_type, entity_id, field_name,
                 old_value, new_value, action, source, changed_at`,
      [
        entry.tenantId,
        entry.userId,
        entry.entityType,
        entry.entityId,
        entry.fieldName,
        safeOld !== undefined ? JSON.stringify(safeOld) : null,
        safeNew !== undefined ? JSON.stringify(safeNew) : null,
        entry.action,
        entry.source,
        entry.timestamp,
      ]
    );

    const row = result.rows[0];
    if (!row) throw new Error("field_changes insert returned no rows");
    return row;
  }

  /**
   * Insert a field access record. Field names in fieldsAccessed are checked
   * for sensitivity and stripped from the list — we record that a sensitive
   * field category was accessed without naming it explicitly.
   *
   * Rationale: storing the name "password" in the access log is itself a form
   * of sensitive data leakage; removing the names satisfies compliance without
   * suppressing the existence of the access event.
   */
  async insertFieldAccess(entry: FieldAccessEntry): Promise<FieldAccessRow> {
    // Split the field list so non-sensitive fields are named, sensitive fields
    // are replaced with the redacted sentinel name. This preserves access count
    // and category information without leaking field semantics.
    const sanitisedFields = entry.fieldsAccessed.map((f) =>
      isSensitiveField(f) ? REDACTED_SENTINEL : f
    );

    const result = await this.db.query<FieldAccessRow>(
      `INSERT INTO logging.field_access
         (tenant_id, user_id, entity_type, entity_id,
          fields_accessed, purpose, accessed_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)
       RETURNING id, tenant_id, user_id, entity_type, entity_id,
                 fields_accessed, purpose, accessed_at`,
      [
        entry.tenantId,
        entry.userId,
        entry.entityType,
        entry.entityId,
        JSON.stringify(sanitisedFields),
        entry.purpose,
        entry.timestamp,
      ]
    );

    const row = result.rows[0];
    if (!row) throw new Error("field_access insert returned no rows");
    return row;
  }

  // ---------------------------------------------------------------------------
  // Reads — field change history
  // ---------------------------------------------------------------------------

  /**
   * Paginated history for a single field on a single entity.
   * Tenant isolation is enforced by the tenantId parameter — callers must pass
   * the tenant from the authenticated user context, not from query params.
   */
  async queryFieldHistory(
    tenantId: string,
    params: FieldHistoryQueryParams
  ): Promise<{ data: FieldChangeRow[]; nextCursor: string | null }> {
    const conditions: string[] = ["tenant_id = $1", "entity_type = $2", "entity_id = $3"];
    const args: unknown[] = [tenantId, params.entityType, params.entityId];
    let n = 4;

    if (params.fieldName !== undefined) {
      conditions.push(`field_name = $${n++}`);
      args.push(params.fieldName);
    }
    if (params.userId !== undefined) {
      conditions.push(`user_id = $${n++}`);
      args.push(params.userId);
    }
    if (params.from !== undefined) {
      conditions.push(`changed_at >= $${n++}::timestamptz`);
      args.push(params.from);
    }
    if (params.to !== undefined) {
      conditions.push(`changed_at < $${n++}::timestamptz`);
      args.push(params.to);
    }

    let cursorClause = "";
    if (params.cursor !== undefined) {
      const raw = await decodeCursor(params.cursor, getCursorSecret());
      const cursor = CursorPayloadSchema.parse(raw);
      cursorClause = `AND (changed_at, id) < ($${n++}::timestamptz, $${n++}::uuid)`;
      args.push(cursor.ts, cursor.id);
    }

    const fetchLimit = params.limit + 1;
    args.push(fetchLimit);
    const limitParam = `$${n}`;

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const sql = `
      SELECT id, tenant_id, user_id, entity_type, entity_id, field_name,
             old_value, new_value, action, source, changed_at
      FROM logging.field_changes
      ${whereClause} ${cursorClause}
      ORDER BY changed_at DESC, id DESC
      LIMIT ${limitParam}
    `;

    const result = await this.db.query<FieldChangeRow>(sql, args);
    return this.paginateFieldChanges(result.rows, params.limit);
  }

  // ---------------------------------------------------------------------------
  // Reads — entity access log
  // ---------------------------------------------------------------------------

  /**
   * Paginated access log for all accesses to any field on a specific entity.
   */
  async queryEntityAccess(
    tenantId: string,
    params: FieldAccessQueryParams
  ): Promise<{ data: FieldAccessRow[]; nextCursor: string | null }> {
    const conditions: string[] = ["tenant_id = $1", "entity_type = $2", "entity_id = $3"];
    const args: unknown[] = [tenantId, params.entityType, params.entityId];
    let n = 4;

    if (params.userId !== undefined) {
      conditions.push(`user_id = $${n++}`);
      args.push(params.userId);
    }
    if (params.from !== undefined) {
      conditions.push(`accessed_at >= $${n++}::timestamptz`);
      args.push(params.from);
    }
    if (params.to !== undefined) {
      conditions.push(`accessed_at < $${n++}::timestamptz`);
      args.push(params.to);
    }

    let cursorClause = "";
    if (params.cursor !== undefined) {
      const raw = await decodeCursor(params.cursor, getCursorSecret());
      const cursor = CursorPayloadSchema.parse(raw);
      cursorClause = `AND (accessed_at, id) < ($${n++}::timestamptz, $${n++}::uuid)`;
      args.push(cursor.ts, cursor.id);
    }

    const fetchLimit = params.limit + 1;
    args.push(fetchLimit);
    const limitParam = `$${n}`;

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const sql = `
      SELECT id, tenant_id, user_id, entity_type, entity_id,
             fields_accessed, purpose, accessed_at
      FROM logging.field_access
      ${whereClause} ${cursorClause}
      ORDER BY accessed_at DESC, id DESC
      LIMIT ${limitParam}
    `;

    const result = await this.db.query<FieldAccessRow>(sql, args);
    return this.paginateFieldAccess(result.rows, params.limit);
  }

  // ---------------------------------------------------------------------------
  // Cursor helpers
  // ---------------------------------------------------------------------------

  private async paginateFieldChanges(
    rows: FieldChangeRow[],
    limit: number
  ): Promise<{ data: FieldChangeRow[]; nextCursor: string | null }> {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1] as FieldChangeRow;
      nextCursor = await encodeCursor(
        { ts: last.changed_at.toISOString(), id: last.id },
        getCursorSecret()
      );
    }

    return { data, nextCursor };
  }

  private async paginateFieldAccess(
    rows: FieldAccessRow[],
    limit: number
  ): Promise<{ data: FieldAccessRow[]; nextCursor: string | null }> {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1] as FieldAccessRow;
      nextCursor = await encodeCursor(
        { ts: last.accessed_at.toISOString(), id: last.id },
        getCursorSecret()
      );
    }

    return { data, nextCursor };
  }
}
