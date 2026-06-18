import { z } from "zod";
import type { FieldAuditRepository } from "../repositories/field-audit-repository.js";
import type {
  FieldChangeEntry,
  FieldAccessEntry,
  FieldChangeRow,
  FieldAccessRow,
  FieldHistoryQueryParams,
  FieldAccessQueryParams,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Input validation schemas
//
// These run at the service boundary — every public method validates its args
// before touching the repository. The Zod schemas are the single source of
// truth for what constitutes a valid entry; route handlers and internal callers
// both go through this layer.
// ---------------------------------------------------------------------------

const entityTypeSchema = z.string().min(1).max(128);
const entityIdSchema = z.string().min(1).max(255);
const fieldNameSchema = z.string().min(1).max(255);
const userIdSchema = z.string().min(1).max(255);
const tenantIdSchema = z.string().min(1).max(255);
const timestampSchema = z.string().datetime();
const paginationLimitSchema = z.number().int().min(1).max(500).default(100);
const optionalCursorSchema = z.string().max(512).optional();
const optionalDatetimeSchema = z.string().datetime().optional();

const fieldChangeEntrySchema = z.object({
  tenantId: tenantIdSchema,
  userId: userIdSchema,
  entityType: entityTypeSchema,
  entityId: entityIdSchema,
  fieldName: fieldNameSchema,
  // oldValue and newValue are arbitrary JSON — we preserve unknown as-is
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  action: z.enum(["create", "update", "delete"]),
  source: z.enum(["api", "ui", "system"]),
  timestamp: timestampSchema,
});

const fieldAccessEntrySchema = z.object({
  tenantId: tenantIdSchema,
  userId: userIdSchema,
  entityType: entityTypeSchema,
  entityId: entityIdSchema,
  fieldsAccessed: z.array(fieldNameSchema).min(1).max(500),
  timestamp: timestampSchema,
  purpose: z.enum(["view", "export", "api"]),
});

const fieldHistoryQuerySchema = z.object({
  fieldName: fieldNameSchema.optional(),
  userId: userIdSchema.optional(),
  from: optionalDatetimeSchema,
  to: optionalDatetimeSchema,
  cursor: optionalCursorSchema,
  limit: paginationLimitSchema,
});

const entityAccessQuerySchema = z.object({
  userId: userIdSchema.optional(),
  from: optionalDatetimeSchema,
  to: optionalDatetimeSchema,
  cursor: optionalCursorSchema,
  limit: paginationLimitSchema,
});

// ---------------------------------------------------------------------------
// Public option types — consumed by route handlers
// ---------------------------------------------------------------------------

export type GetFieldHistoryOptions = z.input<typeof fieldHistoryQuerySchema>;
export type GetEntityAccessOptions = z.input<typeof entityAccessQuerySchema>;

export class FieldAuditService {
  constructor(private readonly repo: FieldAuditRepository) {}

  /**
   * Record that a single field was modified. Callers should invoke this once
   * per changed field — do not aggregate multiple field changes into one call
   * as per-field granularity is required for compliance queries.
   *
   * The service validates all inputs and delegates sensitive-value redaction
   * to the repository layer, which is the last line of defence before writes.
   */
  async logFieldChange(entry: FieldChangeEntry): Promise<FieldChangeRow> {
    const parsed = fieldChangeEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new FieldAuditValidationError(
        `Invalid FieldChangeEntry: ${parsed.error.message}`,
        parsed.error.issues
      );
    }

    return this.repo.insertFieldChange(parsed.data as FieldChangeEntry);
  }

  /**
   * Record that a set of fields was read. A single call covers all fields
   * accessed in one logical operation (e.g. loading a connector detail page).
   */
  async logFieldAccess(entry: FieldAccessEntry): Promise<FieldAccessRow> {
    const parsed = fieldAccessEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new FieldAuditValidationError(
        `Invalid FieldAccessEntry: ${parsed.error.message}`,
        parsed.error.issues
      );
    }

    return this.repo.insertFieldAccess(parsed.data as FieldAccessEntry);
  }

  /**
   * Fetch paginated change history for a specific field (or all fields) on an
   * entity. Tenant isolation is enforced here: the caller must supply the
   * tenantId from the authenticated JWT — it cannot be overridden by query params.
   */
  async getFieldHistory(
    tenantId: string,
    entityType: string,
    entityId: string,
    options: GetFieldHistoryOptions
  ): Promise<{ data: FieldChangeRow[]; nextCursor: string | null }> {
    const tenantParsed = tenantIdSchema.safeParse(tenantId);
    if (!tenantParsed.success) {
      throw new FieldAuditValidationError("Invalid tenantId", tenantParsed.error.issues);
    }

    const entityTypeParsed = entityTypeSchema.safeParse(entityType);
    if (!entityTypeParsed.success) {
      throw new FieldAuditValidationError("Invalid entityType", entityTypeParsed.error.issues);
    }

    const entityIdParsed = entityIdSchema.safeParse(entityId);
    if (!entityIdParsed.success) {
      throw new FieldAuditValidationError("Invalid entityId", entityIdParsed.error.issues);
    }

    const optsParsed = fieldHistoryQuerySchema.safeParse(options);
    if (!optsParsed.success) {
      throw new FieldAuditValidationError(
        `Invalid query options: ${optsParsed.error.message}`,
        optsParsed.error.issues
      );
    }

    // Build params explicitly to satisfy exactOptionalPropertyTypes — spreading
    // Zod output directly includes `key: undefined` which TypeScript rejects when
    // the target type uses optional (not optional-or-undefined) properties.
    const opts = optsParsed.data;
    const params: FieldHistoryQueryParams = {
      entityType,
      entityId,
      limit: opts.limit,
      ...(opts.fieldName !== undefined ? { fieldName: opts.fieldName } : {}),
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    };

    return this.repo.queryFieldHistory(tenantId, params);
  }

  /**
   * Fetch all changes (across all fields) for an entity — the full entity
   * audit log. Useful for "show me everything that happened to this connector".
   * Delegates to getFieldHistory with no fieldName filter.
   */
  async getEntityAuditLog(
    tenantId: string,
    entityType: string,
    entityId: string,
    options: Omit<GetFieldHistoryOptions, "fieldName">
  ): Promise<{ data: FieldChangeRow[]; nextCursor: string | null }> {
    return this.getFieldHistory(tenantId, entityType, entityId, options);
  }

  /**
   * Fetch the access log for a specific entity — who read what fields and when.
   */
  async getEntityAccessLog(
    tenantId: string,
    entityType: string,
    entityId: string,
    options: GetEntityAccessOptions
  ): Promise<{ data: FieldAccessRow[]; nextCursor: string | null }> {
    const tenantParsed = tenantIdSchema.safeParse(tenantId);
    if (!tenantParsed.success) {
      throw new FieldAuditValidationError("Invalid tenantId", tenantParsed.error.issues);
    }

    const entityTypeParsed = entityTypeSchema.safeParse(entityType);
    if (!entityTypeParsed.success) {
      throw new FieldAuditValidationError("Invalid entityType", entityTypeParsed.error.issues);
    }

    const entityIdParsed = entityIdSchema.safeParse(entityId);
    if (!entityIdParsed.success) {
      throw new FieldAuditValidationError("Invalid entityId", entityIdParsed.error.issues);
    }

    const optsParsed = entityAccessQuerySchema.safeParse(options);
    if (!optsParsed.success) {
      throw new FieldAuditValidationError(
        `Invalid query options: ${optsParsed.error.message}`,
        optsParsed.error.issues
      );
    }

    const accOpts = optsParsed.data;
    const params: FieldAccessQueryParams = {
      entityType,
      entityId,
      limit: accOpts.limit,
      ...(accOpts.userId !== undefined ? { userId: accOpts.userId } : {}),
      ...(accOpts.from !== undefined ? { from: accOpts.from } : {}),
      ...(accOpts.to !== undefined ? { to: accOpts.to } : {}),
      ...(accOpts.cursor !== undefined ? { cursor: accOpts.cursor } : {}),
    };

    return this.repo.queryEntityAccess(tenantId, params);
  }
}

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

import { AppError } from "@oneplatform/core";
import type { z as ZodType } from "zod";

export class FieldAuditValidationError extends AppError {
  readonly code = "FIELD_AUDIT_VALIDATION_ERROR" as const;
  readonly statusCode = 400;

  constructor(
    message: string,
    readonly issues: ZodType.ZodIssue[]
  ) {
    super(message);
  }
}
