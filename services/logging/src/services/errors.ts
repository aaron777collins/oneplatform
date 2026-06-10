import { AppError } from "@oneplatform/core";

/**
 * Raised when a log query fails due to invalid parameters or a Postgres error.
 * Surfaces as HTTP 400 so the caller can fix the query rather than retrying.
 */
export class LogQueryError extends AppError {
  readonly code = "LOGGING_QUERY_ERROR" as const;
  readonly statusCode = 400;
}

/**
 * Raised when an export request covers more rows than the per-request cap.
 * The caller must narrow the time window and issue multiple requests.
 */
export class ExportTooLargeError extends AppError {
  readonly code = "LOGGING_EXPORT_TOO_LARGE" as const;
  readonly statusCode = 413;
}

/**
 * Raised when a manual retention run is requested while one is already running.
 * Prevents concurrent retention jobs from racing on partition drops.
 */
export class RetentionRunningError extends AppError {
  readonly code = "LOGGING_RETENTION_RUNNING" as const;
  readonly statusCode = 409;
}
