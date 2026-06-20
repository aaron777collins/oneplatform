/**
 * REST API Connector — connects to any REST API endpoint.
 *
 * Supports offset, cursor, and Link-header pagination, incremental sync via a
 * configurable timestamp/ID field, and API key, bearer token, or HTTP Basic auth.
 *
 * Auth detection order (first credential present wins):
 *   1. bearerToken  → Authorization: Bearer <token>
 *   2. apiKey       → X-API-Key: <key>
 *   3. username + password → Authorization: Basic <base64>
 *
 * The connector is stateless across calls. All connection state needed by
 * fetchBatch is carried in ConnectorHandle.metadata, making ingestion jobs
 * resumable without re-running connect().
 */

import type {
  Connector,
  ConnectorHandle,
  BatchResult,
  PluginContext,
  ConnectorMetadata,
  DataRecord,
} from "@oneplatform/plugin-sdk";
import {
  PluginConfigError,
  PluginAuthError,
  PluginRateLimitError,
  PluginTimeoutError,
  PluginDataError,
} from "@oneplatform/plugin-sdk";

// ────────────────────────────────────────────────────────────────────────────
// Configuration types
// ────────────────────────────────────────────────────────────────────────────

type PaginationType = "none" | "offset" | "cursor" | "link";
type HttpMethod = "GET" | "POST";

/** Validated and typed representation of the tenant-supplied configSchema values. */
interface RestApiConfig {
  baseUrl: string;
  endpoint: string;
  method: HttpMethod;
  headers: Record<string, string>;
  responseDataPath: string | null;
  paginationType: PaginationType;
  pageSize: number;
  incrementalField: string | null;
}

/** Auth credential set resolved at connect() time. Exactly one type is present. */
type ResolvedAuth =
  | { type: "bearer"; token: string }
  | { type: "apiKey"; key: string }
  | { type: "basic"; encoded: string }
  | { type: "none" };

/**
 * Shape stored in ConnectorHandle.metadata — must be JSON-serializable.
 *
 * The index signature `[key: string]: unknown` satisfies the platform's
 * `Record<string, unknown>` boundary while retaining named-field type safety
 * inside the connector. The trade-off is that property accesses via the index
 * signature bypass exactOptionalPropertyTypes, so we read handle.metadata via
 * a double-cast in fetchBatch (unknown → HandleMetadata).
 *
 * Auth credentials are intentionally excluded — they are re-resolved from
 * context.credentials on each fetchBatch() call to avoid persisting secrets
 * in a structure the platform interface documents as potentially checkpointed.
 */
interface HandleMetadata extends Record<string, unknown> {
  baseUrl: string;
  endpoint: string;
  method: HttpMethod;
  staticHeaders: Record<string, string>;
  responseDataPath: string | null;
  paginationType: PaginationType;
  pageSize: number;
  incrementalField: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Cursor encoding
//
// A cursor encodes enough state to resume pagination from a previous call.
// We JSON-encode a small envelope so fetchBatch can restore the exact position.
// ────────────────────────────────────────────────────────────────────────────

interface CursorPayload {
  /** For offset pagination: the byte offset of the next page. */
  offset?: number;
  /** For cursor pagination: the opaque cursor token from the API. */
  token?: string;
  /** For link pagination: the full next URL from the Link header. */
  nextUrl?: string;
  /** For incremental sync: the value to pass to the incrementalField filter. */
  since?: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    // An unreadable cursor means the caller passed something invalid; treat as
    // a config error (permanent failure — no point retrying unchanged cursor).
    // Do NOT include the raw cursor value in the error message — cursor tokens
    // may contain sensitive information (session tokens, internal IDs, encoded
    // query parameters) that should not be exposed in logs.
    throw new PluginConfigError(
      "Invalid cursor value — cannot decode pagination state",
      "cursor",
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Config validation
// ────────────────────────────────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown>): RestApiConfig {
  const baseUrl = raw["baseUrl"];
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new PluginConfigError("baseUrl is required and must be a non-empty string", "baseUrl");
  }

  const endpoint = raw["endpoint"];
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new PluginConfigError("endpoint is required and must be a non-empty string", "endpoint");
  }

  // Validate baseUrl is a parseable URL — catches typos before the first network call.
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new PluginConfigError(
      `baseUrl is not a valid URL: "${baseUrl}"`,
      "baseUrl",
    );
  }

  if (parsedBaseUrl.username !== "" || parsedBaseUrl.password !== "") {
    throw new PluginConfigError(
      "baseUrl must not contain embedded credentials (userinfo) — use the credential system instead",
      "baseUrl",
    );
  }

  const rawMethod = raw["method"];
  const method: HttpMethod =
    rawMethod === "GET" || rawMethod === "POST" ? rawMethod : "GET";

  const rawHeaders = raw["headers"];
  const headers: Record<string, string> = {};
  if (
    rawHeaders !== null &&
    rawHeaders !== undefined &&
    typeof rawHeaders === "object" &&
    !Array.isArray(rawHeaders)
  ) {
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new PluginConfigError(
          `headers["${key}"] must be a string, got ${typeof value}`,
          "headers",
        );
      }
      if (key.toLowerCase() === "authorization" || key.toLowerCase() === "x-api-key") {
        throw new PluginConfigError(
          `headers["${key}"] is managed by the auth credential system and must not be set manually`,
          "headers",
        );
      }
      headers[key] = value;
    }
  }

  const rawDataPath = raw["responseDataPath"];
  const responseDataPath =
    typeof rawDataPath === "string" && rawDataPath.trim() !== ""
      ? rawDataPath.trim()
      : null;

  const rawPagination = raw["paginationType"];
  const validPaginationTypes: PaginationType[] = ["none", "offset", "cursor", "link"];
  const paginationType: PaginationType =
    typeof rawPagination === "string" &&
    (validPaginationTypes as string[]).includes(rawPagination)
      ? (rawPagination as PaginationType)
      : "none";

  const rawPageSize = raw["pageSize"];
  let pageSize = 100;
  if (typeof rawPageSize === "number" && rawPageSize >= 1 && rawPageSize <= 10000) {
    pageSize = Math.floor(rawPageSize);
  }

  const rawIncrementalField = raw["incrementalField"];
  const incrementalField =
    typeof rawIncrementalField === "string" && rawIncrementalField.trim() !== ""
      ? rawIncrementalField.trim()
      : null;

  return {
    baseUrl: baseUrl.trim(),
    endpoint: endpoint.trim(),
    method,
    headers,
    responseDataPath,
    paginationType,
    pageSize,
    incrementalField,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Auth resolution
// ────────────────────────────────────────────────────────────────────────────

async function resolveAuth(context: PluginContext): Promise<ResolvedAuth> {
  const available = await context.credentials.list();

  if (available.includes("bearerToken")) {
    const token = await context.credentials.get("bearerToken");
    return { type: "bearer", token };
  }

  if (available.includes("apiKey")) {
    const key = await context.credentials.get("apiKey");
    return { type: "apiKey", key };
  }

  if (available.includes("username") && available.includes("password")) {
    const username = await context.credentials.get("username");
    const password = await context.credentials.get("password");
    // Base64-encode username:password per RFC 7617; Buffer is available in Node.js.
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    return { type: "basic", encoded };
  }

  return { type: "none" };
}

function authToHeader(auth: ResolvedAuth): string | null {
  switch (auth.type) {
    case "bearer":
      return `Bearer ${auth.token}`;
    case "apiKey":
      // API key is sent as X-API-Key, not Authorization; signal via a sentinel.
      // The connector reads authType separately to choose the header name.
      return auth.key;
    case "basic":
      return `Basic ${auth.encoded}`;
    case "none":
      return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP error mapping
// ────────────────────────────────────────────────────────────────────────────

function throwForHttpStatus(status: number, url: string, retryAfter: string | null): never {
  if (status === 401 || status === 403) {
    throw new PluginAuthError(
      `REST API returned ${status} — check credentials or token expiry`,
      { status, url },
    );
  }

  if (status === 429) {
    const retryAfterSeconds =
      retryAfter !== null ? parseRetryAfter(retryAfter) : undefined;
    throw new PluginRateLimitError(
      `REST API rate limit exceeded (429)`,
      retryAfterSeconds,
    );
  }

  if (status >= 500) {
    // 5xx are transient — the Execution Service will retry with backoff.
    // We throw PluginTimeoutError because it carries isRetryable=true; there is no
    // generic retryable server-error class, and timeout semantics are close enough
    // for the scheduler's purposes.
    throw new PluginTimeoutError(
      `REST API returned ${status} — server error, retrying`,
    );
  }

  throw new PluginDataError(
    `REST API returned unexpected status ${status}`,
    { status, url },
  );
}

function parseRetryAfter(value: string): number | undefined {
  const date = new Date(value);
  if (!isNaN(date.getTime()) && !/^\s*\d+\s*$/.test(value)) {
    return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
  }
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds)) return Math.max(0, seconds);
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Response data extraction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Navigate a dot-delimited path into a parsed JSON object.
 * e.g., path="results.items" on { results: { items: [...] } } → [...]
 */
function extractByPath(obj: unknown, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = obj;

  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

function extractRecordsArray(body: unknown, dataPath: string | null): unknown[] {
  const raw = dataPath !== null ? extractByPath(body, dataPath) : body;

  if (Array.isArray(raw)) {
    return raw;
  }

  // If the path resolves to a non-array, surface a clear error rather than
  // silently returning zero records and masking misconfiguration.
  throw new PluginDataError(
    dataPath !== null
      ? `responseDataPath "${dataPath}" did not resolve to an array in the API response`
      : `API response root is not an array — set responseDataPath to locate the records array`,
    {
      dataPath,
      resolvedType: raw === null ? "null" : typeof raw,
    },
  );
}

function toDataRecord(item: unknown, index: number): DataRecord {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new PluginDataError(
      `Record at index ${index} is not an object`,
      String(item).substring(0, 1024),
    );
  }

  const record = item as Record<string, unknown>;

  // Prefer stable identifiers from the source system.
  // Fall back to string index — acceptable only when the source has no IDs.
  const rawId = record["id"] ?? record["_id"] ?? record["uuid"] ?? String(index);
  const sourceId = String(rawId);

  // Extract ISO 8601 timestamps for change tracking when the source provides them.
  const createdAt = extractTimestamp(record, ["created_at", "createdAt", "created"]);
  const updatedAt = extractTimestamp(record, ["updated_at", "updatedAt", "updated", "modified_at", "modifiedAt"]);
  const deletedAt = extractTimestamp(record, ["deleted_at", "deletedAt", "deleted"]);

  return {
    sourceId,
    data: record,
    metadata: {
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(deletedAt !== undefined ? { deletedAt } : {}),
    },
  };
}

function extractTimestamp(
  record: Record<string, unknown>,
  fieldNames: string[],
): string | undefined {
  for (const name of fieldNames) {
    const value = record[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Link header parsing (RFC 8288)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the URL of the "next" relation from an RFC 8288 Link header.
 * Returns null if no next link is present.
 *
 * Example header: <https://api.example.com/items?page=2>; rel="next", <...>; rel="last"
 */
function parseNextLinkHeader(linkHeader: string): string | null {
  // Use a regex-based parser that correctly handles commas inside angle-bracketed URLs.
  const linkRegex = /<([^>]*)>\s*;\s*rel=["']?([^"',;]*)["']?/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(linkHeader)) !== null) {
    if (match[2] === "next") return match[1];
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// URL construction
// ────────────────────────────────────────────────────────────────────────────

function buildUrl(
  baseUrl: string,
  endpoint: string,
  params: Record<string, string>,
): string {
  // Join base and endpoint path without double-slashing.
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = new URL(`${base}${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

// ────────────────────────────────────────────────────────────────────────────
// Request header assembly
// ────────────────────────────────────────────────────────────────────────────

function buildHeaders(
  staticHeaders: Record<string, string>,
  authHeader: string | null,
  authType: ResolvedAuth["type"],
  tracingContext: PluginContext["tracing"],
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...staticHeaders,
  };

  if (authHeader !== null) {
    if (authType === "apiKey") {
      headers["X-API-Key"] = authHeader;
    } else {
      // bearer → "Authorization: Bearer <token>", basic → "Authorization: Basic <b64>"
      headers["Authorization"] = authHeader;
    }
  }

  // Propagate distributed trace context into every outbound request so
  // ingestion spans correlate with downstream API traces.
  return tracingContext.injectHeaders(headers);
}

// ────────────────────────────────────────────────────────────────────────────
// Connector implementation
// ────────────────────────────────────────────────────────────────────────────

class RestApiConnector implements Connector {
  metadata(): ConnectorMetadata {
    return {
      type: "connector",
      id: "com.oneplatform.connector-rest-api",
      name: "REST API",
      description:
        "Connect to any REST API endpoint. Supports offset, cursor, and Link-header pagination, incremental sync, and API key, bearer token, or HTTP Basic auth.",
      version: "1.0.0",
      author: "OnePlatform",
      category: "api",
      tags: ["rest", "api", "http", "generic"],
      outputSchema: {
        type: "object",
        description:
          "Raw record returned by the REST API. Shape depends on the configured endpoint.",
        additionalProperties: true,
      },
      configSchema: {
        type: "object",
        required: ["baseUrl", "endpoint"],
        properties: {
          baseUrl: { type: "string", format: "uri" },
          endpoint: { type: "string" },
          method: { type: "string", enum: ["GET", "POST"] },
          headers: { type: "object", additionalProperties: { type: "string" } },
          responseDataPath: { type: "string" },
          paginationType: { type: "string", enum: ["none", "offset", "cursor", "link"] },
          pageSize: { type: "number", minimum: 1, maximum: 10000 },
          incrementalField: { type: "string" },
        },
      },
      supportsIncremental: true,
      supportsRealtime: false,
    };
  }

  async connect(
    config: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ConnectorHandle> {
    const span = context.tracing.startSpan("RestApiConnector.connect");

    try {
      const parsed = parseConfig(config);
      const auth = await resolveAuth(context);

      span.setAttribute("connector.baseUrl", parsed.baseUrl);
      span.setAttribute("connector.paginationType", parsed.paginationType);
      span.setAttribute("connector.authType", auth.type);

      context.logger.info("REST API connector connected", {
        baseUrl: parsed.baseUrl,
        endpoint: parsed.endpoint,
        method: parsed.method,
        paginationType: parsed.paginationType,
        authType: auth.type,
      });

      const metadata: HandleMetadata = {
        baseUrl: parsed.baseUrl,
        endpoint: parsed.endpoint,
        method: parsed.method,
        staticHeaders: parsed.headers,
        responseDataPath: parsed.responseDataPath,
        paginationType: parsed.paginationType,
        pageSize: parsed.pageSize,
        incrementalField: parsed.incrementalField,
      };

      const connectionId = `rest-api:${parsed.baseUrl}:${parsed.endpoint}:${Date.now()}`;

      return { connectionId, metadata };
    } finally {
      span.end();
    }
  }

  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    const meta = handle.metadata as unknown as HandleMetadata;
    const span = context.tracing.startSpan("RestApiConnector.fetchBatch");

    try {
      const decodedCursor = cursor !== null ? decodeCursor(cursor) : null;

      const { url, isLinkFollowRequest } = this.buildRequestUrl(meta, decodedCursor);

      const auth = await resolveAuth(context);
      const authHeader = authToHeader(auth);
      const headers = buildHeaders(
        meta.staticHeaders,
        authHeader,
        auth.type,
        context.tracing,
      );

      span.setAttribute("fetch.url", url);
      span.setAttribute("fetch.method", meta.method);

      context.logger.debug("Fetching REST API batch", { url, method: meta.method });

      // For POST requests, send pagination/filter parameters as a JSON body instead
      // of query string params. Many REST APIs that use POST for querying (e.g.,
      // Elasticsearch _search, GraphQL) expect parameters in the request body.
      // The URL was built with query params for GET; for POST we rebuild the URL
      // without those params and send them as the body instead.
      let fetchUrl = url;
      let fetchBody: string | undefined;
      if (meta.method === "POST") {
        const parsedUrl = new URL(url);
        const bodyParams: Record<string, string> = {};
        for (const [key, value] of parsedUrl.searchParams.entries()) {
          bodyParams[key] = value;
        }
        // Clear query params from the URL — they belong in the body for POST.
        parsedUrl.search = "";
        fetchUrl = parsedUrl.toString();
        if (Object.keys(bodyParams).length > 0) {
          fetchBody = JSON.stringify(bodyParams);
          headers["Content-Type"] = "application/json";
        }
      }

      let response: Response;
      try {
        response = await context.fetch.fetch(fetchUrl, {
          method: meta.method,
          headers,
          ...(fetchBody !== undefined ? { body: fetchBody } : {}),
        });
      } catch (err) {
        // Network-level errors (DNS failure, TCP reset, AbortError) are transient.
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("abort")) {
          throw new PluginTimeoutError(`REST API request timed out: ${message}`);
        }
        throw new PluginTimeoutError(`REST API network error: ${message}`);
      }

      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        throwForHttpStatus(response.status, url, retryAfter);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new PluginDataError(
          "REST API response is not valid JSON",
          { url, contentType: response.headers.get("Content-Type") },
        );
      }

      const rawItems = extractRecordsArray(body, meta.responseDataPath);
      const records: DataRecord[] = rawItems.map((item, index) =>
        toDataRecord(item, index),
      );

      span.setAttribute("fetch.recordCount", records.length);

      const { nextCursor, hasMore } = this.computeNextCursor(
        meta,
        decodedCursor,
        records,
        response,
        body,
        isLinkFollowRequest,
      );

      context.logger.info("REST API batch fetched", {
        url,
        recordCount: records.length,
        hasMore,
      });

      return {
        records,
        nextCursor,
        hasMore,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      span.end();
    }
  }

  async disconnect(_handle: ConnectorHandle, context: PluginContext): Promise<void> {
    // HTTP is stateless — nothing to tear down.
    // Log for observability so operators can confirm the lifecycle completed.
    context.logger.debug("REST API connector disconnected (no-op)");
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private buildRequestUrl(
    meta: HandleMetadata,
    cursor: CursorPayload | null,
  ): { url: string; isLinkFollowRequest: boolean } {
    const params: Record<string, string> = {};

    // Incremental filter: add only on subsequent calls (cursor !== null),
    // because the first call always fetches from the beginning.
    if (meta.incrementalField !== null && cursor?.since !== undefined) {
      params[meta.incrementalField] = cursor.since;
    }

    switch (meta.paginationType) {
      case "offset": {
        const offset = cursor?.offset ?? 0;
        params["offset"] = String(offset);
        params["limit"] = String(meta.pageSize);
        return {
          url: buildUrl(meta.baseUrl, meta.endpoint, params),
          isLinkFollowRequest: false,
        };
      }

      case "cursor": {
        if (cursor?.token !== undefined) {
          params["cursor"] = cursor.token;
        }
        params["limit"] = String(meta.pageSize);
        return {
          url: buildUrl(meta.baseUrl, meta.endpoint, params),
          isLinkFollowRequest: false,
        };
      }

      case "link": {
        // On first call there is no next URL yet — fetch the base endpoint.
        // On subsequent calls, follow the exact next URL from the Link header
        // (the API owns the full URL structure).
        if (cursor?.nextUrl !== undefined) {
          const nextOrigin = new URL(cursor.nextUrl).origin;
          const baseOrigin = new URL(meta.baseUrl).origin;
          if (nextOrigin !== baseOrigin) {
            throw new PluginDataError(
              `Link header next URL origin "${nextOrigin}" does not match baseUrl origin "${baseOrigin}"`,
              { nextUrl: cursor.nextUrl, baseUrl: meta.baseUrl },
            );
          }
          return { url: cursor.nextUrl, isLinkFollowRequest: true };
        }
        return {
          url: buildUrl(meta.baseUrl, meta.endpoint, params),
          isLinkFollowRequest: false,
        };
      }

      case "none":
      default:
        return {
          url: buildUrl(meta.baseUrl, meta.endpoint, params),
          isLinkFollowRequest: false,
        };
    }
  }

  private computeNextCursor(
    meta: HandleMetadata,
    previousCursor: CursorPayload | null,
    records: DataRecord[],
    response: Response,
    body: unknown,
    isLinkFollowRequest: boolean,
  ): { nextCursor: string | null; hasMore: boolean } {
    // When no records came back there is nothing more to fetch regardless of
    // pagination mode — avoids infinite loops on empty-page APIs.
    if (records.length === 0) {
      return { nextCursor: null, hasMore: false };
    }

    switch (meta.paginationType) {
      case "offset": {
        const previousOffset = previousCursor?.offset ?? 0;
        const nextOffset = previousOffset + records.length;

        // A page smaller than pageSize means we've reached the last page.
        if (records.length < meta.pageSize) {
          return { nextCursor: null, hasMore: false };
        }

        return {
          nextCursor: encodeCursor({ offset: nextOffset, since: previousCursor?.since }),
          hasMore: true,
        };
      }

      case "cursor": {
        const nextToken = extractCursorToken(body);
        if (nextToken === null) {
          return { nextCursor: null, hasMore: false };
        }
        return {
          nextCursor: encodeCursor({ token: nextToken, since: previousCursor?.since }),
          hasMore: true,
        };
      }

      case "link": {
        const linkHeader = response.headers.get("Link");
        if (linkHeader === null) {
          return { nextCursor: null, hasMore: false };
        }
        const nextUrl = parseNextLinkHeader(linkHeader);
        if (nextUrl === null) {
          return { nextCursor: null, hasMore: false };
        }
        return {
          nextCursor: encodeCursor({ nextUrl, since: previousCursor?.since }),
          hasMore: true,
        };
      }

      case "none":
      default:
        // Single-page connector: one request, no continuation.
        // If incrementalField is set the NEXT run will use the most recently
        // updated record's value as the "since" filter — we don't need a
        // within-run cursor for that.
        return { nextCursor: null, hasMore: false };
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Cursor token extraction from response body (cursor-pagination mode)
//
// Different APIs use different field names. We check common conventions in order.
// ────────────────────────────────────────────────────────────────────────────

function safeNested(parent: unknown, key: string): unknown {
  return parent !== null && typeof parent === "object" && !Array.isArray(parent)
    ? (parent as Record<string, unknown>)[key]
    : undefined;
}

function extractCursorToken(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const obj = body as Record<string, unknown>;

  // Most common cursor field names, checked in priority order.
  const candidates = [
    obj["next_cursor"],
    obj["nextCursor"],
    obj["cursor"],
    obj["next_page_token"],
    obj["nextPageToken"],
    obj["page_token"],
    safeNested(obj["meta"], "next_cursor"),
    safeNested(obj["pagination"], "cursor"),
    safeNested(obj["paging"], "cursor"),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Module entrypoint
//
// The manifest declares `"entrypoint": "connector"` so the Execution Service
// looks for a named export called `connector` on the bundle's module namespace.
// ────────────────────────────────────────────────────────────────────────────

export const connector: Connector = new RestApiConnector();
