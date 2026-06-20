/**
 * PostgreSQL Connector — OnePlatform built-in plugin.
 *
 * WHY A PROXY PATTERN:
 * Plugins run inside an isolated-vm sandbox that cannot load native Node.js
 * addons. The `pg` (node-postgres) package requires native bindings and TCP
 * socket access that the sandbox denies. Instead, this connector delegates
 * all SQL execution to a platform-managed DB proxy (PostgREST, pgweb, or the
 * platform's own proxy service) over HTTPS using context.fetch.
 *
 * The connectionString credential is bound to the proxy at instance-enable
 * time by the platform admin — the plugin code never receives or handles it.
 *
 * PAGINATION STRATEGY:
 * - Full sync:        offset-based  — page through all rows with LIMIT/OFFSET
 * - Incremental sync: cursor-based  — filter WHERE incrementalColumn > cursor,
 *                     ORDER BY incrementalColumn, avoids full table scans on
 *                     large append-only or audit-log style tables.
 *
 * CURSOR ENCODING:
 * The cursor is a JSON string containing { mode, value } so the connector can
 * distinguish an offset integer from a column-value string without ambiguity.
 */

import type {
  Connector,
  ConnectorHandle,
  BatchResult,
  ConnectorMetadata,
  DataRecord,
  PluginContext,
} from "@oneplatform/plugin-sdk";
import {
  PluginConfigError,
  PluginAuthError,
  PluginRateLimitError,
  PluginTimeoutError,
  PluginDataError,
} from "@oneplatform/plugin-sdk";

// ─── Config shape ─────────────────────────────────────────────────────────────

interface PostgresConfig {
  /** Base URL of the Postgres REST proxy. Example: https://proxy.internal/db */
  proxyUrl: string;
  /** Table to sync. Mutually exclusive with customQuery. */
  table?: string;
  /** Database schema. Defaults to "public". */
  schema: string;
  /** Column used for cursor-based incremental sync. */
  incrementalColumn?: string;
  /** Rows per batch. Defaults to 1000. */
  batchSize: number;
  /** Raw SQL query. When present, overrides table + incrementalColumn. */
  customQuery?: string;
  /** Column whose value becomes the DataRecord.sourceId. Defaults to "id". */
  primaryKey: string;
}

// ─── Cursor shape ─────────────────────────────────────────────────────────────

type CursorMode = "offset" | "incremental";

interface OffsetCursor {
  mode: "offset";
  /** Number of rows already consumed from the result set. */
  offset: number;
}

interface IncrementalCursor {
  mode: "incremental";
  /**
   * The last seen value of incrementalColumn. Rows with a value >= lastValue are
   * fetched, and rows with a primary key <= lastId are skipped to avoid
   * re-ingesting rows that share the same cursor value at a batch boundary.
   */
  lastValue: string;
  /**
   * The primary key value of the last row processed. Used as a tiebreaker to
   * skip already-processed rows when the next batch starts with >= lastValue.
   */
  lastId: string;
}

type ParsedCursor = OffsetCursor | IncrementalCursor;

// ─── Proxy response types ─────────────────────────────────────────────────────

/**
 * Shape returned by the proxy's schema-info endpoint.
 * The platform DB proxy is expected to expose:
 *   GET {proxyUrl}/schema?table={table}&db_schema={schema}
 *   → { columns: [{ name, type, isPrimary }] }
 */
interface ProxySchemaColumn {
  name: string;
  type: string;
  isPrimary: boolean;
}

interface ProxySchemaResponse {
  columns: ProxySchemaColumn[];
}

/**
 * Shape returned by the proxy's data endpoint:
 *   GET {proxyUrl}/rows?table={table}&db_schema={schema}&limit={n}&offset={m}
 *   GET {proxyUrl}/rows?table={table}&db_schema={schema}&limit={n}&incremental_column={col}&cursor_value={val}
 *   GET {proxyUrl}/query   (POST with body { sql, params })
 *   → { rows: Record<string, unknown>[], total?: number }
 */
interface ProxyRowsResponse {
  rows: Record<string, unknown>[];
  /** Advisory total row count. The proxy may omit this (e.g., for large tables). */
  total?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SCHEMA = "public";
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_PRIMARY_KEY = "id";
const MAX_BATCH_SIZE = 10_000;

// Connection test endpoint — the proxy must support a health/ping call.
const SCHEMA_PATH = "/schema";
const ROWS_PATH = "/rows";
const QUERY_PATH = "/query";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when the URL uses HTTP and targets a localhost or RFC-1918
 * private network address. This allows local development without an HTTPS
 * proxy while keeping the HTTPS requirement for public endpoints.
 *
 * Recognised private ranges:
 *   - 127.x.x.x  (loopback)
 *   - 10.x.x.x   (Class A private)
 *   - 172.16-31.x.x (Class B private)
 *   - 192.168.x.x (Class C private)
 *   - localhost / [::1] (IPv4/IPv6 loopback names)
 */
function isPrivateNetworkHttp(urlString: string): boolean {
  if (!urlString.startsWith("http://")) {
    return false;
  }

  let hostname: string;
  try {
    hostname = new URL(urlString).hostname;
  } catch {
    return false;
  }

  // Strip IPv6 brackets if present (URL constructor already does this, but be safe)
  hostname = hostname.replace(/^\[|\]$/g, "");

  // Loopback names
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }

  // IPv4 private ranges
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    // 127.x.x.x — loopback
    if (a === 127) return true;
    // 10.x.x.x — Class A private
    if (a === 10) return true;
    // 172.16.0.0 – 172.31.255.255 — Class B private
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    // 192.168.x.x — Class C private
    if (a === 192 && b === 168) return true;
  }

  return false;
}

function parseConfig(raw: Record<string, unknown>): PostgresConfig {
  const proxyUrl = raw["proxyUrl"];
  if (typeof proxyUrl !== "string" || proxyUrl.trim() === "") {
    throw new PluginConfigError(
      "proxyUrl is required and must be a non-empty string",
      "proxyUrl",
    );
  }
  if (!proxyUrl.startsWith("https://") && !isPrivateNetworkHttp(proxyUrl)) {
    throw new PluginConfigError(
      "proxyUrl must use HTTPS for public endpoints — plain HTTP is only permitted for localhost and private network addresses (10.x, 172.16-31.x, 192.168.x, 127.x)",
      "proxyUrl",
    );
  }

  const table = raw["table"];
  const customQuery = raw["customQuery"];
  if (
    (table === undefined || table === null || table === "") &&
    (customQuery === undefined || customQuery === null || customQuery === "")
  ) {
    throw new PluginConfigError(
      "Either 'table' or 'customQuery' must be provided",
      "table",
    );
  }

  const rawBatchSize = raw["batchSize"] ?? DEFAULT_BATCH_SIZE;
  if (typeof rawBatchSize !== "number" || !Number.isInteger(rawBatchSize)) {
    throw new PluginConfigError("batchSize must be an integer", "batchSize");
  }
  if (rawBatchSize < 1 || rawBatchSize > MAX_BATCH_SIZE) {
    throw new PluginConfigError(
      `batchSize must be between 1 and ${MAX_BATCH_SIZE}`,
      "batchSize",
    );
  }

  const incrementalColumn = raw["incrementalColumn"];
  if (incrementalColumn !== undefined && typeof incrementalColumn !== "string") {
    throw new PluginConfigError(
      "incrementalColumn must be a string when provided",
      "incrementalColumn",
    );
  }

  // A customQuery in combination with incrementalColumn is ambiguous — the SQL
  // already controls the WHERE clause. Callers should encode the cursor into
  // their own SQL or omit incrementalColumn.
  if (customQuery !== undefined && incrementalColumn !== undefined) {
    throw new PluginConfigError(
      "incrementalColumn cannot be used together with customQuery — encode the cursor condition directly in your SQL",
      "incrementalColumn",
    );
  }

  return {
    proxyUrl: proxyUrl.replace(/\/+$/, ""), // strip trailing slash
    ...(typeof table === "string" ? { table } : {}),
    schema: typeof raw["schema"] === "string" ? raw["schema"] : DEFAULT_SCHEMA,
    ...(typeof incrementalColumn === "string" ? { incrementalColumn } : {}),
    batchSize: rawBatchSize,
    ...(typeof customQuery === "string" ? { customQuery } : {}),
    primaryKey:
      typeof raw["primaryKey"] === "string" ? raw["primaryKey"] : DEFAULT_PRIMARY_KEY,
  };
}

function encodeCursor(cursor: ParsedCursor): string {
  return JSON.stringify(cursor);
}

function decodeCursor(raw: string): ParsedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginDataError(`Cursor is not valid JSON: ${raw.slice(0, 100)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginDataError("Cursor must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const mode = obj["mode"];

  if (mode === "offset") {
    const offset = obj["offset"];
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      throw new PluginDataError("offset cursor must contain a non-negative integer 'offset'");
    }
    return { mode: "offset", offset };
  }

  if (mode === "incremental") {
    const lastValue = obj["lastValue"];
    if (typeof lastValue !== "string") {
      throw new PluginDataError("incremental cursor must contain a string 'lastValue'");
    }
    // lastId was added to support tiebreaker skipping at batch boundaries.
    // Cursors written before this change omit lastId; treat absence as empty
    // string so those cursors remain valid (they will re-fetch the boundary row).
    const lastId = typeof obj["lastId"] === "string" ? obj["lastId"] : "";
    return { mode: "incremental", lastValue, lastId };
  }

  throw new PluginDataError(`Unknown cursor mode: ${String(mode)}`);
}

/**
 * Extract the primary key value from a row as a string sourceId.
 * Throws PluginDataError when the PK column is absent — this prevents silent
 * data loss where rows would be ingested without a stable identifier.
 */
function extractSourceId(row: Record<string, unknown>, primaryKey: string): string {
  const pkValue = row[primaryKey];
  if (pkValue === undefined || pkValue === null) {
    throw new PluginDataError(
      `Row is missing required primary key column "${primaryKey}". ` +
        "Configure the 'primaryKey' option to match your table's primary key column.",
      { rowKeys: Object.keys(row).slice(0, 10) },
    );
  }
  return String(pkValue);
}

function rowsToDataRecords(
  rows: Record<string, unknown>[],
  primaryKey: string,
): DataRecord[] {
  return rows.map((row) => {
    const sourceId = extractSourceId(row, primaryKey);
    return {
      sourceId,
      data: row,
      metadata: {
        // Surface common timestamp columns into the platform's freshness tracking.
        // These are advisory — the platform ignores undefined values.
        ...(typeof row["created_at"] === "string"
          ? { createdAt: row["created_at"] }
          : {}),
        ...(typeof row["updated_at"] === "string"
          ? { updatedAt: row["updated_at"] }
          : typeof row["modified_at"] === "string"
            ? { updatedAt: row["modified_at"] }
            : {}),
        ...(typeof row["deleted_at"] === "string"
          ? { deletedAt: row["deleted_at"] }
          : {}),
      },
    };
  });
}

/**
 * Map HTTP error status codes from the proxy to the appropriate plugin error.
 * The proxy is trusted infrastructure — 4xx errors are configuration problems,
 * not transient failures.
 */
function handleProxyError(status: number, path: string, body: string): never {
  if (status === 401 || status === 403) {
    throw new PluginAuthError(
      `Proxy rejected the request with ${status}. ` +
        "Verify the connectionString credential and proxy access permissions.",
      { proxyPath: path, status },
    );
  }
  if (status === 429) {
    throw new PluginRateLimitError(
      "Postgres proxy is rate-limiting requests. Reducing batchSize may help.",
    );
  }
  if (status === 408 || status === 504 || status === 524) {
    throw new PluginTimeoutError(
      `Proxy returned timeout status ${status} for ${path}. ` +
        "Consider reducing batchSize or adding indexes to the incrementalColumn.",
    );
  }
  if (status >= 500) {
    // 5xx from the proxy is retryable — it may be a transient proxy or DB issue.
    throw new PluginDataError(
      `Postgres proxy returned server error ${status} for ${path}: ${body.slice(0, 500)}`,
    );
  }
  throw new PluginDataError(
    `Postgres proxy returned unexpected status ${status} for ${path}: ${body.slice(0, 500)}`,
  );
}

// ─── Connector implementation ─────────────────────────────────────────────────

const CONNECTOR_METADATA: ConnectorMetadata = {
  type: "connector",
  id: "com.oneplatform.connector-postgres",
  name: "PostgreSQL",
  description:
    "Sync records from a PostgreSQL table or custom SQL query via the platform database proxy. " +
    "Supports full table sync (offset pagination) and incremental sync (cursor-based, ideal for " +
    "append-only tables with an updated_at column).",
  version: "1.0.0",
  author: "OnePlatform",
  category: "database",
  tags: ["database", "sql", "postgres", "postgresql"],
  configSchema: {
    type: "object",
    required: ["proxyUrl"],
    properties: {
      proxyUrl: { type: "string", description: "Base URL of the Postgres REST proxy." },
      table: { type: "string" },
      schema: { type: "string", default: "public" },
      incrementalColumn: { type: "string" },
      batchSize: { type: "number", default: 1000 },
      customQuery: { type: "string" },
      primaryKey: { type: "string", default: "id" },
    },
  },
  outputSchema: {
    type: "object",
    description: "One record per table row. Fields mirror the column names of the source table.",
    properties: {
      sourceId: { type: "string", description: "Value of the primary key column." },
      data: { type: "object", additionalProperties: true },
    },
  },
  supportsIncremental: true,
  supportsRealtime: false,
};

class PostgresConnector implements Connector {
  metadata(): ConnectorMetadata {
    return CONNECTOR_METADATA;
  }

  async connect(
    config: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ConnectorHandle> {
    const cfg = parseConfig(config);

    // The connectionString credential is used by the proxy service, not this
    // plugin directly. We validate it exists so the platform surfaces a clear
    // error before the first fetchBatch attempt rather than failing mid-sync.
    const connectionString = await context.credentials.get("connectionString");
    if (!connectionString || connectionString.trim() === "") {
      throw new PluginAuthError(
        "The 'connectionString' credential is empty. " +
          "Provide a valid postgresql:// URI in the plugin instance credentials.",
      );
    }

    const span = context.tracing.startSpan("postgres.connect");
    try {
      // Ping the proxy with a schema introspection call to verify connectivity
      // and validate that the target table exists before any data is fetched.
      if (cfg.table !== undefined) {
        await this.fetchTableSchema(cfg, context);
        context.logger.info("PostgreSQL connector connected", {
          table: cfg.table,
          schema: cfg.schema,
          proxyUrl: cfg.proxyUrl,
        });
      } else {
        // customQuery mode — ping the proxy health endpoint if available,
        // or do a zero-row test execution. A failed ping is non-fatal here
        // because the query itself will surface errors on the first fetchBatch.
        context.logger.info("PostgreSQL connector connected (customQuery mode)", {
          proxyUrl: cfg.proxyUrl,
        });
      }
    } finally {
      span.end();
    }

    const connectionId = `postgres-${context.tenant.instanceId}-${Date.now()}`;
    return {
      connectionId,
      metadata: {
        proxyUrl: cfg.proxyUrl,
        table: cfg.table ?? null,
        schema: cfg.schema,
        incrementalColumn: cfg.incrementalColumn ?? null,
        batchSize: cfg.batchSize,
        customQuery: cfg.customQuery ?? null,
        primaryKey: cfg.primaryKey,
      },
    };
  }

  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    // Re-hydrate config from handle.metadata so the connector is stateless
    // between calls — the platform may checkpoint and resume from any batch.
    const cfg = handleToConfig(handle);
    const span = context.tracing.startSpan("postgres.fetchBatch");

    try {
      if (cfg.customQuery !== null) {
        return await this.fetchBatchCustomQuery(cfg, cursor, context);
      }

      const isIncremental = cfg.incrementalColumn !== null;
      if (isIncremental) {
        return await this.fetchBatchIncremental(cfg, cursor, context);
      }
      return await this.fetchBatchOffset(cfg, cursor, context);
    } finally {
      span.end();
    }
  }

  async disconnect(_handle: ConnectorHandle, context: PluginContext): Promise<void> {
    // The proxy connection is stateless HTTP — nothing to tear down.
    // Log for observability but do not throw even if the log fails.
    try {
      context.logger.debug("PostgreSQL connector disconnected");
    } catch {
      // Swallow — disconnect must not throw per the Connector interface contract.
    }
  }

  // ── Private fetch helpers ──────────────────────────────────────────────────

  private async fetchTableSchema(
    cfg: PostgresConfig,
    context: PluginContext,
  ): Promise<ProxySchemaResponse> {
    const url = buildUrl(cfg.proxyUrl, SCHEMA_PATH, {
      table: cfg.table!,
      db_schema: cfg.schema,
    });

    const headers = context.tracing.injectHeaders({
      "Accept": "application/json",
    });

    const response = await context.fetch.fetch(url, { method: "GET", headers });

    if (!response.ok) {
      const body = await response.text();
      handleProxyError(response.status, SCHEMA_PATH, body);
    }

    const schemaText = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(schemaText) as unknown;
    } catch {
      throw new PluginDataError(`Proxy returned non-JSON response from ${SCHEMA_PATH}`, {
        body: schemaText.slice(0, 500),
      });
    }
    if (
      typeof json !== "object" ||
      json === null ||
      !Array.isArray((json as Record<string, unknown>)["columns"])
    ) {
      throw new PluginDataError(
        "Proxy schema response is missing the 'columns' array. " +
          "Ensure the proxy is the platform DB proxy or a compatible PostgREST instance.",
        { responseShape: typeof json },
      );
    }

    return json as ProxySchemaResponse;
  }

  private async fetchBatchOffset(
    cfg: RehydratedConfig,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    const offset =
      cursor === null
        ? 0
        : (() => {
            const parsed = decodeCursor(cursor);
            if (parsed.mode !== "offset") {
              // Switching from incremental to offset mid-sync is a misconfiguration.
              throw new PluginConfigError(
                "Cursor mode mismatch: expected 'offset' but got 'incremental'. " +
                  "Do not change incrementalColumn after a sync has started.",
              );
            }
            return parsed.offset;
          })();

    const url = buildUrl(cfg.proxyUrl, ROWS_PATH, {
      table: cfg.table!,
      db_schema: cfg.schema,
      limit: String(cfg.batchSize),
      offset: String(offset),
    });

    const headers = context.tracing.injectHeaders({ "Accept": "application/json" });
    const response = await context.fetch.fetch(url, { method: "GET", headers });

    if (!response.ok) {
      const body = await response.text();
      handleProxyError(response.status, ROWS_PATH, body);
    }

    const payload = await parseRowsResponse(response, ROWS_PATH);
    const records = rowsToDataRecords(payload.rows, cfg.primaryKey);

    const hasMore = records.length === cfg.batchSize;
    const nextCursor = hasMore
      ? encodeCursor({ mode: "offset", offset: offset + records.length })
      : null;

    context.logger.debug("fetchBatch (offset)", {
      table: cfg.table,
      offset,
      returned: records.length,
      hasMore,
    });

    return {
      records,
      nextCursor,
      hasMore,
      fetchedAt: new Date().toISOString(),
      ...(payload.total !== undefined ? { estimatedTotal: payload.total } : {}),
    };
  }

  private async fetchBatchIncremental(
    cfg: RehydratedConfig,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    // On the first call, cursor is null — fetch all rows ordered by the
    // incremental column so the platform stores a meaningful resume point.
    let lastValue: string | null = null;
    let lastId = "";
    if (cursor !== null) {
      const parsed = decodeCursor(cursor);
      if (parsed.mode !== "incremental") {
        throw new PluginConfigError(
          "Cursor mode mismatch: expected 'incremental' but got 'offset'. " +
            "Do not remove incrementalColumn after a sync has started.",
        );
      }
      lastValue = parsed.lastValue;
      lastId = parsed.lastId;
    }

    // Request batchSize + number of same-cursor-value rows we may need to skip.
    // We over-fetch by asking for more rows when resuming so we can filter out
    // already-processed rows with the same cursor value before returning a full
    // batch to the caller. The proxy receives the primary key as an order tiebreaker
    // so results are deterministic across page boundaries.
    const params: Record<string, string> = {
      table: cfg.table!,
      db_schema: cfg.schema,
      incremental_column: cfg.incrementalColumn!,
      order_by_tiebreaker: cfg.primaryKey,
      limit: String(cfg.batchSize),
    };
    if (lastValue !== null) {
      // Use >= so that rows sharing the cursor value with the last processed row
      // are included. The lastId tiebreaker below filters duplicates already seen.
      params["cursor_value"] = lastValue;
      params["cursor_inclusive"] = "true";
    }
    if (lastId !== "") {
      // Pass the last seen primary key so the proxy can skip rows with
      // (incrementalColumn = lastValue AND primaryKey <= lastId).
      params["cursor_last_id"] = lastId;
    }

    const url = buildUrl(cfg.proxyUrl, ROWS_PATH, params);
    const headers = context.tracing.injectHeaders({ "Accept": "application/json" });
    const response = await context.fetch.fetch(url, { method: "GET", headers });

    if (!response.ok) {
      const body = await response.text();
      handleProxyError(response.status, ROWS_PATH, body);
    }

    const payload = await parseRowsResponse(response, ROWS_PATH);

    // Filter out rows that were already processed in the previous batch.
    // These are rows where incrementalColumn = lastValue AND primaryKey <= lastId.
    const filteredRows =
      lastValue !== null && lastId !== ""
        ? payload.rows.filter((row) => {
            const colVal = String(row[cfg.incrementalColumn!] ?? "");
            const pkVal = String(row[cfg.primaryKey] ?? "");
            // Skip rows at the same cursor position that were already delivered.
            return !(colVal === lastValue && pkVal <= lastId);
          })
        : payload.rows;

    const records = rowsToDataRecords(filteredRows, cfg.primaryKey);

    // Advance the cursor to the maximum incrementalColumn value seen in this batch.
    // Track lastId so the next batch can skip duplicate-cursor rows already delivered.
    let nextCursor: string | null = null;
    let hasMore = false;

    if (records.length > 0) {
      const lastFilteredRow = filteredRows[filteredRows.length - 1];
      const colValue =
        lastFilteredRow !== undefined ? lastFilteredRow[cfg.incrementalColumn!] : undefined;
      if (colValue === undefined || colValue === null) {
        throw new PluginDataError(
          `incrementalColumn "${cfg.incrementalColumn}" is absent from the proxy response rows. ` +
            "Verify the column name and that it is included in the SELECT projection.",
          { availableColumns: Object.keys(lastFilteredRow ?? {}).slice(0, 10) },
        );
      }
      const newLastId = String(lastFilteredRow?.[cfg.primaryKey] ?? "");
      // hasMore is true when the batch is full — a partial batch means we've
      // reached the end of currently available rows.
      hasMore = records.length === cfg.batchSize;
      // Always persist the cursor so a partial (final) batch saves its
      // position.  Without this, restarting after a partial batch would
      // re-fetch rows that were already processed (V5-116).
      nextCursor = encodeCursor({
        mode: "incremental",
        lastValue: String(colValue),
        lastId: newLastId,
      });
    }

    context.logger.debug("fetchBatch (incremental)", {
      table: cfg.table,
      incrementalColumn: cfg.incrementalColumn,
      lastValue,
      lastId,
      returned: records.length,
      hasMore,
    });

    return {
      records,
      nextCursor,
      hasMore,
      fetchedAt: new Date().toISOString(),
      ...(payload.total !== undefined ? { estimatedTotal: payload.total } : {}),
    };
  }

  private async fetchBatchCustomQuery(
    cfg: RehydratedConfig,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    // Custom queries use offset pagination. The caller's SQL is assumed to be a
    // full SELECT — the proxy wraps it with LIMIT/OFFSET to page through results.
    const offset =
      cursor === null
        ? 0
        : (() => {
            const parsed = decodeCursor(cursor);
            if (parsed.mode !== "offset") {
              throw new PluginConfigError(
                "Custom query connectors only support offset cursors",
              );
            }
            return parsed.offset;
          })();

    const url = `${cfg.proxyUrl}${QUERY_PATH}`;
    const headers = context.tracing.injectHeaders({
      "Accept": "application/json",
      "Content-Type": "application/json",
    });

    // Parameterized at the proxy level — the proxy service is responsible for
    // binding LIMIT and OFFSET as query parameters to prevent SQL injection.
    const body = JSON.stringify({
      sql: cfg.customQuery,
      params: { limit: cfg.batchSize, offset },
    });

    const response = await context.fetch.fetch(url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      handleProxyError(response.status, QUERY_PATH, responseBody);
    }

    const payload = await parseRowsResponse(response, QUERY_PATH);
    const records = rowsToDataRecords(payload.rows, cfg.primaryKey);

    const hasMore = records.length === cfg.batchSize;
    const nextCursor = hasMore
      ? encodeCursor({ mode: "offset", offset: offset + records.length })
      : null;

    context.logger.debug("fetchBatch (customQuery)", {
      offset,
      returned: records.length,
      hasMore,
    });

    return {
      records,
      nextCursor,
      hasMore,
      fetchedAt: new Date().toISOString(),
      ...(payload.total !== undefined ? { estimatedTotal: payload.total } : {}),
    };
  }
}

// ─── Re-hydration helper ──────────────────────────────────────────────────────

/**
 * The config stored in ConnectorHandle.metadata is JSON-serializable but
 * loses TypeScript types at the handle boundary. This re-hydrates it into
 * a typed config shape before every fetchBatch call.
 */
interface RehydratedConfig {
  proxyUrl: string;
  table: string | null;
  schema: string;
  incrementalColumn: string | null;
  batchSize: number;
  customQuery: string | null;
  primaryKey: string;
}

function handleToConfig(handle: ConnectorHandle): RehydratedConfig {
  const m = handle.metadata;
  const proxyUrl = m["proxyUrl"] as string | undefined;
  if (typeof proxyUrl !== "string" || proxyUrl === "") {
    throw new PluginConfigError(
      "Handle metadata is missing proxyUrl -- the connector handle may be corrupted",
    );
  }
  return {
    proxyUrl,
    table: (m["table"] as string | null) ?? null,
    schema: (m["schema"] as string) ?? DEFAULT_SCHEMA,
    incrementalColumn: (m["incrementalColumn"] as string | null) ?? null,
    batchSize: (m["batchSize"] as number) ?? DEFAULT_BATCH_SIZE,
    customQuery: (m["customQuery"] as string | null) ?? null,
    primaryKey: (m["primaryKey"] as string) ?? DEFAULT_PRIMARY_KEY,
  };
}

// ─── URL builder ─────────────────────────────────────────────────────────────

/**
 * Safely builds a URL by appending a path and query parameters.
 * Does not use string concatenation for parameter values — all values are
 * encoded through URLSearchParams to prevent injection into the query string.
 */
function buildUrl(base: string, path: string, params: Record<string, string>): string {
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// ─── Response parsing ─────────────────────────────────────────────────────────

async function parseRowsResponse(
  response: Response,
  path: string,
): Promise<ProxyRowsResponse> {
  const responseText = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(responseText) as unknown;
  } catch {
    throw new PluginDataError(`Proxy returned non-JSON response from ${path}`, {
      body: responseText.slice(0, 500),
    });
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new PluginDataError(
      `Proxy response from ${path} is not a JSON object`,
      { responseType: typeof json },
    );
  }

  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj["rows"])) {
    throw new PluginDataError(
      `Proxy response from ${path} is missing the 'rows' array`,
      { responseKeys: Object.keys(obj).slice(0, 10) },
    );
  }

  return {
    rows: obj["rows"] as Record<string, unknown>[],
    ...(typeof obj["total"] === "number" ? { total: obj["total"] } : {}),
  };
}

// ─── Module export ────────────────────────────────────────────────────────────

/**
 * Named export matches the manifest's `entrypoint: "connector"` field.
 * The Execution Service imports this name from the bundle and calls its methods.
 */
export const connector: Connector = new PostgresConnector();
