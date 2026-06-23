import type { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { healthz, readyz } from "@oneplatform/core";
import type { EntityRouteDeps } from "./entities.js";
import type { MigrationRouteDeps } from "./migrations.js";
import type { MappingRuleRouteDeps } from "./mapping-rules.js";
import type { DraftRouteDeps } from "./drafts.js";
import type { InternalRouteDeps } from "./internal.js";
import type { QueryRouteDeps } from "./query.js";
import { createEntityRoutes } from "./entities.js";
import { createMigrationRoutes } from "./migrations.js";
import { createMappingRuleRoutes } from "./mapping-rules.js";
import { createDraftRoutes } from "./drafts.js";
import { createInternalRoutes } from "./internal.js";
import { createQueryRoutes } from "./query.js";
import type pg from "pg";
import type { Redis } from "ioredis";

export interface RegisterRoutesConfig
  extends EntityRouteDeps,
    MigrationRouteDeps,
    MappingRuleRouteDeps,
    DraftRouteDeps,
    InternalRouteDeps,
    QueryRouteDeps {
  db: pg.Pool;
  redis: Redis;
  serviceName: string;
  version: string;
}

export function registerRoutes(
  app: Hono<{ Variables: AppVariables }>,
  config: RegisterRoutesConfig,
): void {
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

  // Query routes must be registered before entity routes so /api/v1/ontology/query
  // is matched before /api/v1/ontology/:entityType.
  // Migration routes must also precede entity routes for the same reason.
  app.route("/", createQueryRoutes(config));
  app.route("/", createMigrationRoutes(config));
  app.route("/", createDraftRoutes(config));
  app.route("/", createEntityRoutes(config));
  app.route("/", createMappingRuleRoutes(config));
  app.route("/", createInternalRoutes(config));
}

export { createEntityRoutes } from "./entities.js";
export type { EntityRouteDeps } from "./entities.js";

export { createMigrationRoutes } from "./migrations.js";
export type { MigrationRouteDeps } from "./migrations.js";

export { createMappingRuleRoutes } from "./mapping-rules.js";
export type { MappingRuleRouteDeps } from "./mapping-rules.js";

export { createDraftRoutes } from "./drafts.js";
export type { DraftRouteDeps } from "./drafts.js";

export { createInternalRoutes } from "./internal.js";
export type { InternalRouteDeps } from "./internal.js";

export { createQueryRoutes } from "./query.js";
export type { QueryRouteDeps } from "./query.js";
