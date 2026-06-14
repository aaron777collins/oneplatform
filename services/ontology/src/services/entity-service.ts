import type pg from "pg";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import { ConflictError } from "@oneplatform/core";
import type { EntityRepository } from "../repositories/entity-repository.js";
import type { FieldRepository } from "../repositories/field-repository.js";
import type { RelationshipRepository } from "../repositories/relationship-repository.js";
import type { MigrationRepository } from "../repositories/migration-repository.js";
import type { EntityRow, FieldRow, CreateFieldData } from "../repositories/types.js";
import { buildCreateTableDDL, buildRlsDDL, buildAddColumnDDL, buildCreateIndexDDL, buildDropColumnDDL } from "../utils/ddl-builder.js";
import type { FieldDDLSpec } from "../utils/ddl-builder.js";
import { quotePgIdentifier, tenantSchemaName, deriveSlug, isReservedSlug } from "../utils/pg-identifier.js";
import type { FieldType } from "../utils/field-type-to-pg.js";
import { classifyChange } from "./migration-service.js";
import type { EntityDiff, ChangeDescription } from "./migration-service.js";
import {
  EntityNotFoundError,
  SlugConflictError,
  ReservedSlugError,
  RefNotFoundError,
  EntityHasDataError,
  MigrationInProgressError,
} from "./errors.js";

export interface EntityServiceDeps {
  db: pg.Pool;
  redis: Redis;
  logger: Logger;
  entityRepo: EntityRepository;
  fieldRepo: FieldRepository;
  relationshipRepo: RelationshipRepository;
  migrationRepo: MigrationRepository;
}

export interface EntityDetail {
  id: string;
  name: string;
  slug: string;
  version: number;
  description: string | null;
  isPublic: boolean;
  fields: FieldDetail[];
  createdAt: string;
  updatedAt: string;
}

export interface FieldDetail {
  id: string;
  name: string;
  slug: string;
  fieldType: string;
  required: boolean;
  nullable: boolean;
  defaultValue: unknown;
  validationRules: unknown[];
  enumValues: string[] | null;
  arrayItemType: string | null;
  refEntityId: string | null;
  isIndexed: boolean;
  isUnique: boolean;
  sortOrder: number;
  systemGenerated: boolean;
}

export interface CreateEntityInput {
  name: string;
  slug?: string;
  description?: string;
  isPublic?: boolean;
  fields: Array<{
    name: string;
    slug?: string;
    fieldType: FieldType;
    required?: boolean;
    nullable?: boolean;
    defaultValue?: unknown;
    validationRules?: unknown[];
    enumValues?: string[];
    arrayItemType?: string;
    refEntitySlug?: string;
    isIndexed?: boolean;
    isUnique?: boolean;
  }>;
}

export interface PatchEntityInput {
  name?: string;
  description?: string | null;
  isPublic?: boolean;
  addFields?: Array<{
    name: string;
    slug?: string;
    fieldType: FieldType;
    required?: boolean;
    nullable?: boolean;
    defaultValue?: unknown;
    validationRules?: unknown[];
    enumValues?: string[];
    arrayItemType?: string;
    refEntitySlug?: string;
    isIndexed?: boolean;
    isUnique?: boolean;
  }>;
  removeFieldSlugs?: string[];
  renameFields?: Array<{
    fromSlug: string;
    toSlug: string;
  }>;
  updateFields?: Array<{
    slug: string;
    name?: string;
    validationRules?: unknown[];
    isIndexed?: boolean;
    isUnique?: boolean;
    defaultValue?: unknown;
  }>;
}

export interface OntologyDiffChange {
  op: "add" | "remove" | "modify";
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface OntologyDiffResult {
  changes: OntologyDiffChange[];
  isBreaking: boolean;
  requiresMigration: boolean;
}

export interface EntityService {
  createEntity(tenantId: string, userId: string, input: CreateEntityInput): Promise<EntityDetail>;
  getEntity(tenantId: string, entityType: string): Promise<EntityDetail>;
  listEntities(tenantId: string, cursor?: string, limit?: number): Promise<{ data: EntityDetail[]; nextCursor: string | null }>;
  patchEntity(tenantId: string, userId: string, entityType: string, input: PatchEntityInput): Promise<{
    entity?: EntityDetail;
    migration?: { migrationId: string; changeType: string; changes: ChangeDescription[] };
    changeType: "backward_compatible" | "breaking";
  }>;
  deleteEntity(tenantId: string, entityType: string, confirm?: boolean): Promise<void>;
  validateRecord(tenantId: string, entityType: string, data: Record<string, unknown>): Promise<{ valid: boolean; errors: Array<{ field: string; code: string; message: string }> }>;
  /**
   * Compute a non-destructive diff of `patch` against the current live schema for
   * `entityType`. Returns the set of logical changes without applying them.
   */
  diffEntity(tenantId: string, entityType: string, patch: PatchEntityInput): Promise<OntologyDiffResult>;
}

export function createEntityService(deps: EntityServiceDeps): EntityService {
  const { db, redis, logger, entityRepo, fieldRepo, relationshipRepo, migrationRepo } = deps;

  function toFieldDetail(f: FieldRow): FieldDetail {
    return {
      id: f.id,
      name: f.name,
      slug: f.slug,
      fieldType: f.field_type,
      required: f.required,
      nullable: f.nullable,
      defaultValue: f.default_value,
      validationRules: f.validation_rules,
      enumValues: f.enum_values,
      arrayItemType: f.array_item_type,
      refEntityId: f.ref_entity_id,
      isIndexed: f.is_indexed,
      isUnique: f.is_unique,
      sortOrder: f.sort_order,
      systemGenerated: f.system_generated,
    };
  }

  function toEntityDetail(entity: EntityRow, fields: FieldRow[]): EntityDetail {
    return {
      id: entity.id,
      name: entity.name,
      slug: entity.slug,
      version: entity.version,
      description: entity.description,
      isPublic: entity.is_public,
      fields: fields.map(toFieldDetail),
      createdAt: entity.created_at.toISOString(),
      updatedAt: entity.updated_at.toISOString(),
    };
  }

  function toFieldDDLSpec(field: { slug: string; fieldType: FieldType; required?: boolean; nullable?: boolean; defaultValue?: unknown; isUnique?: boolean; enumValues?: string[]; refEntitySlug?: string }): FieldDDLSpec {
    return {
      slug: field.slug,
      fieldType: field.fieldType,
      required: field.required ?? false,
      nullable: field.nullable ?? true,
      defaultValue: field.defaultValue,
      isUnique: field.isUnique ?? false,
      ...(field.enumValues ? { enumValues: field.enumValues } : {}),
      ...(field.refEntitySlug ? { refEntitySlug: field.refEntitySlug } : {}),
    };
  }

  async function resolveRefEntityId(tenantId: string, refEntitySlug: string): Promise<string> {
    const refEntity = await entityRepo.findBySlug(tenantId, refEntitySlug);
    if (!refEntity) throw new RefNotFoundError(`Referenced entity '${refEntitySlug}' not found.`);
    return refEntity.id;
  }

  async function publishOntologyChanged(tenantId: string, newVersion: number, diff: Record<string, unknown>): Promise<void> {
    await redis.publish("ontology:changed", JSON.stringify({ tenantId, newVersion, diff }));
  }

  return {
    async createEntity(tenantId, userId, input) {
      const slug = input.slug ?? deriveSlug(input.name);
      if (isReservedSlug(slug)) {
        throw new ReservedSlugError(`Slug '${slug}' is reserved.`);
      }

      const existing = await entityRepo.findBySlug(tenantId, slug);
      if (existing) {
        throw new SlugConflictError(`Entity slug '${slug}' already exists.`);
      }

      const schemaName = tenantSchemaName(tenantId);

      const fieldSpecs: FieldDDLSpec[] = [];
      const fieldCreateData: CreateFieldData[] = [];

      for (let i = 0; i < input.fields.length; i++) {
        const f = input.fields[i]!;
        const fSlug = f.slug ?? deriveSlug(f.name);
        if (isReservedSlug(fSlug)) {
          throw new ReservedSlugError(`Field slug '${fSlug}' is reserved.`);
        }

        let refEntityId: string | undefined;
        if (f.fieldType === "reference" && f.refEntitySlug) {
          refEntityId = await resolveRefEntityId(tenantId, f.refEntitySlug);
        }

        fieldSpecs.push(toFieldDDLSpec({ ...f, slug: fSlug }));
        fieldCreateData.push({
          entity_id: "",
          tenant_id: tenantId,
          name: f.name,
          slug: fSlug,
          field_type: f.fieldType,
          ...(f.required !== undefined ? { required: f.required } : {}),
          ...(f.nullable !== undefined ? { nullable: f.nullable } : {}),
          ...(f.defaultValue !== undefined ? { default_value: f.defaultValue } : {}),
          ...(f.validationRules ? { validation_rules: f.validationRules as FieldRow["validation_rules"] } : {}),
          ...(f.enumValues ? { enum_values: f.enumValues } : {}),
          ...(f.arrayItemType ? { array_item_type: f.arrayItemType } : {}),
          ...(refEntityId ? { ref_entity_id: refEntityId } : {}),
          ...(f.isIndexed !== undefined ? { is_indexed: f.isIndexed } : {}),
          ...(f.isUnique !== undefined ? { is_unique: f.isUnique } : {}),
          sort_order: i,
        });
      }

      const client = await db.connect();
      try {
        await client.query("BEGIN");

        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(schemaName)}`);

        const entityResult = await client.query<EntityRow>(
          `INSERT INTO ontology.entities (tenant_id, name, slug, description, is_public, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [tenantId, input.name, slug, input.description ?? null, input.isPublic ?? false, userId],
        );
        const entity = entityResult.rows[0]!;

        for (const fd of fieldCreateData) {
          fd.entity_id = entity.id;
        }

        const createdFields: FieldRow[] = [];
        for (const fd of fieldCreateData) {
          const fieldResult = await client.query<FieldRow>(
            `INSERT INTO ontology.fields
             (entity_id, tenant_id, name, slug, field_type, required, nullable,
              default_value, validation_rules, enum_values, array_item_type,
              ref_entity_id, is_indexed, is_unique, sort_order, system_generated)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             RETURNING *`,
            [
              fd.entity_id, fd.tenant_id, fd.name, fd.slug, fd.field_type,
              fd.required ?? false, fd.nullable ?? true,
              fd.default_value !== undefined ? JSON.stringify(fd.default_value) : null,
              JSON.stringify(fd.validation_rules ?? []),
              fd.enum_values ?? null, fd.array_item_type ?? null,
              fd.ref_entity_id ?? null, fd.is_indexed ?? false, fd.is_unique ?? false,
              fd.sort_order ?? 0, fd.system_generated ?? false,
            ],
          );
          createdFields.push(fieldResult.rows[0]!);
        }

        const createTableDDL = buildCreateTableDDL(schemaName, slug, fieldSpecs);
        await client.query(createTableDDL);

        const rlsDDL = buildRlsDDL(schemaName, slug, tenantId);
        for (const stmt of rlsDDL.split(";\n")) {
          if (stmt.trim()) await client.query(stmt);
        }

        await client.query("COMMIT");

        // Indexes are created outside the transaction (CONCURRENTLY)
        for (const f of input.fields) {
          const fSlug = f.slug ?? deriveSlug(f.name);
          if (f.isIndexed) {
            const gin = f.fieldType === "json" || f.fieldType === "array";
            try {
              await db.query(buildCreateIndexDDL(schemaName, slug, fSlug, { concurrent: true, gin }));
            } catch (err) {
              logger.warn(`Index creation failed for ${slug}.${fSlug}: ${String(err)}`);
            }
          }
        }

        await publishOntologyChanged(tenantId, entity.version, {
          addedEntities: [slug],
          removedEntities: [],
          modifiedEntities: [],
          changeType: "add_entity",
        });

        logger.info(`Created entity ${slug} (${entity.id}) for tenant ${tenantId}`);
        return toEntityDetail(entity, createdFields);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async getEntity(tenantId, entityType) {
      const entity = await entityRepo.findBySlug(tenantId, entityType);
      if (!entity) throw new EntityNotFoundError(`Entity '${entityType}' not found.`);
      const fields = await fieldRepo.findByEntityId(entity.id);
      return toEntityDetail(entity, fields);
    },

    async listEntities(tenantId, cursor, limit = 50) {
      const entities = await entityRepo.findByTenantId(tenantId, cursor, limit);
      const data: EntityDetail[] = [];
      for (const e of entities) {
        const fields = await fieldRepo.findByEntityId(e.id);
        data.push(toEntityDetail(e, fields));
      }
      const nextCursor = data.length === limit && data.length > 0 ? data[data.length - 1]!.id : null;
      return { data, nextCursor };
    },

    async patchEntity(tenantId, userId, entityType, input) {
      const entity = await entityRepo.findBySlug(tenantId, entityType);
      if (!entity) throw new EntityNotFoundError(`Entity '${entityType}' not found.`);

      const activeMigration = await migrationRepo.findActiveByEntityId(entity.id);
      if (activeMigration) {
        throw new MigrationInProgressError("A migration is already in progress for this entity.");
      }

      const existingFields = await fieldRepo.findByEntityId(entity.id);
      const schemaName = tenantSchemaName(tenantId);

      const hasData = await entityRepo.countDataRows(schemaName, entity.slug) > 0;

      const diff: EntityDiff = {
        ...(input.addFields ? {
          addFields: input.addFields.map((f) => ({
            slug: f.slug ?? deriveSlug(f.name),
            fieldType: f.fieldType,
            required: f.required ?? false,
            nullable: f.nullable ?? true,
            ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
          })),
        } : {}),
        ...(input.removeFieldSlugs ? { removeFieldSlugs: input.removeFieldSlugs } : {}),
        ...(input.renameFields ? { renameFields: input.renameFields } : {}),
        ...(input.updateFields ? { updateFields: input.updateFields } : {}),
        ...(input.name !== undefined ? { nameChanged: true } : {}),
        ...(input.description !== undefined ? { descriptionChanged: true } : {}),
        ...(input.isPublic !== undefined ? { isPublicChanged: true } : {}),
        ...((!input.addFields?.length && !input.removeFieldSlugs?.length && !input.renameFields?.length && !input.updateFields?.length) ? { metadataOnly: true } : {}),
      };

      const { classification, changes } = classifyChange(diff, existingFields, hasData);

      if (classification === "breaking") {
        const migration = await migrationRepo.create({
          tenant_id: tenantId,
          entity_id: entity.id,
          from_version: entity.version,
          to_version: entity.version + 1,
          change_type: changes.length === 1 ? changes[0]!.type : "compound",
          is_breaking: true,
          change_plan: { changes, fields: buildMigrationFieldSpec(existingFields, diff) },
        });

        return {
          migration: { migrationId: migration.id, changeType: migration.change_type, changes },
          changeType: "breaking",
        };
      }

      // Backward-compatible: apply immediately
      const client = await db.connect();
      try {
        await client.query("BEGIN");

        // Update entity metadata
        const updateData: Record<string, unknown> = {};
        if (input.name !== undefined) updateData["name"] = input.name;
        if (input.description !== undefined) updateData["description"] = input.description;
        if (input.isPublic !== undefined) updateData["is_public"] = input.isPublic;

        const updated = await entityRepo.updateOptimistic(
          entity.id, tenantId, entity.version,
          {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.isPublic !== undefined ? { is_public: input.isPublic } : {}),
          },
        );
        if (!updated) {
          throw new ConflictError("Entity was modified since you last fetched it. Fetch the latest version and retry.");
        }

        // Add new fields
        if (input.addFields) {
          for (let i = 0; i < input.addFields.length; i++) {
            const f = input.addFields[i]!;
            const fSlug = f.slug ?? deriveSlug(f.name);

            let refEntityId: string | undefined;
            if (f.fieldType === "reference" && f.refEntitySlug) {
              refEntityId = await resolveRefEntityId(tenantId, f.refEntitySlug);
            }

            await client.query(
              `INSERT INTO ontology.fields
               (entity_id, tenant_id, name, slug, field_type, required, nullable,
                default_value, validation_rules, enum_values, array_item_type,
                ref_entity_id, is_indexed, is_unique, sort_order)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
              [
                entity.id, tenantId, f.name, fSlug, f.fieldType,
                f.required ?? false, f.nullable ?? true,
                f.defaultValue !== undefined ? JSON.stringify(f.defaultValue) : null,
                JSON.stringify(f.validationRules ?? []),
                f.enumValues ?? null, f.arrayItemType ?? null,
                refEntityId ?? null, f.isIndexed ?? false, f.isUnique ?? false,
                existingFields.length + i,
              ],
            );

            const ddl = buildAddColumnDDL(schemaName, entity.slug, toFieldDDLSpec({ ...f, slug: fSlug }));
            for (const stmt of ddl.split(";\n")) {
              if (stmt.trim()) await client.query(stmt);
            }
          }
        }

        // Update existing fields
        if (input.updateFields) {
          for (const uf of input.updateFields) {
            const field = existingFields.find((f) => f.slug === uf.slug);
            if (!field) continue;

            await fieldRepo.update(field.id, {
              ...(uf.name !== undefined ? { name: uf.name } : {}),
              ...(uf.validationRules ? { validation_rules: uf.validationRules as FieldRow["validation_rules"] } : {}),
              ...(uf.isIndexed !== undefined ? { is_indexed: uf.isIndexed } : {}),
              ...(uf.isUnique !== undefined ? { is_unique: uf.isUnique } : {}),
              ...(uf.defaultValue !== undefined ? { default_value: uf.defaultValue } : {}),
            });
          }
        }

        await client.query("COMMIT");

        // Create indexes outside transaction
        if (input.addFields) {
          for (const f of input.addFields) {
            if (f.isIndexed) {
              const fSlug = f.slug ?? deriveSlug(f.name);
              const gin = f.fieldType === "json" || f.fieldType === "array";
              try {
                await db.query(buildCreateIndexDDL(schemaName, entity.slug, fSlug, { concurrent: true, gin }));
              } catch (err) {
                logger.warn(`Index creation failed: ${String(err)}`);
              }
            }
          }
        }

        const updatedFields = await fieldRepo.findByEntityId(entity.id);
        const updatedEntity = await entityRepo.findBySlug(tenantId, entityType);
        if (!updatedEntity) throw new EntityNotFoundError(`Entity disappeared.`);

        await publishOntologyChanged(tenantId, updatedEntity.version, {
          addedEntities: [],
          removedEntities: [],
          modifiedEntities: [entity.slug],
          changeType: "other",
        });

        return {
          entity: toEntityDetail(updatedEntity, updatedFields),
          changeType: "backward_compatible",
        };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async deleteEntity(tenantId, entityType, confirm) {
      const entity = await entityRepo.findBySlug(tenantId, entityType);
      if (!entity) throw new EntityNotFoundError(`Entity '${entityType}' not found.`);

      const schemaName = tenantSchemaName(tenantId);
      const dataCount = await entityRepo.countDataRows(schemaName, entity.slug);

      if (dataCount > 0 && !confirm) {
        throw new EntityHasDataError(
          `Entity '${entityType}' has ${dataCount} records. Pass confirm=true to proceed.`,
        );
      }

      await entityRepo.softDelete(entity.id, tenantId);
      await fieldRepo.softDeleteByEntityId(entity.id);

      await publishOntologyChanged(tenantId, entity.version + 1, {
        addedEntities: [],
        removedEntities: [entity.slug],
        modifiedEntities: [],
        changeType: "remove_entity",
      });

      logger.info(`Soft-deleted entity ${entityType} for tenant ${tenantId}`);
    },

    async validateRecord(tenantId, entityType, data) {
      const { buildCreateInputSchema } = await import("./field-service.js");
      const entity = await entityRepo.findBySlug(tenantId, entityType);
      if (!entity) throw new EntityNotFoundError(`Entity '${entityType}' not found.`);
      const fields = await fieldRepo.findByEntityId(entity.id);
      const schema = buildCreateInputSchema(fields);
      const result = schema.safeParse(data);

      if (result.success) {
        return { valid: true, errors: [] };
      }

      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      }));

      return { valid: false, errors };
    },

    async diffEntity(tenantId, entityType, patch) {
      const entity = await entityRepo.findBySlug(tenantId, entityType);
      if (!entity) throw new EntityNotFoundError(`Entity '${entityType}' not found.`);

      const existingFields = await fieldRepo.findByEntityId(entity.id);

      // Build the EntityDiff shape that classifyChange understands, without
      // mutating the database (this is a read-only preview operation).
      const diff: EntityDiff = {
        ...(patch.addFields ? {
          addFields: patch.addFields.map((f) => ({
            slug: f.slug ?? deriveSlug(f.name),
            fieldType: f.fieldType,
            required: f.required ?? false,
            nullable: f.nullable ?? true,
            ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
          })),
        } : {}),
        ...(patch.removeFieldSlugs ? { removeFieldSlugs: patch.removeFieldSlugs } : {}),
        ...(patch.renameFields ? { renameFields: patch.renameFields } : {}),
        ...(patch.updateFields ? { updateFields: patch.updateFields } : {}),
        ...(patch.name !== undefined ? { nameChanged: true } : {}),
        ...(patch.description !== undefined ? { descriptionChanged: true } : {}),
        ...(patch.isPublic !== undefined ? { isPublicChanged: true } : {}),
        ...(!patch.addFields?.length && !patch.removeFieldSlugs?.length &&
          !patch.renameFields?.length && !patch.updateFields?.length
          ? { metadataOnly: true }
          : {}),
      };

      // hasData check is required by classifyChange to determine whether adding a
      // required-no-default field is breaking. A read on countDataRows is cheaper
      // than a full table scan — it queries the pg_stat metadata table.
      const hasData = await entityRepo.countDataRows(tenantSchemaName(tenantId), entity.slug) > 0;
      const { classification, changes } = classifyChange(diff, existingFields, hasData);

      // Map the internal ChangeDescription list to the canonical diff change shape.
      const diffChanges: OntologyDiffChange[] = changes.map((c) => {
        if (c.type === "add_field" || c.type === "add_required_field_no_default") {
          return { op: "add" as const, path: `/fields/${c.fieldSlug ?? ""}` };
        }
        if (c.type === "remove_field") {
          return { op: "remove" as const, path: `/fields/${c.fieldSlug ?? ""}` };
        }
        if (c.type === "rename_field") {
          return { op: "modify" as const, path: `/fields/${c.fieldSlug ?? ""}`, to: c.details };
        }
        return { op: "modify" as const, path: c.details ?? c.type };
      });

      return {
        changes: diffChanges,
        isBreaking: classification === "breaking",
        requiresMigration: classification === "breaking",
      };
    },
  };
}

function buildMigrationFieldSpec(
  existingFields: FieldRow[],
  diff: EntityDiff,
): Array<{ slug: string; isNew?: boolean; defaultExpression?: string; isRemoved?: boolean }> {
  const specs: Array<{ slug: string; isNew?: boolean; defaultExpression?: string; isRemoved?: boolean }> = [];

  for (const f of existingFields) {
    if (diff.removeFieldSlugs?.includes(f.slug)) {
      specs.push({ slug: f.slug, isRemoved: true });
    } else {
      specs.push({ slug: f.slug });
    }
  }

  if (diff.addFields) {
    for (const f of diff.addFields) {
      const defaultExpr = f.defaultValue !== undefined
        ? (typeof f.defaultValue === "string" ? `'${f.defaultValue}'` : String(f.defaultValue))
        : "NULL";
      specs.push({ slug: f.slug, isNew: true, defaultExpression: defaultExpr });
    }
  }

  return specs;
}
