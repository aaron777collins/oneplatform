import type { ApiError } from "./types.js";

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    // Preserve correct prototype chain when targeting ES5 via tsc
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toApiError(requestId: string): ApiError {
    return {
      error: {
        code: this.code,
        // InternalError overrides this to return a safe message (see below).
        message: this.message,
        ...(this.details !== undefined && { details: this.details }),
        requestId,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Error code registry (spec §6, Error Code Registry table)
// ---------------------------------------------------------------------------

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
  readonly statusCode = 401;
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
  readonly statusCode = 403;
}

export class InsufficientScopeError extends AppError {
  readonly code = "INSUFFICIENT_SCOPE" as const;
  readonly statusCode = 403;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class EntityNotFoundError extends AppError {
  readonly code = "ENTITY_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const;
  readonly statusCode = 409;
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR" as const;
  readonly statusCode = 422;
}

export class RateLimitError extends AppError {
  readonly code = "RATE_LIMIT_EXCEEDED" as const;
  readonly statusCode = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// InternalError intentionally conceals its message from the API response.
// The real message is logged at DEBUG level and tied to requestId for admins.
export class InternalError extends AppError {
  readonly code = "INTERNAL_ERROR" as const;
  readonly statusCode = 500;

  override toApiError(requestId: string): ApiError {
    return {
      error: {
        code: this.code,
        message: "An unexpected error occurred.",
        requestId,
      },
    };
  }
}

export class ServiceUnavailableError extends AppError {
  readonly code = "SERVICE_UNAVAILABLE" as const;
  readonly statusCode = 503;
}

export class PaginationLimitExceededError extends AppError {
  readonly code = "PAGINATION_LIMIT_EXCEEDED" as const;
  readonly statusCode = 400;
}

export class InvalidCursorError extends AppError {
  readonly code = "INVALID_CURSOR" as const;
  readonly statusCode = 400;
}

export class CursorExpiredError extends AppError {
  readonly code = "CURSOR_EXPIRED" as const;
  readonly statusCode = 410;
}

export class BulkLimitExceededError extends AppError {
  readonly code = "BULK_LIMIT_EXCEEDED" as const;
  readonly statusCode = 400;
}

export class OriginNotAllowedError extends AppError {
  readonly code = "ORIGIN_NOT_ALLOWED" as const;
  readonly statusCode = 403;
}

export class UnknownFilterFieldError extends AppError {
  readonly code = "UNKNOWN_FILTER_FIELD" as const;
  readonly statusCode = 400;
}

export class UnsortableFieldError extends AppError {
  readonly code = "UNSORTABLE_FIELD" as const;
  readonly statusCode = 400;
}
