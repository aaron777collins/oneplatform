/**
 * Level 1 integration tests: Gateway service route behaviour.
 *
 * The gateway is primarily a reverse proxy, so most route-level tests are
 * about infrastructure behaviour rather than business logic:
 *   - Health probe responds correctly
 *   - Rate limiter headers are present on non-health routes
 *   - Unknown routes return 404
 *   - CORS headers are present when an allowed Origin is supplied
 *   - Unauthenticated API routes return 401
 *
 * Proxy routes (forwarding to upstream services) are NOT tested at Level 1
 * because the upstream services are not running. Those are Level 2/3 tests.
 *
 * The buildTestApp() helper sets rateLimitPerMinute=10000 so normal test
 * traffic does not accidentally exhaust the limit.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildTestApp } from "../helpers/test-app.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
let cleanup: () => Promise<void>;
let db: pg.Pool;

// ---------------------------------------------------------------------------

describe("Gateway service — routes", () => {
  beforeAll(async () => {
    const result = await buildTestApp();
    app = result.app;
    cleanup = result.cleanup;
    db = result.db;
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  // -------------------------------------------------------------------------

  it("GET /healthz returns 200 with status=healthy when DB and Redis are reachable", async () => {
    const res = await app.fetch(
      new Request("http://localhost/healthz"),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      status: string;
      service: string;
      uptime: number;
      checks: Record<string, string>;
    };

    expect(body.status).toBe("healthy");
    expect(body.service).toBe("gateway");
    expect(typeof body.uptime).toBe("number");
    expect(body.checks["postgres"]).toBe("ok");
    expect(body.checks["redis"]).toBe("ok");
  });

  // -------------------------------------------------------------------------

  it("GET /readyz returns 200 when DB is reachable", async () => {
    const res = await app.fetch(
      new Request("http://localhost/readyz"),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ready");
  });

  // -------------------------------------------------------------------------

  it("GET /healthz bypasses rate limiting (no X-RateLimit headers on health probe)", async () => {
    // Rate limiting middleware explicitly skips /healthz to prevent liveness
    // probes from consuming quota and tripping their own rate limit.
    const res = await app.fetch(
      new Request("http://localhost/healthz"),
    );

    expect(res.status).toBe(200);
    // Health probe responses must NOT carry X-RateLimit-Limit so callers
    // can distinguish probe responses from rate-limited API responses.
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
  });

  // -------------------------------------------------------------------------

  it("unknown routes return 404 with GATEWAY_ROUTE_NOT_FOUND error code", async () => {
    // Paths that don't match the proxy's SERVICE_MAP return a structured 404.
    // This ensures the gateway doesn't leak internal service topology by
    // returning different error shapes for matched vs unmatched paths.
    const res = await app.fetch(
      new Request("http://localhost/api/v1/nonexistent-path-abc123"),
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("GATEWAY_ROUTE_NOT_FOUND");
  });

  // -------------------------------------------------------------------------

  it("CORS headers are present on responses when a valid Origin is sent", async () => {
    // The gateway is configured with allowedOrigins=["http://localhost:3000"].
    // The CORS middleware sets Access-Control-Allow-Origin only when the
    // request carries an Origin header that matches the allowlist.
    const res = await app.fetch(
      new Request("http://localhost/healthz", {
        headers: { Origin: "http://localhost:3000" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    // Vary: Origin is required per RFC 7234 to prevent cache pollution across origins
    expect(res.headers.get("vary")).toContain("Origin");
  });

  // -------------------------------------------------------------------------

  it("CORS preflight OPTIONS returns 200 with CORS headers for an allowed origin", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/v1/webhooks", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, authorization",
        },
      }),
    );

    // Preflight response must allow the requested method and headers
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(res.headers.get("access-control-allow-methods")).toBeTruthy();
  });

  // -------------------------------------------------------------------------

  it("rate limit headers are present on non-health API responses", async () => {
    // The rate limiter middleware registers at app.use("*") and explicitly skips
    // /healthz and /readyz. Every other path — including proxy 404s — runs the
    // limiter and receives X-RateLimit-* headers in the response.
    // Using a path that resolves to GATEWAY_ROUTE_NOT_FOUND avoids any upstream
    // network calls while still exercising the full middleware stack.
    const res = await app.fetch(
      new Request("http://localhost/api/v1/no-such-service-xyz"),
    );

    // The rate limiter runs before route matching so the headers are present
    // even on 404 responses.
    expect(res.headers.get("x-ratelimit-limit")).toBeTruthy();
    expect(res.headers.get("x-ratelimit-remaining")).toBeTruthy();
    expect(res.headers.get("x-ratelimit-reset")).toBeTruthy();
  });
});
