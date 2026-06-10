import type { Context } from "hono";
import { AppError, InternalError } from "../errors.js";
import type { Logger } from "../logger.js";

export interface ErrorHandlerConfig {
  logger?: Logger;
}

export function errorHandlerMiddleware(config: ErrorHandlerConfig = {}) {
  return (err: Error, c: Context) => {
    const requestId: string = c.var["requestId"] ?? "";

    if (err instanceof AppError) {
      const envelope = err.toApiError(requestId);
      return c.json(envelope, err.statusCode as 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503);
    }

    const internalErr = new InternalError(
      err instanceof Error ? err.message : String(err)
    );

    if (config.logger) {
      config.logger.error(`Unhandled error`, {
        requestId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } else {
      console.error(`[${requestId}] Unhandled error:`, err);
    }

    const envelope = internalErr.toApiError(requestId);
    return c.json(envelope, 500);
  };
}
