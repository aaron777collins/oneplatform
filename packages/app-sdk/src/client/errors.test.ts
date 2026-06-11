/**
 * Tests for error normalisation utilities.
 */

import { describe, it, expect } from "vitest";
import { parseBffError, createNetworkError, isAppSDKError, toAppSDKError } from "./errors.js";

describe("parseBffError", () => {
  function mockResponse(
    status: number,
    body?: unknown,
    requestId = "",
  ): Response {
    return {
      status,
      statusText: `Status ${status}`,
      ok: false,
      headers: {
        get: (name: string) => (name === "X-Request-ID" ? requestId : null),
      },
      json: () => Promise.resolve(body ?? {}),
    } as unknown as Response;
  }

  it("maps 403 to PERMISSION_DENIED", async () => {
    const err = await parseBffError(mockResponse(403));
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.statusCode).toBe(403);
    expect(err.isRetryable).toBe(false);
  });

  it("maps 404 to ENTITY_NOT_FOUND", async () => {
    const err = await parseBffError(mockResponse(404));
    expect(err.code).toBe("ENTITY_NOT_FOUND");
  });

  it("maps 429 to RATE_LIMITED and marks retryable", async () => {
    const err = await parseBffError(mockResponse(429));
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.isRetryable).toBe(true);
  });

  it("maps 503 to SERVICE_UNAVAILABLE and marks retryable", async () => {
    const err = await parseBffError(mockResponse(503));
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
    expect(err.isRetryable).toBe(true);
  });

  it("maps unknown status to UNKNOWN_ERROR", async () => {
    const err = await parseBffError(mockResponse(418));
    expect(err.code).toBe("UNKNOWN_ERROR");
  });

  it("prefers error code from JSON body when present", async () => {
    const err = await parseBffError(
      mockResponse(400, { error: { code: "VALIDATION_FAILED", message: "Field required" } }),
    );
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toBe("Field required");
  });

  it("reads X-Request-ID header", async () => {
    const err = await parseBffError(mockResponse(500, undefined, "req-abc-123"));
    expect(err.requestId).toBe("req-abc-123");
  });

  it("falls back gracefully when body is not JSON", async () => {
    const response = {
      status: 500,
      statusText: "Internal Server Error",
      ok: false,
      headers: { get: () => null },
      json: () => Promise.reject(new Error("Invalid JSON")),
    } as unknown as Response;
    const err = await parseBffError(response);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.requestId).toBe("");
  });
});

describe("createNetworkError", () => {
  it("creates a retryable NETWORK_ERROR with status 0", () => {
    const err = createNetworkError(new Error("Failed to fetch"));
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.statusCode).toBe(0);
    expect(err.isRetryable).toBe(true);
    expect(err.requestId).toBe("");
    expect(err.message).toBe("Failed to fetch");
  });

  it("falls back to generic message for non-Error values", () => {
    const err = createNetworkError("something went wrong");
    expect(err.message).toBe("Network request failed");
  });
});

describe("isAppSDKError", () => {
  it("returns true for valid AppSDKError shapes", () => {
    expect(
      isAppSDKError({
        code: "NETWORK_ERROR",
        message: "oops",
        statusCode: 0,
        isRetryable: true,
        requestId: "",
      }),
    ).toBe(true);
  });

  it("returns false for plain strings", () => {
    expect(isAppSDKError("error")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAppSDKError(null)).toBe(false);
  });

  it("returns false for objects missing required fields", () => {
    expect(isAppSDKError({ code: "X" })).toBe(false);
  });
});

describe("toAppSDKError", () => {
  it("passes through existing AppSDKError unchanged", () => {
    const original = {
      code: "CONFLICT",
      message: "Duplicate",
      statusCode: 409,
      isRetryable: false,
      requestId: "r1",
    };
    expect(toAppSDKError(original)).toBe(original);
  });

  it("wraps plain Error", () => {
    const err = toAppSDKError(new Error("boom"));
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("boom");
  });
});
