import { AppError } from "@oneplatform/core";

export class EntityNotFoundError extends AppError {
  readonly code = "ONTOLOGY_ENTITY_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class FieldNotFoundError extends AppError {
  readonly code = "ONTOLOGY_FIELD_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class ReservedSlugError extends AppError {
  readonly code = "ONTOLOGY_RESERVED_SLUG" as const;
  readonly statusCode = 422;
}

export class SlugConflictError extends AppError {
  readonly code = "ONTOLOGY_SLUG_CONFLICT" as const;
  readonly statusCode = 409;
}

export class RefNotFoundError extends AppError {
  readonly code = "ONTOLOGY_REF_NOT_FOUND" as const;
  readonly statusCode = 422;
}

export class MigrationInProgressError extends AppError {
  readonly code = "ONTOLOGY_MIGRATION_IN_PROGRESS" as const;
  readonly statusCode = 409;
}

export class MigrationPlanExpiredError extends AppError {
  readonly code = "ONTOLOGY_MIGRATION_PLAN_EXPIRED" as const;
  readonly statusCode = 410;
}

export class MigrationWrongStateError extends AppError {
  readonly code = "ONTOLOGY_MIGRATION_WRONG_STATE" as const;
  readonly statusCode = 409;
}

export class MigrationNotFoundError extends AppError {
  readonly code = "ONTOLOGY_MIGRATION_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class EntityHasDataError extends AppError {
  readonly code = "ONTOLOGY_ENTITY_HAS_DATA" as const;
  readonly statusCode = 409;
}

export class ExpressionTimeoutError extends AppError {
  readonly code = "ONTOLOGY_EXPRESSION_TIMEOUT" as const;
  readonly statusCode = 503;
}

export class ExpressionError extends AppError {
  readonly code = "ONTOLOGY_EXPRESSION_ERROR" as const;
  readonly statusCode = 422;
}

export class UnionViewTimeoutError extends AppError {
  readonly code = "ONTOLOGY_UNION_VIEW_TIMEOUT" as const;
  readonly statusCode = 503;
}

export class SchemaStaleError extends AppError {
  readonly code = "ONTOLOGY_SCHEMA_STALE" as const;
  readonly statusCode = 503;
}

export class InferInsufficientDataError extends AppError {
  readonly code = "ONTOLOGY_INFER_INSUFFICIENT_DATA" as const;
  readonly statusCode = 422;
}

export class DdlFailedError extends AppError {
  readonly code = "ONTOLOGY_DDL_FAILED" as const;
  readonly statusCode = 500;
}

export class FieldInUseError extends AppError {
  readonly code = "ONTOLOGY_FIELD_IN_USE" as const;
  readonly statusCode = 409;
}
