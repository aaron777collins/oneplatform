// Route barrel — assembles all route groups into the Hono application.
// Import this module from the service entry point (src/index.ts) and pass it
// the fully-constructed dependencies.

import type { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { healthz, readyz } from "@oneplatform/core";
import type { BootstrapRouteDeps } from "./bootstrap.js";
import type { AuthRouteDeps } from "./auth.js";
import type { ApiKeyRouteDeps } from "./api-keys.js";
import type { RoleRouteDeps } from "./roles.js";
import type { UserRouteDeps } from "./users.js";
import type { OAuthRouteDeps } from "./oauth.js";
import type { InternalRouteDeps } from "./internal.js";
import { createBootstrapRoutes } from "./bootstrap.js";
import { createAuthRoutes } from "./auth.js";
import { createApiKeyRoutes } from "./api-keys.js";
import { createRoleRoutes } from "./roles.js";
import { createUserRoutes } from "./users.js";
import { createOAuthRoutes } from "./oauth.js";
import { createInternalRoutes } from "./internal.js";
import type pg from "pg";
import type { Redis } from "ioredis";

export interface RegisterRoutesConfig
  extends BootstrapRouteDeps,
    AuthRouteDeps,
    ApiKeyRouteDeps,
    RoleRouteDeps,
    UserRouteDeps,
    OAuthRouteDeps,
    InternalRouteDeps {
  db: pg.Pool;
  redis: Redis;
  serviceName: string;
  version: string;
}

/**
 * Registers all route groups on the given Hono application.
 *
 * Health endpoints are mounted first because they must always respond,
 * even if the auth middleware rejects other routes.
 */
export function registerRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: RegisterRoutesConfig,
): void {
  // Health probes — no auth, no envelope wrapping (core middleware special-cases these)
  app.get(
    "/healthz",
    healthz({ service: config.serviceName, version: config.version }),
  );
  app.get(
    "/readyz",
    readyz({
      service: config.serviceName,
      version: config.version,
      db: config.db,
      redis: config.redis,
    }),
  );

  // Domain route groups
  app.route("/", createBootstrapRoutes(config));
  app.route("/", createAuthRoutes(config));
  app.route("/", createApiKeyRoutes(config));
  app.route("/", createRoleRoutes(config));
  app.route("/", createUserRoutes(config));
  app.route("/", createOAuthRoutes(config));
  app.route("/", createInternalRoutes(config));
}

// Re-export route creators and their dep types for consumers that need to
// compose custom stacks (e.g. integration tests that skip certain groups).
export { createBootstrapRoutes } from "./bootstrap.js";
export type { BootstrapRouteDeps } from "./bootstrap.js";

export { createAuthRoutes } from "./auth.js";
export type { AuthRouteDeps } from "./auth.js";

export { createApiKeyRoutes } from "./api-keys.js";
export type { ApiKeyRouteDeps } from "./api-keys.js";

export { createRoleRoutes } from "./roles.js";
export type { RoleRouteDeps } from "./roles.js";

export { createUserRoutes } from "./users.js";
export type { UserRouteDeps } from "./users.js";

export { createOAuthRoutes } from "./oauth.js";
export type { OAuthRouteDeps } from "./oauth.js";

export { createInternalRoutes } from "./internal.js";
export type { InternalRouteDeps } from "./internal.js";
