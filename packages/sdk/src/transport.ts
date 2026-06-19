/**
 * HTTP transport layer — the only code in the SDK that calls fetch().
 *
 * Every API call flows through here in a fixed pipeline:
 *   request builder → timeout wrapper → retry wrapper → fetch()
 *   → response parser → error mapper → return typed result or throw
 *
 * This module is not exported from the public barrel. Resource methods
 * receive a Transport instance from the client factory.
 */

import type { RetryPolicy } from './types/client-options.js';
import type { AuthHandler } from './auth/api-key.js';
import type { AccessTokenHandler } from './auth/access-token.js';
import {
  OnePlatformError,
  ClientError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  CursorExpiredError,
  ServerError,
  NetworkError,
  RateLimitError,
} from './errors/index.js';
import { withRetry, resolveRetryPolicy } from './retry/index.js';

// SDK version injected at build time. Fallback ensures the constant is always defined.
const SDK_VERSION = '0.1.0';

function generateRequestId(): string {
  // UUID v4 using crypto.randomUUID() (Node 14.17+ and all modern browsers)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function parseRetryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (header === null) return null;
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return seconds;
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, Math.floor((date - Date.now()) / 1000));
  return null;
}

async function mapResponseToError(response: Response): Promise<OnePlatformError> {
  let body: {
    error?: {
      code?: string;
      message?: string;
      details?: unknown;
      requestId?: string;
    };
  };

  try {
    body = (await response.json()) as typeof body;
  } catch {
    return new ServerError({
      code: 'INTERNAL_ERROR',
      message: `Server returned ${response.status} with a non-JSON body`,
      statusCode: response.status,
      response,
      retryable: response.status >= 500,
    });
  }

  const {
    code = 'UNKNOWN_ERROR',
    message = 'An unknown error occurred',
    details,
    requestId,
  } = body.error ?? {};

  // exactOptionalPropertyTypes: build base using spread to avoid passing `undefined`
  // to optional properties that only accept `string` (not `string | undefined`).
  const base = {
    code,
    message,
    ...(details !== undefined ? { details: details as Record<string, unknown> } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    statusCode: response.status,
    response,
    retryable: false,
  };

  switch (response.status) {
    case 400:
      return new ClientError(base);
    case 401:
      return new AuthError(base);
    case 403:
      return new ForbiddenError(base);
    case 404:
      return new NotFoundError(base);
    case 409:
      return new ConflictError(base);
    case 410:
      return new CursorExpiredError(base);
    case 422: {
      // Extract Zod-style issues from server response details and map them
      // to the typed ValidationFieldError / ValidationConstraintViolation
      // arrays so callers get populated `fields` and `constraints`.
      const detailsObj = details as Record<string, unknown> | undefined;
      const zodIssues = Array.isArray(detailsObj?.['issues'])
        ? (detailsObj!['issues'] as Array<{ path?: (string | number)[]; message?: string; code?: string }>)
        : [];

      const fields: Array<{ field: string; message: string }> = [];
      const constraints: Array<{ constraint: string; message: string }> = [];

      for (const issue of zodIssues) {
        const msg = issue.message ?? 'Validation failed';
        if (issue.path && issue.path.length > 0) {
          fields.push({
            field: issue.path.join('.'),
            message: msg,
          });
        } else {
          constraints.push({
            constraint: issue.code ?? 'unknown',
            message: msg,
          });
        }
      }

      return new ValidationError({
        ...base,
        ...(fields.length > 0 ? { fields } : {}),
        ...(constraints.length > 0 ? { constraints } : {}),
      });
    }
    case 429:
      return new RateLimitError({
        ...base,
        retryAfterSeconds: parseRetryAfterSeconds(response),
      });
    default:
      if (response.status >= 500) {
        return new ServerError({ ...base, retryable: true });
      }
      return new ClientError(base); // Unknown 4xx
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function makeLogger(level: LogLevel) {
  return {
    debug: (msg: string, ...args: unknown[]) =>
      LOG_LEVELS[level] <= LOG_LEVELS.debug && console.debug(`[OnePlatform SDK] ${msg}`, ...args),
    info: (msg: string, ...args: unknown[]) =>
      LOG_LEVELS[level] <= LOG_LEVELS.info && console.info(`[OnePlatform SDK] ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) =>
      LOG_LEVELS[level] <= LOG_LEVELS.warn && console.warn(`[OnePlatform SDK] ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) =>
      LOG_LEVELS[level] <= LOG_LEVELS.error && console.error(`[OnePlatform SDK] ${msg}`, ...args),
  };
}

/** Tracks deprecated endpoint paths already warned about (per Transport instance). */
const warnedDeprecations = new Set<string>();

export interface TransportOptions {
  readonly baseUrl: string;
  readonly authHandler: AuthHandler | AccessTokenHandler;
  readonly retry: RetryPolicy | false;
  readonly timeout: number;
  readonly customHeaders: Record<string, string>;
  readonly logLevel: LogLevel;
  readonly fetch: typeof globalThis.fetch;
  readonly isBrowser: boolean;
}

export interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly query?: Record<string, string | string[] | number | boolean | undefined>;
  readonly body?: unknown;
  /**
   * When set, sent as the `Idempotency-Key` request header so the server can
   * safely deduplicate POST/PATCH/PUT retries.
   */
  readonly idempotencyKey?: string;
}

export class Transport {
  private readonly opts: TransportOptions;
  private readonly resolvedRetry: ReturnType<typeof resolveRetryPolicy>;
  private readonly logger: ReturnType<typeof makeLogger>;

  constructor(opts: TransportOptions) {
    this.opts = opts;
    this.resolvedRetry = resolveRetryPolicy(opts.retry);
    this.logger = makeLogger(opts.logLevel);
  }

  async request<T>(requestOptions: RequestOptions): Promise<T> {
    const { method, path, query, body, idempotencyKey } = requestOptions;
    const url = this.buildUrl(path, query);
    const serializedBody = body !== undefined ? JSON.stringify(body) : undefined;

    this.logger.debug(`${method} ${path}`);

    const result = await withRetry(
      () => this.executeRequest<T>(method, url, serializedBody, false, idempotencyKey),
      (err) => (err instanceof OnePlatformError ? err.statusCode : undefined),
      (err) =>
        err instanceof RateLimitError
          ? err.response?.headers.get('Retry-After') ?? undefined
          : undefined,
      this.resolvedRetry,
      (attempt, delayMs, err) => {
        this.logger.warn(
          `Retry attempt ${attempt + 1} for ${method} ${path} after ${delayMs}ms`,
          err instanceof OnePlatformError ? err.code : String(err),
        );
      },
    );

    return result;
  }

  /**
   * Sends a multipart/form-data request (e.g. file upload).
   *
   * Unlike `request()`, this method does NOT serialize the body as JSON and does
   * NOT set a Content-Type header — the browser/Node FormData implementation sets
   * it automatically with the correct multipart boundary.
   *
   * Retries are disabled for multipart uploads because FormData streams are
   * not replayable once consumed by fetch(). Callers that need retry semantics
   * must construct a fresh FormData on each attempt.
   */
  async requestMultipart<T>(requestOptions: Omit<RequestOptions, 'body'> & { body: FormData }): Promise<T> {
    const { method, path, query, body } = requestOptions;
    const url = this.buildUrl(path, query);

    this.logger.debug(`${method} ${path} (multipart)`);

    return this.executeMultipartRequest<T>(method, url, body);
  }

  private async executeMultipartRequest<T>(
    method: string,
    url: string,
    form: FormData,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = this.opts.timeout;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const authHeaders = await this.opts.authHandler.getHeaders();
      // Omit Content-Type intentionally — fetch sets it automatically for FormData
      // with the multipart boundary value. Manually setting it would omit the boundary
      // and cause the server to reject the upload.
      const headers: Record<string, string> = {
        ...this.opts.customHeaders,
        ...authHeaders,
        Accept: 'application/json',
        'X-SDK-Version': `@oneplatform/sdk/${SDK_VERSION}`,
        'X-Request-ID': generateRequestId(),
        ...(this.opts.isBrowser ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
      };

      let response: Response;
      try {
        response = await this.opts.fetch(url, {
          method,
          headers,
          body: form,
          signal: controller.signal,
        });
      } catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          throw new NetworkError({
            message: `Multipart request timed out after ${timeoutMs}ms`,
            reason: 'timeout',
            timeoutMs,
            cause: fetchErr,
          });
        }
        throw new NetworkError({
          message: fetchErr instanceof Error ? fetchErr.message : 'fetch() threw an unknown error',
          reason: 'fetch-failed',
          cause: fetchErr,
        });
      }

      if (response.status === 204) return undefined as T;

      if (!response.ok) {
        throw await mapResponseToError(response);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (parseErr) {
        throw new NetworkError({
          message: 'Failed to parse JSON response body',
          reason: 'parse-failed',
          cause: parseErr,
        });
      }

      // Unwrap the { data: T } envelope, consistent with request()
      const envelope = parsed as { data?: T };
      if (envelope.data !== undefined) return envelope.data;
      return parsed as T;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
  }

  private async executeRequest<T>(
    method: string,
    url: string,
    serializedBody: string | undefined,
    isAuthRetry: boolean,
    idempotencyKey?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = this.opts.timeout;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const authHeaders = await this.opts.authHandler.getHeaders();
      const headers: Record<string, string> = {
        ...this.opts.customHeaders, // lowest precedence
        ...authHeaders, // auth overwrites custom headers
        Accept: 'application/json',
        'X-SDK-Version': `@oneplatform/sdk/${SDK_VERSION}`,
        'X-Request-ID': generateRequestId(),
      };
      if (serializedBody !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      if (idempotencyKey !== undefined) {
        headers['Idempotency-Key'] = idempotencyKey;
      }
      if (this.opts.isBrowser) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
      }

      let response: Response;
      try {
        response = await this.opts.fetch(url, {
          method,
          headers,
          ...(serializedBody !== undefined ? { body: serializedBody } : {}),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          throw new NetworkError({
            message: `Request timed out after ${timeoutMs}ms`,
            reason: 'timeout',
            timeoutMs,
            cause: fetchErr,
          });
        }
        throw new NetworkError({
          message:
            fetchErr instanceof Error ? fetchErr.message : 'fetch() threw an unknown error',
          reason: 'fetch-failed',
          cause: fetchErr,
        });
      }

      // Emit deprecation warning once per unique endpoint
      if (response.headers.get('Deprecation') === 'true') {
        const key = `${method} ${new URL(url).pathname}`;
        if (!warnedDeprecations.has(key)) {
          warnedDeprecations.add(key);
          const sunset = response.headers.get('Sunset') ?? 'unknown';
          const link = response.headers.get('Link') ?? '';
          this.logger.warn(
            `endpoint ${key} is deprecated. Sunset: ${sunset}. Migration guide: ${link}`,
          );
        }
      }

      if (response.status === 204) {
        return undefined as T;
      }

      if (!response.ok) {
        const err = await mapResponseToError(response);

        // Access token mode: if we have a refresh callback, retry once on 401.
        // isAuthRetry guard ensures a second 401 after refresh fails loudly rather
        // than recursing infinitely.
        if (
          err instanceof AuthError &&
          !isAuthRetry &&
          'canRefresh' in this.opts.authHandler &&
          (this.opts.authHandler as AccessTokenHandler).canRefresh()
        ) {
          try {
            await (this.opts.authHandler as AccessTokenHandler).handleUnauthorized();
            return this.executeRequest<T>(method, url, serializedBody, true, idempotencyKey);
          } catch {
            // Refresh failed — surface the original AuthError
            throw err;
          }
        }

        throw err;
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (parseErr) {
        throw new NetworkError({
          message: 'Failed to parse JSON response body',
          reason: 'parse-failed',
          cause: parseErr,
        });
      }

      // Unwrap the { data: T } envelope
      const envelope = parsed as { data?: T };
      if (envelope.data !== undefined) {
        return envelope.data;
      }

      // Some endpoints return the result directly (e.g., non-standard 2xx)
      return parsed as T;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
  }

  buildUrl(
    path: string,
    query?: Record<string, string | string[] | number | boolean | undefined>,
  ): string {
    const base = this.opts.baseUrl.replace(/\/$/, '');
    const url = new URL(`${base}${path}`);

    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, String(item));
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }
}
