import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError } from "@oneplatform/core";
import type { FieldAuditService } from "../services/field-audit-service.js";
import type { FieldChangeRow, FieldAccessRow } from "../repositories/types.js";
import { fieldHistoryQuerySchema, entityAccessQuerySchema } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Response mappers — camelCase at the API boundary, snake_case in the DB
// ---------------------------------------------------------------------------

function mapChangeRow(row: FieldChangeRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fieldName: row.field_name,
    oldValue: row.old_value,
    newValue: row.new_value,
    action: row.action,
    source: row.source,
    changedAt: row.changed_at.toISOString(),
  };
}

function mapAccessRow(row: FieldAccessRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fieldsAccessed: row.fields_accessed,
    purpose: row.purpose,
    accessedAt: row.accessed_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Dependency injection contract
// ---------------------------------------------------------------------------

export interface FieldAuditRouteDeps {
  fieldAuditService: FieldAuditService;
}

// ---------------------------------------------------------------------------
// Authorization helper
//
// Field audit routes require either audit:read or admin scope. Non-admin callers
// are further restricted to their own tenant — they cannot pass a cross-tenant
// entityId and get another tenant's data because tenantId is sourced from the JWT.
// ---------------------------------------------------------------------------

function assertAuditReadAccess(
  user: AppVariables["user"]
): void {
  if (
    !user.scopes.includes("audit:read") &&
    !user.scopes.includes("admin")
  ) {
    throw new ForbiddenError("audit:read scope is required");
  }
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createFieldAuditRoutes(
  deps: FieldAuditRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { fieldAuditService } = deps;

  // -------------------------------------------------------------------------
  // GET /api/v1/audit/entities/:type/:id/fields
  // All field changes for an entity (all fields, paginated).
  // -------------------------------------------------------------------------
  routes.get("/api/v1/audit/entities/:type/:id/fields", async (c) => {
    const user = c.var.user;
    assertAuditReadAccess(user);

    const entityType = c.req.param("type");
    const entityId = c.req.param("id");

    // tenantId is always the caller's own tenant from the JWT. Admins can
    // query any tenant only via the existing /audit-events endpoint; field
    // audit routes are intentionally scoped to the caller's tenant to keep
    // blast radius small.
    const tenantId = user.tenantId;

    const parsed = fieldHistoryQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.issues);
    }

    const result = await fieldAuditService.getEntityAuditLog(
      tenantId,
      entityType,
      entityId,
      parsed.data
    );

    return c.json({
      data: result.data.map(mapChangeRow),
      pagination: {
        cursor: result.nextCursor,
        limit: parsed.data.limit,
        hasMore: result.nextCursor !== null,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/audit/entities/:type/:id/fields/:fieldName
  // Change history for a specific field on an entity.
  // -------------------------------------------------------------------------
  routes.get("/api/v1/audit/entities/:type/:id/fields/:fieldName", async (c) => {
    const user = c.var.user;
    assertAuditReadAccess(user);

    const entityType = c.req.param("type");
    const entityId = c.req.param("id");
    const fieldName = c.req.param("fieldName");
    const tenantId = user.tenantId;

    const parsed = fieldHistoryQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.issues);
    }

    const result = await fieldAuditService.getFieldHistory(
      tenantId,
      entityType,
      entityId,
      // fieldName from the path takes precedence over any query param
      { ...parsed.data, fieldName }
    );

    return c.json({
      data: result.data.map(mapChangeRow),
      pagination: {
        cursor: result.nextCursor,
        limit: parsed.data.limit,
        hasMore: result.nextCursor !== null,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/audit/entities/:type/:id/access
  // Field access log for an entity — who read what fields and when.
  // -------------------------------------------------------------------------
  routes.get("/api/v1/audit/entities/:type/:id/access", async (c) => {
    const user = c.var.user;
    assertAuditReadAccess(user);

    const entityType = c.req.param("type");
    const entityId = c.req.param("id");
    const tenantId = user.tenantId;

    const parsed = entityAccessQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters", parsed.error.issues);
    }

    const result = await fieldAuditService.getEntityAccessLog(
      tenantId,
      entityType,
      entityId,
      parsed.data
    );

    return c.json({
      data: result.data.map(mapAccessRow),
      pagination: {
        cursor: result.nextCursor,
        limit: parsed.data.limit,
        hasMore: result.nextCursor !== null,
      },
    });
  });

  return routes;
}
