/**
 * MySQL Connector — extracts records from a MySQL database via a REST proxy.
 *
 * Plugins run inside an isolated sandbox that cannot open raw TCP sockets, so
 * direct MySQL wire-protocol connections are impossible. This connector routes
 * all queries through a MySQL REST proxy (configured via `config.proxyUrl`) that
 * accepts parameterized query requests over HTTPS and returns JSON result sets.
 *
 * Two extraction modes:
 *   - Table mode (default): SELECT * FROM `database`.`table` with appended
 *     LIMIT/OFFSET for pagination and an optional incremental WHERE clause.
 *   - Custom query mode: caller-supplied SELECT statement with LIMIT/OFFSET
 *     appended. The connector owns pagination; the caller must not include
 *     LIMIT or OFFSET in their query.
 *
 * Pagination uses offset-based batching because MySQL does not have a native
 * server-side cursor for arbitrary queries. Cursor-based pagination is
 * layered on top via an encoded cursor that carries the current offset and,
 * for incremental syncs, the last seen value of the incremental column.
 *
 * Incremental sync:
 *   On the first run (cursor === null), the connector fetches all rows.
 *   On subsequent runs, it adds WHERE `incrementalColumn` > ? using the
 *   highest value seen in the previous batch. The cursor encodes this value
 *   as a string so the platform can checkpoint and resume safely.
 *
 * Primary key resolution:
 *   The connector discovers the table's primary key(s) via
 *   INFORMATION_SCHEMA.KEY_COLUMN_USAGE and uses the first PK column as
 *   sourceId. For custom queries it falls back to the row offset within the
 *   batch, which is deterministic within a single ingestion run.
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

/** Validated and typed representation of the tenant-supplied configSchema values. */
interface MySqlConfig {
  database: string;
  table: string;
  incrementalColumn: string | null;
  batchSize: number;
  customQuery: string | null;
  proxyUrl: string;
}

/**
 * Shape stored in ConnectorHandle.metadata — must be JSON-serializable.
 * Carries everything fetchBatch needs without re-validating config.
 */
interface HandleMetadata {
  database: string;
  table: string;
  incrementalColumn: string | null;
  batchSize: number;
  customQuery: string | null;
  proxyUrl: string;
  /** Primary key column name discovered at connect() time. Null for custom queries. */
  primaryKeyColumn: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Cursor encoding
//
// The cursor carries the current page offset and, for incremental syncs, the
// highest seen value of the incremental column from the previous batch.
// Base64url encoding keeps the cursor opaque to the platform and safe for
// storage/transport without escaping.
// ────────────────────────────────────────────────────────────────────────────

interface CursorPayload {
  /** Zero-based row offset for the next batch. */
  offset: number;
  /**
   * For incremental sync: the highest value of incrementalColumn seen so far.
   * This is passed as the WHERE clause parameter on subsequent runs.
   * Stored as a string regardless of the underlying column type so it is safe
   * to serialise through JSON without precision loss.
   */
  since: string | null;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new PluginConfigError(
      "Invalid cursor value — cannot decode pagination state",
      "cursor",
    );
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)["offset"] !== "number" ||
    !(
      (parsed as Record<string, unknown>)["since"] === null ||
      typeof (parsed as Record<string, unknown>)["since"] === "string"
    )
  ) {
    throw new PluginConfigError(
      "Invalid cursor value — unexpected shape",
      "cursor",
    );
  }

  return parsed as CursorPayload;
}

// ────────────────────────────────────────────────────────────────────────────
// Private network detection
//
// Allow plain HTTP for localhost and private network addresses where TLS
// termination is handled by the infrastructure (e.g., sidecar proxy).
// This matches the check used by the Postgres connector.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the URL uses http:// and points to a recognised private
 * network address. This allows developers to run a MySQL REST proxy on their
 * local machine or inside a private VPC without requiring a TLS certificate.
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
    // Skip index 0 (full match string); indices 1-4 are the four octets.
    // All four capture groups always exist when the regex matches, so
    // a and b are always numbers (never undefined or NaN given \d+ pattern).
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    // 127.x.x.x — loopback
    if (a === 127) return true;
    // 10.x.x.x — Class A private
    if (a === 10) return true;
    // 172.16.0.0 – 172.31.255.255 — Class B private
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.x.x — Class C private
    if (a === 192 && b === 168) return true;
  }

  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Config validation
// ────────────────────────────────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown>): MySqlConfig {
  const database = raw["database"];
  if (typeof database !== "string" || database.trim() === "") {
    throw new PluginConfigError(
      "database is required and must be a non-empty string",
      "database",
    );
  }

  const table = raw["table"];
  if (typeof table !== "string" || table.trim() === "") {
    throw new PluginConfigError(
      "table is required and must be a non-empty string",
      "table",
    );
  }

  // Restrict identifiers to safe MySQL unquoted identifier syntax. Backticks,
  // backslashes, null bytes, and other control characters can break out of the
  // backtick quoting used in buildTableQuery even when the proxy is hardened.
  const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
  if (!SAFE_IDENTIFIER.test(database.trim())) {
    throw new PluginConfigError(
      "database name must contain only letters, digits, and underscores, and must start with a letter or underscore (max 64 characters)",
      "database",
    );
  }
  if (!SAFE_IDENTIFIER.test(table.trim())) {
    throw new PluginConfigError(
      "table name must contain only letters, digits, and underscores, and must start with a letter or underscore (max 64 characters)",
      "table",
    );
  }

  const rawIncrementalColumn = raw["incrementalColumn"];
  const incrementalColumn =
    typeof rawIncrementalColumn === "string" && rawIncrementalColumn.trim() !== ""
      ? rawIncrementalColumn.trim()
      : null;

  if (incrementalColumn !== null && !SAFE_IDENTIFIER.test(incrementalColumn)) {
    throw new PluginConfigError(
      "incrementalColumn must contain only letters, digits, and underscores, and must start with a letter or underscore (max 64 characters)",
      "incrementalColumn",
    );
  }

  const rawBatchSize = raw["batchSize"];
  let batchSize = 1000;
  if (typeof rawBatchSize === "number" && rawBatchSize >= 1 && rawBatchSize <= 10000) {
    batchSize = Math.floor(rawBatchSize);
  }

  const rawCustomQuery = raw["customQuery"];
  const customQuery =
    typeof rawCustomQuery === "string" && rawCustomQuery.trim() !== ""
      ? rawCustomQuery.trim()
      : null;

  if (customQuery !== null && incrementalColumn !== null) {
    throw new PluginConfigError(
      "incrementalColumn cannot be used together with customQuery — the connector cannot apply an incremental WHERE filter to a caller-supplied query",
      "incrementalColumn",
    );
  }

  if (customQuery !== null) {
    // Validate it looks like a SELECT — the proxy enforces this too, but failing
    // fast here gives a more informative error than a proxy rejection.
    const normalised = customQuery.replace(/\s+/g, " ").trimStart().toUpperCase();
    if (!normalised.startsWith("SELECT")) {
      throw new PluginConfigError(
        "customQuery must be a SELECT statement",
        "customQuery",
      );
    }
    // Reject LIMIT/OFFSET — the connector appends these itself.
    if (/\bLIMIT\b/.test(normalised) || /\bOFFSET\b/.test(normalised)) {
      throw new PluginConfigError(
        "customQuery must not include LIMIT or OFFSET — the connector appends them",
        "customQuery",
      );
    }
  }

  const rawProxyUrl = raw["proxyUrl"];
  if (typeof rawProxyUrl !== "string" || rawProxyUrl.trim() === "") {
    throw new PluginConfigError(
      "proxyUrl is required — plugins cannot open direct TCP connections to MySQL",
      "proxyUrl",
    );
  }

  const trimmedProxyUrl = rawProxyUrl.trim();
  if (!trimmedProxyUrl.startsWith("https://") && !isPrivateNetworkHttp(trimmedProxyUrl)) {
    throw new PluginConfigError(
      "proxyUrl must use HTTPS for public endpoints — plain HTTP is only permitted for localhost and private network addresses (10.x, 172.16-31.x, 192.168.x, 127.x)",
      "proxyUrl",
    );
  }
  try {
    new URL(trimmedProxyUrl);
  } catch {
    throw new PluginConfigError(
      `proxyUrl is not a valid URL: "${rawProxyUrl}"`,
      "proxyUrl",
    );
  }

  return {
    database: database.trim(),
    table: table.trim(),
    incrementalColumn,
    batchSize,
    customQuery,
    proxyUrl: rawProxyUrl.trim(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP error mapping
// ────────────────────────────────────────────────────────────────────────────

function throwForProxyStatus(status: number, url: string, retryAfter: string | null): never {
  if (status === 401 || status === 403) {
    throw new PluginAuthError(
      `MySQL proxy returned ${status} — check the connectionString credential or proxy auth configuration`,
      { status, url },
    );
  }

  if (status === 429) {
    const retryAfterSeconds =
      retryAfter !== null ? parseRetryAfterHeader(retryAfter) : undefined;
    throw new PluginRateLimitError(
      "MySQL proxy rate limit exceeded (429) — the proxy is throttling requests",
      retryAfterSeconds,
    );
  }

  if (status >= 500) {
    // 5xx from the proxy are transient. PluginTimeoutError carries isRetryable=true.
    throw new PluginTimeoutError(
      `MySQL proxy returned ${status} — server error, retrying`,
    );
  }

  throw new PluginDataError(
    `MySQL proxy returned unexpected status ${status}`,
    { status, url },
  );
}

function parseRetryAfterHeader(value: string): number | undefined {
  const seconds = parseInt(value, 10);
  if (isNaN(seconds)) return undefined;
  return seconds < 0 ? 0 : seconds;
}

// ────────────────────────────────────────────────────────────────────────────
// Proxy request/response types
//
// The MySQL REST proxy accepts POST requests with this JSON body and returns
// a JSON response. The proxy is responsible for opening the real MySQL
// connection, running the parameterised query, and returning results.
//
// Using parameterised queries (params array) is non-negotiable: the proxy
// MUST use prepared statement binding, never string interpolation of params.
// ────────────────────────────────────────────────────────────────────────────

interface ProxyRequest {
  connectionString: string; // forwarded by the proxy to the MySQL driver
  query: string;            // parameterised SQL with ? placeholders
  params: unknown[];        // bound in order to the ? placeholders
}

interface ProxyResponse {
  rows: Record<string, unknown>[];
  /** Total rows matching the query without LIMIT, when the proxy can cheaply supply it. */
  totalCount?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Proxy interaction helpers
// ────────────────────────────────────────────────────────────────────────────

async function runProxyQuery(
  proxyUrl: string,
  request: ProxyRequest,
  context: PluginContext,
): Promise<ProxyResponse> {
  const headers = context.tracing.injectHeaders({
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  let response: Response;
  try {
    response = await context.fetch.fetch(proxyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("abort")) {
      throw new PluginTimeoutError(`MySQL proxy request timed out: ${message}`);
    }
    throw new PluginTimeoutError(`MySQL proxy network error: ${message}`);
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    throwForProxyStatus(response.status, proxyUrl, retryAfter);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PluginDataError(
      "MySQL proxy response is not valid JSON",
      { proxyUrl, contentType: response.headers.get("Content-Type") },
    );
  }

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray((body as Record<string, unknown>)["rows"])
  ) {
    throw new PluginDataError(
      "MySQL proxy response is missing the required 'rows' array",
      String(body).substring(0, 1024),
    );
  }

  return body as ProxyResponse;
}

// ────────────────────────────────────────────────────────────────────────────
// Primary key discovery
//
// We query INFORMATION_SCHEMA.KEY_COLUMN_USAGE once at connect() time and
// cache the result in the ConnectorHandle so fetchBatch never hits the schema
// tables. Using backtick quoting (MySQL standard) for the identifier placeholders
// in the WHERE clause — the actual values are still parameterised.
// ────────────────────────────────────────────────────────────────────────────

async function discoverPrimaryKey(
  config: MySqlConfig,
  connectionString: string,
  context: PluginContext,
): Promise<string | null> {
  // Custom queries do not have a reliable primary key to discover.
  if (config.customQuery !== null) {
    return null;
  }

  const query = `
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = ?
      AND CONSTRAINT_NAME = 'PRIMARY'
    ORDER BY ORDINAL_POSITION
    LIMIT 1
  `.trim();

  const proxyResponse = await runProxyQuery(
    config.proxyUrl,
    { connectionString, query, params: [config.database, config.table] },
    context,
  );

  const firstRow = proxyResponse.rows[0];
  if (firstRow === undefined) {
    return null;
  }

  const columnName = firstRow["COLUMN_NAME"];
  if (typeof columnName !== "string") {
    return null;
  }

  // Validate the discovered column name against the same safe identifier regex
  // used for user-supplied identifiers. Column names from INFORMATION_SCHEMA
  // should always be safe, but a corrupted or adversarial source database could
  // return a name containing backtick characters that would break SQL quoting
  // in buildTableQuery.
  const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
  if (!SAFE_IDENTIFIER.test(columnName)) {
    return null;
  }

  return columnName;
}

// ────────────────────────────────────────────────────────────────────────────
// SQL query building
//
// All user-supplied identifier names (database, table, column) are quoted
// with backticks. Literal values are always passed as proxy params, never
// interpolated into the SQL string.
// ────────────────────────────────────────────────────────────────────────────

interface QueryAndParams {
  query: string;
  params: unknown[];
}

function escapeBacktickIdentifier(name: string): string {
  return name.replace(/`/g, "``");
}

function buildTableQuery(
  handle: HandleMetadata,
  offset: number,
  since: string | null,
): QueryAndParams {
  const params: unknown[] = [];

  const db = escapeBacktickIdentifier(handle.database);
  const tbl = escapeBacktickIdentifier(handle.table);
  let query = `SELECT * FROM \`${db}\`.\`${tbl}\``;

  if (handle.incrementalColumn !== null && since !== null) {
    query += ` WHERE \`${escapeBacktickIdentifier(handle.incrementalColumn)}\` > ?`;
    params.push(since);
  }

  if (handle.incrementalColumn !== null) {
    query += ` ORDER BY \`${escapeBacktickIdentifier(handle.incrementalColumn)}\` ASC`;
  } else if (handle.primaryKeyColumn !== null) {
    query += ` ORDER BY \`${escapeBacktickIdentifier(handle.primaryKeyColumn)}\` ASC`;
  }

  query += ` LIMIT ? OFFSET ?`;
  params.push(handle.batchSize, offset);

  return { query, params };
}

function buildCustomQuery(handle: HandleMetadata, offset: number): QueryAndParams {
  // The custom query is already validated to be a SELECT without LIMIT/OFFSET.
  // We append LIMIT and OFFSET as parameterised values.
  const query = `${handle.customQuery} LIMIT ? OFFSET ?`;
  return { query, params: [handle.batchSize, offset] };
}

// ────────────────────────────────────────────────────────────────────────────
// Row → DataRecord mapping
// ────────────────────────────────────────────────────────────────────────────

function rowToDataRecord(
  row: Record<string, unknown>,
  rowIndex: number,
  primaryKeyColumn: string | null,
  globalOffset: number,
): DataRecord {
  // Prefer the table's primary key column as the sourceId for stable dedup.
  // Fall back to the global row position (offset + within-batch index), which
  // is deterministic for a given snapshot but not across re-inserts.
  let sourceId: string;
  if (primaryKeyColumn !== null) {
    const pkValue = row[primaryKeyColumn];
    sourceId = pkValue !== undefined && pkValue !== null ? String(pkValue) : String(globalOffset + rowIndex);
  } else {
    sourceId = String(globalOffset + rowIndex);
  }

  // Extract common timestamp column names for provenance metadata.
  const createdAt = extractTimestampField(row, ["created_at", "createdAt", "created"]);
  const updatedAt = extractTimestampField(row, [
    "updated_at",
    "updatedAt",
    "modified_at",
    "modifiedAt",
  ]);
  const deletedAt = extractTimestampField(row, ["deleted_at", "deletedAt"]);

  return {
    sourceId,
    data: row,
    metadata: {
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(deletedAt !== undefined ? { deletedAt } : {}),
    },
  };
}

function extractTimestampField(
  row: Record<string, unknown>,
  fieldNames: string[],
): string | undefined {
  for (const name of fieldNames) {
    const value = row[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    // MySQL DATETIME/TIMESTAMP columns may deserialise as Date objects or numbers
    // depending on the proxy implementation. Normalise to ISO 8601 string.
    if (value instanceof Date) {
      return value.toISOString();
    }
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Incremental column high-water mark
//
// After each batch we find the maximum value of the incremental column in the
// returned rows. This becomes the `since` field of the next cursor. We compare
// as strings because the column type is unknown at compile time — the proxy
// serialises all values to JSON (strings, numbers). String comparison is safe
// for ISO 8601 timestamps and numeric IDs (MySQL returns numerics as numbers).
// ────────────────────────────────────────────────────────────────────────────

function findHighWaterMark(
  rows: Record<string, unknown>[],
  incrementalColumn: string,
  previousSince: string | null,
): string | null {
  let highest = previousSince;

  for (const row of rows) {
    const value = row[incrementalColumn];
    if (value === null || value === undefined) {
      continue;
    }
    const asString = String(value);
    // Numeric column values (MySQL returns numbers for INT/BIGINT/DECIMAL) must
    // be compared numerically — string ordering breaks for multi-digit integers
    // (e.g. "9" > "10" lexicographically but 9 < 10 numerically).
    if (typeof value === "number") {
      const numericHighest = highest !== null ? parseFloat(highest) : -Infinity;
      if (parseFloat(asString) > numericHighest) {
        highest = asString;
      }
    } else {
      if (highest === null || asString > highest) {
        highest = asString;
      }
    }
  }

  return highest;
}

// ────────────────────────────────────────────────────────────────────────────
// Connector implementation
// ────────────────────────────────────────────────────────────────────────────

class MySqlConnector implements Connector {
  metadata(): ConnectorMetadata {
    return {
      type: "connector",
      id: "com.oneplatform.connector-mysql",
      name: "MySQL",
      description:
        "Connect to a MySQL database and extract records from a table or custom query with offset and cursor-based pagination and incremental sync.",
      version: "1.0.0",
      author: "OnePlatform",
      category: "database",
      tags: ["mysql", "database", "sql"],
      outputSchema: {
        type: "object",
        description: "Raw row from the MySQL table or query result. Shape depends on the configured table or customQuery.",
        additionalProperties: true,
      },
      configSchema: {
        type: "object",
        required: ["database", "table", "proxyUrl"],
        properties: {
          database: { type: "string" },
          table: { type: "string" },
          incrementalColumn: { type: "string" },
          batchSize: { type: "number", minimum: 1, maximum: 10000, default: 1000 },
          customQuery: { type: "string" },
          proxyUrl: { type: "string", format: "uri" },
        },
        additionalProperties: false,
      },
      supportsIncremental: true,
      // Real-time support could be added via MySQL binary log (binlog) change
      // data capture, similar to Debezium's MySQL connector. This requires a
      // binlog reader exposed through the platform DB proxy. Set
      // supportsRealtime: true once that proxy integration is available.
      supportsRealtime: false,
    };
  }

  async connect(
    config: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ConnectorHandle> {
    const span = context.tracing.startSpan("MySqlConnector.connect");

    try {
      const parsed = parseConfig(config);

      // Retrieve the connection string from the secrets vault for use during
      // connect-time discovery. Not stored in handle metadata — fetchBatch
      // retrieves it fresh from the credential store on each call to avoid
      // caching secrets in serializable state.
      const connectionString = await context.credentials.get("connectionString");

      // Discover the primary key once upfront and cache it in the handle so
      // fetchBatch never touches INFORMATION_SCHEMA during ingestion.
      const primaryKeyColumn = await discoverPrimaryKey(parsed, connectionString, context);

      span.setAttribute("connector.database", parsed.database);
      span.setAttribute("connector.table", parsed.table);
      span.setAttribute("connector.batchSize", parsed.batchSize);
      span.setAttribute("connector.mode", parsed.customQuery !== null ? "customQuery" : "table");

      context.logger.info("MySQL connector connected", {
        database: parsed.database,
        table: parsed.table,
        mode: parsed.customQuery !== null ? "customQuery" : "table",
        primaryKeyColumn,
        incrementalColumn: parsed.incrementalColumn,
      });

      const metadata: HandleMetadata = {
        database: parsed.database,
        table: parsed.table,
        incrementalColumn: parsed.incrementalColumn,
        batchSize: parsed.batchSize,
        customQuery: parsed.customQuery,
        proxyUrl: parsed.proxyUrl,
        primaryKeyColumn,
      };

      const connectionId = `mysql:${parsed.database}.${parsed.table}:${Date.now()}`;

      return { connectionId, metadata: metadata as unknown as Record<string, unknown> };
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
    const span = context.tracing.startSpan("MySqlConnector.fetchBatch");

    try {
      // Retrieve the connection string fresh from the credential store on each
      // batch instead of reading it from handle metadata. This avoids caching
      // secrets in serializable state and picks up credential rotations.
      const connectionString = await context.credentials.get("connectionString");

      // Decode the opaque cursor or start from offset 0 with no incremental filter.
      const decoded: CursorPayload =
        cursor !== null ? decodeCursor(cursor) : { offset: 0, since: null };

      const { offset, since } = decoded;

      // Build the query appropriate for the configured mode.
      const { query, params } =
        meta.customQuery !== null
          ? buildCustomQuery(meta, offset)
          : buildTableQuery(meta, offset, since);

      span.setAttribute("fetch.offset", offset);
      span.setAttribute("fetch.batchSize", meta.batchSize);

      context.logger.debug("MySQL: fetching batch", {
        database: meta.database,
        table: meta.table,
        offset,
        batchSize: meta.batchSize,
        hasIncrementalFilter: since !== null,
      });

      const proxyResponse = await runProxyQuery(
        meta.proxyUrl,
        { connectionString, query, params },
        context,
      );

      const rows = proxyResponse.rows;
      const records: DataRecord[] = rows.map((row, i) =>
        rowToDataRecord(row, i, meta.primaryKeyColumn, offset),
      );

      span.setAttribute("fetch.recordCount", records.length);

      // Compute the next cursor. A batch smaller than batchSize means we have
      // reached the last page of this run.
      const isLastPage = records.length < meta.batchSize;

      let nextCursor: string | null;
      let hasMore: boolean;

      if (isLastPage) {
        // Even on the final batch we must persist the high-water mark so the next
        // incremental run starts from where this one ended, not from the beginning.
        const finalSince =
          meta.incrementalColumn !== null
            ? findHighWaterMark(rows, meta.incrementalColumn, since)
            : since;

        // Only emit a cursor when there is meaningful state to carry forward.
        nextCursor = finalSince !== null ? encodeCursor({ offset: 0, since: finalSince }) : null;
        hasMore = false;
      } else {
        const nextSince =
          meta.incrementalColumn !== null
            ? findHighWaterMark(rows, meta.incrementalColumn, since)
            : since;

        let nextOffset: number;
        if (meta.incrementalColumn !== null) {
          if (nextSince !== null && nextSince === since) {
            nextOffset = offset + records.length;
          } else {
            nextOffset = 0;
          }
        } else {
          nextOffset = offset + records.length;
        }

        nextCursor = encodeCursor({ offset: nextOffset, since: nextSince });
        hasMore = true;
      }

      context.logger.info("MySQL: batch fetched", {
        database: meta.database,
        table: meta.table,
        recordCount: records.length,
        offset,
        hasMore,
      });

      return {
        records,
        nextCursor,
        hasMore,
        fetchedAt: new Date().toISOString(),
        ...(proxyResponse.totalCount !== undefined
          ? { estimatedTotal: proxyResponse.totalCount }
          : {}),
      };
    } finally {
      span.end();
    }
  }

  async disconnect(_handle: ConnectorHandle, context: PluginContext): Promise<void> {
    // The proxy manages connection pooling — there is no persistent socket to close.
    // Log at debug so the lifecycle is observable in verbose mode.
    context.logger.debug("MySQL connector disconnected (proxy manages pooling)");
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Module entrypoint
//
// The manifest declares `"entrypoint": "connector"` so the Execution Service
// looks for a named export called `connector` on the bundle's module namespace.
// ────────────────────────────────────────────────────────────────────────────

export const connector: Connector = new MySqlConnector();
