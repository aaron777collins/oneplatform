import type { Context } from "hono";
import { AppError, InternalError } from "../errors.js";

// errorHandlerMiddleware returns an onError handler for use with app.onError().
// In Hono v4, errors thrown inside route handlers are NOT propagated through
// middleware try/catch blocks — they go directly to app.onError. This function
// returns a handler compatible with app.onError(errorHandlerMiddleware()).
//
// AppError subclasses serialize to their typed API envelope.
// Unknown errors become InternalError to prevent leaking implementation details
// (stack traces, SQL, internal paths) to the client (spec §6).
export function errorHandlerMiddleware() {
  return (err: Error, c: Context) => {
    const requestId: string = c.var["requestId"] ?? "";

    if (err instanceof AppError) {
      const envelope = err.toApiError(requestId);
      return c.json(envelope, err.statusCode as 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503);
    }

    // Unknown error: hide implementation details from the client.
    // In production, errors surface only as "An unexpected error occurred."
    // Debug info is available to admins by looking up the requestId in logs.
    const internalErr = new InternalError(
      err instanceof Error ? err.message : String(err)
    );
    // Log internally — in a full implementation this calls logger.error()
    // We use console.error here so the middleware has no logger dependency.
    console.error(`[${requestId}] Unhandled error:`, err);

    const envelope = internalErr.toApiError(requestId);
    return c.json(envelope, 500);
  };
}
