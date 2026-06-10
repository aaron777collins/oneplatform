// Unit tests for services/errors.ts
// Verifies every ontology error class has the correct code, statusCode,
// message propagation, and AppError inheritance.

import { describe, it, expect } from "vitest";
import { AppError } from "@oneplatform/core";
import {
  EntityNotFoundError,
  FieldNotFoundError,
  ReservedSlugError,
  SlugConflictError,
  RefNotFoundError,
  MigrationInProgressError,
  MigrationPlanExpiredError,
  MigrationWrongStateError,
  MigrationNotFoundError,
  EntityHasDataError,
  ExpressionTimeoutError,
  ExpressionError,
  UnionViewTimeoutError,
  SchemaStaleError,
  InferInsufficientDataError,
  DdlFailedError,
  FieldInUseError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert the common contract every ontology error must satisfy. */
function assertErrorContract(
  ErrorClass: new (message: string) => AppError,
  expectedCode: string,
  expectedStatusCode: number,
) {
  const message = `Test message for ${expectedCode}`;
  const err = new ErrorClass(message);

  it(`${ErrorClass.name} — code is ${expectedCode}`, () => {
    expect(err.code).toBe(expectedCode);
  });

  it(`${ErrorClass.name} — statusCode is ${expectedStatusCode}`, () => {
    expect(err.statusCode).toBe(expectedStatusCode);
  });

  it(`${ErrorClass.name} — message is propagated`, () => {
    expect(err.message).toBe(message);
  });

  it(`${ErrorClass.name} — is an instance of AppError`, () => {
    expect(err).toBeInstanceOf(AppError);
  });

  it(`${ErrorClass.name} — is an instance of Error`, () => {
    expect(err).toBeInstanceOf(Error);
  });

  it(`${ErrorClass.name} — name matches constructor`, () => {
    expect(err.name).toBe(ErrorClass.name);
  });

  it(`${ErrorClass.name} — toApiError returns spec-compliant envelope`, () => {
    const envelope = err.toApiError("req-test");
    expect(envelope).toMatchObject({
      error: {
        code: expectedCode,
        message,
        requestId: "req-test",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 404 errors
// ---------------------------------------------------------------------------

describe("EntityNotFoundError", () => {
  assertErrorContract(EntityNotFoundError, "ONTOLOGY_ENTITY_NOT_FOUND", 404);
});

describe("FieldNotFoundError", () => {
  assertErrorContract(FieldNotFoundError, "ONTOLOGY_FIELD_NOT_FOUND", 404);
});

describe("MigrationNotFoundError", () => {
  assertErrorContract(MigrationNotFoundError, "ONTOLOGY_MIGRATION_NOT_FOUND", 404);
});

// ---------------------------------------------------------------------------
// 409 errors
// ---------------------------------------------------------------------------

describe("SlugConflictError", () => {
  assertErrorContract(SlugConflictError, "ONTOLOGY_SLUG_CONFLICT", 409);
});

describe("MigrationInProgressError", () => {
  assertErrorContract(MigrationInProgressError, "ONTOLOGY_MIGRATION_IN_PROGRESS", 409);
});

describe("MigrationWrongStateError", () => {
  assertErrorContract(MigrationWrongStateError, "ONTOLOGY_MIGRATION_WRONG_STATE", 409);
});

describe("EntityHasDataError", () => {
  assertErrorContract(EntityHasDataError, "ONTOLOGY_ENTITY_HAS_DATA", 409);
});

describe("FieldInUseError", () => {
  assertErrorContract(FieldInUseError, "ONTOLOGY_FIELD_IN_USE", 409);
});

// ---------------------------------------------------------------------------
// 410 errors
// ---------------------------------------------------------------------------

describe("MigrationPlanExpiredError", () => {
  assertErrorContract(MigrationPlanExpiredError, "ONTOLOGY_MIGRATION_PLAN_EXPIRED", 410);
});

// ---------------------------------------------------------------------------
// 422 errors
// ---------------------------------------------------------------------------

describe("ReservedSlugError", () => {
  assertErrorContract(ReservedSlugError, "ONTOLOGY_RESERVED_SLUG", 422);
});

describe("RefNotFoundError", () => {
  assertErrorContract(RefNotFoundError, "ONTOLOGY_REF_NOT_FOUND", 422);
});

describe("ExpressionError", () => {
  assertErrorContract(ExpressionError, "ONTOLOGY_EXPRESSION_ERROR", 422);
});

describe("InferInsufficientDataError", () => {
  assertErrorContract(InferInsufficientDataError, "ONTOLOGY_INFER_INSUFFICIENT_DATA", 422);
});

// ---------------------------------------------------------------------------
// 500 errors
// ---------------------------------------------------------------------------

describe("DdlFailedError", () => {
  assertErrorContract(DdlFailedError, "ONTOLOGY_DDL_FAILED", 500);
});

// ---------------------------------------------------------------------------
// 503 errors
// ---------------------------------------------------------------------------

describe("ExpressionTimeoutError", () => {
  assertErrorContract(ExpressionTimeoutError, "ONTOLOGY_EXPRESSION_TIMEOUT", 503);
});

describe("UnionViewTimeoutError", () => {
  assertErrorContract(UnionViewTimeoutError, "ONTOLOGY_UNION_VIEW_TIMEOUT", 503);
});

describe("SchemaStaleError", () => {
  assertErrorContract(SchemaStaleError, "ONTOLOGY_SCHEMA_STALE", 503);
});

// ---------------------------------------------------------------------------
// details payload propagation (spot-check)
// ---------------------------------------------------------------------------

describe("error details propagation", () => {
  it("EntityNotFoundError carries optional details payload", () => {
    const details = { entitySlug: "product", tenantId: "t-1" };
    const err = new EntityNotFoundError("Entity not found", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-x");
    expect(envelope.error.details).toEqual(details);
  });

  it("SlugConflictError without details has no details key in envelope", () => {
    const err = new SlugConflictError("Slug taken");
    const envelope = err.toApiError("req-y");
    expect(envelope.error).not.toHaveProperty("details");
  });
});

// ---------------------------------------------------------------------------
// Prototype chain is preserved after transpilation (Object.setPrototypeOf)
// ---------------------------------------------------------------------------

describe("prototype chain integrity", () => {
  it("all 17 error classes pass instanceof AppError check at runtime", () => {
    const instances: AppError[] = [
      new EntityNotFoundError("e"),
      new FieldNotFoundError("e"),
      new ReservedSlugError("e"),
      new SlugConflictError("e"),
      new RefNotFoundError("e"),
      new MigrationInProgressError("e"),
      new MigrationPlanExpiredError("e"),
      new MigrationWrongStateError("e"),
      new MigrationNotFoundError("e"),
      new EntityHasDataError("e"),
      new ExpressionTimeoutError("e"),
      new ExpressionError("e"),
      new UnionViewTimeoutError("e"),
      new SchemaStaleError("e"),
      new InferInsufficientDataError("e"),
      new DdlFailedError("e"),
      new FieldInUseError("e"),
    ];
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(AppError);
      expect(instance).toBeInstanceOf(Error);
    }
  });
});
