/**
 * BFF HTTP client — internal, not exported from the package index.
 *
 * Wraps `fetch` with:
 * - Consistent credentials handling (`credentials: "include"`, httpOnly cookie)
 * - Strict redirect policy (`redirect: "error"`) to prevent open redirect attacks (C-5)
 * - Structured error parsing so all errors emerge as {@link AppSDKError}
 * - Global 401 interception for seamless session expiry handling
 * - Query parameter serialisation following the BFF bracket notation contract
 *
 * @internal
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
  // The base URL is resolved once at construction time and never changes
  // (C-6 analogue for HTTP). Defaults to window.location.origin; can be
  // overridden via the bffBaseUrl AppProvider prop for cross-origin BFF hosts.
  private readonly baseUrl: string;

  // Registered by AppProvider after reading window.__OP_APP_CONFIG__.
  // Every BFF endpoint requires this header to scope requests to the correct app.
  private appId: string | null = null;

  // Registered by AppProvider to redirect to /login on session expiry.
  // Kept as a nullable property so the client works in test environments
  // where AppProvider may not be fully wired.
  private onUnauthorized: (() => void) | null = null;

  constructor(bffBaseUrl?: string) {
    // Fall back to window.location.origin in browser environments.
    // SSR / test environments that supply no origin and no override get an
    // empty string, which will fail loudly at the first request() call via
    // the URL constructor — an acceptable trade-off for non-browser contexts.
    const resolved =
      bffBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");

    if (resolved !== "") {
      // Validate early so a misconfigured bffBaseUrl surfaces at construction
      // time, not buried inside the first failing HTTP request.
      let parsed: URL;
      try {
        parsed = new URL(resolved);
      } catch (e) {
        throw new Error(
          `[BffClient] bffBaseUrl "${resolved}" is not a valid URL. ` +
            `Provide an absolute URL such as "https://api.example.com". ` +
            `(${(e as Error).message})`,
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
          `[BffClient] bffBaseUrl must use http or https, got "${parsed.protocol}" ` +
            `in URL "${resolved}".`,
        );
      }
    }

    // Strip one-or-more trailing slashes so path concatenation is always "/path"
    // not "//path", regardless of how many slashes the caller appended.
    this.baseUrl = resolved.replace(/\/+$/, "");
  }

  /**
   * Sets the app ID sent as X-App-Id on every BFF request.
   * Called by AppProvider immediately after reading window.__OP_APP_CONFIG__,
   * before any BFF calls are made.
   */
  configure(appId: string): void {
    this.appId = appId;
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

    // Every BFF endpoint requires X-App-Id to scope requests to the correct app
    // (see bff.ts §8.1 – §8.5). Fail loudly here rather than letting the server
    // return a 400 with a less-obvious error message.
    if (this.appId === null) {
      throw new Error(
        "[app-sdk] BffClient.configure(appId) must be called before making BFF requests. " +
          "Ensure AppProvider has mounted and read window.__OP_APP_CONFIG__ successfully.",
      );
    }

    // Content-Type is only meaningful when there is a request body. Sending it
    // on bodyless requests (e.g. DELETE) causes some servers / proxies to reject
    // the request or interpret the absent body as malformed.
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-App-Id": this.appId,
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
