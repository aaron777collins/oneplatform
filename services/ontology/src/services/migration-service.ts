import type pg from "pg";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import type { MigrationRepository } from "../repositories/migration-repository.js";
import type { ShadowRegistryRepository } from "../repositories/shadow-registry-repository.js";
import type { EntityRepository } from "../repositories/entity-repository.js";
import type { FieldRow, MigrationRow } from "../repositories/types.js";
import { buildUnionViewDDL, buildUnionViewName, buildDropViewDDL } from "../utils/ddl-builder.js";
import { quotePgIdentifier, tenantSchemaName } from "../utils/pg-identifier.js";
import {
  MigrationNotFoundError,
  MigrationPlanExpiredError,
  MigrationWrongStateError,
  MigrationInProgressError,
} from "./errors.js";

export type ChangeClassification = "backward_compatible" | "breaking";

export interface ChangeDescription {
  type: string;
  fieldSlug?: string;
  fromType?: string;
  toType?: string;
  details?: string;
}

export interface EntityDiff {
  addFields?: Array<{ slug: string; fieldType: string; required: boolean; nullable: boolean; defaultValue?: unknown }>;
  removeFieldSlugs?: string[];
  renameFields?: Array<{ fromSlug: string; toSlug: string }>;
  updateFields?: Array<{ slug: string; name?: string; validationRules?: unknown[]; isIndexed?: boolean; isUnique?: boolean; defaultValue?: unknown }>;
  metadataOnly?: boolean;
  nameChanged?: boolean;
  descriptionChanged?: boolean;
  isPublicChanged?: boolean;
}

const WIDEN_MAP: Record<string, Set<string>> = {
  number: new Set(["string"]),
  boolean: new Set(["string"]),
  date: new Set(["string"]),
  enum: new Set(["string"]),
};

export function classifyChange(
  diff: EntityDiff,
  existingFields: FieldRow[],
  hasData: boolean,
): { classification: ChangeClassification; changes: ChangeDescription[] } {
  const changes: ChangeDescription[] = [];
  let isBreaking = false;

  if (diff.nameChanged) changes.push({ type: "update_metadata", details: "name changed" });
  if (diff.descriptionChanged) changes.push({ type: "update_metadata", details: "description changed" });
  if (diff.isPublicChanged) changes.push({ type: "update_metadata", details: "isPublic changed" });

  if (diff.addFields) {
    for (const field of diff.addFields) {
      if (field.required && !field.nullable && field.defaultValue === undefined && hasData) {
        isBreaking = true;
        changes.push({ type: "add_required_field_no_default", fieldSlug: field.slug });
      } else {
        changes.push({ type: "add_field", fieldSlug: field.slug });
      }
    }
  }

  if (diff.renameFields) {
    for (const rename of diff.renameFields) {
      isBreaking = true;
      changes.push({ type: "rename_field", fieldSlug: rename.fromSlug, details: `renamed to ${rename.toSlug}` });
    }
  }

  if (diff.removeFieldSlugs) {
    for (const slug of diff.removeFieldSlugs) {
      isBreaking = true;
      changes.push({ type: "remove_field", fieldSlug: slug });
    }
  }

  if (diff.updateFields) {
    for (const update of diff.updateFields) {
      const existing = existingFields.find((f) => f.slug === update.slug);
      if (!existing) continue;

      if (update.validationRules !== undefined) {
        const moreRestrictive = isValidationMoreRestrictive(
          existing.validation_rules,
          update.validationRules as FieldRow["validation_rules"],
        );
        if (moreRestrictive && hasData) {
          isBreaking = true;
          changes.push({ type: "tighten_validation", fieldSlug: update.slug });
        } else {
          changes.push({ type: "relax_validation", fieldSlug: update.slug });
        }
      }

      if (update.name !== undefined || update.isIndexed !== undefined || update.isUnique !== undefined) {
        changes.push({ type: "update_field_metadata", fieldSlug: update.slug });
      }
    }
  }

  if (changes.length === 0 && diff.metadataOnly) {
    return { classification: "backward_compatible", changes };
  }

  return {
    classification: isBreaking ? "breaking" : "backward_compatible",
    changes,
  };
}

function isValidationMoreRestrictive(
  existing: FieldRow["validation_rules"],
  updated: FieldRow["validation_rules"],
): boolean {
  const existingMap = new Map(existing.map((r) => [r.type, r]));
  for (const rule of updated) {
    const prev = existingMap.get(rule.type);
    if (!prev) return true;

    switch (rule.type) {
      case "minLength":
      case "min":
        if ((rule.value as number) > (prev.value as number)) return true;
        break;
      case "maxLength":
      case "max":
        if ((rule.value as number) < (prev.value as number)) return true;
        break;
    }
  }
  return false;
}

export function isTypeWiden(fromType: string, toType: string): boolean {
  return WIDEN_MAP[fromType]?.has(toType) ?? false;
}

export interface MigrationServiceDeps {
  db: pg.Pool;
  redis: Redis;
  logger: Logger;
  migrationRepo: MigrationRepository;
  shadowRegistryRepo: ShadowRegistryRepository;
  entityRepo: EntityRepository;
}

export interface MigrationService {
  confirmMigration(migrationId: string, userId: string): Promise<MigrationRow>;
  completeMigration(migrationId: string): Promise<void>;
  failMigration(migrationId: string, error: Record<string, unknown>): Promise<void>;
  rollbackMigration(migrationId: string): Promise<void>;
}

const PLAN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

export function createMigrationService(deps: MigrationServiceDeps): MigrationService {
  const { db, redis, logger, migrationRepo, shadowRegistryRepo, entityRepo } = deps;

  return {
    async confirmMigration(migrationId, userId) {
      const migration = await migrationRepo.findById(migrationId);
      if (!migration) throw new MigrationNotFoundError(`Migration ${migrationId} not found.`);

      if (migration.status !== "pending_confirmation") {
        throw new MigrationWrongStateError(
          `Migration is in '${migration.status}' state, expected 'pending_confirmation'.`,
        );
      }

      const elapsed = Date.now() - migration.created_at.getTime();
      if (elapsed > PLAN_EXPIRY_MS) {
        throw new MigrationPlanExpiredError("Migration confirmation window (1 hour) has expired.");
      }

      const confirmed = await migrationRepo.setConfirmed(migrationId, userId);
      if (!confirmed) {
        throw new MigrationWrongStateError("Migration state changed concurrently.");
      }

      const entity = await entityRepo.findById(migration.tenant_id, migration.entity_id);
      if (!entity) throw new MigrationNotFoundError("Entity no longer exists.");

      // Use a dedicated connection for the advisory lock so it is acquired and
      // released on the same connection. The lock is transaction-scoped
      // (pg_try_advisory_xact_lock) so it is automatically released when the
      // transaction ends, preventing leaks if the process crashes mid-migration.
      const client = await db.connect();
      try {
        await client.query("BEGIN");

        const lockResult = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtext($1))`,
          [migration.entity_id],
        );
        if (!lockResult.rows[0]?.["pg_try_advisory_xact_lock"]) {
          await client.query("ROLLBACK");
          throw new MigrationInProgressError("Another migration is already running for this entity.");
        }

        const schemaName = tenantSchemaName(migration.tenant_id);
        const viewName = buildUnionViewName(entity.slug, migrationId);

        const fields = (migration.change_plan as Record<string, unknown>)["fields"] as Array<{ slug: string; isNew?: boolean; defaultExpression?: string; isRemoved?: boolean }> | undefined;
        if (fields) {
          const viewDDL = buildUnionViewDDL(schemaName, entity.slug, migrationId, fields);
          await client.query(viewDDL);
        }

        await migrationRepo.setRunning(migrationId, viewName);

        await client.query("COMMIT");

        logger.info(`Migration ${migrationId} started for entity ${entity.slug}`);
        await redis.publish("ontology:migration:started", JSON.stringify({
          tenantId: migration.tenant_id,
          entityType: entity.slug,
          fromVersion: migration.from_version,
          toVersion: migration.to_version,
          migrationId,
        }));

        return confirmed;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async completeMigration(migrationId) {
      const migration = await migrationRepo.findById(migrationId);
      if (!migration) return;

      const entity = await entityRepo.findById(migration.tenant_id, migration.entity_id);
      if (!entity) return;

      if (migration.union_view_name) {
        const schemaName = tenantSchemaName(migration.tenant_id);
        await db.query(buildDropViewDDL(schemaName, migration.union_view_name));
      }

      await migrationRepo.setComplete(migrationId);
      await entityRepo.bumpVersion(migration.entity_id);

      await redis.publish("ontology:changed", JSON.stringify({
        tenantId: migration.tenant_id,
        newVersion: entity.version + 1,
        diff: { modifiedEntities: [entity.slug], changeType: "migration_complete" },
      }));
      await redis.publish("ontology:migration:completed", JSON.stringify({
        tenantId: migration.tenant_id,
        entityType: entity.slug,
        migrationId,
      }));

      logger.info(`Migration ${migrationId} completed for entity ${entity.slug}`);
    },

    async failMigration(migrationId, error) {
      const migration = await migrationRepo.findById(migrationId);
      if (!migration) return;

      if (migration.union_view_name) {
        const schemaName = tenantSchemaName(migration.tenant_id);
        await db.query(buildDropViewDDL(schemaName, migration.union_view_name)).catch(() => {});
      }

      await migrationRepo.setFailed(migrationId, error);

      const entity = await entityRepo.findById(migration.tenant_id, migration.entity_id);
      await redis.publish("ontology:migration:failed", JSON.stringify({
        tenantId: migration.tenant_id,
        entityType: entity?.slug ?? "unknown",
        migrationId,
        error,
      }));

      logger.error(`Migration ${migrationId} failed: ${JSON.stringify(error)}`);
    },

    async rollbackMigration(migrationId) {
      const migration = await migrationRepo.findById(migrationId);
      if (!migration) return;

      const entity = await entityRepo.findById(migration.tenant_id, migration.entity_id);
      if (!entity) return;

      const schemaName = tenantSchemaName(migration.tenant_id);
      const batches = await shadowRegistryRepo.findByMigrationId(migrationId);

      for (let i = batches.length - 1; i >= 0; i--) {
        const batch = batches[i]!;
        if (batch.status === "corrupt" || batch.status === "rollback_unavailable") {
          logger.warn(`Batch ${batch.batch_id} rollback unavailable — skipping`);
          continue;
        }

        const shadowTable = `${quotePgIdentifier(batch.schema_name)}.${quotePgIdentifier(batch.table_name)}`;
        const targetTable = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entity.slug)}`;

        const client = await db.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `DELETE FROM ${targetTable} WHERE "_id" IN (SELECT "_id" FROM ${shadowTable})`,
          );

          const targetColsResult = await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
            [schemaName, entity.slug],
          );
          const shadowColsResult = await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
            [batch.schema_name, batch.table_name],
          );

          const targetCols = new Set(targetColsResult.rows.map((r) => r.column_name));
          const shadowCols = new Set(shadowColsResult.rows.map((r) => r.column_name));
          const commonCols = [...targetCols].filter((c) => shadowCols.has(c));

          if (commonCols.length === 0) {
            throw new Error(`No common columns between ${targetTable} and ${shadowTable}`);
          }

          const columnList = commonCols.map((c) => quotePgIdentifier(c)).join(", ");
          await client.query(
            `INSERT INTO ${targetTable} (${columnList}) SELECT ${columnList} FROM ${shadowTable}`,
          );
          await client.query("COMMIT");
          await shadowRegistryRepo.updateStatus(batch.id, "dropped");
          await db.query(`DROP TABLE IF EXISTS ${shadowTable}`);
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          logger.error(`Failed to rollback batch ${batch.batch_id}: ${String(err)}`);
          await shadowRegistryRepo.updateStatus(batch.id, "rollback_unavailable");
        } finally {
          client.release();
        }
      }

      if (migration.union_view_name) {
        await db.query(buildDropViewDDL(schemaName, migration.union_view_name)).catch(() => {});
      }

      await migrationRepo.setRolledBack(migrationId);

      logger.info(`Migration ${migrationId} rolled back for entity ${entity.slug}`);
    },
  };
}
