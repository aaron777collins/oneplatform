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

/** Well-defined exit codes documented in the design spec §11.1 */
export const EXIT = {
  OK: 0,
  GENERAL: 1,
  RATE_LIMIT: 2,
  NETWORK: 3,
  AUTH: 4,
  FORBIDDEN: 5,
  SERVER: 6,
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
 */
export function httpErrorToCliError(
  status: number,
  body: ApiErrorBody,
  verbose: boolean,
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
        EXIT.FORBIDDEN,
      );
    case status === 404:
      return new CliError(msg || "Resource not found.", EXIT.GENERAL);
    case status === 409:
      return new CliError(`Conflict: ${msg}`, EXIT.GENERAL);
    case status === 422:
      return new CliError(msg, EXIT.GENERAL);
    case status === 429:
      return new CliError(
        "Rate limited. Wait and retry.",
        EXIT.RATE_LIMIT,
      );
    case status >= 500 && status <= 504:
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
