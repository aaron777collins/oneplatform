// Bootstrap route handlers.
// The bootstrap endpoint is a one-shot flow: it's enabled exactly once after
// platform installation and permanently disabled after success (410 Gone).
// The status check is public so the UI can gate the setup wizard.

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError } from "@oneplatform/core";
import type { BootstrapService } from "../services/index.js";
import { bootstrapRequest } from "../schemas/index.js";

export interface BootstrapRouteDeps {
  bootstrapService: BootstrapService;
}

export function createBootstrapRoutes(deps: BootstrapRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { bootstrapService } = deps;

  // GET /api/v1/bootstrap/status — public, no auth required
  // Returns { completed: boolean } so the setup UI knows whether to show the wizard.
  routes.get("/api/v1/bootstrap/status", async (c) => {
    const status = await bootstrapService.getStatus();
    return c.json(status);
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
