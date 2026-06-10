import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError } from "@oneplatform/core";
import type { AuditEventRepository } from "../repositories/index.js";
import type { AuditQueryParams } from "../repositories/types.js";
import type { AuditEventRow } from "../repositories/types.js";
import { auditQuerySchema } from "../schemas/index.js";

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

    const params: AuditQueryParams = {
      limit: parsed.data.limit,
      ...(parsed.data.actorId !== undefined ? { actorId: parsed.data.actorId } : {}),
      ...(parsed.data.actorType !== undefined ? { actorType: parsed.data.actorType } : {}),
      ...(effectiveTenantId !== undefined ? { tenantId: effectiveTenantId } : {}),
      ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
      ...(parsed.data.resourceType !== undefined ? { resourceType: parsed.data.resourceType } : {}),
      ...(parsed.data.resourceId !== undefined ? { resourceId: parsed.data.resourceId } : {}),
      ...(parsed.data.result !== undefined ? { result: parsed.data.result } : {}),
      ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
      ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
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

  return routes;
}
