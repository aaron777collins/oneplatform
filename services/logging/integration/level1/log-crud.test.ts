/**
 * Level 1 integration tests: Logging service log events and audit events.
 *
 * WHY direct DB writes: the only write path for log events in Level 1 is either
 * the Redis pub/sub channel (background job, disabled) or the internal HTTP
 * ingest route (requires service-to-service Ed25519 auth, not available in L1
 * without pre-generated key pairs). Direct DB inserts via the superuser pool
 * are the correct Level 1 pattern — they let tests control exactly what data
 * exists before calling the read endpoints.
 *
 * Tenant isolation: logging.events has no tenant_id column. The test isolation
 * strategy (per tenant.ts) is to use the tenantId as the trace_id value. This
 * means each test's rows are uniquely identifiable for cleanup without needing
 * RLS. Audit events DO have a tenant_id column and are tested for isolation.
 *
 * Token minting: the logging service validates Bearer JWTs against OP_JWT_SECRET.
 * Tests mint tokens directly using the same key (see helpers/jwt.ts) rather than
 * standing up the auth service, which is a separate Level 3 concern.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId } from "../helpers/tenant.js";
import { mintTestToken } from "../helpers/jwt.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
let cleanup: () => Promise<void>;
let db: pg.Pool;

// Access token with admin scope, valid for the duration of the test suite
let adminToken: string;
// Tenant ID for admin token (used for audit event tenant isolation test)
let adminTenantId: string;

// ---------------------------------------------------------------------------
// DB helper: insert a log event row directly (bypasses batch accumulator)
// ---------------------------------------------------------------------------

async function insertLogEvent(opts: {
  traceId: string;
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO logging.events
       (trace_id, service, level, message, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      opts.traceId,
      opts.service,
      opts.level,
      opts.message,
      JSON.stringify(opts.metadata ?? {}),
      opts.createdAt ?? new Date(),
    ],
  );

  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("INSERT INTO logging.events returned no id");
  }
  return id;
}

// ---------------------------------------------------------------------------
// DB helper: insert an audit event row directly
// ---------------------------------------------------------------------------

async function insertAuditEvent(opts: {
  tenantId: string;
  actorId: string;
  actorType: "user" | "service" | "system";
  action: string;
  resourceType: string;
  resourceId: string;
  result: "success" | "failure";
  traceId?: string;
}): Promise<string> {
  const insertResult = await db.query<{ id: string }>(
    `INSERT INTO logging.audit_events
       (trace_id, actor_id, actor_type, tenant_id, action,
        resource_type, resource_id, result, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)
     RETURNING id`,
    [
      opts.traceId ?? opts.tenantId,
      opts.actorId,
      opts.actorType,
      opts.tenantId,
      opts.action,
      opts.resourceType,
      opts.resourceId,
      opts.result,
    ],
  );

  const id = insertResult.rows[0]?.id;
  if (id === undefined) {
    throw new Error("INSERT INTO logging.audit_events returned no id");
  }
  return id;
}

// ---------------------------------------------------------------------------

describe("Logging service — log events", () => {
  beforeAll(async () => {
    const result = await buildTestApp();
    app = result.app;
    cleanup = result.cleanup;
    db = result.db;

    adminTenantId = newTenantId();
    adminToken = await mintTestToken({
      tenantId: adminTenantId,
      roles: ["platform-admin"],
      scopes: ["admin"],
    });
  });

  afterAll(async () => {
    await cleanup();
    // Clean up any rows written during the suite.
    // adminTenantId was used as trace_id in log events and as tenant_id in audit events.
    await db.query("DELETE FROM logging.audit_events WHERE tenant_id = $1", [adminTenantId]);
    await db.query("DELETE FROM logging.events WHERE trace_id = $1", [adminTenantId]);
    await db.end();
  });

  // -------------------------------------------------------------------------

  it("GET /api/v1/logs returns a paginated list of log events", async () => {
    const traceId = newTenantId();

    // Insert two events with a unique trace_id so we can filter just these
    await insertLogEvent({
      traceId,
      service: "test-service",
      level: "info",
      message: "integration test log event A",
    });
    await insertLogEvent({
      traceId,
      service: "test-service",
      level: "warn",
      message: "integration test log event B",
    });

    try {
      const res = await app.fetch(
        new Request(
          `http://localhost/api/v1/logs?traceId=${traceId}&limit=10`,
          { headers: { Authorization: `Bearer ${adminToken}` } },
        ),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: Array<{
          id: string;
          traceId: string;
          service: string;
          level: string;
          message: string;
          createdAt: string;
        }>;
        pagination: { cursor: string | null; limit: number; hasMore: boolean };
      };

      expect(body.data.length).toBe(2);
      // All returned events must carry the filter trace_id
      expect(body.data.every((e) => e.traceId === traceId)).toBe(true);
      expect(body.pagination.limit).toBe(10);
      // Both events fit within limit=10, so no cursor
      expect(body.pagination.hasMore).toBe(false);
    } finally {
      await db.query("DELETE FROM logging.events WHERE trace_id = $1", [traceId]);
    }
  });

  // -------------------------------------------------------------------------

  it("GET /api/v1/logs can filter by service and level", async () => {
    const traceId = newTenantId();

    await insertLogEvent({ traceId, service: "svc-alpha", level: "error", message: "alpha error" });
    await insertLogEvent({ traceId, service: "svc-alpha", level: "info", message: "alpha info" });
    await insertLogEvent({ traceId, service: "svc-beta", level: "error", message: "beta error" });

    try {
      const res = await app.fetch(
        new Request(
          `http://localhost/api/v1/logs?traceId=${traceId}&service=svc-alpha&level=error`,
          { headers: { Authorization: `Bearer ${adminToken}` } },
        ),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: Array<{ service: string; level: string }>;
      };

      // Only the svc-alpha/error row should match
      expect(body.data.length).toBe(1);
      const first = body.data[0];
      expect(first?.service).toBe("svc-alpha");
      expect(first?.level).toBe("error");
    } finally {
      await db.query("DELETE FROM logging.events WHERE trace_id = $1", [traceId]);
    }
  });

  // -------------------------------------------------------------------------

  it("GET /api/v1/logs requires logs:read or admin scope (returns 403 without it)", async () => {
    // Mint a token with no relevant scopes
    const limitedToken = await mintTestToken({
      roles: ["viewer"],
      scopes: ["data:read"], // no logs:read
    });

    const res = await app.fetch(
      new Request("http://localhost/api/v1/logs", {
        headers: { Authorization: `Bearer ${limitedToken}` },
      }),
    );

    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------

  it("GET /api/v1/logs without auth returns 401", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/logs"),
    );

    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------

  it("audit events are isolated between tenants (GET /api/v1/audit-events)", async () => {
    const tenantA = newTenantId();
    const tenantB = newTenantId();

    // Insert audit events for two separate tenants
    await insertAuditEvent({
      tenantId: tenantA,
      actorId: newTenantId(),
      actorType: "user",
      action: "user.login",
      resourceType: "user",
      resourceId: newTenantId(),
      result: "success",
    });
    await insertAuditEvent({
      tenantId: tenantB,
      actorId: newTenantId(),
      actorType: "user",
      action: "user.login",
      resourceType: "user",
      resourceId: newTenantId(),
      result: "failure",
    });

    try {
      // Tenant A token — non-admin, has audit:read scope
      const tokenA = await mintTestToken({
        tenantId: tenantA,
        roles: ["tenant-admin"],
        // tenant-admin does not have audit:read by default; override scopes for test
        scopes: ["audit:read"],
      });

      const resA = await app.fetch(
        new Request("http://localhost/api/v1/audit-events", {
          headers: { Authorization: `Bearer ${tokenA}` },
        }),
      );

      expect(resA.status).toBe(200);
      const bodyA = await resA.json() as {
        data: Array<{ tenantId: string }>;
      };

      // Non-admin token: the route enforces effectiveTenantId = user.tenantId
      // so only tenant A's events are returned regardless of query params.
      const tenantBRowsInA = bodyA.data.filter((e) => e.tenantId === tenantB);
      expect(tenantBRowsInA.length).toBe(0);

      // Tenant A's own event is present
      const tenantARows = bodyA.data.filter((e) => e.tenantId === tenantA);
      expect(tenantARows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await db.query("DELETE FROM logging.audit_events WHERE tenant_id = $1", [tenantA]);
      await db.query("DELETE FROM logging.audit_events WHERE tenant_id = $1", [tenantB]);
    }
  });

  // -------------------------------------------------------------------------

  it("GET /api/v1/logs/:id returns a single log event by id", async () => {
    const traceId = newTenantId();

    const id = await insertLogEvent({
      traceId,
      service: "test-service",
      level: "debug",
      message: "single event lookup test",
      metadata: { key: "value" },
    });

    try {
      const res = await app.fetch(
        new Request(`http://localhost/api/v1/logs/${id}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: {
          id: string;
          traceId: string;
          service: string;
          level: string;
          message: string;
          metadata: Record<string, unknown>;
          createdAt: string;
        };
      };

      expect(body.data.id).toBe(id);
      expect(body.data.traceId).toBe(traceId);
      expect(body.data.service).toBe("test-service");
      expect(body.data.level).toBe("debug");
      expect(body.data.message).toBe("single event lookup test");
      expect(body.data.metadata).toEqual({ key: "value" });
    } finally {
      await db.query("DELETE FROM logging.events WHERE trace_id = $1", [traceId]);
    }
  });
});
