/**
 * CLI error types and HTTP-to-exit-code translation.
 * Actions throw CliError; the withContext wrapper catches it and calls process.exit.
 * This keeps process.exit centralized and makes actions unit-testable without mocking process.
 */

export class CliError extends Error {
  public readonly exitCode: number;
  // Renamed to avoid conflict with Error.cause (added in ES2022/lib.es2022)
  public readonly underlyingCause: Error | undefined;

  constructor(
    message: string,
    exitCode: number = 1,
    underlyingCause?: Error,
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.underlyingCause = underlyingCause;
  }
}

/**
 * Well-defined exit codes documented in the design spec §11.1.
 *
 * Shell scripts and CI pipelines can branch on these codes:
 *   0  — success
 *   1  — generic / unexpected error
 *   2  — resource not found (HTTP 404)
 *   3  — authentication / authorisation error (HTTP 401, 403)
 *   4  — rate limited (HTTP 429)
 *   5  — server error (HTTP 5xx)
 *   6  — network / transport error (timeout, DNS failure)
 */
export const EXIT = {
  OK: 0,
  GENERAL: 1,
  NOT_FOUND: 2,
  AUTH: 3,
  RATE_LIMIT: 4,
  SERVER: 5,
  NETWORK: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

/**
 * Translates an HTTP status + optional parsed body into a CliError.
 * Called by the HttpClient wrapper when the API returns a non-2xx response.
 *
 * @param retryAfter - Value of the Retry-After response header, if present (seconds or HTTP-date).
 */
export function httpErrorToCliError(
  status: number,
  body: ApiErrorBody,
  verbose: boolean,
  retryAfter?: string | null,
): CliError {
  const msg = body.error?.message ?? "Unexpected server response.";

  switch (true) {
    case status === 400:
      return new CliError(`Validation error: ${msg}`, EXIT.GENERAL);
    case status === 401:
      return new CliError(
        "Not authenticated. Run 'op auth login' to log in.",
        EXIT.AUTH,
      );
    case status === 403:
      return new CliError(
        `Insufficient permissions. ${msg}`,
        EXIT.AUTH,
      );
    case status === 404:
      return new CliError(msg || "Resource not found.", EXIT.NOT_FOUND);
    case status === 409:
      return new CliError(`Conflict: ${msg}`, EXIT.GENERAL);
    case status === 422:
      return new CliError(msg, EXIT.GENERAL);
    case status === 429: {
      // Parse Retry-After as seconds (numeric) or an HTTP-date so we can give
      // the user a concrete time to wait rather than a vague "wait and retry".
      let retryMsg = "Rate limited.";
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds) && seconds > 0) {
          retryMsg = `Rate limited. Retry after ${seconds} second${seconds !== 1 ? "s" : ""}.`;
        } else {
          // HTTP-date format — show it verbatim so the user can interpret it
          retryMsg = `Rate limited. Retry after: ${retryAfter}`;
        }
      } else {
        retryMsg = "Rate limited. Wait and retry.";
      }
      return new CliError(retryMsg, EXIT.RATE_LIMIT);
    }
    case status >= 500:
      return new CliError(
        `Server error (${status}). Platform may be degraded. Try again.`,
        EXIT.SERVER,
      );
    default:
      return new CliError(
        `Unexpected response: HTTP ${status}. ${verbose ? msg : ""}`,
        EXIT.GENERAL,
      );
  }
}

/** Formats a CliError for printing to stderr, with optional stack trace when verbose. */
export function formatCliError(err: CliError, verbose: boolean): string {
  let out = `Error: ${err.message}`;
  if (verbose && err.underlyingCause) {
    out += `\n\nCause:\n  ${err.underlyingCause.message}`;
    if (err.underlyingCause.stack) {
      out += `\n\nStack trace:\n${err.underlyingCause.stack}`;
    }
  }
  return out;
}
