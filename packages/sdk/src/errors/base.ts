/**
 * Base error class for all OnePlatform SDK errors.
 *
 * The design makes every thrown value instanceof-checkable for specific error
 * types, while guaranteeing callers can always catch OnePlatformError as a
 * catch-all. Auth tokens and request headers are never included in serialized
 * error objects (see §13).
 */

export interface OnePlatformErrorOptions {
  readonly code: string;
  readonly message: string;
  readonly statusCode?: number;
  readonly requestId?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly response?: Response;
}

export class OnePlatformError extends Error {
  /** Platform error code (SCREAMING_SNAKE_CASE). "SDK_ERROR" for pre-flight errors. */
  readonly code: string;

  /** HTTP status code. Undefined for NetworkError and ConfigurationError. */
  readonly statusCode: number | undefined;

  /** Platform request ID for log correlation with support. */
  readonly requestId: string | undefined;

  /** Structured details from the server error body. */
  readonly details: Record<string, unknown> | undefined;

  /** Whether this error type is safe to retry. */
  readonly retryable: boolean;

  /**
   * Original response object, if the error originated from an HTTP response.
   * Useful for reading custom headers such as X-RateLimit-Reset.
   * Not included in JSON serialization.
   */
  readonly response: Response | undefined;

  constructor(options: OnePlatformErrorOptions) {
    super(options.message);
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.details = options.details;
    this.retryable = options.retryable;
    this.response = options.response;

    // Restore prototype chain broken by extending Error in transpiled targets
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    // Intentionally excludes `response` (contains request headers) and the
    // raw stack trace to prevent accidental credential or path disclosure.
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      requestId: this.requestId,
      details: this.details,
      retryable: this.retryable,
    };
  }
}
