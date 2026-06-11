import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Execution Service errors — design spec §14.1 error code registry
//
// HTTP status conventions for this service:
//   - 400: validation error detectable before dispatch (bad input)
//   - 404: resource not found
//   - 500: internal infrastructure failure
//   - 503: service temporarily unavailable
//   - 200: errors reported as SSE events inside an already-open stream.
//          These classes still extend AppError so they can be caught and
//          serialised uniformly, but statusCode = 200 signals to the SSE
//          handler that the error should be emitted as an `error` event
//          rather than as an HTTP error response.
// ---------------------------------------------------------------------------

// Execution record does not exist within the requesting tenant's scope.
// The response is identical for "not found" and "wrong tenant" to avoid
// leaking existence of cross-tenant records.
export class ExecutionNotFoundError extends AppError {
  readonly code = "EXECUTION_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// The sandbox-vm Unix socket is unreachable or returned no healthy response
// to three consecutive pings. Callers should not retry automatically.
export class ExecutionSandboxUnavailableError extends AppError {
  readonly code = "EXECUTION_SANDBOX_UNAVAILABLE" as const;
  readonly statusCode = 503;
}

// SSE event — execution exceeded the configured timeout. The HTTP response
// for the /run endpoint was already 202; this error is emitted on the log
// stream. statusCode = 200 indicates it is not an HTTP-level error.
export class ExecutionTimeoutError extends AppError {
  readonly code = "EXECUTION_TIMEOUT" as const;
  readonly statusCode = 200;
}

// SSE event — sandbox process was killed by the OOM killer (container-level)
// or isolated-vm threw MemoryExceededError (isolate-level).
export class ExecutionOomError extends AppError {
  readonly code = "EXECUTION_OOM" as const;
  readonly statusCode = 200;
}

// SSE event — sandbox container crashed unexpectedly (ECONNRESET, SIGKILL not
// from a timeout). All in-flight executions on the crashed sandbox are marked
// with this error code.
export class ExecutionSandboxCrashError extends AppError {
  readonly code = "EXECUTION_SANDBOX_CRASH" as const;
  readonly statusCode = 200;
}

// SSE event — plugin code called context.pipeline.trigger() while running
// inside a hook chain (hookContext = true). Detected via the contextCall
// handler; never returned as an HTTP error from /run because the execution
// was already dispatched.
export class ExecutionHookRecursionError extends AppError {
  readonly code = "EXECUTION_HOOK_RECURSION" as const;
  readonly statusCode = 200;
}

// HTTP 400 — code.length > 524_288 bytes (512 KB user limit) or > 10_485_760
// bytes (10 MB internal limit). Caught by Zod before dispatch.
export class ExecutionCodeTooLargeError extends AppError {
  readonly code = "EXECUTION_CODE_TOO_LARGE" as const;
  readonly statusCode = 400;
}

// HTTP 400 — total serialised sandbox request exceeds the 12 MB socket limit.
// Caught before the payload is written to the Unix socket.
export class ExecutionPayloadTooLargeError extends AppError {
  readonly code = "EXECUTION_PAYLOAD_TOO_LARGE" as const;
  readonly statusCode = 400;
}

// SSE event — sandbox serialised the execution result and it exceeded 4 MB.
// The sandbox returns status 'error' with this code; the Execution Service
// propagates it as an SSE error event.
export class ExecutionResultTooLargeError extends AppError {
  readonly code = "EXECUTION_RESULT_TOO_LARGE" as const;
  readonly statusCode = 200;
}

// HTTP 400 — user-facing /run only accepts 'js' | 'ts'. Any other value
// (including valid internal languages like 'python' or 'go') is rejected.
export class ExecutionInvalidLanguageError extends AppError {
  readonly code = "EXECUTION_INVALID_LANGUAGE" as const;
  readonly statusCode = 400;
}

// HTTP 400 — requested timeout exceeds the maximum for the endpoint
// (30 000 ms for user-facing, 300 000 ms for connectors).
export class ExecutionTimeoutExceededLimitError extends AppError {
  readonly code = "EXECUTION_TIMEOUT_EXCEEDED_LIMIT" as const;
  readonly statusCode = 400;
}

// HTTP 500 — fetched plugin bundle SHA-256 does not match the hash returned
// by the Plugin Service. The bundle is discarded; Plugin Service is alerted
// via a structured log event. Not retried automatically.
export class ExecutionBundleIntegrityError extends AppError {
  readonly code = "EXECUTION_BUNDLE_INTEGRITY_ERROR" as const;
  readonly statusCode = 500;
}

// SSE event — user code attempted to import a module not on the sandbox
// allowlist (e.g., require('fs'), require('axios')). The sandbox returns
// this as an execution-level error, not a process crash.
export class ExecutionModuleNotAllowedError extends AppError {
  readonly code = "EXECUTION_MODULE_NOT_ALLOWED" as const;
  readonly statusCode = 200;
}

// SSE event — context.fetch() was called with a URL matching the internal
// network blocklist (RFC 1918 ranges, *.service:* hostnames, file:// etc.).
export class ExecutionFetchBlockedError extends AppError {
  readonly code = "EXECUTION_FETCH_BLOCKED" as const;
  readonly statusCode = 200;
}

// SSE event — credentials.get() was called from an execution type other
// than 'connector-run'. Credential access is only permitted for connector
// invocations that supply a credentialBundleId.
export class ExecutionCredentialsDeniedError extends AppError {
  readonly code = "EXECUTION_CREDENTIALS_DENIED" as const;
  readonly statusCode = 200;
}

// HTTP 503 — a new execution request arrived for a plugin that is currently
// being drained (disabled or upgraded). Callers should retry after the
// plugin-drain response confirms completion.
export class ServiceDrainingError extends AppError {
  readonly code = "SERVICE_DRAINING" as const;
  readonly statusCode = 503;
}
