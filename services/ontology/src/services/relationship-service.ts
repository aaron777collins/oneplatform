import type pg from "pg";
import type { Logger } from "@oneplatform/core";
import type { EntityRepository } from "../repositories/entity-repository.js";
import type { FieldRepository } from "../repositories/field-repository.js";
import type { RelationshipRepository } from "../repositories/relationship-repository.js";
import type { RelationshipRow } from "../repositories/types.js";
import { buildJoinTableDDL, buildCreateIndexDDL, deriveJoinTableName } from "../utils/ddl-builder.js";
import { quotePgIdentifier, tenantSchemaName } from "../utils/pg-identifier.js";
import type { FieldType } from "../utils/field-type-to-pg.js";
import { EntityNotFoundError, RefNotFoundError } from "./errors.js";

export interface CreateRelationshipInput {
  fromEntitySlug: string;
  toEntitySlug: string;
  relationshipType: "1:1" | "1:N" | "M:N";
  fromFieldName: string;
  toFieldName?: string;
  cascadeDelete?: boolean;
}

export interface RelationshipDetail {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  fromFieldName: string;
  toFieldName: string | null;
  joinTableName: string | null;
  cascadeDelete: boolean;
}

export interface RelationshipServiceDeps {
  db: pg.Pool;
  logger: Logger;
  entityRepo: EntityRepository;
  fieldRepo: FieldRepository;
  relationshipRepo: RelationshipRepository;
}

export interface RelationshipService {
  createRelationship(tenantId: string, input: CreateRelationshipInput): Promise<RelationshipDetail>;
  getRelationships(tenantId: string, entitySlug: string): Promise<RelationshipDetail[]>;
  deleteRelationship(tenantId: string, id: string): Promise<void>;
}

export function createRelationshipService(deps: RelationshipServiceDeps): RelationshipService {
  const { db, logger, entityRepo, fieldRepo, relationshipRepo } = deps;

  function toDetail(r: RelationshipRow): RelationshipDetail {
    return {
      id: r.id,
      fromEntityId: r.from_entity_id,
      toEntityId: r.to_entity_id,
      relationshipType: r.relationship_type,
      fromFieldName: r.from_field_name,
      toFieldName: r.to_field_name,
      joinTableName: r.join_table_name,
      cascadeDelete: r.cascade_delete,
    };
  }

  return {
    async createRelationship(tenantId, input) {
      const fromEntity = await entityRepo.findBySlug(tenantId, input.fromEntitySlug);
      if (!fromEntity) throw new EntityNotFoundError(`Entity '${input.fromEntitySlug}' not found.`);

      const toEntity = await entityRepo.findBySlug(tenantId, input.toEntitySlug);
      if (!toEntity) throw new RefNotFoundError(`Target entity '${input.toEntitySlug}' not found.`);

      const schemaName = tenantSchemaName(tenantId);
      const cascade = input.cascadeDelete ?? false;

      const client = await db.connect();
      try {
        await client.query("BEGIN");

        let joinTableName: string | undefined;

        if (input.relationshipType === "M:N") {
          joinTableName = deriveJoinTableName(fromEntity.slug, toEntity.slug);
          const ddl = buildJoinTableDDL(schemaName, fromEntity.slug, toEntity.slug, joinTableName, cascade);
          await client.query(ddl);
        } else {
          // 1:1 or 1:N — add FK column to the "from" entity table
          const fkCol = `${toEntity.slug}_id`;
          const onDelete = cascade ? "CASCADE" : "RESTRICT";
          const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(fromEntity.slug)}`;
          const refTable = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(toEntity.slug)}`;

          await client.query(
            `ALTER TABLE ${table} ADD COLUMN ${quotePgIdentifier(fkCol)} UUID REFERENCES ${refTable}("_id") ON DELETE ${onDelete}`,
          );

          // Register the FK column as a system-generated field in the catalog
          await client.query(
            `INSERT INTO ontology.fields
             (entity_id, tenant_id, name, slug, field_type, required, nullable,
              ref_entity_id, system_generated, validation_rules)
             VALUES ($1, $2, $3, $4, 'reference', false, true, $5, true, '[]')`,
            [fromEntity.id, tenantId, input.fromFieldName, fkCol, toEntity.id],
          );
        }

        const rel = await relationshipRepo.create({
          tenant_id: tenantId,
          from_entity_id: fromEntity.id,
          to_entity_id: toEntity.id,
          relationship_type: input.relationshipType,
          from_field_name: input.fromFieldName,
          ...(input.toFieldName ? { to_field_name: input.toFieldName } : {}),
          ...(joinTableName ? { join_table_name: joinTableName } : {}),
          ...(cascade ? { cascade_delete: cascade } : {}),
        }, client);

        await client.query("COMMIT");

        // Index FK column outside transaction
        if (input.relationshipType !== "M:N") {
          const fkCol = `${toEntity.slug}_id`;
          try {
            await db.query(buildCreateIndexDDL(schemaName, fromEntity.slug, fkCol, { concurrent: true }));
          } catch (err) {
            logger.warn(`FK index creation failed: ${String(err)}`);
          }
        }

        logger.info(`Created ${input.relationshipType} relationship from ${input.fromEntitySlug} to ${input.toEntitySlug}`);
        return toDetail(rel);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async getRelationships(tenantId, entitySlug) {
      const entity = await entityRepo.findBySlug(tenantId, entitySlug);
      if (!entity) throw new EntityNotFoundError(`Entity '${entitySlug}' not found.`);
      const rels = await relationshipRepo.findByEntityId(entity.id);
      return rels.map(toDetail);
    },

    async deleteRelationship(tenantId, id) {
      // Filter by tenant_id to prevent cross-tenant deletion of relationships
      // that share the same UUID (latent gap — this method currently has no route
      // but is closed here before one is added).
      await relationshipRepo.delete(id, tenantId);
    },
  };
}
