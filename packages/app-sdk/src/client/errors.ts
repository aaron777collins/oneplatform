/**
 * Error normalisation utilities for the BFF client.
 *
 * All errors that escape the SDK are normalised to AppSDKError so that
 * app developers never need to handle raw fetch errors or HTTP status
 * codes — they work with a single, predictable error shape.
 */

import type { AppSDKError } from "../types/entities.js";

// ─── HTTP status → error code mapping ────────────────────────────────────────

const HTTP_STATUS_CODES: Readonly<Record<number, string>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "PERMISSION_DENIED",
  404: "ENTITY_NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  503: "SERVICE_UNAVAILABLE",
} as const;

function httpStatusToCode(status: number): string {
  return HTTP_STATUS_CODES[status] ?? "UNKNOWN_ERROR";
}

// ─── Error factories ──────────────────────────────────────────────────────────

/**
 * Parses a non-2xx BFF response into a normalised AppSDKError.
 * Attempts to read a structured JSON error body but gracefully degrades to
 * status text if the body is not valid JSON.
 */
export async function parseBffError(response: Response): Promise<AppSDKError> {
  const requestId = response.headers.get("X-Request-ID") ?? "";
  let body: { error?: { code?: string; message?: string } } = {};
  try {
    body = (await response.json()) as { error?: { code?: string; message?: string } };
  } catch {
    // Non-JSON error body — fall through to defaults
  }
  return {
    code: body.error?.code ?? httpStatusToCode(response.status),
    message: body.error?.message ?? response.statusText,
    statusCode: response.status,
    isRetryable: response.status === 429 || response.status === 503,
    requestId,
  };
}

/**
 * Wraps a caught fetch error (network failure, DNS, timeout) into AppSDKError.
 * These errors never have an HTTP status code (0) and are always retryable.
 */
export function createNetworkError(err: unknown): AppSDKError {
  const message = err instanceof Error ? err.message : "Network request failed";
  return {
    code: "NETWORK_ERROR",
    message,
    statusCode: 0,
    isRetryable: true,
    requestId: "",
  };
}

/**
 * Type guard to check if an unknown value conforms to the AppSDKError shape.
 * Used in hooks to narrow caught values from Promise rejections.
 */
export function isAppSDKError(value: unknown): value is AppSDKError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["code"] === "string" &&
    typeof (value as Record<string, unknown>)["message"] === "string" &&
    typeof (value as Record<string, unknown>)["statusCode"] === "number"
  );
}

/**
 * Coerces any caught value into an AppSDKError.
 * Used as the last line of defence in catch blocks where the error origin
 * is unknown (e.g. programmer error, unexpected throws).
 */
export function toAppSDKError(err: unknown): AppSDKError {
  if (isAppSDKError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "INTERNAL_ERROR",
    message,
    statusCode: 0,
    isRetryable: false,
    requestId: "",
  };
}
