/**
 * All output rendering is encapsulated here.
 * Commands never write to stdout/stderr directly — they call ctx.output methods.
 * This allows tests to capture output without mocking process streams.
 */
import Table from "cli-table3";

export type OutputFormat = "table" | "json" | "jsonl" | "tsv";

export interface ColumnDef {
  /** Header label shown in table output */
  header: string;
  /** Key to read from each row object */
  key: string;
  /** Max column width before truncation (default 60) */
  maxWidth?: number;
}

export interface OutputRenderer {
  table(columns: ColumnDef[], rows: Record<string, unknown>[]): void;
  json(data: unknown): void;
  jsonl(data: unknown[]): void;
  tsv(columns: ColumnDef[], rows: Record<string, unknown>[]): void;
  /**
   * Auto-dispatch: table for TTY, json/jsonl for pipe.
   * If columns are provided, array data uses the table/tsv path.
   */
  render(data: unknown | unknown[], columns?: ColumnDef[]): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  success(message: string): void;
  /**
   * Writes a one-time secret (e.g. a freshly generated API key) directly to
   * stdout, bypassing the --quiet guard. The server never re-exposes these
   * values, so suppressing them would lose them permanently. Always use this —
   * not info() — for output the user cannot recover.
   */
  secret(message: string): void;
}

// ANSI color codes — avoids ESM-only chalk dependency
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  grey: "\x1b[90m",
  cyan: "\x1b[36m",
} as const;

function colorize(text: string, code: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${code}${text}${ANSI.reset}`;
}

/** Color-codes known status values for table output */
function colorizeStatus(value: string, enabled: boolean): string {
  const lower = value.toLowerCase();
  if (["active", "healthy", "completed", "deployed"].includes(lower)) {
    return colorize(value, ANSI.green, enabled);
  }
  if (["paused", "building", "degraded", "warning"].includes(lower)) {
    return colorize(value, ANSI.yellow, enabled);
  }
  if (["error", "failed", "unhealthy", "inactive"].includes(lower)) {
    return colorize(value, ANSI.red, enabled);
  }
  return value;
}

function truncate(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  return value.slice(0, maxWidth - 3) + "...";
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function createOutputRenderer(
  format: OutputFormat,
  quiet: boolean,
  noColor: boolean,
): OutputRenderer {
  const colorEnabled = !noColor && process.stdout.isTTY === true;

  function renderTable(columns: ColumnDef[], rows: Record<string, unknown>[]): void {
    if (quiet) return;
    const headers = columns.map((c) =>
      colorize(c.header.toUpperCase(), ANSI.bold, colorEnabled),
    );
    const t = new Table({
      head: headers,
      style: { head: [], border: [] },
      chars: {
        top: "─",
        "top-mid": "─",
        "top-left": "",
        "top-right": "",
        bottom: "─",
        "bottom-mid": "─",
        "bottom-left": "",
        "bottom-right": "",
        left: "",
        "left-mid": "",
        mid: "─",
        "mid-mid": "─",
        right: "",
        "right-mid": "",
        middle: "  ",
      },
    });

    for (const row of rows) {
      t.push(
        columns.map((col) => {
          const raw = stringify(row[col.key]);
          const maxW = col.maxWidth ?? 60;
          const cell = truncate(raw, maxW);
          // Heuristic: key named "status" or "state" gets color-coded
          if (col.key === "status" || col.key === "state") {
            return colorizeStatus(cell, colorEnabled);
          }
          return cell;
        }),
      );
    }

    process.stdout.write(t.toString() + "\n");
  }

  function renderJson(data: unknown): void {
    if (quiet) return;
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }

  function renderJsonl(data: unknown[]): void {
    if (quiet) return;
    for (const item of data) {
      process.stdout.write(JSON.stringify(item) + "\n");
    }
  }

  function renderTsv(columns: ColumnDef[], rows: Record<string, unknown>[]): void {
    if (quiet) return;
    // Header row so downstream tools (awk, cut, spreadsheets) know the field names
    const header = columns.map((c) => c.header).join("\t");
    process.stdout.write(header + "\n");
    for (const row of rows) {
      const line = columns.map((c) => stringify(row[c.key])).join("\t");
      process.stdout.write(line + "\n");
    }
  }

  return {
    table: renderTable,
    json: renderJson,
    jsonl: renderJsonl,
    tsv: renderTsv,

    render(data: unknown | unknown[], columns?: ColumnDef[]): void {
      if (quiet) return;
      const isArray = Array.isArray(data);

      if (format === "json") {
        renderJson(data);
      } else if (format === "jsonl" && isArray) {
        renderJsonl(data as unknown[]);
      } else if (format === "tsv" && columns && isArray) {
        renderTsv(columns, data as Record<string, unknown>[]);
      } else if (format === "table" && columns && isArray) {
        renderTable(columns, data as Record<string, unknown>[]);
      } else {
        // PU-015: Non-array data falls back to JSON regardless of the requested
        // format. This is intentional — table and TSV formats require an array
        // of rows with known column keys. If callers start returning single-object
        // responses for list commands this warning will surface the mismatch.
        if ((format === "table" || format === "tsv") && !isArray) {
          process.stderr.write(
            `WARNING: --format=${format} requires array data; falling back to JSON output.\n`,
          );
        }
        renderJson(data);
      }
    },

    error(message: string): void {
      const prefix = colorize("Error:", ANSI.red, colorEnabled);
      process.stderr.write(`${prefix} ${message}\n`);
    },

    warn(message: string): void {
      const prefix = colorize("WARNING:", ANSI.yellow, colorEnabled);
      process.stderr.write(`${prefix} ${message}\n`);
    },

    info(message: string): void {
      if (quiet) return;
      process.stdout.write(`${message}\n`);
    },

    success(message: string): void {
      if (quiet) return;
      const tick = colorize("✓", ANSI.green, colorEnabled);
      process.stdout.write(`${tick} ${message}\n`);
    },

    secret(message: string): void {
      // Intentionally NOT guarded by `quiet`: one-time secrets are never
      // re-exposed by the server, so suppressing them loses them forever.
      process.stdout.write(`${message}\n`);
    },
  };
}

/** Detect default output format based on TTY state and whether data is a list */
export function detectDefaultFormat(isList: boolean): OutputFormat {
  if (process.stdout.isTTY === true) return "table";
  return isList ? "jsonl" : "json";
}

/** Color-code log level for logs tail command */
export function colorizeLogLevel(level: string, noColor: boolean): string {
  const enabled = !noColor && process.stdout.isTTY === true;
  switch (level.toLowerCase()) {
    case "debug":
      return colorize(level, ANSI.grey, enabled);
    case "info":
      return level;
    case "warn":
    case "warning":
      return colorize(level, ANSI.yellow, enabled);
    case "error":
      return colorize(level, ANSI.red, enabled);
    default:
      return level;
  }
}
