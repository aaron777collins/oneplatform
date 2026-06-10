// Unit tests for services/errors.ts
//
// Verifies every Gateway error class has the correct code, statusCode,
// message propagation, details payload propagation, AppError/Error inheritance,
// and correct name property.

import { describe, it, expect } from "vitest";
import { AppError } from "@oneplatform/core";
import {
  WebhookSsrfBlockedError,
  WebhookConnectivityFailedError,
  WebhookInvalidUrlError,
  SseConnectionLimitError,
  RouteNotFoundError,
  ProxyTimeoutError,
  ProxyUnavailableError,
  EntityTypeNotFoundError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function assertErrorContract(
  ErrorClass: new (message: string) => AppError,
  expectedCode: string,
  expectedStatusCode: number
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
    const envelope = err.toApiError("req-gateway-test");
    expect(envelope).toMatchObject({
      error: {
        code: expectedCode,
        message,
        requestId: "req-gateway-test",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 404 errors
// ---------------------------------------------------------------------------

describe("RouteNotFoundError", () => {
  assertErrorContract(RouteNotFoundError, "GATEWAY_ROUTE_NOT_FOUND", 404);
});

describe("EntityTypeNotFoundError", () => {
  assertErrorContract(EntityTypeNotFoundError, "GATEWAY_ENTITY_TYPE_NOT_FOUND", 404);
});

// ---------------------------------------------------------------------------
// 422 errors
// ---------------------------------------------------------------------------

describe("WebhookSsrfBlockedError", () => {
  assertErrorContract(WebhookSsrfBlockedError, "GATEWAY_WEBHOOK_SSRF_BLOCKED", 422);
});

describe("WebhookConnectivityFailedError", () => {
  assertErrorContract(
    WebhookConnectivityFailedError,
    "GATEWAY_WEBHOOK_CONNECTIVITY_FAILED",
    422
  );
});

describe("WebhookInvalidUrlError", () => {
  assertErrorContract(WebhookInvalidUrlError, "GATEWAY_WEBHOOK_INVALID_URL", 422);
});

// ---------------------------------------------------------------------------
// 429 errors
// ---------------------------------------------------------------------------

describe("SseConnectionLimitError", () => {
  assertErrorContract(SseConnectionLimitError, "GATEWAY_SSE_CONNECTION_LIMIT", 429);
});

// ---------------------------------------------------------------------------
// 503 errors
// ---------------------------------------------------------------------------

describe("ProxyTimeoutError", () => {
  assertErrorContract(ProxyTimeoutError, "GATEWAY_PROXY_TIMEOUT", 503);
});

describe("ProxyUnavailableError", () => {
  assertErrorContract(ProxyUnavailableError, "GATEWAY_PROXY_UNAVAILABLE", 503);
});

// ---------------------------------------------------------------------------
// Details payload propagation
// ---------------------------------------------------------------------------

describe("error details propagation", () => {
  it("WebhookSsrfBlockedError carries details payload", () => {
    const details = { url: "https://evil.internal", resolvedIp: "10.0.0.1" };
    const err = new WebhookSsrfBlockedError("SSRF detected", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-x");
    expect(envelope.error.details).toEqual(details);
  });

  it("WebhookInvalidUrlError carries url and protocol in details", () => {
    const details = { url: "ftp://bad", protocol: "ftp:" };
    const err = new WebhookInvalidUrlError("Invalid protocol", details);
    expect(err.details).toEqual(details);
  });

  it("RouteNotFoundError without details has no details key in envelope", () => {
    const err = new RouteNotFoundError("Route not found");
    const envelope = err.toApiError("req-y");
    expect(envelope.error).not.toHaveProperty("details");
  });

  it("ProxyTimeoutError with service details", () => {
    const details = { service: "auth", timeoutMs: 5000 };
    const err = new ProxyTimeoutError("Timeout", details);
    expect((err.details as typeof details).service).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// Prototype chain integrity (Object.setPrototypeOf)
// ---------------------------------------------------------------------------

describe("prototype chain integrity", () => {
  it("all 8 error classes pass instanceof AppError at runtime", () => {
    const instances: AppError[] = [
      new WebhookSsrfBlockedError("e"),
      new WebhookConnectivityFailedError("e"),
      new WebhookInvalidUrlError("e"),
      new SseConnectionLimitError("e"),
      new RouteNotFoundError("e"),
      new ProxyTimeoutError("e"),
      new ProxyUnavailableError("e"),
      new EntityTypeNotFoundError("e"),
    ];
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(AppError);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it("instanceof check works correctly for concrete subclass vs sibling", () => {
    const ssrf = new WebhookSsrfBlockedError("e");
    expect(ssrf).toBeInstanceOf(WebhookSsrfBlockedError);
    expect(ssrf).not.toBeInstanceOf(WebhookInvalidUrlError);
    expect(ssrf).not.toBeInstanceOf(RouteNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Stack trace is present
// ---------------------------------------------------------------------------

describe("stack trace", () => {
  it("WebhookSsrfBlockedError has a non-empty stack trace", () => {
    const err = new WebhookSsrfBlockedError("test");
    expect(err.stack).toBeTruthy();
  });

  it("ProxyUnavailableError stack trace contains the error name", () => {
    const err = new ProxyUnavailableError("test");
    expect(err.stack).toContain("ProxyUnavailableError");
  });
});
