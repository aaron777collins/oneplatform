// Unit tests for services/errors.ts
//
// Verifies all 19 app error classes have the correct code, statusCode,
// message propagation, details payload, AppError/Error inheritance,
// name property, toApiError() envelope shape, and stack trace.

import { describe, it, expect } from "vitest";
import { AppError } from "@oneplatform/core";
import {
  AppNotFoundError,
  AppFileNotFoundError,
  AppFileVersionConflictError,
  AppFileTooLargeError,
  AppFileInvalidPathError,
  AppCannotDeleteEntrypointError,
  AppBuildInProgressError,
  AppBuildNotReadyError,
  AppBuildArtifactsExpiredError,
  AppCannotDeleteActiveBuildError,
  AppNoActiveBuildError,
  AppNoFilesError,
  AppStorageKeyNotFoundError,
  AppStorageValueTooLargeError,
  AppOAuthClientRegistrationFailedError,
  AppCrossTenantSharingDisabledError,
  GuestSessionRateLimitedError,
  AppBuildNotFoundError,
  AppSlugConflictError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helper — generates standard contract tests for each error class
// ---------------------------------------------------------------------------

function assertErrorContract(
  ErrorClass: new (message: string) => AppError,
  expectedCode: string,
  expectedStatusCode: number,
): void {
  const message = `Test message for ${expectedCode}`;
  const err = new ErrorClass(message);

  it(`${ErrorClass.name} — code is '${expectedCode}'`, () => {
    expect(err.code).toBe(expectedCode);
  });

  it(`${ErrorClass.name} — statusCode is ${expectedStatusCode}`, () => {
    expect(err.statusCode).toBe(expectedStatusCode);
  });

  it(`${ErrorClass.name} — message is propagated`, () => {
    expect(err.message).toBe(message);
  });

  it(`${ErrorClass.name} — instanceof AppError`, () => {
    expect(err).toBeInstanceOf(AppError);
  });

  it(`${ErrorClass.name} — instanceof Error`, () => {
    expect(err).toBeInstanceOf(Error);
  });

  it(`${ErrorClass.name} — name matches constructor`, () => {
    expect(err.name).toBe(ErrorClass.name);
  });

  it(`${ErrorClass.name} — toApiError returns spec-compliant envelope`, () => {
    const envelope = err.toApiError("req-app-test");
    expect(envelope).toMatchObject({
      error: {
        code: expectedCode,
        message,
        requestId: "req-app-test",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 404 errors
// ---------------------------------------------------------------------------

describe("AppNotFoundError", () => {
  assertErrorContract(AppNotFoundError, "APP_NOT_FOUND", 404);
});

describe("AppFileNotFoundError", () => {
  assertErrorContract(AppFileNotFoundError, "APP_FILE_NOT_FOUND", 404);
});

describe("AppStorageKeyNotFoundError", () => {
  assertErrorContract(AppStorageKeyNotFoundError, "APP_STORAGE_KEY_NOT_FOUND", 404);
});

// ---------------------------------------------------------------------------
// 400 errors
// ---------------------------------------------------------------------------

describe("AppBuildNotReadyError", () => {
  assertErrorContract(AppBuildNotReadyError, "APP_BUILD_NOT_READY", 400);
});

describe("AppBuildArtifactsExpiredError", () => {
  assertErrorContract(AppBuildArtifactsExpiredError, "APP_BUILD_ARTIFACTS_EXPIRED", 400);
});

describe("AppBuildNotFoundError", () => {
  assertErrorContract(AppBuildNotFoundError, "APP_BUILD_NOT_FOUND", 400);
});

describe("AppFileInvalidPathError", () => {
  assertErrorContract(AppFileInvalidPathError, "APP_FILE_INVALID_PATH", 400);
});

// ---------------------------------------------------------------------------
// 409 conflict errors
// ---------------------------------------------------------------------------

describe("AppFileVersionConflictError", () => {
  assertErrorContract(AppFileVersionConflictError, "APP_FILE_VERSION_CONFLICT", 409);
});

describe("AppBuildInProgressError", () => {
  assertErrorContract(AppBuildInProgressError, "APP_BUILD_IN_PROGRESS", 409);
});

describe("AppSlugConflictError", () => {
  assertErrorContract(AppSlugConflictError, "APP_SLUG_CONFLICT", 409);
});

// ---------------------------------------------------------------------------
// 413 payload-too-large errors
// ---------------------------------------------------------------------------

describe("AppFileTooLargeError", () => {
  assertErrorContract(AppFileTooLargeError, "APP_FILE_TOO_LARGE", 413);
});

describe("AppStorageValueTooLargeError", () => {
  assertErrorContract(AppStorageValueTooLargeError, "APP_STORAGE_VALUE_TOO_LARGE", 413);
});

// ---------------------------------------------------------------------------
// 422 unprocessable-entity errors
// ---------------------------------------------------------------------------

describe("AppCannotDeleteEntrypointError", () => {
  assertErrorContract(AppCannotDeleteEntrypointError, "APP_CANNOT_DELETE_ENTRYPOINT", 422);
});

describe("AppCannotDeleteActiveBuildError", () => {
  assertErrorContract(AppCannotDeleteActiveBuildError, "APP_CANNOT_DELETE_ACTIVE_BUILD", 422);
});

describe("AppNoFilesError", () => {
  assertErrorContract(AppNoFilesError, "APP_NO_FILES", 422);
});

// ---------------------------------------------------------------------------
// 429 rate-limit error
// ---------------------------------------------------------------------------

describe("GuestSessionRateLimitedError", () => {
  assertErrorContract(GuestSessionRateLimitedError, "GUEST_SESSION_RATE_LIMITED", 429);
});

// ---------------------------------------------------------------------------
// 403 forbidden errors
// ---------------------------------------------------------------------------

describe("AppCrossTenantSharingDisabledError", () => {
  assertErrorContract(AppCrossTenantSharingDisabledError, "APP_CROSS_TENANT_SHARING_DISABLED", 403);
});

// ---------------------------------------------------------------------------
// 502 / 503 upstream errors
// ---------------------------------------------------------------------------

describe("AppOAuthClientRegistrationFailedError", () => {
  assertErrorContract(AppOAuthClientRegistrationFailedError, "APP_OAUTH_CLIENT_REGISTRATION_FAILED", 502);
});

describe("AppNoActiveBuildError", () => {
  assertErrorContract(AppNoActiveBuildError, "APP_NO_ACTIVE_BUILD", 503);
});

// ---------------------------------------------------------------------------
// Details payload propagation
// ---------------------------------------------------------------------------

describe("error details propagation", () => {
  it("AppNotFoundError carries appId and tenantId in details", () => {
    const details = { appId: "app-001", tenantId: "tenant-001" };
    const err = new AppNotFoundError("not found", details);
    expect(err.details).toEqual(details);
  });

  it("AppNotFoundError details appear in toApiError envelope", () => {
    const details = { appId: "app-001", tenantId: "tenant-001" };
    const err = new AppNotFoundError("not found", details);
    const envelope = err.toApiError("req-app-1");
    expect(envelope.error.details).toEqual(details);
  });

  it("AppBuildInProgressError carries appId and activeBuildId in details", () => {
    const details = { appId: "app-001", activeBuildId: "build-999" };
    const err = new AppBuildInProgressError("build in progress", details);
    expect(err.details).toEqual(details);
  });

  it("AppFileVersionConflictError carries path and version in details", () => {
    const details = { path: "/src/index.tsx", expectedVersion: 3, actualVersion: 4 };
    const err = new AppFileVersionConflictError("version conflict", details);
    expect(err.details).toEqual(details);
  });

  it("AppBuildNotFoundError carries buildId and appId in details", () => {
    const details = { buildId: "build-xyz", appId: "app-001" };
    const err = new AppBuildNotFoundError("build not found", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-b-1");
    expect(envelope.error.details).toEqual(details);
  });

  it("AppSlugConflictError carries slug in details", () => {
    const details = { slug: "my-app" };
    const err = new AppSlugConflictError("slug conflict", details);
    expect(err.details).toEqual(details);
  });

  it("AppCannotDeleteActiveBuildError carries buildId and appId in details", () => {
    const details = { buildId: "build-active", appId: "app-001" };
    const err = new AppCannotDeleteActiveBuildError("cannot delete active build", details);
    expect(err.details).toEqual(details);
  });

  it("AppOAuthClientRegistrationFailedError carries appId in details", () => {
    const details = { appId: "app-001", previousBuildId: "build-prev" };
    const err = new AppOAuthClientRegistrationFailedError("oauth failed", details);
    expect(err.details).toEqual(details);
  });

  it("error without details has no details key in envelope", () => {
    const err = new AppNotFoundError("not found");
    const envelope = err.toApiError("req-z");
    expect(envelope.error).not.toHaveProperty("details");
  });

  it("GuestSessionRateLimitedError carries IP in details", () => {
    const details = { ip: "192.0.2.1", retryAfter: 60 };
    const err = new GuestSessionRateLimitedError("rate limited", details);
    expect(err.details).toEqual(details);
  });
});

// ---------------------------------------------------------------------------
// Prototype chain integrity
// ---------------------------------------------------------------------------

describe("prototype chain integrity", () => {
  it("all 19 error classes pass instanceof AppError at runtime", () => {
    const instances: AppError[] = [
      new AppNotFoundError("e"),
      new AppFileNotFoundError("e"),
      new AppFileVersionConflictError("e"),
      new AppFileTooLargeError("e"),
      new AppFileInvalidPathError("e"),
      new AppCannotDeleteEntrypointError("e"),
      new AppBuildInProgressError("e"),
      new AppBuildNotReadyError("e"),
      new AppBuildArtifactsExpiredError("e"),
      new AppCannotDeleteActiveBuildError("e"),
      new AppNoActiveBuildError("e"),
      new AppNoFilesError("e"),
      new AppStorageKeyNotFoundError("e"),
      new AppStorageValueTooLargeError("e"),
      new AppOAuthClientRegistrationFailedError("e"),
      new AppCrossTenantSharingDisabledError("e"),
      new GuestSessionRateLimitedError("e"),
      new AppBuildNotFoundError("e"),
      new AppSlugConflictError("e"),
    ];
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(AppError);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it("instanceof check correctly distinguishes AppNotFoundError from AppFileNotFoundError", () => {
    const e = new AppNotFoundError("e");
    expect(e).toBeInstanceOf(AppNotFoundError);
    expect(e).not.toBeInstanceOf(AppFileNotFoundError);
    expect(e).not.toBeInstanceOf(AppBuildNotFoundError);
  });

  it("instanceof check correctly distinguishes AppBuildInProgressError from AppBuildNotReadyError", () => {
    const e = new AppBuildInProgressError("e");
    expect(e).toBeInstanceOf(AppBuildInProgressError);
    expect(e).not.toBeInstanceOf(AppBuildNotReadyError);
    expect(e).not.toBeInstanceOf(AppBuildArtifactsExpiredError);
  });

  it("instanceof check correctly distinguishes AppFileTooLargeError from AppStorageValueTooLargeError", () => {
    const e = new AppFileTooLargeError("e");
    expect(e).toBeInstanceOf(AppFileTooLargeError);
    expect(e).not.toBeInstanceOf(AppStorageValueTooLargeError);
  });

  it("AppSlugConflictError is not an AppFileVersionConflictError", () => {
    const e = new AppSlugConflictError("e");
    expect(e).toBeInstanceOf(AppSlugConflictError);
    expect(e).not.toBeInstanceOf(AppFileVersionConflictError);
  });
});

// ---------------------------------------------------------------------------
// Stack trace presence
// ---------------------------------------------------------------------------

describe("stack trace", () => {
  it("AppNotFoundError has a non-empty stack trace", () => {
    const err = new AppNotFoundError("test");
    expect(err.stack).toBeTruthy();
  });

  it("AppBuildInProgressError stack trace contains the error class name", () => {
    const err = new AppBuildInProgressError("test");
    expect(err.stack).toContain("AppBuildInProgressError");
  });

  it("AppSlugConflictError stack trace is defined", () => {
    const err = new AppSlugConflictError("test");
    expect(typeof err.stack).toBe("string");
  });

  it("AppOAuthClientRegistrationFailedError stack trace is a string", () => {
    const err = new AppOAuthClientRegistrationFailedError("test");
    expect(typeof err.stack).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Code property stability — multiple instances always produce the same code
// ---------------------------------------------------------------------------

describe("code property stability", () => {
  it("AppNotFoundError code is always APP_NOT_FOUND", () => {
    const a = new AppNotFoundError("first");
    const b = new AppNotFoundError("second");
    expect(a.code).toBe("APP_NOT_FOUND");
    expect(b.code).toBe("APP_NOT_FOUND");
  });

  it("AppSlugConflictError code is always APP_SLUG_CONFLICT", () => {
    const err = new AppSlugConflictError("msg");
    expect(err.code).toBe("APP_SLUG_CONFLICT");
  });

  it("GuestSessionRateLimitedError code is always GUEST_SESSION_RATE_LIMITED", () => {
    const err = new GuestSessionRateLimitedError("limited");
    expect(err.code).toBe("GUEST_SESSION_RATE_LIMITED");
  });

  it("AppBuildArtifactsExpiredError statusCode is always 400", () => {
    const err = new AppBuildArtifactsExpiredError("expired");
    expect(err.statusCode).toBe(400);
  });

  it("AppNoActiveBuildError statusCode is always 503", () => {
    const err = new AppNoActiveBuildError("no build");
    expect(err.statusCode).toBe(503);
  });
});
