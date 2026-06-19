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

// Patterns that indicate attempts to escape the expression sandbox or access
// Node.js internals. These are blocked at storage time so they never reach
// the Execution Service. The sandbox also enforces noIo and memoryLimitMb, but
// defence-in-depth means we reject obviously dangerous inputs before storing them.
const EXPRESSION_DANGEROUS_PATTERNS = [
  /\bprocess\b/,       // Node.js process object — env vars, exit, kill
  /\brequire\b/,       // CommonJS module loader
  /\bimport\b/,        // Dynamic import()
  /\b__proto__\b/,     // Prototype pollution
  /\bconstructor\b/,   // constructor property access for prototype chain escape
  /\beval\b/,          // eval() inside an expression is doubly dangerous
  /\bFunction\b/,      // new Function() bypasses expression scope
  /\bGlobalThis\b/i,   // globalThis reference
];

function validateExpressionTransform(val: string): boolean {
  return !EXPRESSION_DANGEROUS_PATTERNS.some((re) => re.test(val));
}

const safeTransformExpression = z
  .string()
  .min(1)
  .max(4096)
  .refine(validateExpressionTransform, {
    message:
      "Expression contains disallowed patterns (process, require, import, __proto__, constructor, eval, Function, globalThis).",
  });

export const createMappingRuleRequest = z.object({
  connectorId: z.string().uuid(),
  sourceFieldPath: z.string().min(1),
  targetFieldId: z.string().uuid(),
  transformType: z.enum(["direct", "expression", "constant", "template"]).default("direct"),
  transform: z.string().optional(),
  priority: z.number().int().min(0).default(0),
}).superRefine((data, ctx) => {
  if (data.transformType === "expression" && data.transform !== undefined) {
    if (!validateExpressionTransform(data.transform)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transform"],
        message:
          "Expression contains disallowed patterns (process, require, import, __proto__, constructor, eval, Function, globalThis).",
      });
    }
    if (data.transform.length > 4096) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: 4096,
        inclusive: true,
        path: ["transform"],
        message: "Expression transform must not exceed 4096 characters.",
      });
    }
  }
});

export const updateMappingRuleRequest = z.object({
  sourceFieldPath: z.string().min(1).optional(),
  transformType: z.enum(["direct", "expression", "constant", "template"]).optional(),
  transform: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
}).superRefine((data, ctx) => {
  // Apply the same expression safety check on updates as on creation.
  if (
    (data.transformType === "expression" || data.transformType === undefined) &&
    data.transform != null
  ) {
    if (!validateExpressionTransform(data.transform)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transform"],
        message:
          "Expression contains disallowed patterns (process, require, import, __proto__, constructor, eval, Function, globalThis).",
      });
    }
    if (data.transform.length > 4096) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: 4096,
        inclusive: true,
        path: ["transform"],
        message: "Expression transform must not exceed 4096 characters.",
      });
    }
  }
});

// safeTransformExpression is exported for direct use in unit tests.
export { safeTransformExpression };

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

// ---------------------------------------------------------------------------
// Structured query endpoints
// ---------------------------------------------------------------------------

const whereOperatorSchema = z.enum([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "in", "not_in", "is_null", "is_not_null",
]);

const whereClauseSchema = z.object({
  field: z.string().min(1),
  operator: whereOperatorSchema,
  value: z.unknown().optional(),
});

const orderBySchema = z.object({
  field: z.string().min(1),
  direction: z.enum(["asc", "desc"]),
});

export const structuredQuerySchema = z.object({
  entityType: z.string().min(1),
  select: z.array(z.string().min(1)).min(1),
  where: z.array(whereClauseSchema).optional(),
  orderBy: z.array(orderBySchema).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  groupBy: z.array(z.string().min(1)).optional(),
  having: z.array(whereClauseSchema).optional(),
});
