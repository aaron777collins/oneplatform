import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import type { EntityRepository } from "../repositories/entity-repository.js";
import type { FieldRepository } from "../repositories/field-repository.js";
import type { RelationshipRepository } from "../repositories/relationship-repository.js";
import type { MigrationRepository } from "../repositories/migration-repository.js";
import type { EntityRow, FieldRow, RelationshipRow } from "../repositories/types.js";
import { generateTypeScriptInterface, generateZodSchema, generateRouteDefinition } from "./codegen-service.js";
import type { EntityRouteDefinition } from "./codegen-service.js";

export interface EntitySnapshot {
  id: string;
  name: string;
  slug: string;
  version: number;
  isPublic: boolean;
  fields: FieldSnapshot[];
  relationships: RelationshipSnapshot[];
  zodValidator: string;
  tsType: string;
  routeDefinition: EntityRouteDefinition;
  migrationStatus: "idle" | "migrating" | "complete";
  migrationViewName: string | null;
}

export interface FieldSnapshot {
  id: string;
  name: string;
  slug: string;
  fieldType: string;
  required: boolean;
  nullable: boolean;
  defaultValue: unknown;
  enumValues: string[] | null;
  arrayItemType: string | null;
  refEntityId: string | null;
  isIndexed: boolean;
  isUnique: boolean;
}

export interface RelationshipSnapshot {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  fromFieldName: string;
  toFieldName: string | null;
  joinTableName: string | null;
  cascadeDelete: boolean;
}

export interface OntologySnapshot {
  tenantId: string;
  schemaVersion: number;
  fetchedAt: string;
  etag: string;
  entities: EntitySnapshot[];
}

export interface CacheServiceDeps {
  redis: Redis;
  logger: Logger;
  entityRepo: EntityRepository;
  fieldRepo: FieldRepository;
  relationshipRepo: RelationshipRepository;
  migrationRepo: MigrationRepository;
}

export interface CacheService {
  getSnapshot(tenantId: string): Promise<OntologySnapshot>;
  getSnapshotIfChanged(tenantId: string, etag: string): Promise<OntologySnapshot | null>;
  invalidate(tenantId: string): Promise<void>;
}

const CACHE_TTL = 300; // 5 minutes

export function createCacheService(deps: CacheServiceDeps): CacheService {
  const { redis, logger, entityRepo, fieldRepo, relationshipRepo, migrationRepo } = deps;

  async function buildSnapshot(tenantId: string): Promise<OntologySnapshot> {
    const entities = await entityRepo.findByTenantId(tenantId, undefined, 10000);
    const entitySnapshots: EntitySnapshot[] = [];
    let maxVersion = 0;

    const entityIds = entities.map((e) => e.id);

    // Batch-load all fields, relationships, and active migrations in 3 queries
    // instead of 3 queries per entity (N+1 eliminated).  The batch methods
    // short-circuit on empty input so the Promise.all is safe for zero entities.
    const [fieldsByEntityId, relsByEntityId, activeMigrationByEntityId] = await Promise.all([
      fieldRepo.findByEntityIds(entityIds),
      relationshipRepo.findByEntityIds(entityIds),
      migrationRepo.findActiveByEntityIds(entityIds),
    ]);

    for (const entity of entities) {
      const fields = fieldsByEntityId.get(entity.id) ?? [];
      const relationships = relsByEntityId.get(entity.id) ?? [];
      const activeMigration = activeMigrationByEntityId.get(entity.id) ?? null;

      const migrationStatus: "idle" | "migrating" = activeMigration?.status === "running" ? "migrating" : "idle";
      const migrationViewName = activeMigration?.union_view_name ?? null;

      entitySnapshots.push({
        id: entity.id,
        name: entity.name,
        slug: entity.slug,
        version: entity.version,
        isPublic: entity.is_public,
        fields: fields.map((f) => ({
          id: f.id,
          name: f.name,
          slug: f.slug,
          fieldType: f.field_type,
          required: f.required,
          nullable: f.nullable,
          defaultValue: f.default_value,
          enumValues: f.enum_values,
          arrayItemType: f.array_item_type,
          refEntityId: f.ref_entity_id,
          isIndexed: f.is_indexed,
          isUnique: f.is_unique,
        })),
        relationships: relationships.map((r) => ({
          id: r.id,
          fromEntityId: r.from_entity_id,
          toEntityId: r.to_entity_id,
          relationshipType: r.relationship_type,
          fromFieldName: r.from_field_name,
          toFieldName: r.to_field_name,
          joinTableName: r.join_table_name,
          cascadeDelete: r.cascade_delete,
        })),
        zodValidator: generateZodSchema(entity, fields),
        tsType: generateTypeScriptInterface(entity, fields),
        routeDefinition: generateRouteDefinition(entity, fields),
        migrationStatus,
        migrationViewName,
      });

      if (entity.version > maxVersion) maxVersion = entity.version;
    }

    const snapshot: OntologySnapshot = {
      tenantId,
      schemaVersion: maxVersion,
      fetchedAt: new Date().toISOString(),
      etag: "",
      entities: entitySnapshots,
    };

    snapshot.etag = computeEtag(snapshot);

    return snapshot;
  }

  function computeEtag(snapshot: OntologySnapshot): string {
    const hash = createHash("sha256");
    hash.update(snapshot.tenantId);
    hash.update(String(snapshot.schemaVersion));
    for (const e of snapshot.entities) {
      hash.update(e.slug);
      hash.update(String(e.version));
    }
    return hash.digest("hex").slice(0, 16);
  }

  return {
    async getSnapshot(tenantId) {
      const cacheKey = `ontology:snapshot:${tenantId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as OntologySnapshot;
        } catch {
          // corrupted cache, rebuild
        }
      }

      const snapshot = await buildSnapshot(tenantId);
      await redis.set(cacheKey, JSON.stringify(snapshot), "EX", CACHE_TTL);
      return snapshot;
    },

    async getSnapshotIfChanged(tenantId, etag) {
      const snapshot = await this.getSnapshot(tenantId);
      if (snapshot.etag === etag) return null;
      return snapshot;
    },

    async invalidate(tenantId) {
      const cacheKey = `ontology:snapshot:${tenantId}`;
      await redis.del(cacheKey);
      logger.debug(`Invalidated ontology cache for tenant ${tenantId}`);
    },
  };
}
