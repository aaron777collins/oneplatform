/**
 * Ontology service OpenAPI 3.0.3 route metadata.
 *
 * The Ontology service owns the schema layer for OnePlatform. It manages:
 *   - Entity type definitions (fields, validation rules, relationships)
 *   - Schema migration lifecycle (breaking changes require confirmation)
 *   - Field mapping rules (connector field → entity field, with transforms)
 *   - Schema inference drafts (auto-inferred from connector sample data)
 *
 * Routes excluded:
 *   All routes in internal.ts (/internal/*) are service-to-service routes
 *   protected by X-Service-Token and are not public API.
 *   /healthz and /readyz are infrastructure probes.
 *
 * Scope requirements (enforced in route handlers, not middleware):
 *   Read endpoints: ontology:read or admin
 *   Write endpoints: ontology:write or admin
 */

import type { ServiceOpenApiMeta } from "@oneplatform/openapi-gen";
import { z } from "zod";
import {
  createEntityRequest,
  patchEntityRequest,
  validateRecordRequest,
  listEntitiesQuery,
  deleteEntityQuery,
  createRelationshipRequest,
  createMappingRuleRequest,
  updateMappingRuleRequest,
  listMigrationsQuery,
  listDraftsQuery,
} from "./schemas/index.js";

// ---------------------------------------------------------------------------
// Inline response schemas
// ---------------------------------------------------------------------------

const noContentResponse = z.object({}).describe("NoContentResponse");

const fieldDefinitionResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  fieldType: z.enum(["string", "number", "boolean", "date", "json", "reference", "enum", "array"]),
  required: z.boolean(),
  nullable: z.boolean(),
  defaultValue: z.unknown().nullable(),
  validationRules: z.array(z.record(z.unknown())),
  enumValues: z.array(z.string()).nullable(),
  isIndexed: z.boolean(),
  isUnique: z.boolean(),
  refEntitySlug: z.string().nullable(),
});

const entitySummaryResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        slug: z.string(),
        version: z.number().int(),
        description: z.string().nullable(),
        isPublic: z.boolean(),
        fieldCount: z.number().int(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
    ),
    pagination: z.object({
      nextCursor: z.string().nullable(),
      total: z.number().int(),
    }),
  })
  .describe("EntityListResponse");

const entityDetailResponse = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    version: z.number().int(),
    description: z.string().nullable(),
    isPublic: z.boolean(),
    fields: z.array(fieldDefinitionResponse),
    relationships: z.array(
      z.object({
        id: z.string().uuid(),
        fromEntitySlug: z.string(),
        toEntitySlug: z.string(),
        relationshipType: z.enum(["1:1", "1:N", "M:N"]),
        fromFieldName: z.string(),
        toFieldName: z.string().nullable(),
        cascadeDelete: z.boolean(),
      })
    ),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe("EntityDetailResponse");

const entityCreateResponse = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    version: z.number().int(),
    description: z.string().nullable(),
    isPublic: z.boolean(),
    fields: z.array(fieldDefinitionResponse),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe("EntityCreateResponse");

// PATCH /ontology/:entityType may return 200 (backward compat) or 202 (breaking change)
const entityPatchResponse = z
  .object({
    entity: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }).optional(),
    migration: z.object({ id: z.string().uuid() }).optional(),
    changeType: z.enum(["backward_compatible", "breaking"]),
    requiresConfirmation: z.boolean().optional(),
    appliedImmediately: z.boolean().optional(),
  })
  .describe("EntityPatchResponse");

const validateRecordResponse = z
  .object({
    valid: z.boolean(),
    errors: z.array(z.object({ field: z.string(), message: z.string() })),
  })
  .describe("ValidateRecordResponse");

const relationshipResponse = z
  .object({
    id: z.string().uuid(),
    fromEntitySlug: z.string(),
    toEntitySlug: z.string(),
    relationshipType: z.enum(["1:1", "1:N", "M:N"]),
    fromFieldName: z.string(),
    toFieldName: z.string().nullable(),
    cascadeDelete: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .describe("RelationshipResponse");

const migrationListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        entityId: z.string().uuid(),
        fromVersion: z.number().int(),
        toVersion: z.number().int(),
        changeType: z.string(),
        isBreaking: z.boolean(),
        status: z.enum([
          "pending_confirmation", "confirmed", "running", "complete", "failed", "rolled_back",
        ]),
        createdAt: z.string().datetime(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable(), total: z.number().int() }),
  })
  .describe("MigrationListResponse");

const migrationDetailResponse = z
  .object({
    id: z.string().uuid(),
    entityId: z.string().uuid(),
    fromVersion: z.number().int(),
    toVersion: z.number().int(),
    changeType: z.string(),
    isBreaking: z.boolean(),
    status: z.enum([
      "pending_confirmation", "confirmed", "running", "complete", "failed", "rolled_back",
    ]),
    changePlan: z.record(z.unknown()).nullable(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    errorDetails: z.record(z.unknown()).nullable(),
    createdAt: z.string().datetime(),
  })
  .describe("MigrationDetailResponse");

const migrationConfirmResponse = z
  .object({
    migrationId: z.string().uuid(),
    status: z.literal("confirmed"),
    estimatedDurationMs: z.number().int().nullable(),
  })
  .describe("MigrationConfirmResponse");

const migrationRollbackResponse = z
  .object({
    migrationId: z.string().uuid(),
    status: z.literal("rolling_back"),
  })
  .describe("MigrationRollbackResponse");

const migrationStatusResponse = z
  .object({
    status: z.string(),
    batchProgress: z.number().nullable(),
    estimatedCompletionAt: z.string().datetime().nullable(),
  })
  .describe("MigrationStatusResponse");

const mappingRuleListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        connectorId: z.string().uuid(),
        sourceFieldPath: z.string(),
        targetEntityId: z.string().uuid(),
        targetFieldId: z.string().uuid(),
        transformType: z.enum(["direct", "expression", "constant", "template"]),
        transform: z.string().nullable(),
        isActive: z.boolean(),
        priority: z.number().int(),
        createdAt: z.string().datetime(),
      })
    ),
  })
  .describe("MappingRuleListResponse");

const mappingRuleResponse = z
  .object({
    id: z.string().uuid(),
    connectorId: z.string().uuid(),
    sourceFieldPath: z.string(),
    transformType: z.enum(["direct", "expression", "constant", "template"]),
    transform: z.string().nullable(),
    priority: z.number().int(),
    createdAt: z.string().datetime(),
  })
  .describe("MappingRuleResponse");

const mappingRuleUpdateResponse = z
  .object({
    id: z.string().uuid(),
    sourceFieldPath: z.string(),
    transformType: z.enum(["direct", "expression", "constant", "template"]),
    transform: z.string().nullable(),
    isActive: z.boolean(),
    priority: z.number().int(),
  })
  .describe("MappingRuleUpdateResponse");

const mappingErrorListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        connectorId: z.string().uuid(),
        batchId: z.string(),
        rawId: z.string(),
        entityType: z.string(),
        errorFields: z.array(z.string()),
        errorDetails: z.record(z.unknown()),
        createdAt: z.string().datetime(),
      })
    ),
    pagination: z.object({ nextCursor: z.string().nullable() }),
  })
  .describe("MappingErrorListResponse");

const draftListResponse = z
  .object({
    data: z.array(
      z.object({
        id: z.string().uuid(),
        connectorId: z.string().uuid().nullable(),
        inferredSchema: z.record(z.unknown()).nullable(),
        status: z.string(),
        sampleBatchId: z.string().nullable(),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
    ),
  })
  .describe("DraftListResponse");

const draftDetailResponse = z
  .object({
    id: z.string().uuid(),
    connectorId: z.string().uuid().nullable(),
    inferredSchema: z.record(z.unknown()).nullable(),
    status: z.string(),
    sampleBatchId: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .describe("DraftDetailResponse");

const draftConfirmResponse = z
  .object({
    id: z.string().uuid(),
    status: z.literal("confirmed"),
    confirmedAt: z.string().datetime().nullable(),
  })
  .describe("DraftConfirmResponse");

const draftRejectResponse = z
  .object({ id: z.string().uuid(), status: z.literal("rejected") })
  .describe("DraftRejectResponse");

// ---------------------------------------------------------------------------
// Meta export
// ---------------------------------------------------------------------------

export const meta: ServiceOpenApiMeta = {
  info: {
    title: "Ontology Service",
    description:
      "Manages the schema layer for OnePlatform. Provides entity type definitions, " +
      "field management, schema migration lifecycle, connector field mapping rules, " +
      "and schema inference drafts auto-generated from connector sample data.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:3000", description: "Local (via Gateway)" }],
  tags: [
    {
      name: "Entities",
      description:
        "Entity type definitions. Each entity maps to a table in the tenant's dynamic " +
        "schema. Breaking field changes (rename, type change) generate a migration.",
    },
    {
      name: "Migrations",
      description:
        "Schema migration lifecycle. Breaking changes produce a pending migration that " +
        "must be confirmed before it is applied to the database.",
    },
    {
      name: "Mapping Rules",
      description:
        "Connector field → entity field mapping rules. Supports direct, expression, " +
        "constant, and template transform types.",
    },
    {
      name: "Drafts",
      description:
        "Schema inference drafts auto-generated when a connector delivers its first " +
        "batch of records. Drafts can be confirmed (creating entity types) or rejected.",
    },
  ],
  routes: [
    // -----------------------------------------------------------------------
    // Entities
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/ontology",
      summary: "List entity types",
      description:
        "Returns all entity types visible to the caller's tenant. Requires " +
        "ontology:read or admin scope.",
      tags: ["Entities"],
      query: { schema: listEntitiesQuery },
      response: {
        200: entitySummaryResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/ontology",
      summary: "Create entity type",
      description:
        "Creates a new entity type and provisions the backing database table. " +
        "Requires ontology:write or admin scope. The slug is auto-derived from the " +
        "name if omitted.",
      tags: ["Entities"],
      body: {
        schema: createEntityRequest.describe("CreateEntityRequest"),
        contentType: "application/json",
      },
      response: {
        201: entityCreateResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/ontology/{entityType}",
      summary: "Get entity type",
      description:
        "Returns full entity type definition including all fields and relationships. " +
        "Requires ontology:read or admin scope.",
      tags: ["Entities"],
      params: { entityType: z.string().describe("EntityTypeSlug") },
      response: {
        200: entityDetailResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/ontology/{entityType}",
      summary: "Update entity type",
      description:
        "Partially updates an entity type. Backward-compatible changes (add optional " +
        "field, update index) are applied immediately (200). Breaking changes (rename " +
        "required field, change type) create a pending migration and return 202. " +
        "Requires ontology:write or admin scope.",
      tags: ["Entities"],
      params: { entityType: z.string().describe("PatchEntityTypeSlug") },
      body: {
        schema: patchEntityRequest.describe("PatchEntityRequest"),
        contentType: "application/json",
      },
      response: {
        200: entityPatchResponse,
        202: entityPatchResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/ontology/{entityType}",
      summary: "Delete entity type",
      description:
        "Soft-deletes an entity type. Pass confirm=true to acknowledge data loss. " +
        "Requires ontology:write or admin scope.",
      tags: ["Entities"],
      params: { entityType: z.string().describe("DeleteEntityTypeSlug") },
      query: { schema: deleteEntityQuery },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/ontology/{entityType}/validate",
      summary: "Validate a record against entity schema",
      description:
        "Validates a data record against the entity's field definitions and validation " +
        "rules without writing to the database. Useful for client-side pre-validation. " +
        "Requires ontology:read or admin scope.",
      tags: ["Entities"],
      params: { entityType: z.string().describe("ValidateEntityTypeSlug") },
      body: {
        schema: validateRecordRequest.describe("ValidateRecordRequest"),
        contentType: "application/json",
      },
      response: {
        200: validateRecordResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/ontology/{entityType}/relationships",
      summary: "Create relationship",
      description:
        "Defines a typed relationship between two entity types (1:1, 1:N, M:N). " +
        "Requires ontology:write or admin scope.",
      tags: ["Entities"],
      params: { entityType: z.string().describe("RelationshipEntityTypeSlug") },
      body: {
        schema: createRelationshipRequest.describe("CreateRelationshipRequest"),
        contentType: "application/json",
      },
      response: {
        201: relationshipResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Migrations
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/ontology/migrations",
      summary: "List migrations",
      description:
        "Returns schema migrations for the caller's tenant. Supports filtering by " +
        "status. Requires ontology:read or admin scope.",
      tags: ["Migrations"],
      query: { schema: listMigrationsQuery },
      response: {
        200: migrationListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/ontology/migrations/{id}",
      summary: "Get migration",
      tags: ["Migrations"],
      params: { id: z.string().uuid().describe("MigrationId") },
      response: {
        200: migrationDetailResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/ontology/migrations/{id}/confirm",
      summary: "Confirm migration",
      description:
        "Confirms a pending breaking migration, scheduling it to run. " +
        "Requires ontology:write or admin scope.",
      tags: ["Migrations"],
      params: { id: z.string().uuid().describe("ConfirmMigrationId") },
      response: {
        202: migrationConfirmResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/ontology/migrations/{id}/rollback",
      summary: "Rollback migration",
      description:
        "Initiates a rollback of a failed or running migration. " +
        "Requires ontology:write or admin scope.",
      tags: ["Migrations"],
      params: { id: z.string().uuid().describe("RollbackMigrationId") },
      response: {
        202: migrationRollbackResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/ontology/migrations/{id}/status",
      summary: "Get migration status",
      description:
        "Returns the current execution status of a migration including batch progress. " +
        "Requires ontology:read or admin scope.",
      tags: ["Migrations"],
      params: { id: z.string().uuid().describe("MigrationStatusId") },
      response: {
        200: migrationStatusResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Mapping Rules
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/ontology/{entityType}/mappings",
      summary: "List mapping rules",
      description:
        "Returns all field mapping rules for an entity type. " +
        "Requires ontology:read or admin scope.",
      tags: ["Mapping Rules"],
      params: { entityType: z.string().describe("MappingEntityTypeSlug") },
      response: {
        200: mappingRuleListResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/ontology/{entityType}/mappings",
      summary: "Create mapping rule",
      description:
        "Creates a field mapping rule from a connector source field to an entity field. " +
        "Expression transforms are sandboxed and checked for dangerous patterns at save time. " +
        "Requires ontology:write or admin scope.",
      tags: ["Mapping Rules"],
      params: { entityType: z.string().describe("CreateMappingEntityTypeSlug") },
      body: {
        schema: createMappingRuleRequest.describe("CreateMappingRuleRequest"),
        contentType: "application/json",
      },
      response: {
        201: mappingRuleResponse,
      },
    },
    {
      method: "PATCH",
      path: "/api/v1/ontology/{entityType}/mappings/{ruleId}",
      summary: "Update mapping rule",
      description:
        "Partially updates a mapping rule. Requires ontology:write or admin scope.",
      tags: ["Mapping Rules"],
      params: {
        entityType: z.string().describe("UpdateMappingEntityTypeSlug"),
        ruleId: z.string().uuid().describe("MappingRuleId"),
      },
      body: {
        schema: updateMappingRuleRequest.describe("UpdateMappingRuleRequest"),
        contentType: "application/json",
      },
      response: {
        200: mappingRuleUpdateResponse,
      },
    },
    {
      method: "DELETE",
      path: "/api/v1/ontology/{entityType}/mappings/{ruleId}",
      summary: "Delete mapping rule",
      tags: ["Mapping Rules"],
      params: {
        entityType: z.string().describe("DeleteMappingEntityTypeSlug"),
        ruleId: z.string().uuid().describe("DeleteMappingRuleId"),
      },
      response: {
        204: noContentResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/ontology/mappings/{id}/errors",
      summary: "List mapping errors",
      description:
        "Returns recent mapping errors for a specific rule, scoped to the rule's " +
        "connector. Useful for diagnosing transform failures. " +
        "Requires ontology:read or admin scope.",
      tags: ["Mapping Rules"],
      params: { id: z.string().uuid().describe("MappingRuleErrorsId") },
      response: {
        200: mappingErrorListResponse,
      },
    },

    // -----------------------------------------------------------------------
    // Drafts
    // -----------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/v1/ontology/drafts",
      summary: "List schema drafts",
      description:
        "Lists schema inference drafts for the caller's tenant. " +
        "Requires ontology:read or admin scope.",
      tags: ["Drafts"],
      query: { schema: listDraftsQuery },
      response: {
        200: draftListResponse,
      },
    },
    {
      method: "GET",
      path: "/api/v1/ontology/drafts/{id}",
      summary: "Get schema draft",
      tags: ["Drafts"],
      params: { id: z.string().uuid().describe("DraftId") },
      response: {
        200: draftDetailResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/ontology/drafts/{id}/confirm",
      summary: "Confirm schema draft",
      description:
        "Accepts a schema inference draft and creates the corresponding entity type. " +
        "Requires ontology:write or admin scope.",
      tags: ["Drafts"],
      params: { id: z.string().uuid().describe("ConfirmDraftId") },
      response: {
        200: draftConfirmResponse,
      },
    },
    {
      method: "POST",
      path: "/api/v1/ontology/drafts/{id}/reject",
      summary: "Reject schema draft",
      description:
        "Discards a schema inference draft without creating entity types. " +
        "Requires ontology:write or admin scope.",
      tags: ["Drafts"],
      params: { id: z.string().uuid().describe("RejectDraftId") },
      response: {
        200: draftRejectResponse,
      },
    },
  ],
};
