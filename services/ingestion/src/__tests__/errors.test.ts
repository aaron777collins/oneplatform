// Unit tests for services/ingestion/src/services/errors.ts
//
// Verifies every Ingestion error class has the correct code, statusCode,
// message propagation, details payload propagation, AppError/Error inheritance,
// and correct name property.

import { describe, it, expect } from "vitest";
import { AppError } from "@oneplatform/core";
import {
  ConnectorNotFoundError,
  ConnectorDisabledError,
  SyncAlreadyRunningError,
  ConnectorTimeoutError,
  ConnectorAuthFailedError,
  ConnectorRateLimitedError,
  ConnectorDataError,
  ConnectorConfigError,
  QueueFullError,
  CredentialDecryptFailedError,
  CredentialNotFoundError,
  UploadFileTooLargeError,
  UploadUnsupportedTypeError,
  UploadParseFailedError,
  UploadJobNotFoundError,
  WebhookReceiverNotFoundError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helper — generates a standard battery of assertions for each error class.
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
    const envelope = err.toApiError("req-ingestion-test");
    expect(envelope).toMatchObject({
      error: {
        code: expectedCode,
        message,
        requestId: "req-ingestion-test",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 400 errors
// ---------------------------------------------------------------------------

describe("ConnectorConfigError", () => {
  assertErrorContract(ConnectorConfigError, "INGESTION_CONNECTOR_CONFIG_ERROR", 400);
});

describe("CredentialNotFoundError", () => {
  assertErrorContract(CredentialNotFoundError, "CREDENTIAL_NOT_FOUND", 400);
});

// ---------------------------------------------------------------------------
// 404 errors
// ---------------------------------------------------------------------------

describe("ConnectorNotFoundError", () => {
  assertErrorContract(ConnectorNotFoundError, "INGESTION_CONNECTOR_NOT_FOUND", 404);
});

describe("UploadJobNotFoundError", () => {
  assertErrorContract(UploadJobNotFoundError, "UPLOAD_JOB_NOT_FOUND", 404);
});

// ---------------------------------------------------------------------------
// 409 errors
// ---------------------------------------------------------------------------

describe("ConnectorDisabledError", () => {
  assertErrorContract(ConnectorDisabledError, "INGESTION_CONNECTOR_DISABLED", 409);
});

describe("SyncAlreadyRunningError", () => {
  assertErrorContract(SyncAlreadyRunningError, "INGESTION_SYNC_ALREADY_RUNNING", 409);
});

// ---------------------------------------------------------------------------
// 413 errors
// ---------------------------------------------------------------------------

describe("UploadFileTooLargeError", () => {
  assertErrorContract(UploadFileTooLargeError, "UPLOAD_FILE_TOO_LARGE", 413);
});

// ---------------------------------------------------------------------------
// 415 errors
// ---------------------------------------------------------------------------

describe("UploadUnsupportedTypeError", () => {
  assertErrorContract(UploadUnsupportedTypeError, "UPLOAD_UNSUPPORTED_TYPE", 415);
});

// ---------------------------------------------------------------------------
// 422 errors
// ---------------------------------------------------------------------------

describe("UploadParseFailedError", () => {
  assertErrorContract(UploadParseFailedError, "UPLOAD_PARSE_FAILED", 422);
});

// ---------------------------------------------------------------------------
// 500 errors
// ---------------------------------------------------------------------------

describe("CredentialDecryptFailedError", () => {
  assertErrorContract(CredentialDecryptFailedError, "CREDENTIAL_DECRYPT_FAILED", 500);
});

// ---------------------------------------------------------------------------
// 502 errors
// ---------------------------------------------------------------------------

describe("ConnectorTimeoutError", () => {
  assertErrorContract(ConnectorTimeoutError, "INGESTION_CONNECTOR_TIMEOUT", 502);
});

describe("ConnectorAuthFailedError", () => {
  assertErrorContract(ConnectorAuthFailedError, "INGESTION_CONNECTOR_AUTH_FAILED", 502);
});

describe("ConnectorRateLimitedError", () => {
  assertErrorContract(ConnectorRateLimitedError, "INGESTION_CONNECTOR_RATE_LIMITED", 502);
});

describe("ConnectorDataError", () => {
  assertErrorContract(ConnectorDataError, "INGESTION_CONNECTOR_DATA_ERROR", 502);
});

// ---------------------------------------------------------------------------
// 503 errors
// ---------------------------------------------------------------------------

describe("QueueFullError", () => {
  assertErrorContract(QueueFullError, "INGESTION_QUEUE_FULL", 503);
});

// ---------------------------------------------------------------------------
// 200 status (anti-enumeration)
// ---------------------------------------------------------------------------

describe("WebhookReceiverNotFoundError", () => {
  assertErrorContract(WebhookReceiverNotFoundError, "INGESTION_WEBHOOK_NOT_FOUND", 200);
});

// ---------------------------------------------------------------------------
// Details payload propagation
// ---------------------------------------------------------------------------

describe("error details propagation", () => {
  it("ConnectorNotFoundError carries details payload", () => {
    const details = { connectorId: "abc-123" };
    const err = new ConnectorNotFoundError("Not found", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-1");
    expect(envelope.error.details).toEqual(details);
  });

  it("CredentialDecryptFailedError carries cause in details", () => {
    const details = { connectorId: "c1", fieldName: "apiKey", cause: "auth tag mismatch" };
    const err = new CredentialDecryptFailedError("Decrypt failed", details);
    expect(err.details).toEqual(details);
  });

  it("UploadFileTooLargeError carries fileSize and maxBytes", () => {
    const details = { fileSize: 10_000_000_000, maxBytes: 5_368_709_120 };
    const err = new UploadFileTooLargeError("Too large", details);
    expect(err.details).toEqual(details);
  });

  it("ConnectorConfigError without details has no details key in envelope", () => {
    const err = new ConnectorConfigError("Bad config");
    const envelope = err.toApiError("req-2");
    expect(envelope.error).not.toHaveProperty("details");
  });

  it("WebhookReceiverNotFoundError with details propagates them", () => {
    const details = { webhookId: "wh-xyz" };
    const err = new WebhookReceiverNotFoundError("Webhook not found", details);
    expect(err.details).toEqual(details);
  });
});

// ---------------------------------------------------------------------------
// Prototype chain integrity
// ---------------------------------------------------------------------------

describe("prototype chain integrity", () => {
  it("all 16 error classes pass instanceof AppError at runtime", () => {
    const instances: AppError[] = [
      new ConnectorNotFoundError("e"),
      new ConnectorDisabledError("e"),
      new SyncAlreadyRunningError("e"),
      new ConnectorTimeoutError("e"),
      new ConnectorAuthFailedError("e"),
      new ConnectorRateLimitedError("e"),
      new ConnectorDataError("e"),
      new ConnectorConfigError("e"),
      new QueueFullError("e"),
      new CredentialDecryptFailedError("e"),
      new CredentialNotFoundError("e"),
      new UploadFileTooLargeError("e"),
      new UploadUnsupportedTypeError("e"),
      new UploadParseFailedError("e"),
      new UploadJobNotFoundError("e"),
      new WebhookReceiverNotFoundError("e"),
    ];
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(AppError);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it("instanceof check works correctly for concrete subclass vs sibling", () => {
    const notFound = new ConnectorNotFoundError("e");
    expect(notFound).toBeInstanceOf(ConnectorNotFoundError);
    expect(notFound).not.toBeInstanceOf(ConnectorDisabledError);
    expect(notFound).not.toBeInstanceOf(CredentialNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Stack trace is present
// ---------------------------------------------------------------------------

describe("stack trace", () => {
  it("ConnectorNotFoundError has a non-empty stack trace", () => {
    const err = new ConnectorNotFoundError("test");
    expect(err.stack).toBeTruthy();
  });

  it("CredentialDecryptFailedError stack trace contains the error name", () => {
    const err = new CredentialDecryptFailedError("test");
    expect(err.stack).toContain("CredentialDecryptFailedError");
  });

  it("WebhookReceiverNotFoundError has a non-empty stack trace", () => {
    const err = new WebhookReceiverNotFoundError("test");
    expect(err.stack).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Edge cases — empty message
// ---------------------------------------------------------------------------

describe("empty message handling", () => {
  it("ConnectorNotFoundError accepts an empty message string", () => {
    const err = new ConnectorNotFoundError("");
    expect(err.message).toBe("");
    expect(err.code).toBe("INGESTION_CONNECTOR_NOT_FOUND");
  });

  it("QueueFullError accepts an empty message string", () => {
    const err = new QueueFullError("");
    expect(err.message).toBe("");
    expect(err.statusCode).toBe(503);
  });
});
