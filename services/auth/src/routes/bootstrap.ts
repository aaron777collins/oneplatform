// Bootstrap route handlers.
// The bootstrap endpoint is a one-shot flow: it's enabled exactly once after
// platform installation and permanently disabled after success (410 Gone).
// The status check is public so the UI can gate the setup wizard.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError } from "@oneplatform/core";
import type { Redis } from "ioredis";
import type { BootstrapService } from "../services/index.js";
import { bootstrapRequest } from "../schemas/index.js";

/** Redis key used to track whether the master key has already been served.
 *  SET NX EX 3600 — once set, the key survives process restarts and
 *  scale-out for one hour before auto-expiring (defense in depth). */
const MASTER_KEY_SERVED_REDIS_KEY = "auth:master-key-served";
const MASTER_KEY_SERVED_TTL_SEC = 3600;

export interface BootstrapRouteDeps {
  bootstrapService: BootstrapService;
  /** Returns the hex-encoded master key, or null if unavailable. */
  getMasterKeyHex?: () => string | null;
  /** Redis client for distributed state (master-key-served flag). */
  redis: Redis;
}

export function createBootstrapRoutes(deps: BootstrapRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { bootstrapService, getMasterKeyHex, redis } = deps;

  // GET /api/v1/bootstrap/status — public, no auth required
  // Returns { completed: boolean; bootstrapToken?: string } so the setup UI
  // knows whether to show the wizard and can pass the token to the completion call.
  routes.get("/api/v1/bootstrap/status", async (c) => {
    const status = await bootstrapService.getStatus();
    return c.json(status);
  });

  // GET /api/v1/bootstrap/master-key — public, no auth required
  // Returns the platform master encryption key exactly once during bootstrap.
  // After bootstrap is complete or after the key has already been served, returns 410 Gone.
  routes.get("/api/v1/bootstrap/master-key", async (c) => {
    const status = await bootstrapService.getStatus();
    if (status.completed) {
      return c.json(
        { error: { code: "BOOTSTRAP_COMPLETED", message: "Bootstrap has already been completed." } },
        410,
      );
    }

    // Check the distributed flag — survives restarts and works across replicas.
    const alreadyServed = await redis.get(MASTER_KEY_SERVED_REDIS_KEY);
    if (alreadyServed !== null) {
      return c.json(
        { error: { code: "MASTER_KEY_ALREADY_SERVED", message: "The master key has already been displayed." } },
        410,
      );
    }

    const hex = getMasterKeyHex?.() ?? process.env["OP_MASTER_KEY"] ?? null;
    if (hex === null) {
      return c.json(
        { error: { code: "MASTER_KEY_UNAVAILABLE", message: "Master key is not available." } },
        503,
      );
    }

    // SET NX EX — only sets the key if it does not already exist (atomic).
    // This ensures exactly one process "wins" the serve even under concurrent requests.
    const wasSet = await redis.set(MASTER_KEY_SERVED_REDIS_KEY, "1", "EX", MASTER_KEY_SERVED_TTL_SEC, "NX");
    if (wasSet === null) {
      // Another request beat us — treat as already served.
      return c.json(
        { error: { code: "MASTER_KEY_ALREADY_SERVED", message: "The master key has already been displayed." } },
        410,
      );
    }

    return c.json({ data: { masterKey: hex } });
  });

  // POST /api/v1/bootstrap — public, token-protected (not JWT auth)
  // Completes the first-run setup: creates the first tenant + platform-admin user.
  routes.post("/api/v1/bootstrap", async (c) => {
    const body = await c.req.json();
    const parsed = bootstrapRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid bootstrap request", parsed.error.issues);
    }

    // Extract the caller's IP for rate limiting inside the service.
    // X-Forwarded-For is set by the reverse proxy; fall back to a placeholder
    // when the service is called directly (e.g. integration tests).
    const ipAddress =
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      c.req.header("X-Real-IP") ??
      "0.0.0.0";

    const result = await bootstrapService.bootstrap({
      ...parsed.data,
      ipAddress,
    });

    if (c.req.header("Origin") !== undefined && result.accessToken !== undefined) {
      const isSecure = c.req.url.startsWith("https://");
      c.res = new Response(JSON.stringify(result), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
      c.header(
        "Set-Cookie",
        `op_access_token=${result.accessToken}; HttpOnly; SameSite=Strict; Path=/${isSecure ? "; Secure" : ""}`,
      );
      if (result.refreshToken !== undefined) {
        c.header(
          "Set-Cookie",
          `op_refresh_token=${result.refreshToken}; HttpOnly; SameSite=Strict; Path=/api/v1/auth/refresh${isSecure ? "; Secure" : ""}`,
        );
      }
      return c.res;
    }

    return c.json(result, 201);
  });

  return routes;
}
