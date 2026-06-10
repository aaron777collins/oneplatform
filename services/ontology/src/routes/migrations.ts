import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ForbiddenError } from "@oneplatform/core";
import type { MigrationService } from "../services/migration-service.js";
import type { MigrationRepository } from "../repositories/migration-repository.js";
import { listMigrationsQuery } from "../schemas/index.js";

export interface MigrationRouteDeps {
  migrationService: MigrationService;
  migrationRepo: MigrationRepository;
}

const REQUIRED_READ_SCOPE = "ontology:read";
const REQUIRED_WRITE_SCOPE = "ontology:write";

export function createMigrationRoutes(deps: MigrationRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { migrationService, migrationRepo } = deps;

  routes.get("/api/v1/ontology/migrations", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const query = listMigrationsQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const migrations = await migrationRepo.findByTenantId(
      user.tenantId, query.status, query.cursor, query.limit,
    );

    return c.json({
      data: migrations.map((m) => ({
        id: m.id,
        entityId: m.entity_id,
        fromVersion: m.from_version,
        toVersion: m.to_version,
        changeType: m.change_type,
        isBreaking: m.is_breaking,
        status: m.status,
        createdAt: m.created_at.toISOString(),
      })),
      pagination: {
        nextCursor: migrations.length === query.limit && migrations.length > 0
          ? migrations[migrations.length - 1]!.id
          : null,
        total: migrations.length,
      },
    });
  });

  routes.get("/api/v1/ontology/migrations/:id", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const migration = await migrationRepo.findById(c.req.param("id"));
    if (!migration || migration.tenant_id !== user.tenantId) {
      throw new (await import("../services/errors.js")).MigrationNotFoundError("Migration not found.");
    }

    return c.json({
      id: migration.id,
      entityId: migration.entity_id,
      fromVersion: migration.from_version,
      toVersion: migration.to_version,
      changeType: migration.change_type,
      isBreaking: migration.is_breaking,
      status: migration.status,
      changePlan: migration.change_plan,
      startedAt: migration.started_at?.toISOString() ?? null,
      completedAt: migration.completed_at?.toISOString() ?? null,
      errorDetails: migration.error_details,
      createdAt: migration.created_at.toISOString(),
    });
  });

  routes.post("/api/v1/ontology/migrations/:id/confirm", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    const confirmed = await migrationService.confirmMigration(c.req.param("id"), user.userId);
    return c.json({
      migrationId: confirmed.id,
      status: "confirmed",
      estimatedDurationMs: null,
    }, 202);
  });

  routes.post("/api/v1/ontology/migrations/:id/rollback", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    await migrationService.rollbackMigration(c.req.param("id"));
    return c.json({
      migrationId: c.req.param("id"),
      status: "rolling_back",
    }, 202);
  });

  routes.get("/api/v1/ontology/migrations/:id/status", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const migration = await migrationRepo.findById(c.req.param("id"));
    if (!migration || migration.tenant_id !== user.tenantId) {
      throw new (await import("../services/errors.js")).MigrationNotFoundError("Migration not found.");
    }

    return c.json({
      status: migration.status,
      batchProgress: null,
      estimatedCompletionAt: null,
    });
  });

  return routes;
}
