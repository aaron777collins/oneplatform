// Unit tests for GDPR route handlers.
//
// Routes are tested by constructing a minimal Hono app with the route handlers
// mounted and a pre-populated user context variable, then calling app.fetch()
// directly without a real HTTP server.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createGdprRoutes } from "../routes/gdpr.js";
import type { GdprService } from "../services/gdpr-service.js";
import type { GdprRequestRow } from "../repositories/types.js";
import type { AppVariables } from "@oneplatform/core";
import { errorHandlerMiddleware } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Timer management
//
// Route handlers use setImmediate() to dispatch background GDPR processing so
// the HTTP response returns immediately. We use fake timers in these unit tests
// to prevent the setImmediate callbacks from leaking out of each test scope —
// without this the callbacks fire after the mock has been torn down, causing
// "Cannot read properties of undefined (reading 'catch')" unhandled exceptions.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<GdprRequestRow> = {}): GdprRequestRow {
  return {
    id: "req-0001",
    tenant_id: "tenant-1",
    user_id: "user-1",
    type: "access",
    status: "pending",
    requester_id: "user-1",
    requested_at: new Date("2024-01-01T00:00:00Z"),
    completed_at: null,
    result_url: null,
    error_detail: null,
    ...overrides,
  };
}

function makeGdprService(overrides: Partial<GdprService> = {}): GdprService {
  return {
    createRequest: vi.fn().mockResolvedValue(makeRow()),
    getRequest: vi.fn().mockResolvedValue(makeRow()),
    listRequests: vi.fn().mockResolvedValue([makeRow()]),
    handleAccessRequest: vi.fn().mockResolvedValue({
      userId: "user-1",
      tenantId: "tenant-1",
      exportedAt: "2024-01-01T00:00:00Z",
      profile: {},
      auditLog: [],
    }),
    handleDeletionRequest: vi.fn().mockResolvedValue(undefined),
    handleExportRequest: vi.fn().mockResolvedValue({
      requestId: "req-0001",
      resultUrl: "data:application/json;base64,e30=",
    }),
    ...overrides,
  };
}

/**
 * Creates a Hono app that pre-injects user context so tests don't need a real
 * JWT. Sets the AppVariables.user field directly before reaching route handlers.
 *
 * The error handler is wired so AppErrors translate to correct HTTP status codes
 * rather than falling through as unhandled 500s.
 */
function makeTestApp(
  gdprService: GdprService,
  userContext: Partial<AppVariables["user"]> = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();

  const user: AppVariables["user"] = {
    userId: "user-1",
    tenantId: "tenant-1",
    roles: ["member"],
    scopes: [],
    isGuest: false,
    isService: false,
    emailVerified: true,
    ...userContext,
  };

  // Inject user context before any route is matched
  app.use("*", async (c, next) => {
    c.set("user", user);
    c.set("requestId", "test-request-id");
    await next();
  });

  const gdprRoutes = createGdprRoutes({ gdprService });
  app.route("/", gdprRoutes);

  // Wire error handler so AppErrors (ValidationError, ForbiddenError, etc.)
  // map to their correct HTTP status codes instead of propagating as 500.
  app.onError(errorHandlerMiddleware());

  return app;
}

// ---------------------------------------------------------------------------
// POST /access-request
// ---------------------------------------------------------------------------

describe("POST /access-request", () => {
  it("returns 202 Accepted and creates an access request", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc);

    const res = await app.fetch(
      new Request("http://localhost/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json() as { data: { type: string } };
    expect(body.data.type).toBe("access");
    expect(svc.createRequest).toHaveBeenCalledWith(
      "access",
      "user-1",
      "tenant-1",
      "user-1",
    );
  });

  it("allows admin to specify a different userId", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc, { scopes: ["admin"] });
    const otherUserId = "00000000-0000-0000-0000-000000000099";

    const res = await app.fetch(
      new Request("http://localhost/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: otherUserId }),
      }),
    );

    expect(res.status).toBe(202);
    expect(svc.createRequest).toHaveBeenCalledWith(
      "access",
      otherUserId,
      "tenant-1",
      "user-1",
    );
  });

  it("returns 403 when non-admin specifies a different userId", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc, { scopes: [] });
    const otherUserId = "00000000-0000-0000-0000-000000000099";

    const res = await app.fetch(
      new Request("http://localhost/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: otherUserId }),
      }),
    );

    expect(res.status).toBe(403);
  });

  it("returns 422 when userId is not a valid UUID", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc, { scopes: ["admin"] });

    const res = await app.fetch(
      new Request("http://localhost/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "not-a-uuid" }),
      }),
    );

    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// POST /deletion-request
// ---------------------------------------------------------------------------

describe("POST /deletion-request", () => {
  it("returns 202 and creates a deletion request", async () => {
    const svc = makeGdprService({
      createRequest: vi.fn().mockResolvedValue(makeRow({ type: "deletion" })),
    });
    const app = makeTestApp(svc);

    const res = await app.fetch(
      new Request("http://localhost/deletion-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json() as { data: { type: string } };
    expect(body.data.type).toBe("deletion");
  });
});

// ---------------------------------------------------------------------------
// POST /export-request
// ---------------------------------------------------------------------------

describe("POST /export-request", () => {
  it("returns 202 and creates an export request", async () => {
    const svc = makeGdprService({
      createRequest: vi.fn().mockResolvedValue(makeRow({ type: "export" })),
    });
    const app = makeTestApp(svc);

    const res = await app.fetch(
      new Request("http://localhost/export-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json() as { data: { type: string } };
    expect(body.data.type).toBe("export");
  });
});

// ---------------------------------------------------------------------------
// GET /requests
// ---------------------------------------------------------------------------

describe("GET /requests", () => {
  it("returns 200 with paginated request list for the caller's tenant", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc);

    const res = await app.fetch(
      new Request("http://localhost/requests", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; pagination: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("non-admin user only sees their own requests (userId filter is forced)", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc, { scopes: [] });

    await app.fetch(new Request("http://localhost/requests", { method: "GET" }));

    // The service should have been called with userId = caller's own userId
    expect(svc.listRequests).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("admin can pass a userId filter", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc, { scopes: ["admin"] });
    const otherUserId = "00000000-0000-0000-0000-000000000099";

    await app.fetch(
      new Request(`http://localhost/requests?userId=${otherUserId}`, { method: "GET" }),
    );

    expect(svc.listRequests).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({ userId: otherUserId }),
    );
  });

  it("returns 422 for an invalid status filter", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc, { scopes: ["admin"] });

    const res = await app.fetch(
      new Request("http://localhost/requests?status=invalid-status", { method: "GET" }),
    );

    expect(res.status).toBe(422);
  });

  it("builds nextCursor from last row when result fills the page", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      makeRow({ id: `req-${String(i).padStart(4, "0")}` }),
    );
    const svc = makeGdprService({ listRequests: vi.fn().mockResolvedValue(rows) });
    const app = makeTestApp(svc, { scopes: ["admin"] });

    const res = await app.fetch(
      new Request("http://localhost/requests?limit=50", { method: "GET" }),
    );

    const body = await res.json() as { pagination: { nextCursor: string | null } };
    // Should produce a cursor because exactly 50 rows were returned
    expect(body.pagination.nextCursor).not.toBeNull();
    expect(body.pagination.nextCursor).toContain("|");
  });

  it("returns null nextCursor when fewer rows than limit are returned", async () => {
    const rows = [makeRow()]; // only 1 row, limit defaults to 50
    const svc = makeGdprService({ listRequests: vi.fn().mockResolvedValue(rows) });
    const app = makeTestApp(svc, { scopes: ["admin"] });

    const res = await app.fetch(
      new Request("http://localhost/requests", { method: "GET" }),
    );

    const body = await res.json() as { pagination: { nextCursor: string | null } };
    expect(body.pagination.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /requests/:id
// ---------------------------------------------------------------------------

describe("GET /requests/:id", () => {
  it("returns 200 for the request owner", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc, { userId: "user-1", scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/requests/req-0001", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string } };
    expect(body.data.id).toBe("req-0001");
  });

  it("returns 403 when non-admin accesses another user's request", async () => {
    // getRequest returns a row belonging to "user-other"
    const svc = makeGdprService({
      getRequest: vi.fn().mockResolvedValue(makeRow({ user_id: "user-other" })),
    });
    const app = makeTestApp(svc, { userId: "user-1", scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/requests/req-0001", { method: "GET" }),
    );

    expect(res.status).toBe(403);
  });

  it("allows admin to access any request", async () => {
    // getRequest returns a row belonging to "user-other"
    const svc = makeGdprService({
      getRequest: vi.fn().mockResolvedValue(makeRow({ user_id: "user-other" })),
    });
    const app = makeTestApp(svc, { userId: "user-1", scopes: ["admin"] });

    const res = await app.fetch(
      new Request("http://localhost/requests/req-0001", { method: "GET" }),
    );

    expect(res.status).toBe(200);
  });

  it("propagates 404 from the service when request does not exist", async () => {
    const { NotFoundError } = await import("@oneplatform/core");
    const svc = makeGdprService({
      getRequest: vi.fn().mockRejectedValue(new NotFoundError("GDPR request not found.")),
    });
    const app = makeTestApp(svc);

    const res = await app.fetch(
      new Request("http://localhost/requests/nonexistent", { method: "GET" }),
    );

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Response shape — error_detail is never exposed
// ---------------------------------------------------------------------------

describe("Response shape", () => {
  it("does not include error_detail in the response even when the row has one", async () => {
    const rowWithError = makeRow({ error_detail: "internal service error details" });
    const svc = makeGdprService({
      getRequest: vi.fn().mockResolvedValue(rowWithError),
    });
    const app = makeTestApp(svc, { userId: "user-1", scopes: ["admin"] });

    const res = await app.fetch(
      new Request("http://localhost/requests/req-0001", { method: "GET" }),
    );

    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty("errorDetail");
    expect(body.data).not.toHaveProperty("error_detail");
  });

  it("formats dates as ISO strings", async () => {
    const svc = makeGdprService();
    const app = makeTestApp(svc, { userId: "user-1" });

    const res = await app.fetch(
      new Request("http://localhost/requests/req-0001", { method: "GET" }),
    );

    const body = await res.json() as { data: { requestedAt: string } };
    expect(body.data.requestedAt).toBe("2024-01-01T00:00:00.000Z");
  });
});
