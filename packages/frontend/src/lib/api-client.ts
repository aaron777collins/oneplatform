/**
 * Dashboard API client — the single module through which all API calls flow.
 *
 * Design decisions:
 * - All calls are relative to `/api`, which Nginx proxies to the Gateway.
 * - credentials: "include" is always set so the httpOnly session cookie is sent.
 * - 401 responses trigger one session refresh attempt before redirecting to /login.
 *   The `isRetry` flag prevents infinite recursion when the session is genuinely expired.
 * - 4xx errors (except 401 and 429) are not retried — they indicate a client error.
 * - 429 retries after the Retry-After header value (max 2 retries).
 * - 5xx errors retry with exponential backoff: 1s then 2s (max 2 retries total).
 */

// Imported at module level to avoid circular dependency when the auth store
// calls logout, which calls apiFetch, which calls authStore.clearSession.
// The real authStore is injected at runtime by configureAuthStore().
let clearSessionFn: (() => void) | null = null;

export function configureAuthStore(onClearSession: () => void): void {
  clearSessionFn = onClearSession;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  public override readonly name = "ApiError";

  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export class AuthError extends Error {
  public override readonly name = "AuthError";
}

// ---------------------------------------------------------------------------
// Response envelope types (mirrors the Gateway API contract)
// ---------------------------------------------------------------------------

export type ApiResponse<T> = { data: T };
export type PaginatedResponse<T> = {
  data: T[];
  pagination: { nextCursor: string | null; total: number | null };
};

// Minimal shape returned by error response bodies
interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    details?: unknown;
  };
}

function parseErrorBody(body: unknown): ErrorBody {
  if (typeof body === "object" && body !== null) {
    return body as ErrorBody;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Core fetch implementation
// ---------------------------------------------------------------------------

/**
 * Internal implementation. Callers use the ApiClient methods instead.
 *
 * `isRetry` is true only when this is a second attempt after a 401 — we must
 * not retry again because that would create an infinite loop.
 */
async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  isRetry = false,
  retryCount = 0,
): Promise<T> {
  const url = `/api${path}`;
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      // Only set Content-Type when a body is present. Sending it on GET/DELETE
      // requests causes some servers/proxies to reject the request (RFC 7230
      // allows bodies on GET but many implementations reject it).
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  // --- 401: Attempt session refresh, then retry once ---
  // Public auth endpoints (login, register) return 401 to signal bad credentials,
  // not an expired session. Skip the refresh/redirect flow so callers receive a
  // normal ApiError they can display to the user.
  if (response.status === 401) {
    const isPublicAuth =
      path.startsWith("/v1/auth/login") ||
      path.startsWith("/v1/auth/register");

    if (!isPublicAuth) {
      if (isRetry) {
        clearSessionFn?.();
        window.location.href = "/login";
        throw new AuthError("Session expired");
      }

      const refreshResponse = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        credentials: "include",
      });

      if (!refreshResponse.ok) {
        clearSessionFn?.();
        window.location.href = "/login";
        throw new AuthError("Session expired");
      }

      return apiFetch<T>(path, init, true, 0);
    }
  }

  // --- 429: Retry after Retry-After header (max 2 retries) ---
  if (response.status === 429 && retryCount < 2) {
    const retryAfterHeader = response.headers.get("Retry-After");
    let retryAfterMs = 1000;
    if (retryAfterHeader !== null) {
      const parsed = parseInt(retryAfterHeader, 10);
      if (!isNaN(parsed)) {
        retryAfterMs = parsed * 1000;
      } else {
        // HTTP-date format fallback
        const dateMs = new Date(retryAfterHeader).getTime() - Date.now();
        retryAfterMs = dateMs > 0 ? dateMs : 1000;
      }
    }
    // Cap the delay so a server cannot freeze the tab with an arbitrarily large
    // Retry-After (e.g. 86400s). 60s is the longest we will block before failing.
    retryAfterMs = Math.min(retryAfterMs, 60_000);
    await delay(retryAfterMs, init?.signal ?? null);
    return apiFetch<T>(path, init, isRetry, retryCount + 1);
  }

  // --- 5xx: Exponential backoff (max 2 retries: 1s, 2s) ---
  if (response.status >= 500 && retryCount < 2) {
    await delay(1000 * Math.pow(2, retryCount), init?.signal ?? null);
    return apiFetch<T>(path, init, isRetry, retryCount + 1);
  }

  // --- Non-2xx: Parse error body and throw ApiError ---
  if (!response.ok) {
    const rawBody = await response.json().catch(() => ({}));
    const body = parseErrorBody(rawBody);
    const err = body.error ?? {};
    throw new ApiError(
      response.status,
      err.code ?? "UNKNOWN_ERROR",
      err.message ?? `Request failed with status ${response.status}`,
      err.requestId ?? "",
      err.details,
    );
  }

  // --- 2xx: Unwrap response ---
  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return undefined as unknown as T;
  }

  return response.json() as Promise<T>;
}

function delay(ms: number, signal: AbortSignal | null = null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// URL + query-string helpers
// ---------------------------------------------------------------------------

export type FilterSpec = Record<string, Record<string, string | number | boolean>>;

/**
 * Serializes a filter spec into the Gateway's filter DSL query parameters:
 *   { status: { eq: "active" } } → { "filter[status][eq]": "active" }
 */
export function serializeFilters(filters: FilterSpec): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [field, ops] of Object.entries(filters)) {
    for (const [op, value] of Object.entries(ops)) {
      params[`filter[${field}][${op}]`] = String(value);
    }
  }
  return params;
}

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return path;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

// ---------------------------------------------------------------------------
// Public API client interface
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  /** Base path prefix — always empty string in production (relative to /api) */
  baseUrl: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  params?: Record<string, string | number | boolean | undefined>;
}

export interface ApiClient {
  get<T>(path: string, params?: Record<string, string | number | boolean | undefined>, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T = void>(path: string, options?: RequestOptions): Promise<T>;
}

export function createApiClient(_options: ApiClientOptions): ApiClient {
  return {
    get<T>(path: string, params?: Record<string, string | number | boolean | undefined>, options?: RequestOptions): Promise<T> {
      const url = buildUrl(path, params ?? options?.params);
      return apiFetch<T>(url, {
        method: "GET",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },

    post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
      return apiFetch<T>(path, {
        method: "POST",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },

    put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
      return apiFetch<T>(path, {
        method: "PUT",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },

    patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
      return apiFetch<T>(path, {
        method: "PATCH",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },

    delete<T = void>(path: string, options?: RequestOptions): Promise<T> {
      return apiFetch<T>(path, {
        method: "DELETE",
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// React context plumbing
// ---------------------------------------------------------------------------

import { createContext, useContext } from "react";

export const ApiClientContext = createContext<ApiClient | null>(null);

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) {
    throw new Error("useApiClient must be used within an ApiClientContext.Provider");
  }
  return client;
}
