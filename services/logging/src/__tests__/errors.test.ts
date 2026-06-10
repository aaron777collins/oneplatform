// Unit tests for services/errors.ts
// Verifies every logging error class has the correct code, statusCode,
// message propagation, and AppError inheritance.

import { describe, it, expect } from "vitest";
import { AppError } from "@oneplatform/core";
import {
  LogQueryError,
  ExportTooLargeError,
  RetentionRunningError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert the common contract every logging error must satisfy.
 * Runs as a set of its() inside a caller-provided describe block.
 */
function assertErrorContract(
  ErrorClass: new (message: string) => AppError,
  expectedCode: string,
  expectedStatusCode: number
): void {
  const message = `Test message for ${expectedCode}`;
  const err = new ErrorClass(message);

  it(`has code "${expectedCode}"`, () => {
    expect(err.code).toBe(expectedCode);
  });

  it(`has statusCode ${expectedStatusCode}`, () => {
    expect(err.statusCode).toBe(expectedStatusCode);
  });

  it("propagates the message string", () => {
    expect(err.message).toBe(message);
  });

  it("is an instance of AppError", () => {
    expect(err).toBeInstanceOf(AppError);
  });

  it("is an instance of Error", () => {
    expect(err).toBeInstanceOf(Error);
  });

  it("name matches constructor name", () => {
    expect(err.name).toBe(ErrorClass.name);
  });

  it("toApiError returns a spec-compliant envelope", () => {
    const envelope = err.toApiError("req-test-id");
    expect(envelope).toMatchObject({
      error: {
        code: expectedCode,
        message,
        requestId: "req-test-id",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 400 errors
// ---------------------------------------------------------------------------

describe("LogQueryError", () => {
  assertErrorContract(LogQueryError, "LOGGING_QUERY_ERROR", 400);

  it("carries optional details payload", () => {
    const details = { query: { level: "unknown" }, reason: "invalid enum" };
    const err = new LogQueryError("Bad query params", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-1");
    expect(envelope.error.details).toEqual(details);
  });

  it("has no details key in toApiError envelope when constructed without details", () => {
    const err = new LogQueryError("Bad query");
    const envelope = err.toApiError("req-2");
    expect(envelope.error).not.toHaveProperty("details");
  });

  it("accepts a long error message", () => {
    const long = "x".repeat(1000);
    const err = new LogQueryError(long);
    expect(err.message).toHaveLength(1000);
  });

  it("accepts an empty message string", () => {
    const err = new LogQueryError("");
    expect(err.message).toBe("");
  });

  it("instanceof check works across multiple instantiations", () => {
    const a = new LogQueryError("a");
    const b = new LogQueryError("b");
    expect(a).toBeInstanceOf(LogQueryError);
    expect(b).toBeInstanceOf(LogQueryError);
    expect(a).toBeInstanceOf(AppError);
  });
});

// ---------------------------------------------------------------------------
// 413 errors
// ---------------------------------------------------------------------------

describe("ExportTooLargeError", () => {
  assertErrorContract(ExportTooLargeError, "LOGGING_EXPORT_TOO_LARGE", 413);

  it("carries optional details payload with row count info", () => {
    const details = { estimatedRows: 1_500_000, maxRows: 1_000_000 };
    const err = new ExportTooLargeError("Export exceeds limit", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-export-1");
    expect(envelope.error.details).toEqual(details);
    expect(envelope.error.requestId).toBe("req-export-1");
  });

  it("has no details key when constructed without details", () => {
    const err = new ExportTooLargeError("Too large");
    const envelope = err.toApiError("req-3");
    expect(envelope.error).not.toHaveProperty("details");
  });

  it("statusCode is 413 — distinct from 400", () => {
    const err = new ExportTooLargeError("limit exceeded");
    expect(err.statusCode).not.toBe(400);
    expect(err.statusCode).toBe(413);
  });

  it("instanceof checks are correct and disjoint from LogQueryError", () => {
    const err = new ExportTooLargeError("big");
    expect(err).toBeInstanceOf(ExportTooLargeError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).not.toBeInstanceOf(LogQueryError);
  });
});

// ---------------------------------------------------------------------------
// 409 errors
// ---------------------------------------------------------------------------

describe("RetentionRunningError", () => {
  assertErrorContract(RetentionRunningError, "LOGGING_RETENTION_RUNNING", 409);

  it("carries optional details payload with job context", () => {
    const details = { startedAt: "2026-01-15T02:00:00Z", jobId: "ret-001" };
    const err = new RetentionRunningError("Retention job already running", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-ret-1");
    expect(envelope.error.details).toEqual(details);
  });

  it("has no details key when constructed without details", () => {
    const err = new RetentionRunningError("Already running");
    const envelope = err.toApiError("req-4");
    expect(envelope.error).not.toHaveProperty("details");
  });

  it("statusCode is 409 — distinct from 400 and 413", () => {
    const err = new RetentionRunningError("conflict");
    expect(err.statusCode).toBe(409);
    expect(err.statusCode).not.toBe(400);
    expect(err.statusCode).not.toBe(413);
  });

  it("instanceof checks are correct and disjoint from other logging errors", () => {
    const err = new RetentionRunningError("running");
    expect(err).toBeInstanceOf(RetentionRunningError);
    expect(err).toBeInstanceOf(AppError);
    expect(err).not.toBeInstanceOf(LogQueryError);
    expect(err).not.toBeInstanceOf(ExportTooLargeError);
  });
});

// ---------------------------------------------------------------------------
// Cross-class invariants
// ---------------------------------------------------------------------------

describe("logging error cross-class invariants", () => {
  it("all three error classes pass instanceof AppError at runtime", () => {
    const instances: AppError[] = [
      new LogQueryError("a"),
      new ExportTooLargeError("b"),
      new RetentionRunningError("c"),
    ];
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(AppError);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it("all three have distinct error codes", () => {
    const codes = [
      new LogQueryError("x").code,
      new ExportTooLargeError("x").code,
      new RetentionRunningError("x").code,
    ];
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(3);
  });

  it("all three have distinct status codes", () => {
    const statuses = [
      new LogQueryError("x").statusCode,
      new ExportTooLargeError("x").statusCode,
      new RetentionRunningError("x").statusCode,
    ];
    const uniqueStatuses = new Set(statuses);
    expect(uniqueStatuses.size).toBe(3);
  });

  it("toApiError requestId is included in every error class output", () => {
    const rid = "global-request-id";
    const errors: AppError[] = [
      new LogQueryError("q"),
      new ExportTooLargeError("e"),
      new RetentionRunningError("r"),
    ];
    for (const err of errors) {
      const envelope = err.toApiError(rid);
      expect(envelope.error.requestId).toBe(rid);
    }
  });

  it("prototype chain is preserved so instanceof works after Object.setPrototypeOf", () => {
    // This guards against the ES5 transpilation bug where instanceof breaks
    // unless the constructor explicitly calls Object.setPrototypeOf(this, new.target.prototype)
    const lqe = new LogQueryError("test");
    const etle = new ExportTooLargeError("test");
    const rre = new RetentionRunningError("test");

    expect(Object.getPrototypeOf(lqe)).toBe(LogQueryError.prototype);
    expect(Object.getPrototypeOf(etle)).toBe(ExportTooLargeError.prototype);
    expect(Object.getPrototypeOf(rre)).toBe(RetentionRunningError.prototype);
  });

  it("name property on each instance matches the class constructor name", () => {
    expect(new LogQueryError("x").name).toBe("LogQueryError");
    expect(new ExportTooLargeError("x").name).toBe("ExportTooLargeError");
    expect(new RetentionRunningError("x").name).toBe("RetentionRunningError");
  });
});
