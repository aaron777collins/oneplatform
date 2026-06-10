import type { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { healthz, readyz } from "@oneplatform/core";
import type pg from "pg";
import type { Redis } from "ioredis";
import { createLogRoutes } from "./logs.js";
import { createAuditRoutes } from "./audit.js";
import { createInternalRoutes } from "./internal.js";
import type { LogRouteDeps } from "./logs.js";
import type { AuditRouteDeps } from "./audit.js";
import type { InternalRouteDeps } from "./internal.js";

export interface RegisterRoutesConfig
  extends LogRouteDeps,
    AuditRouteDeps,
    InternalRouteDeps {
  db: pg.Pool;
  redis: Redis;
  serviceName: string;
  version: string;
}

export function registerRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: RegisterRoutesConfig
): void {
  app.get(
    "/healthz",
    healthz({ service: config.serviceName, version: config.version })
  );
  app.get(
    "/readyz",
    readyz({
      service: config.serviceName,
      version: config.version,
      db: config.db,
      redis: config.redis,
    })
  );

  app.route("/", createLogRoutes(config));
  app.route("/", createAuditRoutes(config));
  app.route("/", createInternalRoutes(config));
}

export { createLogRoutes } from "./logs.js";
export type { LogRouteDeps } from "./logs.js";

export { createAuditRoutes } from "./audit.js";
export type { AuditRouteDeps } from "./audit.js";

export { createInternalRoutes } from "./internal.js";
export type { InternalRouteDeps } from "./internal.js";
