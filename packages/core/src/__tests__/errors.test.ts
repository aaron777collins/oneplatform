import { describe, it, expect } from "vitest";
import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  InternalError,
  ServiceUnavailableError,
} from "../errors.js";

describe("AppError subclasses", () => {
  it("NotFoundError serializes to correct code and status", () => {
    const err = new NotFoundError("Customer with id '123' does not exist.");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Customer with id '123' does not exist.");
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("ValidationError carries details payload", () => {
    const details = { field: "email", issue: "Invalid format" };
    const err = new ValidationError("Validation failed", details);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.statusCode).toBe(422);
    expect(err.details).toEqual(details);
  });

  it("RateLimitError includes retryAfter", () => {
    const err = new RateLimitError(60);
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSeconds).toBe(60);
  });

  it("InternalError hides original message from toApiError", () => {
    const err = new InternalError("SELECT * FROM users -- internal detail");
    const envelope = err.toApiError("req-123");
    expect(envelope.error.message).toBe("An unexpected error occurred.");
    expect(envelope.error.message).not.toContain("SELECT");
    expect(envelope.error.requestId).toBe("req-123");
  });

  it("toApiError produces spec-compliant envelope shape", () => {
    const err = new ForbiddenError("Insufficient scope: data:write required");
    const envelope = err.toApiError("req-456");
    expect(envelope).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Insufficient scope: data:write required",
        requestId: "req-456",
      },
    });
  });

  it("UnauthorizedError uses correct status 401", () => {
    const err = new UnauthorizedError("Missing token");
    expect(err.statusCode).toBe(401);
  });

  it("ConflictError uses status 409", () => {
    const err = new ConflictError("Duplicate slug");
    expect(err.statusCode).toBe(409);
  });

  it("ServiceUnavailableError uses status 503", () => {
    const err = new ServiceUnavailableError("Postgres unreachable");
    expect(err.statusCode).toBe(503);
  });
});
