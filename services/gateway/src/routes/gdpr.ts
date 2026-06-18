// GDPR data subject request route handlers.
//
// Authorization model:
//   - A user may submit requests for themselves (self-service).
//   - A platform-admin may submit requests for any user within their tenant
//     by passing an explicit userId in the request body.
//   - All requests are scoped to the caller's tenant — cross-tenant operations
//     are not possible through this API.
//
// Processing model:
//   Routes accept the request synchronously, persist a gdpr_requests row,
//   then spawn the actual fan-out asynchronously via setImmediate(). The
//   HTTP response returns immediately with status 202 Accepted. Callers
//   poll GET /api/v1/gdpr/requests/:id to track progress.
//
//   WHY async: downstream service calls can take tens of seconds combined.
//   Keeping the HTTP handler open that long would consume a connection slot
//   and risk client-side timeout disconnects before the request completes.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@oneplatform/core";
import type { GdprService } from "../services/gdpr-service.js";
import {
  gdprAccessRequestSchema,
  gdprDeletionRequestSchema,
  gdprExportRequestSchema,
  listGdprRequestsQuery,
} from "../schemas/index.js";

export interface GdprRouteDeps {
  gdprService: GdprService;
}

export function createGdprRoutes(deps: GdprRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { gdprService } = deps;

  // -------------------------------------------------------------------------
  // POST /access-request
  // -------------------------------------------------------------------------
  routes.post("/access-request", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = gdprAccessRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const targetUserId = resolveTargetUserId(
      parsed.data.userId,
      user.userId,
      user.scopes,
    );

    const row = await gdprService.createRequest(
      "access",
      targetUserId,
      user.tenantId,
      user.userId,
    );

    // Fan out asynchronously — HTTP response returns before processing completes.
    setImmediate(() => {
      gdprService
        .handleAccessRequest(row.id, targetUserId, user.tenantId)
        .catch(() => {
          // Errors are persisted to the gdpr_requests row and logged inside the service.
        });
    });

    return c.json({ data: formatRequest(row) }, 202);
  });

  // -------------------------------------------------------------------------
  // POST /deletion-request
  // -------------------------------------------------------------------------
  routes.post("/deletion-request", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = gdprDeletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const targetUserId = resolveTargetUserId(
      parsed.data.userId,
      user.userId,
      user.scopes,
    );

    const row = await gdprService.createRequest(
      "deletion",
      targetUserId,
      user.tenantId,
      user.userId,
    );

    setImmediate(() => {
      gdprService
        .handleDeletionRequest(row.id, targetUserId, user.tenantId)
        .catch(() => {});
    });

    return c.json({ data: formatRequest(row) }, 202);
  });

  // -------------------------------------------------------------------------
  // POST /export-request
  // -------------------------------------------------------------------------
  routes.post("/export-request", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = gdprExportRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body.", parsed.error.issues);
    }

    const targetUserId = resolveTargetUserId(
      parsed.data.userId,
      user.userId,
      user.scopes,
    );

    const row = await gdprService.createRequest(
      "export",
      targetUserId,
      user.tenantId,
      user.userId,
    );

    setImmediate(() => {
      gdprService
        .handleExportRequest(row.id, targetUserId, user.tenantId)
        .catch(() => {});
    });

    return c.json({ data: formatRequest(row) }, 202);
  });

  // -------------------------------------------------------------------------
  // GET /requests — list all GDPR requests for the caller's tenant
  // -------------------------------------------------------------------------
  routes.get("/requests", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const rawQuery = {
      userId: c.req.query("userId"),
      status: c.req.query("status"),
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    };
    const parsed = listGdprRequestsQuery.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ValidationError("Invalid query parameters.", parsed.error.issues);
    }

    // Non-admin users may only list their own requests.
    // exactOptionalPropertyTypes requires we only set keys that have values,
    // so we spread optional fields rather than assigning undefined explicitly.
    const isAdmin = user.scopes.includes("admin");
    const userIdFilter = isAdmin ? parsed.data.userId : user.userId;

    const rows = await gdprService.listRequests(user.tenantId, {
      ...(userIdFilter !== undefined ? { userId: userIdFilter } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
      limit: parsed.data.limit,
    });

    // Build next cursor from the last row so the caller can page forward.
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      rows.length === parsed.data.limit && lastRow !== undefined
        ? `${lastRow.requested_at.toISOString()}|${lastRow.id}`
        : null;

    return c.json({
      data: rows.map(formatRequest),
      pagination: { nextCursor, total: null },
    });
  });

  // -------------------------------------------------------------------------
  // GET /requests/:id — get a single GDPR request by ID
  // -------------------------------------------------------------------------
  routes.get("/requests/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const requestId = c.req.param("id");
    if (!requestId) {
      throw new NotFoundError("Request ID is required.");
    }

    const row = await gdprService.getRequest(requestId, user.tenantId);

    // Non-admin users may only view their own requests.
    const isAdmin = user.scopes.includes("admin");
    if (!isAdmin && row.user_id !== user.userId) {
      throw new ForbiddenError("You do not have access to this GDPR request.");
    }

    return c.json({ data: formatRequest(row) });
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the target user ID for a GDPR request.
 *
 * - If no userId was provided, the caller is requesting for themselves.
 * - If a userId was provided AND differs from the caller, only platform-admin
 *   (admin scope) may act on behalf of another user.
 */
function resolveTargetUserId(
  requestedUserId: string | undefined,
  callerId: string,
  callerScopes: string[],
): string {
  if (requestedUserId === undefined || requestedUserId === callerId) {
    return callerId;
  }

  const isAdmin = callerScopes.includes("admin");
  if (!isAdmin) {
    throw new ForbiddenError(
      "Only platform-admin users can submit GDPR requests on behalf of other users.",
    );
  }

  return requestedUserId;
}

/**
 * Format a GdprRequestRow for the API response.
 * Omits internal fields (error_detail) from non-admin contexts.
 * The route layer does not know the caller's role here, so error_detail is
 * always omitted — admins who need it should query the audit log.
 */
function formatRequest(row: {
  id: string;
  tenant_id: string;
  user_id: string;
  type: string;
  status: string;
  requester_id: string;
  requested_at: Date;
  completed_at: Date | null;
  result_url: string | null;
  error_detail: string | null;
}): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    type: row.type,
    status: row.status,
    requesterId: row.requester_id,
    requestedAt: row.requested_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    resultUrl: row.result_url,
  };
}
