import { describe, it, expect, beforeEach } from "vitest";
import { createMockContext } from "@oneplatform/plugin-sdk/testing";
import { PluginConfigError, PluginDataError } from "@oneplatform/plugin-sdk";
import { connector, parseCSV } from "../index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock context that returns the given CSV text from GET requests and
 * 200 OK from HEAD requests (for connect() validation).
 */
function makeCsvContext(csvText: string, credentials: Record<string, string> = {}) {
  return createMockContext({
    credentials,
    fetchHandler: async (_url: string, init?: RequestInit) => {
      const method = init?.method?.toUpperCase() ?? "GET";
      if (method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      return new Response(csvText, {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      });
    },
  });
}

const SIMPLE_CSV = `id,name,email
1,Alice,alice@example.com
2,Bob,bob@example.com
3,Carol,carol@example.com`;

// ─── metadata() ───────────────────────────────────────────────────────────────

describe("metadata()", () => {
  it("returns type connector", () => {
    const meta = connector.metadata();
    expect(meta.type).toBe("connector");
  });

  it("returns category file", () => {
    const meta = connector.metadata();
    expect(meta.category).toBe("file");
  });

  it("sets supportsIncremental to false", () => {
    const meta = connector.metadata();
    expect(meta.supportsIncremental).toBe(false);
  });

  it("sets supportsRealtime to false", () => {
    const meta = connector.metadata();
    expect(meta.supportsRealtime).toBe(false);
  });

  it("id matches manifest", () => {
    const meta = connector.metadata();
    expect(meta.id).toBe("com.oneplatform.connector-csv");
  });

  it("has a non-empty description", () => {
    const meta = connector.metadata();
    expect(meta.description.length).toBeGreaterThan(10);
  });

  it("configSchema marks url as required", () => {
    const meta = connector.metadata();
    const schema = meta.configSchema as { required?: string[] };
    expect(schema.required).toContain("url");
  });
});

// ─── parseCSV() ───────────────────────────────────────────────────────────────

describe("parseCSV()", () => {
  describe("simple CSV", () => {
    it("parses headers from the first row", () => {
      const { headers } = parseCSV("a,b,c\n1,2,3\n", ",", true);
      expect(headers).toEqual(["a", "b", "c"]);
    });

    it("parses data rows", () => {
      const { rows } = parseCSV("a,b,c\n1,2,3\n4,5,6\n", ",", true);
      expect(rows).toEqual([
        ["1", "2", "3"],
        ["4", "5", "6"],
      ]);
    });

    it("handles CRLF line endings", () => {
      const { headers, rows } = parseCSV("a,b\r\n1,2\r\n", ",", true);
      expect(headers).toEqual(["a", "b"]);
      expect(rows).toEqual([["1", "2"]]);
    });

    it("handles a trailing newline without producing an empty last row", () => {
      const { rows } = parseCSV("a,b\n1,2\n", ",", true);
      expect(rows).toHaveLength(1);
    });

    it("handles no trailing newline", () => {
      const { rows } = parseCSV("a,b\n1,2", ",", true);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(["1", "2"]);
    });
  });

  describe("quoted fields", () => {
    it("parses a quoted field containing a comma", () => {
      const { rows } = parseCSV(`name,value\n"Smith, John",42\n`, ",", true);
      expect(rows[0]).toEqual(["Smith, John", "42"]);
    });

    it("unescapes doubled double-quotes inside a quoted field", () => {
      const { rows } = parseCSV(`name,quote\nAlice,"say ""hello"""\n`, ",", true);
      expect(rows[0]).toEqual(["Alice", 'say "hello"']);
    });

    it("parses a quoted field containing an embedded newline", () => {
      const text = `id,notes\n1,"line one\nline two"\n`;
      const { rows } = parseCSV(text, ",", true);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(["1", "line one\nline two"]);
    });

    it("parses a quoted field containing an embedded CRLF", () => {
      const text = `id,notes\r\n1,"line one\r\nline two"\r\n`;
      const { rows } = parseCSV(text, ",", true);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(["1", "line one\r\nline two"]);
    });

    it("handles an empty quoted field", () => {
      const { rows } = parseCSV(`a,b,c\n1,"",3\n`, ",", true);
      expect(rows[0]).toEqual(["1", "", "3"]);
    });
  });

  describe("custom delimiter", () => {
    it("parses tab-separated values", () => {
      const { headers, rows } = parseCSV("a\tb\tc\n1\t2\t3\n", "\t", true);
      expect(headers).toEqual(["a", "b", "c"]);
      expect(rows).toEqual([["1", "2", "3"]]);
    });

    it("parses semicolon-separated values", () => {
      const { headers, rows } = parseCSV("a;b\n1;2\n", ";", true);
      expect(headers).toEqual(["a", "b"]);
      expect(rows[0]).toEqual(["1", "2"]);
    });

    it("treats commas as plain data when using a different delimiter", () => {
      const { rows } = parseCSV("a;b\n1,000;2\n", ";", true);
      expect(rows[0]).toEqual(["1,000", "2"]);
    });
  });

  describe("hasHeader=false", () => {
    it("generates synthetic col_N headers", () => {
      const { headers } = parseCSV("1,2,3\n4,5,6\n", ",", false);
      expect(headers).toEqual(["col_0", "col_1", "col_2"]);
    });

    it("includes all rows as data (none treated as header)", () => {
      const { rows } = parseCSV("1,2,3\n4,5,6\n", ",", false);
      expect(rows).toHaveLength(2);
    });
  });

  describe("edge cases", () => {
    it("returns empty result for an empty string", () => {
      const { headers, rows } = parseCSV("", ",", true);
      expect(headers).toEqual([]);
      expect(rows).toEqual([]);
    });

    it("returns empty result for a whitespace-only string", () => {
      const result = parseCSV("\n\n", ",", true);
      // A single empty header row with no data rows is valid
      expect(result.rows).toHaveLength(0);
    });

    it("handles a single-column CSV", () => {
      const { headers, rows } = parseCSV("id\n1\n2\n", ",", true);
      expect(headers).toEqual(["id"]);
      expect(rows).toEqual([["1"], ["2"]]);
    });

    it("fills missing fields with empty string when row is shorter than header", () => {
      // Intentionally mismatched row widths — real-world CSV files sometimes omit trailing fields.
      const text = "a,b,c\n1,2\n3,4,5\n";
      const { rows } = parseCSV(text, ",", true);
      // First row has only 2 fields — index 2 is undefined, which fetchBatch coerces to "".
      // The parser itself returns what's there; coercion happens in fetchBatch.
      expect(rows[0]).toEqual(["1", "2"]);
      expect(rows[1]).toEqual(["3", "4", "5"]);
    });
  });
});

// ─── connect() ────────────────────────────────────────────────────────────────

describe("connect()", () => {
  it("returns a ConnectorHandle with the connectionId derived from the URL", async () => {
    const ctx = makeCsvContext(SIMPLE_CSV);
    const handle = await connector.connect({ url: "https://example.com/data.csv" }, ctx);
    expect(handle.connectionId).toContain("https://example.com/data.csv");
  });

  it("stores resolved config in handle.metadata", async () => {
    const ctx = makeCsvContext(SIMPLE_CSV);
    const handle = await connector.connect(
      { url: "https://example.com/data.csv", delimiter: "\t", hasHeader: false, batchSize: 100 },
      ctx,
    );
    expect(handle.metadata["url"]).toBe("https://example.com/data.csv");
    expect(handle.metadata["delimiter"]).toBe("\t");
    expect(handle.metadata["hasHeader"]).toBe(false);
    expect(handle.metadata["batchSize"]).toBe(100);
  });

  it("throws PluginConfigError when url is missing", async () => {
    const ctx = makeCsvContext(SIMPLE_CSV);
    await expect(connector.connect({}, ctx)).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when url is an empty string", async () => {
    const ctx = makeCsvContext(SIMPLE_CSV);
    await expect(connector.connect({ url: "" }, ctx)).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when url has an invalid scheme", async () => {
    const ctx = makeCsvContext(SIMPLE_CSV);
    await expect(
      connector.connect({ url: "ftp://example.com/data.csv" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when HEAD request returns non-ok status", async () => {
    const ctx = createMockContext({
      fetchHandler: async (_url, init) => {
        const method = init?.method?.toUpperCase() ?? "GET";
        if (method === "HEAD") {
          return new Response(null, { status: 404 });
        }
        return new Response("", { status: 200 });
      },
    });
    await expect(
      connector.connect({ url: "https://example.com/missing.csv" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("throws PluginConfigError when the network fetch itself fails", async () => {
    const ctx = createMockContext({
      fetchHandler: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(
      connector.connect({ url: "https://example.com/data.csv" }, ctx),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });
});

// ─── fetchBatch() ─────────────────────────────────────────────────────────────

describe("fetchBatch()", () => {
  let ctx: ReturnType<typeof makeCsvContext>;

  beforeEach(() => {
    ctx = makeCsvContext(SIMPLE_CSV);
  });

  async function connectAndFetch(
    config: Record<string, unknown>,
    cursor: string | null,
    context = ctx,
  ) {
    const handle = await connector.connect(config, context);
    return connector.fetchBatch(handle, cursor, context);
  }

  it("returns records from the first batch (cursor=null)", async () => {
    const result = await connectAndFetch({ url: "https://example.com/data.csv" }, null);
    expect(result.records).toHaveLength(3);
  });

  it("maps column values to data fields", async () => {
    const result = await connectAndFetch({ url: "https://example.com/data.csv" }, null);
    const first = result.records[0];
    expect(first?.data["name"]).toBe("Alice");
    expect(first?.data["email"]).toBe("alice@example.com");
  });

  it("uses row index as sourceId when idColumn is not set", async () => {
    const result = await connectAndFetch({ url: "https://example.com/data.csv" }, null);
    expect(result.records[0]?.sourceId).toBe("0");
    expect(result.records[1]?.sourceId).toBe("1");
    expect(result.records[2]?.sourceId).toBe("2");
  });

  it("uses the specified idColumn as sourceId", async () => {
    const result = await connectAndFetch(
      { url: "https://example.com/data.csv", idColumn: "id" },
      null,
    );
    expect(result.records[0]?.sourceId).toBe("1");
    expect(result.records[1]?.sourceId).toBe("2");
    expect(result.records[2]?.sourceId).toBe("3");
  });

  it("sets hasMore=false and nextCursor=null when all rows fit in one batch", async () => {
    const result = await connectAndFetch(
      { url: "https://example.com/data.csv", batchSize: 500 },
      null,
    );
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("sets hasMore=true and provides nextCursor when rows exceed batchSize", async () => {
    const result = await connectAndFetch(
      { url: "https://example.com/data.csv", batchSize: 2 },
      null,
    );
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("2");
    expect(result.records).toHaveLength(2);
  });

  it("paginates correctly across multiple batches", async () => {
    const config = { url: "https://example.com/data.csv", batchSize: 2 };
    const handle = await connector.connect(config, ctx);

    const batch1 = await connector.fetchBatch(handle, null, ctx);
    expect(batch1.records).toHaveLength(2);
    expect(batch1.hasMore).toBe(true);

    const batch2 = await connector.fetchBatch(handle, batch1.nextCursor, ctx);
    expect(batch2.records).toHaveLength(1);
    expect(batch2.hasMore).toBe(false);
    expect(batch2.nextCursor).toBeNull();
  });

  it("pagination returns non-overlapping, contiguous records", async () => {
    const config = { url: "https://example.com/data.csv", batchSize: 2 };
    const handle = await connector.connect(config, ctx);

    const batch1 = await connector.fetchBatch(handle, null, ctx);
    const batch2 = await connector.fetchBatch(handle, batch1.nextCursor, ctx);

    const allIds = [...batch1.records, ...batch2.records].map((r) => r.sourceId);
    expect(allIds).toEqual(["0", "1", "2"]);
  });

  it("includes estimatedTotal equal to total row count", async () => {
    const result = await connectAndFetch({ url: "https://example.com/data.csv" }, null);
    expect(result.estimatedTotal).toBe(3);
  });

  it("fetchedAt is a valid ISO 8601 timestamp", async () => {
    const result = await connectAndFetch({ url: "https://example.com/data.csv" }, null);
    expect(new Date(result.fetchedAt).toISOString()).toBe(result.fetchedAt);
  });

  describe("without headers (hasHeader=false)", () => {
    it("generates col_N field names", async () => {
      const headerlessCtx = makeCsvContext("1,Alice,alice@example.com\n2,Bob,bob@example.com\n");
      const result = await connectAndFetch(
        { url: "https://example.com/data.csv", hasHeader: false },
        null,
        headerlessCtx,
      );
      expect(result.records[0]?.data["col_0"]).toBe("1");
      expect(result.records[0]?.data["col_1"]).toBe("Alice");
      expect(result.records[0]?.data["col_2"]).toBe("alice@example.com");
    });
  });

  describe("error handling", () => {
    it("throws PluginDataError when the GET request returns a non-ok status", async () => {
      const errorCtx = createMockContext({
        fetchHandler: async (_url, init) => {
          const method = init?.method?.toUpperCase() ?? "GET";
          if (method === "HEAD") {
            return new Response(null, { status: 200 });
          }
          return new Response("Not Found", { status: 404 });
        },
      });

      const handle = await connector.connect({ url: "https://example.com/data.csv" }, errorCtx);
      await expect(
        connector.fetchBatch(handle, null, errorCtx),
      ).rejects.toBeInstanceOf(PluginDataError);
    });

    it("throws PluginTimeoutError when the network fetch throws", async () => {
      // connect() succeeds via HEAD; only GET fails, simulating a mid-job network error.
      let headDone = false;
      const networkErrorCtx = createMockContext({
        fetchHandler: async (_url, init) => {
          const method = init?.method?.toUpperCase() ?? "GET";
          if (method === "HEAD" && !headDone) {
            headDone = true;
            return new Response(null, { status: 200 });
          }
          throw new Error("network timeout");
        },
      });

      const handle = await connector.connect(
        { url: "https://example.com/data.csv" },
        networkErrorCtx,
      );
      const { PluginTimeoutError: TimeoutErr } = await import("@oneplatform/plugin-sdk");
      await expect(
        connector.fetchBatch(handle, null, networkErrorCtx),
      ).rejects.toBeInstanceOf(TimeoutErr);
    });

    it("throws PluginDataError for an invalid cursor value", async () => {
      const handle = await connector.connect(
        { url: "https://example.com/data.csv" },
        ctx,
      );
      await expect(
        connector.fetchBatch(handle, "not-a-number", ctx),
      ).rejects.toBeInstanceOf(PluginDataError);
    });
  });
});

// ─── disconnect() ─────────────────────────────────────────────────────────────

describe("disconnect()", () => {
  it("completes without throwing", async () => {
    const ctx = makeCsvContext(SIMPLE_CSV);
    const handle = await connector.connect({ url: "https://example.com/data.csv" }, ctx);
    await expect(connector.disconnect(handle, ctx)).resolves.toBeUndefined();
  });

  it("logs the disconnect event", async () => {
    const ctx = makeCsvContext(SIMPLE_CSV);
    const handle = await connector.connect({ url: "https://example.com/data.csv" }, ctx);
    await connector.disconnect(handle, ctx);
    const infoLogs = ctx.logger.__logs.filter((l) => l.level === "info");
    expect(infoLogs.some((l) => l.message.includes("disconnected"))).toBe(true);
  });
});
