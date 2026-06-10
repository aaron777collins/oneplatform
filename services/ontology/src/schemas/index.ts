import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

export const validationRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("min"), value: z.number(), message: z.string().optional() }),
  z.object({ type: z.literal("max"), value: z.number(), message: z.string().optional() }),
  z.object({ type: z.literal("minLength"), value: z.number().int().min(0), message: z.string().optional() }),
  z.object({ type: z.literal("maxLength"), value: z.number().int().min(1), message: z.string().optional() }),
  z.object({ type: z.literal("pattern"), value: z.string(), message: z.string().optional() }),
  z.object({ type: z.literal("email"), message: z.string().optional() }),
  z.object({ type: z.literal("url"), message: z.string().optional() }),
]);

export const fieldDefinitionSchema = z.object({
  name: z.string().min(1).max(64),
  slug: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).optional(),
  fieldType: z.enum(["string", "number", "boolean", "date", "json", "reference", "enum", "array"]),
  required: z.boolean().default(false),
  nullable: z.boolean().default(true),
  defaultValue: z.unknown().optional(),
  validationRules: z.array(validationRuleSchema).default([]),
  enumValues: z.array(z.string()).min(1).optional(),
  arrayItemType: z.enum(["string", "number", "boolean", "date", "json"]).optional(),
  refEntitySlug: z.string().optional(),
  isIndexed: z.boolean().default(false),
  isUnique: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Entity endpoints
// ---------------------------------------------------------------------------

export const createEntityRequest = z.object({
  name: z.string().min(1).max(64),
  slug: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).optional(),
  description: z.string().max(512).optional(),
  isPublic: z.boolean().default(false),
  fields: z.array(fieldDefinitionSchema).min(0).max(200),
});

export const patchEntityRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(512).nullable().optional(),
  isPublic: z.boolean().optional(),
  addFields: z.array(fieldDefinitionSchema).optional(),
  removeFieldSlugs: z.array(z.string()).optional(),
  renameFields: z.array(z.object({
    fromSlug: z.string(),
    toSlug: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  })).optional(),
  updateFields: z.array(z.object({
    slug: z.string(),
    name: z.string().optional(),
    validationRules: z.array(validationRuleSchema).optional(),
    isIndexed: z.boolean().optional(),
    isUnique: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
  })).optional(),
});

export const validateRecordRequest = z.object({
  data: z.record(z.unknown()),
});

export const listEntitiesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const deleteEntityQuery = z.object({
  confirm: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Migration endpoints
// ---------------------------------------------------------------------------

export const listMigrationsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum([
    "pending_confirmation", "confirmed", "running", "complete", "failed", "rolled_back",
  ]).optional(),
});

// ---------------------------------------------------------------------------
// Mapping rule endpoints
// ---------------------------------------------------------------------------

export const createMappingRuleRequest = z.object({
  connectorId: z.string().uuid(),
  sourceFieldPath: z.string().min(1),
  targetFieldId: z.string().uuid(),
  transformType: z.enum(["direct", "expression", "constant", "template"]).default("direct"),
  transform: z.string().optional(),
  priority: z.number().int().min(0).default(0),
});

export const updateMappingRuleRequest = z.object({
  sourceFieldPath: z.string().min(1).optional(),
  transformType: z.enum(["direct", "expression", "constant", "template"]).optional(),
  transform: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Internal endpoints
// ---------------------------------------------------------------------------

export const dataEnvelopeSchema = z.object({
  _id: z.string(),
  _batchId: z.string(),
  _connectorId: z.string(),
  _ingestedAt: z.string(),
  data: z.record(z.unknown()),
});

export const mapRequest = z.object({
  tenantId: z.string().uuid(),
  connectorId: z.string().uuid(),
  batchId: z.string(),
  records: z.array(dataEnvelopeSchema).min(1).max(100),
});

export const inferRequest = z.object({
  tenantId: z.string().uuid(),
  connectorId: z.string().uuid(),
  sample: z.array(dataEnvelopeSchema).min(1).max(1000),
  entityTypeHint: z.string().optional(),
});

export const schemaQueryRequest = z.object({
  tenantId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Relationship endpoints
// ---------------------------------------------------------------------------

export const createRelationshipRequest = z.object({
  fromEntitySlug: z.string(),
  toEntitySlug: z.string(),
  relationshipType: z.enum(["1:1", "1:N", "M:N"]),
  fromFieldName: z.string(),
  toFieldName: z.string().optional(),
  cascadeDelete: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Draft endpoints
// ---------------------------------------------------------------------------

export const listDraftsQuery = z.object({
  connectorId: z.string().uuid().optional(),
});
