// Data residency API route handlers.
//
// Authorization model:
//   - GET /regions is public to authenticated users (any role).
//   - GET /policies/:tenantId requires the caller to belong to the tenant
//     or have the "admin" scope.
//   - PUT /policies/:tenantId requires the "admin" scope within the tenant.
//   - Transfer rules are system-wide and require the "admin" scope.
//   - Audit log queries are scoped to the caller's tenant (admins can query
//     any tenant via the tenantId query parameter).
//
// All responses use the standard { data } / { data, pagination } envelope.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@oneplatform/core";
import type { DataResidencyService } from "../services/data-residency-service.js";
import {
  upsertResidencyPolicyRequest,
  createTransferRuleRequest,
  queryAuditLogParams,
} from "../schemas/index.js";

export interface DataResidencyRouteDeps {
  dataResidencyService: DataResidencyService;
}

export function createDataResidencyRoutes(
  deps: DataResidencyRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { dataResidencyService } = deps;

  // -------------------------------------------------------------------------
  // GET /regions — list all available regions
  // -------------------------------------------------------------------------
  routes.get("/regions", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const regions = dataResidencyService.listRegions();
    return c.json({ data: regions });
  });

  // -------------------------------------------------------------------------
  // GET /policies/:tenantId — get a tenant's residency policy
  // -------------------------------------------------------------------------
  routes.get("/policies/:tenantId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const tenantId = c.req.param("tenantId");
    if (!tenantId) {
      throw new ValidationError("Tenant ID is required.");
    }

    // Non-admin users can only view their own tenant's policy
    const isAdmin = user.scopes.includes("admin");
    if (!isAdmin && user.tenantId !== tenantId) {
      throw new ForbiddenError("You can only view your own tenant's data residency policy.");
    }

    const policy = await dataResidencyService.getPolicy(tenantId);
    if (policy === null) {
      throw new NotFoundError(`No data residency policy found for tenant ${tenantId}.`);
    }

    return c.json({ data: formatPolicy(policy) });
  });

  // -------------------------------------------------------------------------
  // PUT /policies/:tenantId — set or update a tenant's residency policy
  // -------------------------------------------------------------------------
  routes.put("/policies/:tenantId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const isAdmin = user.scopes.includes("admin");
    if (!isAdmin) {
      throw new ForbiddenError("Only administrators can manage data residency policies.");
    }

    const tenantId = c.req.param("tenantId");
    if (!tenantId) {
      throw new ValidationError("Tenant ID is required.");
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = upsertResidencyPolicyRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const policy = await dataResidencyService.upsertPolicy(
      tenantId,
      parsed.data.region,
      {
        ...(parsed.data.storageClass !== undefined ? { storageClass: parsed.data.storageClass } : {}),
        ...(parsed.data.replicationPolicy !== undefined ? { replicationPolicy: parsed.data.replicationPolicy } : {}),
      },
    );

    return c.json({ data: formatPolicy(policy) });
  });

  // -------------------------------------------------------------------------
  // DELETE /policies/:tenantId — remove a tenant's residency policy
  // -------------------------------------------------------------------------
  routes.delete("/policies/:tenantId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const isAdmin = user.scopes.includes("admin");
    if (!isAdmin) {
      throw new ForbiddenError("Only administrators can manage data residency policies.");
    }

    const tenantId = c.req.param("tenantId");
    if (!tenantId) {
      throw new ValidationError("Tenant ID is required.");
    }

    await dataResidencyService.deletePolicy(tenantId);

    return c.json({ data: { deleted: true } });
  });

  // -------------------------------------------------------------------------
  // GET /transfer-rules — list all cross-region transfer rules
  // -------------------------------------------------------------------------
  routes.get("/transfer-rules", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const isAdmin = user.scopes.includes("admin");
    if (!isAdmin) {
      throw new ForbiddenError("Only administrators can view transfer rules.");
    }

    const rules = await dataResidencyService.listTransferRules();
    return c.json({ data: rules.map(formatTransferRule) });
  });

  // -------------------------------------------------------------------------
  // POST /transfer-rules — create a new cross-region transfer rule
  // -------------------------------------------------------------------------
  routes.post("/transfer-rules", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const isAdmin = user.scopes.includes("admin");
    if (!isAdmin) {
      throw new ForbiddenError("Only administrators can manage transfer rules.");
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = createTransferRuleRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const rule = await dataResidencyService.createTransferRule(
      parsed.data.sourceRegion,
      parsed.data.targetRegion,
      parsed.data.policy,
      parsed.data.justificationRequired,
    );

    return c.json({ data: formatTransferRule(rule) }, 201);
  });

  // -------------------------------------------------------------------------
  // DELETE /transfer-rules/:id — delete a transfer rule
  // -------------------------------------------------------------------------
  routes.delete("/transfer-rules/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const isAdmin = user.scopes.includes("admin");
    if (!isAdmin) {
      throw new ForbiddenError("Only administrators can manage transfer rules.");
    }

    const ruleId = c.req.param("id");
    if (!ruleId) {
      throw new ValidationError("Rule ID is required.");
    }

    await dataResidencyService.deleteTransferRule(ruleId);

    return c.json({ data: { deleted: true } });
  });

  // -------------------------------------------------------------------------
  // GET /audit-log — query data location audit log
  // -------------------------------------------------------------------------
  routes.get("/audit-log", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const rawQuery = {
      region: c.req.query("region"),
      service: c.req.query("service"),
      startTime: c.req.query("startTime"),
      endTime: c.req.query("endTime"),
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    };

    // Strip undefined values before parsing to avoid Zod issues with undefined strings
    const cleanQuery = Object.fromEntries(
      Object.entries(rawQuery).filter(([, v]) => v !== undefined),
    );

    const parsed = queryAuditLogParams.safeParse(cleanQuery);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters.", parsed.error.issues);
    }

    // Admin can query any tenant via tenantId query param; non-admins only see their own
    const isAdmin = user.scopes.includes("admin");
    const queryTenantId = isAdmin
      ? (c.req.query("tenantId") ?? user.tenantId)
      : user.tenantId;

    const logs = await dataResidencyService.queryAuditLog(queryTenantId, {
      ...(parsed.data.region !== undefined ? { region: parsed.data.region } : {}),
      ...(parsed.data.service !== undefined ? { service: parsed.data.service } : {}),
      ...(parsed.data.startTime !== undefined ? { startTime: new Date(parsed.data.startTime) } : {}),
      ...(parsed.data.endTime !== undefined ? { endTime: new Date(parsed.data.endTime) } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
      limit: parsed.data.limit,
    });

    const lastLog = logs[logs.length - 1];
    const nextCursor =
      logs.length === parsed.data.limit && lastLog !== undefined
        ? `${lastLog.timestamp.toISOString()}|${lastLog.id}`
        : null;

    return c.json({
      data: logs.map(formatLocationLog),
      pagination: { nextCursor, total: null },
    });
  });

  // -------------------------------------------------------------------------
  // GET /compliance/:tenantId — check compliance status
  // -------------------------------------------------------------------------
  routes.get("/compliance/:tenantId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const tenantId = c.req.param("tenantId");
    if (!tenantId) {
      throw new ValidationError("Tenant ID is required.");
    }

    const isAdmin = user.scopes.includes("admin");
    if (!isAdmin && user.tenantId !== tenantId) {
      throw new ForbiddenError("You can only check compliance for your own tenant.");
    }

    const result = await dataResidencyService.checkCompliance(tenantId);
    return c.json({ data: result });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Response formatters
// ---------------------------------------------------------------------------

function formatPolicy(row: {
  id: string;
  tenant_id: string;
  region: string;
  storage_class: string;
  replication_policy: string;
  created_at: Date;
  updated_at: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    region: row.region,
    storageClass: row.storage_class,
    replicationPolicy: row.replication_policy,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function formatTransferRule(row: {
  id: string;
  source_region: string;
  target_region: string;
  policy: string;
  justification_required: boolean;
  created_at: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    sourceRegion: row.source_region,
    targetRegion: row.target_region,
    policy: row.policy,
    justificationRequired: row.justification_required,
    createdAt: row.created_at.toISOString(),
  };
}

function formatLocationLog(row: {
  id: string;
  record_id: string;
  tenant_id: string;
  region: string;
  service: string;
  operation: string;
  actor_id: string | null;
  metadata: Record<string, unknown> | null;
  timestamp: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    recordId: row.record_id,
    tenantId: row.tenant_id,
    region: row.region,
    service: row.service,
    operation: row.operation,
    actorId: row.actor_id,
    metadata: row.metadata,
    timestamp: row.timestamp.toISOString(),
  };
}
