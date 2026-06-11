// Unit tests for services/errors.ts
//
// Verifies all 16 execution error classes have the correct code, statusCode,
// message propagation, details payload propagation, AppError/Error inheritance,
// correct name property, and toApiError() envelope shape.

import { describe, it, expect } from "vitest";
import { AppError } from "@oneplatform/core";
import {
  ExecutionNotFoundError,
  ExecutionSandboxUnavailableError,
  ExecutionTimeoutError,
  ExecutionOomError,
  ExecutionSandboxCrashError,
  ExecutionHookRecursionError,
  ExecutionCodeTooLargeError,
  ExecutionPayloadTooLargeError,
  ExecutionResultTooLargeError,
  ExecutionInvalidLanguageError,
  ExecutionTimeoutExceededLimitError,
  ExecutionBundleIntegrityError,
  ExecutionModuleNotAllowedError,
  ExecutionFetchBlockedError,
  ExecutionCredentialsDeniedError,
  ServiceDrainingError,
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
    const envelope = err.toApiError("req-exec-test");
    expect(envelope).toMatchObject({
      error: {
        code: expectedCode,
        message,
        requestId: "req-exec-test",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 404 errors
// ---------------------------------------------------------------------------

describe("ExecutionNotFoundError", () => {
  assertErrorContract(ExecutionNotFoundError, "EXECUTION_NOT_FOUND", 404);
});

// ---------------------------------------------------------------------------
// 503 errors
// ---------------------------------------------------------------------------

describe("ExecutionSandboxUnavailableError", () => {
  assertErrorContract(ExecutionSandboxUnavailableError, "EXECUTION_SANDBOX_UNAVAILABLE", 503);
});

describe("ServiceDrainingError", () => {
  assertErrorContract(ServiceDrainingError, "SERVICE_DRAINING", 503);
});

// ---------------------------------------------------------------------------
// 400 errors
// ---------------------------------------------------------------------------

describe("ExecutionCodeTooLargeError", () => {
  assertErrorContract(ExecutionCodeTooLargeError, "EXECUTION_CODE_TOO_LARGE", 400);
});

describe("ExecutionPayloadTooLargeError", () => {
  assertErrorContract(ExecutionPayloadTooLargeError, "EXECUTION_PAYLOAD_TOO_LARGE", 400);
});

describe("ExecutionInvalidLanguageError", () => {
  assertErrorContract(ExecutionInvalidLanguageError, "EXECUTION_INVALID_LANGUAGE", 400);
});

describe("ExecutionTimeoutExceededLimitError", () => {
  assertErrorContract(ExecutionTimeoutExceededLimitError, "EXECUTION_TIMEOUT_EXCEEDED_LIMIT", 400);
});

// ---------------------------------------------------------------------------
// 500 errors
// ---------------------------------------------------------------------------

describe("ExecutionBundleIntegrityError", () => {
  assertErrorContract(ExecutionBundleIntegrityError, "EXECUTION_BUNDLE_INTEGRITY_ERROR", 500);
});

// ---------------------------------------------------------------------------
// 200 (SSE event) errors
// ---------------------------------------------------------------------------

describe("ExecutionTimeoutError", () => {
  assertErrorContract(ExecutionTimeoutError, "EXECUTION_TIMEOUT", 200);
});

describe("ExecutionOomError", () => {
  assertErrorContract(ExecutionOomError, "EXECUTION_OOM", 200);
});

describe("ExecutionSandboxCrashError", () => {
  assertErrorContract(ExecutionSandboxCrashError, "EXECUTION_SANDBOX_CRASH", 200);
});

describe("ExecutionHookRecursionError", () => {
  assertErrorContract(ExecutionHookRecursionError, "EXECUTION_HOOK_RECURSION", 200);
});

describe("ExecutionResultTooLargeError", () => {
  assertErrorContract(ExecutionResultTooLargeError, "EXECUTION_RESULT_TOO_LARGE", 200);
});

describe("ExecutionModuleNotAllowedError", () => {
  assertErrorContract(ExecutionModuleNotAllowedError, "EXECUTION_MODULE_NOT_ALLOWED", 200);
});

describe("ExecutionFetchBlockedError", () => {
  assertErrorContract(ExecutionFetchBlockedError, "EXECUTION_FETCH_BLOCKED", 200);
});

describe("ExecutionCredentialsDeniedError", () => {
  assertErrorContract(ExecutionCredentialsDeniedError, "EXECUTION_CREDENTIALS_DENIED", 200);
});

// ---------------------------------------------------------------------------
// Details payload propagation
// ---------------------------------------------------------------------------

describe("error details propagation", () => {
  it("ExecutionNotFoundError carries details payload", () => {
    const details = { executionId: "exec-abc", tenantId: "tenant-1" };
    const err = new ExecutionNotFoundError("not found", details);
    expect(err.details).toEqual(details);
  });

  it("ExecutionNotFoundError details appear in toApiError envelope", () => {
    const details = { executionId: "exec-abc" };
    const err = new ExecutionNotFoundError("not found", details);
    const envelope = err.toApiError("req-1");
    expect(envelope.error.details).toEqual(details);
  });

  it("ExecutionBundleIntegrityError carries pluginId and version in details", () => {
    const details = { pluginId: "plugin-x", version: "1.2.3", expectedHash: "sha256:abc" };
    const err = new ExecutionBundleIntegrityError("Hash mismatch", details);
    expect(err.details).toEqual(details);
  });

  it("ExecutionCodeTooLargeError carries size details", () => {
    const details = { actualBytes: 524_289, limitBytes: 524_288 };
    const err = new ExecutionCodeTooLargeError("Code too large", details);
    expect(err.details).toEqual(details);
  });

  it("ExecutionTimeoutError carries durationMs in details", () => {
    const details = { durationMs: 30_001 };
    const err = new ExecutionTimeoutError("Execution timed out", details);
    expect(err.details).toEqual(details);
  });

  it("ServiceDrainingError carries pluginId in details", () => {
    const details = { pluginId: "stripe-connector" };
    const err = new ServiceDrainingError("Plugin is draining", details);
    expect(err.details).toEqual(details);
  });

  it("error without details has no details key in toApiError envelope", () => {
    const err = new ExecutionNotFoundError("Not found");
    const envelope = err.toApiError("req-x");
    expect(envelope.error).not.toHaveProperty("details");
  });
});

// ---------------------------------------------------------------------------
// Prototype chain integrity
// ---------------------------------------------------------------------------

describe("prototype chain integrity", () => {
  it("all 16 error classes pass instanceof AppError at runtime", () => {
    const instances: AppError[] = [
      new ExecutionNotFoundError("e"),
      new ExecutionSandboxUnavailableError("e"),
      new ExecutionTimeoutError("e"),
      new ExecutionOomError("e"),
      new ExecutionSandboxCrashError("e"),
      new ExecutionHookRecursionError("e"),
      new ExecutionCodeTooLargeError("e"),
      new ExecutionPayloadTooLargeError("e"),
      new ExecutionResultTooLargeError("e"),
      new ExecutionInvalidLanguageError("e"),
      new ExecutionTimeoutExceededLimitError("e"),
      new ExecutionBundleIntegrityError("e"),
      new ExecutionModuleNotAllowedError("e"),
      new ExecutionFetchBlockedError("e"),
      new ExecutionCredentialsDeniedError("e"),
      new ServiceDrainingError("e"),
    ];
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(AppError);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it("instanceof check — ExecutionNotFoundError is not ExecutionSandboxUnavailableError", () => {
    const e = new ExecutionNotFoundError("e");
    expect(e).toBeInstanceOf(ExecutionNotFoundError);
    expect(e).not.toBeInstanceOf(ExecutionSandboxUnavailableError);
    expect(e).not.toBeInstanceOf(ServiceDrainingError);
  });

  it("instanceof check — SSE error classes are distinct from each other", () => {
    const timeout = new ExecutionTimeoutError("e");
    expect(timeout).toBeInstanceOf(ExecutionTimeoutError);
    expect(timeout).not.toBeInstanceOf(ExecutionOomError);
    expect(timeout).not.toBeInstanceOf(ExecutionSandboxCrashError);
  });

  it("instanceof check — 400 error classes are distinct from 503 error classes", () => {
    const codeTooLarge = new ExecutionCodeTooLargeError("e");
    expect(codeTooLarge).toBeInstanceOf(ExecutionCodeTooLargeError);
    expect(codeTooLarge).not.toBeInstanceOf(ServiceDrainingError);
    expect(codeTooLarge).not.toBeInstanceOf(ExecutionSandboxUnavailableError);
  });
});

// ---------------------------------------------------------------------------
// SSE status code semantics (statusCode = 200 signals SSE event, not HTTP error)
// ---------------------------------------------------------------------------

describe("SSE event errors have statusCode 200", () => {
  const sseErrorClasses = [
    ExecutionTimeoutError,
    ExecutionOomError,
    ExecutionSandboxCrashError,
    ExecutionHookRecursionError,
    ExecutionResultTooLargeError,
    ExecutionModuleNotAllowedError,
    ExecutionFetchBlockedError,
    ExecutionCredentialsDeniedError,
  ] as const;

  it("all SSE event errors report statusCode 200", () => {
    for (const ErrorClass of sseErrorClasses) {
      const err = new ErrorClass("test");
      expect(err.statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Stack trace presence
// ---------------------------------------------------------------------------

describe("stack trace", () => {
  it("ExecutionNotFoundError has a non-empty stack trace", () => {
    const err = new ExecutionNotFoundError("test");
    expect(err.stack).toBeTruthy();
  });

  it("ExecutionBundleIntegrityError stack trace contains class name", () => {
    const err = new ExecutionBundleIntegrityError("test");
    expect(err.stack).toContain("ExecutionBundleIntegrityError");
  });

  it("ServiceDrainingError stack is a string", () => {
    const err = new ServiceDrainingError("test");
    expect(typeof err.stack).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Code property stability — two instances return the same code
// ---------------------------------------------------------------------------

describe("code property stability", () => {
  it("ExecutionNotFoundError code is always EXECUTION_NOT_FOUND", () => {
    const a = new ExecutionNotFoundError("first");
    const b = new ExecutionNotFoundError("second");
    expect(a.code).toBe("EXECUTION_NOT_FOUND");
    expect(b.code).toBe("EXECUTION_NOT_FOUND");
  });

  it("ServiceDrainingError code is always SERVICE_DRAINING", () => {
    const err = new ServiceDrainingError("msg");
    expect(err.code).toBe("SERVICE_DRAINING");
  });

  it("ExecutionBundleIntegrityError code is always EXECUTION_BUNDLE_INTEGRITY_ERROR", () => {
    const err = new ExecutionBundleIntegrityError("integrity fail");
    expect(err.code).toBe("EXECUTION_BUNDLE_INTEGRITY_ERROR");
  });
});
