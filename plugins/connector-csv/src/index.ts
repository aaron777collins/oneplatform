/**
 * CSV Connector — fetches records from a remote CSV file.
 *
 * Design notes:
 * - The entire CSV is fetched on the first fetchBatch call and stored in cache.
 *   Subsequent calls read from cache using a row-offset cursor. This avoids
 *   re-fetching on each page, which would be both slow and non-deterministic
 *   if the remote file changes mid-ingestion.
 * - No external CSV parsing libraries are used. The parser is implemented
 *   inline per the RFC 4180 spec, keeping the bundle self-contained.
 * - Only https:// URLs are accepted. http:// URLs are rejected at config validation
 *   time with a clear error, since the FetchProxy blocks unencrypted HTTP anyway.
 */

import type {
  Connector,
  ConnectorHandle,
  ConnectorMetadata,
  BatchResult,
  DataRecord,
  PluginContext,
} from "@oneplatform/plugin-sdk";
import {
  PluginAuthError,
  PluginConfigError,
  PluginDataError,
  PluginTimeoutError,
} from "@oneplatform/plugin-sdk";

// ─── Config ──────────────────────────────────────────────────────────────────

interface CsvConfig {
  url: string;
  delimiter: string;
  hasHeader: boolean;
  encoding: string;
  idColumn: string | undefined;
  batchSize: number;
  maxFileSizeMb: number;
}

const DEFAULT_DELIMITER = ",";
const DEFAULT_HAS_HEADER = true;
const DEFAULT_ENCODING = "utf-8";
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_FILE_SIZE_MB = 100;
const MAX_FIELDS_PER_ROW = 1000;

/** Cache key for the parsed row set, scoped per connection. */
function rowsCacheKey(connectionId: string): string {
  return `csv:rows:${connectionId}`;
}

// ─── RFC 4180 CSV Parser ──────────────────────────────────────────────────────

/**
 * Parsed CSV result returned from parseCSV().
 */
interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/**
 * Parse CSV text into headers and data rows.
 *
 * Implements RFC 4180 with the following behaviour:
 * - Fields may be enclosed in double-quotes. Quoted fields may contain the
 *   delimiter, CRLF/LF newlines, and escaped double-quotes ("").
 * - Unquoted fields are read until the next delimiter or end-of-line.
 * - Trailing CRLF on the last line is ignored (RFC 4180 §2 rule 2).
 * - Empty lines at the end of the file are skipped.
 *
 * @param text      Raw CSV text (UTF-8 string).
 * @param delimiter Field separator, typically "," or "\t".
 * @param hasHeader When true, the first data row becomes the headers array.
 *                  When false, synthetic "col_0", "col_1", … names are generated.
 */
export function parseCSV(
  text: string,
  delimiter: string,
  hasHeader: boolean,
): ParsedCsv {
  const rows: string[][] = [];

  // We parse character-by-character to correctly handle quoted fields that
  // span multiple lines. Splitting on newlines first would break embedded-newline support.
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    const row = parseRow(text, delimiter, pos);
    pos = row.nextPos;

    // Skip the row if it is a single empty field (trailing newline or blank line)
    if (row.fields.length === 1 && row.fields[0] === "") {
      continue;
    }
    rows.push(row.fields);
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }

  if (hasHeader) {
    // The first row supplies column names; validate it is non-empty.
    const headerRow = rows[0];
    if (headerRow === undefined || headerRow.length === 0) {
      return { headers: [], rows: [] };
    }
    return { headers: headerRow, rows: rows.slice(1) };
  }

  // Generate synthetic column names based on the width of the first data row.
  const width = rows[0]?.length ?? 0;
  const headers = Array.from({ length: width }, (_, i) => `col_${i}`);
  return { headers, rows };
}

/**
 * Parse one row starting at position `start` in `text`.
 * Returns the parsed fields and the position immediately after the row's
 * terminating newline (or EOF).
 */
interface RowResult {
  fields: string[];
  nextPos: number;
}

function parseRow(text: string, delimiter: string, start: number): RowResult {
  const fields: string[] = [];
  let pos = start;
  const len = text.length;

  while (pos <= len) {
    if (fields.length >= MAX_FIELDS_PER_ROW) {
      throw new PluginDataError(
        `Row exceeds maximum field count of ${MAX_FIELDS_PER_ROW}`,
        { maxFields: MAX_FIELDS_PER_ROW },
      );
    }

    if (pos === len) {
      // EOF mid-row: emit the last (empty) field to close the row.
      fields.push("");
      break;
    }

    if (text[pos] === '"') {
      // Quoted field: read until the closing unescaped quote.
      const { value, nextPos } = parseQuotedField(text, pos + 1);
      fields.push(value);
      pos = nextPos;

      // After a quoted field: expect delimiter, newline, or EOF.
      if (pos < len && text[pos] === delimiter) {
        pos++; // consume delimiter, continue to next field
      } else if (pos < len && text[pos] === "\r" && text[pos + 1] === "\n") {
        pos += 2; // consume CRLF, end row
        break;
      } else if (pos < len && text[pos] === "\n") {
        pos += 1; // consume LF, end row
        break;
      } else {
        // EOF after closing quote — row is done
        break;
      }
    } else {
      // Unquoted field: read until delimiter, newline, or EOF.
      let fieldStart = pos;
      while (pos < len && text[pos] !== delimiter && text[pos] !== "\n" && text[pos] !== "\r") {
        pos++;
      }
      fields.push(text.slice(fieldStart, pos));

      if (pos >= len) {
        break; // EOF
      } else if (text[pos] === delimiter) {
        pos++; // consume delimiter, continue to next field
      } else if (text[pos] === "\r" && text[pos + 1] === "\n") {
        pos += 2; // consume CRLF, end row
        break;
      } else if (text[pos] === "\r") {
        pos += 1; // consume bare CR (old Mac line ending), end row
        break;
      } else if (text[pos] === "\n") {
        pos += 1; // consume LF, end row
        break;
      }
    }
  }

  // Guarantee at least one field per row (empty row = one empty string field)
  if (fields.length === 0) {
    fields.push("");
  }

  return { fields, nextPos: pos };
}

/**
 * Parse a quoted field body. `pos` is the character immediately after the
 * opening double-quote. Returns the unescaped field value and the position
 * immediately after the closing double-quote.
 *
 * RFC 4180 §2 rule 7: A double-quote within a quoted field is represented by
 * two consecutive double-quotes ("").
 */
function parseQuotedField(text: string, pos: number): { value: string; nextPos: number } {
  let value = "";
  const len = text.length;

  while (pos < len) {
    if (text[pos] === '"') {
      if (pos + 1 < len && text[pos + 1] === '"') {
        // Escaped quote — emit one quote and skip both characters.
        value += '"';
        pos += 2;
      } else {
        // Closing quote — field ends here.
        pos++; // advance past the closing quote
        break;
      }
    } else {
      value += text[pos];
      pos++;
    }
  }

  return { value, nextPos: pos };
}

// ─── Config Extraction ────────────────────────────────────────────────────────

function extractConfig(raw: Record<string, unknown>): CsvConfig {
  const url = raw["url"];
  if (typeof url !== "string" || url.trim() === "") {
    throw new PluginConfigError("config.url is required and must be a non-empty string", "url");
  }

  const trimmedUrl = url.trim();
  if (trimmedUrl.startsWith("http://")) {
    throw new PluginConfigError(
      "Only https:// URLs are supported. The platform does not allow unencrypted HTTP connections.",
      "url",
    );
  }
  if (!trimmedUrl.startsWith("https://")) {
    throw new PluginConfigError(
      "config.url must begin with https://",
      "url",
    );
  }

  const rawDelimiter = raw["delimiter"];
  if (typeof rawDelimiter === "string" && rawDelimiter.length > 1) {
    // The parser compares text[pos] (a single character) against the delimiter,
    // so a multi-character delimiter would never match, silently corrupting every row.
    throw new PluginConfigError(
      `config.delimiter must be exactly one character. Received: "${rawDelimiter}"`,
      "delimiter",
    );
  }
  const delimiter =
    typeof rawDelimiter === "string" && rawDelimiter.length === 1
      ? rawDelimiter
      : DEFAULT_DELIMITER;

  const hasHeader =
    typeof raw["hasHeader"] === "boolean" ? raw["hasHeader"] : DEFAULT_HAS_HEADER;

  const encoding =
    typeof raw["encoding"] === "string" && raw["encoding"].length > 0
      ? raw["encoding"]
      : DEFAULT_ENCODING;

  const idColumn =
    typeof raw["idColumn"] === "string" && raw["idColumn"].length > 0
      ? raw["idColumn"]
      : undefined;

  const rawBatchSize = raw["batchSize"];
  const batchSize =
    typeof rawBatchSize === "number" && Number.isInteger(rawBatchSize) && rawBatchSize > 0
      ? rawBatchSize
      : DEFAULT_BATCH_SIZE;

  const rawMaxFileSizeMb = raw["maxFileSizeMb"];
  const maxFileSizeMb =
    typeof rawMaxFileSizeMb === "number" && rawMaxFileSizeMb > 0
      ? rawMaxFileSizeMb
      : DEFAULT_MAX_FILE_SIZE_MB;

  return { url: trimmedUrl, delimiter, hasHeader, encoding, idColumn, batchSize, maxFileSizeMb };
}

// ─── Connector Implementation ─────────────────────────────────────────────────

class CsvConnector implements Connector {
  metadata(): ConnectorMetadata {
    return {
      type: "connector",
      id: "com.oneplatform.connector-csv",
      name: "CSV",
      description:
        "Fetches records from a remote CSV file over HTTP/HTTPS. Supports custom delimiters, optional header rows, and authenticated endpoints via bearer token.",
      version: "1.0.0",
      author: "OnePlatform",
      category: "file",
      outputSchema: {
        type: "object",
        description: "Shape depends on the CSV headers and idColumn configuration.",
        additionalProperties: true,
      },
      supportsIncremental: false,
      // Real-time support could be added via polling: re-fetch the CSV on an
      // interval and diff against the previously seen rows using the idColumn.
      // This is not implemented — set supportsRealtime: true once the Execution
      // Service poll-loop integration is wired up.
      supportsRealtime: false,
      configSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", description: "URL to fetch the CSV file from." },
          delimiter: { type: "string", default: "," },
          hasHeader: { type: "boolean", default: true },
          encoding: { type: "string", default: "utf-8" },
          idColumn: { type: "string" },
          batchSize: { type: "number", default: 500 },
          maxFileSizeMb: { type: "number", default: 100, description: "Maximum file size in MB. Responses exceeding this are rejected." },
        },
      },
      tags: ["csv", "file", "import", "data-source"],
    };
  }

  async connect(
    config: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ConnectorHandle> {
    const cfg = extractConfig(config);

    // Generate a stable connection ID from the URL so cache keys are predictable
    // across reconnects to the same source.
    const connectionId = `csv:${cfg.url}`;

    context.logger.info("CSV connector connecting", { url: cfg.url });

    // Eagerly validate that the remote URL is reachable. We use HEAD to avoid
    // downloading the full file during connect() (which must be < 5 seconds).
    // If HEAD fails or the server returns an error, we surface it immediately
    // rather than deferring to the first fetchBatch call.
    try {
      const availableCredentials = await context.credentials.list();
      const bearerToken = availableCredentials.includes("bearerToken")
        ? await context.credentials.get("bearerToken")
        : undefined;
      const headers = buildRequestHeaders(context, bearerToken);
      const response = await context.fetch.fetch(cfg.url, { method: "HEAD", headers });
      if (!response.ok) {
        throw new PluginConfigError(
          `CSV endpoint returned HTTP ${response.status} — check config.url and credentials`,
          "url",
        );
      }
    } catch (err) {
      if (err instanceof PluginConfigError) {
        throw err;
      }
      // Network errors (DNS failure, timeout) surface as generic fetch errors.
      // We re-throw as PluginConfigError because a bad URL is a config issue.
      const message = err instanceof Error ? err.message : String(err);
      throw new PluginConfigError(
        `Could not reach CSV endpoint: ${message}`,
        "url",
      );
    }

    return {
      connectionId,
      // Store resolved config in the handle so fetchBatch doesn't need to re-parse it.
      metadata: {
        url: cfg.url,
        delimiter: cfg.delimiter,
        hasHeader: cfg.hasHeader,
        encoding: cfg.encoding,
        idColumn: cfg.idColumn ?? null,
        batchSize: cfg.batchSize,
        maxFileSizeMb: cfg.maxFileSizeMb,
      },
    };
  }

  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    const meta = handle.metadata;
    const url = meta["url"] as string;
    const delimiter = meta["delimiter"] as string;
    const hasHeader = meta["hasHeader"] as boolean;
    const encoding = (meta["encoding"] as string | undefined) ?? DEFAULT_ENCODING;
    const idColumn = (meta["idColumn"] as string | null) ?? undefined;
    const batchSize = (meta["batchSize"] as number | undefined) ?? DEFAULT_BATCH_SIZE;
    const maxFileSizeMb = (meta["maxFileSizeMb"] as number | undefined) ?? DEFAULT_MAX_FILE_SIZE_MB;
    const availableCredentials = await context.credentials.list();
    const bearerToken = availableCredentials.includes("bearerToken")
      ? await context.credentials.get("bearerToken")
      : undefined;

    const cacheKey = rowsCacheKey(handle.connectionId);

    // On the first call (cursor === null) fetch and parse the entire CSV file,
    // then cache the result for subsequent pages. Caching avoids re-downloading
    // on every page and guarantees a consistent view of the data across all batches.
    let parsed: ParsedCsv;

    const cached = await context.cache.get<ParsedCsv>(cacheKey);
    if (cached !== null) {
      parsed = cached;
    } else {
      context.logger.info("Fetching CSV file", { url });

      const headers = buildRequestHeaders(context, bearerToken);
      let response: Response;
      try {
        response = await context.fetch.fetch(url, { method: "GET", headers });
      } catch (err) {
        // Re-throw permanent plugin errors (e.g. PluginAuthError for disallowed URLs)
        // as-is so the platform does not pointlessly retry them. Only transient
        // network failures (timeouts, connection resets) are wrapped as retryable.
        if (err instanceof PluginAuthError || err instanceof PluginConfigError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new PluginTimeoutError(`CSV fetch failed: ${message}`);
      }

      if (!response.ok) {
        throw new PluginDataError(
          `CSV endpoint returned HTTP ${response.status}`,
          { url, status: response.status },
        );
      }

      // Enforce maxFileSizeMb: check Content-Length header first for an early
      // rejection before downloading the body. If Content-Length is absent,
      // the byte count is checked after reading the response body.
      const maxBytes = maxFileSizeMb * 1024 * 1024;
      const contentLength = response.headers.get("Content-Length");
      if (contentLength !== null) {
        const declaredSize = parseInt(contentLength, 10);
        if (!isNaN(declaredSize) && declaredSize > maxBytes) {
          throw new PluginDataError(
            `CSV file exceeds maxFileSizeMb (${maxFileSizeMb} MB). Content-Length: ${declaredSize} bytes`,
            { url, contentLength: declaredSize, maxBytes },
          );
        }
      }

      let text: string;
      try {
        const buffer = await response.arrayBuffer();
        // Post-download size check when Content-Length was absent or inaccurate.
        const actualBytes = buffer.byteLength;
        if (actualBytes > maxBytes) {
          throw new PluginDataError(
            `CSV file exceeds maxFileSizeMb (${maxFileSizeMb} MB). Actual size: ${actualBytes} bytes`,
            { url, actualBytes, maxBytes },
          );
        }
        text = new TextDecoder(encoding).decode(buffer);
      } catch (err) {
        if (err instanceof PluginDataError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new PluginDataError(`Failed to read CSV response body: ${message}`, { url });
      }

      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }

      try {
        parsed = parseCSV(text, delimiter, hasHeader);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new PluginDataError(`CSV parse error: ${message}`, { url });
      }

      context.logger.info("CSV parsed", {
        rowCount: parsed.rows.length,
        columnCount: parsed.headers.length,
      });

      // Cache for 24 hours (the max allowed TTL). The ingestion job will complete
      // well within this window; the cache is cleared on disconnect via key expiry.
      await context.cache.set(cacheKey, parsed, 86400);
    }

    // Decode the row offset from the cursor string. null cursor = start at row 0.
    const offset = cursor === null ? 0 : parseInt(cursor, 10);

    if (isNaN(offset) || offset < 0) {
      throw new PluginDataError(`Invalid cursor value: "${cursor}"`, { cursor });
    }

    const { headers, rows } = parsed;
    const page = rows.slice(offset, offset + batchSize);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < rows.length;

    const records: DataRecord[] = page.map((row, pageIndex) => {
      const absoluteIndex = offset + pageIndex;
      const data: Record<string, unknown> = {};

      for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        const colName = headers[colIdx];
        if (colName !== undefined) {
          // row[colIdx] may be undefined if this row has fewer fields than the header;
          // we coerce that to an empty string to keep the record shape consistent.
          data[colName] = row[colIdx] ?? "";
        }
      }

      // Rows wider than the header produce extra unnamed fields; we surface them
      // under synthetic names rather than silently discarding data.
      for (let colIdx = headers.length; colIdx < row.length; colIdx++) {
        data[`col_${colIdx}`] = row[colIdx] ?? "";
      }

      const sourceId =
        idColumn !== undefined && data[idColumn] !== undefined
          ? String(data[idColumn])
          : String(absoluteIndex);

      return {
        sourceId,
        data,
      };
    });

    return {
      records,
      nextCursor: hasMore ? String(nextOffset) : null,
      hasMore,
      fetchedAt: new Date().toISOString(),
      estimatedTotal: rows.length,
    };
  }

  async disconnect(_handle: ConnectorHandle, context: PluginContext): Promise<void> {
    context.logger.info("CSV connector disconnected", {
      connectionId: _handle.connectionId,
    });
    try {
      await context.cache.delete(rowsCacheKey(_handle.connectionId));
    } catch (err) {
      context.logger.warn("Failed to clear CSV cache", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build request headers, injecting tracing context and optional bearer token.
 *
 * When a bearerToken is configured, it is included as an Authorization header
 * so the CSV endpoint can verify access. This supports authenticated CSV
 * sources (e.g., private S3 presigned URLs, internal APIs behind auth).
 */
function buildRequestHeaders(context: PluginContext, bearerToken?: string): Record<string, string> {
  // Propagate distributed trace context so platform observability spans
  // can correlate the outbound CSV fetch with the ingestion job.
  const headers: Record<string, string> = { Accept: "text/csv, text/plain, */*" };
  if (bearerToken !== undefined) {
    headers["Authorization"] = `Bearer ${bearerToken}`;
  }
  return context.tracing.injectHeaders(headers);
}

// ─── Export ───────────────────────────────────────────────────────────────────

/** Named export matching `entrypoint` in plugin.manifest.json. */
export const connector: Connector = new CsvConnector();
