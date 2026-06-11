/**
 * BFF HTTP client (internal — not exported from package index).
 *
 * Wraps fetch with:
 * - Consistent credentials handling (httpOnly cookie, no explicit auth headers)
 * - Strict redirect policy (redirect: "error") to prevent open redirect attacks (C-5)
 * - Structured error parsing so all errors emerge as AppSDKError
 * - Global 401 interception for seamless session expiry handling
 * - Query parameter serialisation following the BFF bracket notation contract
 */

import type { AppSDKError, FilterSpec } from "../types/entities.js";
import { parseBffError, createNetworkError } from "./errors.js";

// ─── Request options ──────────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface BffRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  queryParams?: Record<string, string | number | boolean | string[]>;
  signal?: AbortSignal;
}

// ─── Query parameter builder ──────────────────────────────────────────────────

/**
 * Appends structured query parameters to a URLSearchParams instance.
 *
 * Arrays are expanded with index notation (e.g. sort[0]=name&sort[1]=-createdAt).
 * Nested objects (for filter specs) use bracket notation (filter[field][op]=value).
 */
export function appendQueryParams(
  searchParams: URLSearchParams,
  params: Record<string, string | number | boolean | string[]>,
): void {
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        searchParams.append(`${key}[${idx}]`, String(item));
      });
    } else {
      searchParams.append(key, String(value));
    }
  }
}

/**
 * Converts a FilterSpec into flat query parameter entries using bracket notation.
 *
 * FilterSpec { status: { eq: "active" } }
 * → filter[status][eq]=active
 *
 * FilterSpec { ownerId: { in: ["id1", "id2"] } }
 * → filter[ownerId][in][0]=id1&filter[ownerId][in][1]=id2
 */
export function buildFilterParams(
  filter: FilterSpec,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [field, conditions] of Object.entries(filter)) {
    if (!conditions) continue;
    for (const [op, value] of Object.entries(conditions)) {
      if (value === undefined) continue;
      const paramKey = `filter[${field}][${op}]`;
      if (Array.isArray(value)) {
        // Array values get indexed bracket notation
        value.forEach((item, idx) => {
          result[`${paramKey}[${idx}]`] = String(item);
        });
      } else {
        result[paramKey] = String(value);
      }
    }
  }
  return result;
}

// ─── BffClient class ──────────────────────────────────────────────────────────

export class BffClient {
  // The base URL is always the same origin — constructed from window.location.origin
  // at instantiation so it is captured once and never changes (C-6 analogue for HTTP).
  private readonly baseUrl: string;

  // Registered by AppProvider to redirect to /login on session expiry.
  // Kept as a nullable property so the client works in test environments
  // where AppProvider may not be fully wired.
  private onUnauthorized: (() => void) | null = null;

  constructor() {
    this.baseUrl = window.location.origin;
  }

  setUnauthorizedHandler(handler: () => void): void {
    this.onUnauthorized = handler;
  }

  /**
   * Makes an authenticated request to the BFF.
   *
   * Always uses credentials: "include" (C-2) and redirect: "error" (C-5).
   * Throws AppSDKError on any non-2xx response or network failure.
   */
  async request<T>(path: string, options: BffRequestOptions = {}): Promise<T> {
    // Entity names in the path are encoded by callers via encodeURIComponent
    // to prevent path traversal (e.g. entity "../../secret").
    const url = new URL(`${this.baseUrl}${path}`);

    if (options.queryParams) {
      appendQueryParams(url.searchParams, options.queryParams);
    }

    const hasBody = options.body !== undefined;

    // Content-Type is only meaningful when there is a request body. Sending it
    // on bodyless requests (e.g. DELETE) causes some servers / proxies to reject
    // the request or interpret the absent body as malformed.
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    };

    // Build fetch init without undefined optional fields to satisfy exactOptionalPropertyTypes
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      credentials: "include",
      redirect: "error", // C-5: never follow redirects automatically
    };
    if (hasBody) {
      init.body = JSON.stringify(options.body);
    }
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), init);
    } catch (err) {
      // fetch() throws on network failure — no HTTP status available
      throw createNetworkError(err);
    }

    // Intercept 401 before throwing so AppProvider can trigger the login redirect.
    // We still throw after calling the handler so the individual hook's error path
    // also fires (even though the redirect will supersede it in practice).
    if (response.status === 401) {
      this.onUnauthorized?.();
      throw await parseBffError(response);
    }

    if (!response.ok) {
      throw await parseBffError(response);
    }

    return response.json() as Promise<T>;
  }
}

// ─── Exported singleton ───────────────────────────────────────────────────────
// AppProvider constructs the canonical instance. This export exists so hooks
// can import the type without going through the provider module.
export type { AppSDKError };
