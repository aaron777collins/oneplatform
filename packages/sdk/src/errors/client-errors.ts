/**
 * 4xx client error classes.
 *
 * All are non-retryable: the caller's request is wrong in a way that a retry
 * cannot fix without changing the request itself.
 */

import { OnePlatformError, type OnePlatformErrorOptions } from './base.js';

/** Base class for all 4xx (non-429) HTTP errors. */
export class ClientError extends OnePlatformError {
  override readonly retryable = false as const;

  constructor(options: OnePlatformErrorOptions) {
    super({ ...options, retryable: false });
  }
}

/** 401 Unauthorized. Invalid or expired credentials. */
export class AuthError extends ClientError {
  override readonly statusCode = 401 as const;
}

/** 403 Forbidden. Authenticated but lacks permission. */
export class ForbiddenError extends ClientError {
  override readonly statusCode = 403 as const;
}

/** 404 Not Found. The requested resource does not exist. */
export class NotFoundError extends ClientError {
  override readonly statusCode = 404 as const;
}

/** 409 Conflict. Unique constraint or optimistic lock violation. */
export class ConflictError extends ClientError {
  override readonly statusCode = 409 as const;
}

/** 422 Unprocessable Entity. Schema validation failed. */
export class ValidationError extends ClientError {
  override readonly statusCode = 422 as const;

  /**
   * Per-field validation messages extracted from details.fields.
   * Keys are field names; values are arrays of error strings.
   */
  get fieldErrors(): Record<string, string[]> {
    return (this.details?.['fields'] as Record<string, string[]> | undefined) ?? {};
  }
}

/** 410 Gone. Pagination cursor older than 24 hours. Caller must restart from page 1. */
export class CursorExpiredError extends ClientError {
  override readonly statusCode = 410 as const;
}

/**
 * SDK-level misconfiguration error.
 * Never reaches the server — thrown at client construction or before the request.
 */
export class ConfigurationError extends ClientError {
  // statusCode intentionally absent — this error never touches the network
  override readonly statusCode = undefined;

  constructor(message: string) {
    super({
      code: 'SDK_CONFIGURATION_ERROR',
      message,
      retryable: false,
    });
  }
}

/**
 * Thrown by collect() when the result set exceeds the caller-specified maxItems cap.
 * Callers should increase maxItems or switch to async iteration.
 */
export class PaginationLimitError extends ClientError {
  constructor(message: string, readonly limit: number) {
    super({
      code: 'PAGINATION_LIMIT_EXCEEDED',
      message,
      retryable: false,
    });
  }
}
