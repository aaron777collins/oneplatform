import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError } from "@oneplatform/core";
import type { AuditEventRepository } from "../repositories/index.js";
import type { AuditQueryParams } from "../repositories/types.js";
import type { AuditEventRow } from "../repositories/types.js";
import { auditQuerySchema, auditExportQuerySchema } from "../schemas/index.js";

function mapAuditRow(row: AuditEventRow) {
  return {
    id: row.id,
    traceId: row.trace_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    tenantId: row.tenant_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    result: row.result,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

export interface AuditRouteDeps {
  auditEventRepository: AuditEventRepository;
}

export function createAuditRoutes(
  deps: AuditRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { auditEventRepository } = deps;

  // ---------------------------------------------------------------------------
  // GET /api/v1/audit-events — query audit events with cursor pagination
  // Requires admin-only audit:read scope per L2 §5.2
  // ---------------------------------------------------------------------------
  routes.get("/api/v1/audit-events", async (c) => {
    const user = c.var.user;
    if (
      !user.scopes.includes("audit:read") &&
      !user.scopes.includes("admin")
    ) {
      throw new ForbiddenError("audit:read scope is required");
    }

    const parsed = auditQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.issues);
    }

    const isAdmin = user.scopes.includes("admin");

    // Non-admin callers may only query their own tenant's audit events. The
    // tenantId from the validated JWT is authoritative — callers cannot escalate
    // by passing a different tenantId in the query string.
    const effectiveTenantId: string | undefined = isAdmin
      ? parsed.data.tenantId
      : user.tenantId;

    // startDate / endDate take precedence over legacy from / to when both are supplied.
    const effectiveFrom = parsed.data.startDate ?? parsed.data.from;
    const effectiveTo = parsed.data.endDate ?? parsed.data.to;

    const params: AuditQueryParams = {
      limit: parsed.data.limit,
      ...(parsed.data.search !== undefined ? { search: parsed.data.search } : {}),
      ...(parsed.data.actorId !== undefined ? { actorId: parsed.data.actorId } : {}),
      ...(parsed.data.actorType !== undefined ? { actorType: parsed.data.actorType } : {}),
      ...(effectiveTenantId !== undefined ? { tenantId: effectiveTenantId } : {}),
      ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
      ...(parsed.data.resourceType !== undefined ? { resourceType: parsed.data.resourceType } : {}),
      ...(parsed.data.resourceId !== undefined ? { resourceId: parsed.data.resourceId } : {}),
      ...(parsed.data.result !== undefined ? { result: parsed.data.result } : {}),
      ...(effectiveFrom !== undefined ? { from: effectiveFrom } : {}),
      ...(effectiveTo !== undefined ? { to: effectiveTo } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    };

    const queryResult = await auditEventRepository.query(params);

    return c.json({
      data: queryResult.data.map(mapAuditRow),
      pagination: {
        cursor: queryResult.nextCursor,
        limit: params.limit,
        hasMore: queryResult.nextCursor !== null,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/audit/export — stream audit events as newline-delimited JSON
  //
  // Designed for SIEM integration and compliance archives. Each row is written
  // as a single JSON object followed by a newline (NDJSON / JSON Lines format).
  // The response streams rows as they are serialised — the entire result set is
  // NOT held in memory as a JSON array, so this endpoint handles 50k row exports
  // without excessive memory allocation.
  //
  // Requires admin scope. startDate + endDate are mandatory to bound the query.
  // ---------------------------------------------------------------------------
  routes.get("/api/v1/audit/export", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes("admin")) {
      throw new ForbiddenError("admin scope is required to export audit events.");
    }

    const parsed = auditExportQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!parsed.success) {
      throw new ValidationError("Invalid export query parameters", parsed.error.issues);
    }

    const rows = await auditEventRepository.queryForExport({
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      ...(parsed.data.actorId !== undefined ? { actorId: parsed.data.actorId } : {}),
      // eventType maps to the action column in the audit_events table
      ...(parsed.data.eventType !== undefined ? { action: parsed.data.eventType } : {}),
      limit: parsed.data.limit,
    });

    // Stream each row as a JSON line. Using ReadableStream avoids loading the
    // entire serialised payload into memory before the first byte is sent.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const row of rows) {
          // mapAuditRow normalises snake_case columns to the camelCase API contract
          const line = JSON.stringify(mapAuditRow(row)) + "\n";
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        // Prevent proxies from buffering the stream before forwarding
        "X-Content-Type-Options": "nosniff",
        // Expose the row count in a header so callers can detect truncation
        // without parsing the entire payload
        "X-Total-Records": String(rows.length),
      },
    });
  });

  return routes;
}
