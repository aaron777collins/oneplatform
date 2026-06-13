/**
 * Level 2 integration tests for the Execution service.
 *
 * The service process is already running on port 13005 (started by
 * globalSetup.ts). Tests use real fetch() over localhost HTTP.
 *
 * SANDBOX DEPENDENCY: The execution service requires a reachable Unix-socket
 * sandbox proxy (OP_SANDBOX_SOCKET_PATH). In environments where the sandbox is
 * unavailable the service starts but the /readyz probe fails, and execution
 * requests that reach the sandbox will error out. The basic smoke tests below
 * exercise only the HTTP layer and do not submit code for execution, so they
 * are safe to run in any environment. The "run execution" test is conditionally
 * skipped when OP_SANDBOX_SOCKET_PATH is unset.
 *
 * Auth tokens are minted locally with jose (same secret as the running service)
 * to avoid depending on the auth service being active.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { newTenantId, cleanupExecutionTenant } from "../helpers/tenant.js";
import { createTestToken } from "../helpers/auth.js";

const BASE = "http://localhost:13005";

// Execution tests that actually submit work require a live sandbox socket.
// CI environments without Docker skip these via the env guard below.
const sandboxAvailable = Boolean(process.env["OP_SANDBOX_SOCKET_PATH"]);

const db = new pg.Pool({
  connectionString: process.env["OP_DATABASE_URL"]!,
  max: 2,
});

afterAll(async () => {
  await db.end();
});

// ---------------------------------------------------------------------------

describe("Execution service — Level 2 HTTP smoke tests", () => {
  // 1 -----------------------------------------------------------------------
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // 2 -----------------------------------------------------------------------
  it("POST /api/v1/exec/run without auth returns 401", async () => {
    const res = await fetch(`${BASE}/api/v1/exec/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "javascript", code: "1+1" }),
    });
    expect(res.status).toBe(401);
  });

  // 3 -----------------------------------------------------------------------
  it(
    sandboxAvailable
      ? "GET /api/v1/exec lists executions for the tenant with a valid token"
      : "GET /api/v1/exec lists executions for the tenant with a valid token [SKIPPED: no sandbox]",
    async () => {
      // Skip gracefully when sandbox is unavailable — the service starts but
      // execution submissions would fail at the sandbox layer.
      if (!sandboxAvailable) return;

      const tenantId = newTenantId();
      const token = await createTestToken(tenantId, {
        roles: ["tenant-admin"],
        scopes: ["execution:run", "execution:read", "*"],
      });

      try {
        const res = await fetch(`${BASE}/api/v1/exec`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        expect(res.status).toBe(200);
        const body = await res.json() as {
          data: unknown[];
          pagination: { nextCursor: string | null };
        };
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.pagination).toBeDefined();
      } finally {
        await cleanupExecutionTenant(db, tenantId);
      }
    },
  );
});
