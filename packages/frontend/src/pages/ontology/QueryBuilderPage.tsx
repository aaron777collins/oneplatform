/**
 * QueryBuilderPage — visual SQL query builder for ontology entity data.
 * Route: /ontology/query
 *
 * Users pick an entity type, choose columns, add WHERE conditions, group by
 * fields, configure ordering, set limit/offset, and run the query. Results
 * render in a paginated table, an interactive chart, or a SQL preview.
 * Queries can be saved to and loaded from localStorage.
 */
import React, { useState, useCallback, useId } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Plus, Trash2, Play, Download, ChevronLeft, ChevronRight,
  AlertCircle, X, BarChart3, LineChart as LineChartIcon,
  PieChart as PieChartIcon, Save, FolderOpen, Eye, Layers, Code, Calendar,
} from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { Badge } from "@/components/ui/badge.js";
import { Separator } from "@/components/ui/separator.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { useApiClient, ApiError, type PaginatedResponse } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { EntitySummary } from "@/components/ontology/EntityList.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;
const SAVED_QUERIES_KEY = "oneplatform:saved-queries";
const SCHEDULED_REPORTS_KEY = "oneplatform:scheduled-reports";

/** HSL chart palette — chosen for contrast and legibility on both light/dark themes. */
const CHART_COLORS = [
  "hsl(220, 70%, 50%)",
  "hsl(160, 60%, 45%)",
  "hsl(30, 80%, 55%)",
  "hsl(280, 60%, 55%)",
  "hsl(340, 70%, 55%)",
  "hsl(45, 80%, 50%)",
  "hsl(190, 70%, 45%)",
  "hsl(0, 65%, 50%)",
];

// ---------------------------------------------------------------------------
// Domain types (mirrors services/ontology/src/services/query-service.ts)
// ---------------------------------------------------------------------------

type WhereOperator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "like" | "in" | "not_in" | "is_null" | "is_not_null";

type AggregateFunction = "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";

type ResultViewTab = "table" | "chart" | "sql" | "pivot";
type ChartType = "bar" | "line" | "pie";

const OPERATOR_LABELS: Record<WhereOperator, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  gte: "greater than or equal to",
  lt: "less than",
  lte: "less than or equal to",
  like: "contains (pattern)",
  in: "is one of",
  not_in: "is not one of",
  is_null: "is empty",
  is_not_null: "is not empty",
};

const AGGREGATE_LABELS: Record<AggregateFunction, string> = {
  COUNT: "COUNT",
  SUM: "SUM",
  AVG: "AVG",
  MIN: "MIN",
  MAX: "MAX",
};

// Operators that do not take a value input
const NULLARY_OPERATORS = new Set<WhereOperator>(["is_null", "is_not_null"]);

interface WhereClauseUI {
  id: string;
  field: string;
  operator: WhereOperator;
  value: string;
}

interface OrderByUI {
  id: string;
  field: string;
  direction: "asc" | "desc";
}

interface GroupByUI {
  id: string;
  field: string;
  /** Set when the field is a date/timestamp type and the user wants date-level grouping. */
  dateGranularity?: DateGranularity;
}

// NCA-009: JOIN support
type JoinType = "INNER" | "LEFT" | "RIGHT";

interface JoinUI {
  id: string;
  joinType: JoinType;
  /** Slug of the entity type to join against. */
  joinEntityType: string;
  /** Field on the primary entity (left side of the condition). */
  leftField: string;
  /** Field on the joined entity (right side of the condition). */
  rightField: string;
}

interface AggregateUI {
  id: string;
  fn: AggregateFunction;
  field: string;
  alias: string;
}

/** A user-defined computed column expressed as a raw expression string (e.g. "price * quantity"). */
interface CalculatedFieldUI {
  id: string;
  /** Raw SQL-like expression the user types, e.g. "price * quantity" */
  expression: string;
  /** Column alias shown in results */
  alias: string;
}

interface StructuredQuery {
  entityType: string;
  select: string[];
  where?: Array<{ field: string; operator: WhereOperator; value?: unknown }>;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  groupBy?: string[];
  limit?: number;
  offset?: number;
}

interface QueryColumn {
  name: string;
  type: string;
}

interface QueryResult {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  totalCount: number;
  executionTimeMs: number;
}

interface EntityDetail {
  id: string;
  name: string;
  slug: string;
  fields: Array<{ slug: string; name: string; fieldType: string }>;
}

interface SavedQuery {
  name: string;
  entityType: string;
  selectedFields: string[];
  whereClauses: WhereClauseUI[];
  groupByClauses: GroupByUI[];
  orderByClauses: OrderByUI[];
  aggregates: AggregateUI[];
  calculatedFields: CalculatedFieldUI[];
  joins: JoinUI[];
  limitStr: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(): string {
  // crypto.randomUUID() is available in all modern browsers and avoids the
  // ~1-in-2^52 collision probability of the old Math.random approach.
  return crypto.randomUUID();
}

/** Parse a comma-separated string into an array for "in" / "not_in" operators. */
function parseArrayValue(raw: string): unknown {
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

/** Convert a WhereClauseUI to the wire format, coercing the value appropriately. */
function toWireWhereClause(
  clause: WhereClauseUI,
): { field: string; operator: WhereOperator; value?: unknown } {
  if (NULLARY_OPERATORS.has(clause.operator)) {
    return { field: clause.field, operator: clause.operator };
  }
  if (clause.operator === "in" || clause.operator === "not_in") {
    return { field: clause.field, operator: clause.operator, value: parseArrayValue(clause.value) };
  }
  return { field: clause.field, operator: clause.operator, value: clause.value };
}

/** Serialize query result rows to CSV text. */
function rowsToCsv(columns: QueryColumn[], rows: Record<string, unknown>[]): string {
  const header = columns.map((c) => JSON.stringify(c.name)).join(",");
  const dataRows = rows.map((row) =>
    columns
      .map((c) => {
        const v = row[c.name];
        if (v === null || v === undefined) return "";
        // S1: objects need exactly one level of JSON.stringify — no double-encoding
        if (typeof v === "object") return JSON.stringify(v);
        return JSON.stringify(String(v));
      })
      .join(","),
  );
  return [header, ...dataRows].join("\n");
}

/** Serialize query result rows to a pretty-printed JSON array. */
function rowsToJson(columns: QueryColumn[], rows: Record<string, unknown>[]): string {
  // Reconstruct row objects using only the queried column names so that the
  // exported shape is predictable regardless of what the API returns.
  const output = rows.map((row) => {
    const entry: Record<string, unknown> = {};
    for (const col of columns) {
      entry[col.name] = row[col.name] ?? null;
    }
    return entry;
  });
  return JSON.stringify(output, null, 2);
}

/** Download a string as a file via a synthetic anchor click. */
function downloadText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // The anchor must be in the DOM for Firefox to fire the download reliably.
  document.body.appendChild(a);
  a.click();
  // Revoke asynchronously so the browser has time to initiate the download
  // before the object URL is released.
  requestAnimationFrame(() => {
    a.remove();
    URL.revokeObjectURL(url);
  });
}

/**
 * Build a readable SQL-like preview string from the current query state.
 * This is intentionally simplified (not real SQL) — its purpose is to help
 * users understand what the structured query translates to.
 */
function buildSqlPreview(params: {
  entityType: string;
  selectedFields: Set<string>;
  aggregates: AggregateUI[];
  calculatedFields: CalculatedFieldUI[];
  whereClauses: WhereClauseUI[];
  groupByClauses: GroupByUI[];
  orderByClauses: OrderByUI[];
  joins: JoinUI[];
  limitStr: string;
}): string {
  const { entityType, selectedFields, aggregates, calculatedFields, whereClauses, groupByClauses, orderByClauses, joins, limitStr } = params;

  if (!entityType) return "-- Select an entity type to preview the query";

  const selectParts: string[] = [
    ...(selectedFields.size === 0 ? ["*"] : Array.from(selectedFields)),
    ...aggregates
      .filter((a) => a.field)
      .map((a) => {
        const expr = `${a.fn}(${a.field})`;
        return a.alias ? `${expr} AS ${a.alias}` : expr;
      }),
    ...calculatedFields
      .filter((c) => c.expression.trim())
      .map((c) => {
        const expr = c.expression.trim();
        return c.alias.trim() ? `${expr} AS ${c.alias.trim()}` : expr;
      }),
  ];

  const lines: string[] = [
    `SELECT ${selectParts.join(",\n       ")}`,
    `FROM   ${entityType}`,
  ];

  // NCA-009: JOIN clauses
  const activeJoins = joins.filter((j) => j.joinEntityType && j.leftField && j.rightField);
  for (const j of activeJoins) {
    lines.push(`${j.joinType} JOIN ${j.joinEntityType} ON ${j.leftField} = ${j.rightField}`);
  }

  const activeWhere = whereClauses.filter((c) => c.field);
  if (activeWhere.length > 0) {
    const conditions = activeWhere.map((c, i) => {
      const prefix = i === 0 ? "WHERE  " : "  AND  ";
      if (NULLARY_OPERATORS.has(c.operator)) {
        return `${prefix}${c.field} ${c.operator.toUpperCase().replace("_", " ")}`;
      }
      if (c.operator === "in" || c.operator === "not_in") {
        const vals = c.value.split(",").map((v) => `'${v.trim()}'`).join(", ");
        const op = c.operator === "in" ? "IN" : "NOT IN";
        return `${prefix}${c.field} ${op} (${vals})`;
      }
      const opMap: Partial<Record<WhereOperator, string>> = {
        eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE",
      };
      return `${prefix}${c.field} ${opMap[c.operator] ?? c.operator} '${c.value}'`;
    });
    lines.push(...conditions);
  }

  const activeGroupBy = groupByClauses.filter((g) => g.field);
  if (activeGroupBy.length > 0) {
    // NCA-010: Apply date_trunc when a date granularity is selected
    const groupByExprs = activeGroupBy.map((g) => {
      if (g.dateGranularity !== undefined) {
        const gran = DATE_GRANULARITY_OPTIONS.find((o) => o.value === g.dateGranularity);
        if (gran !== undefined) return gran.sqlExpr(g.field);
      }
      return g.field;
    });
    lines.push(`GROUP BY ${groupByExprs.join(", ")}`);
  }

  const activeOrderBy = orderByClauses.filter((o) => o.field);
  if (activeOrderBy.length > 0) {
    lines.push(`ORDER BY ${activeOrderBy.map((o) => `${o.field} ${o.direction.toUpperCase()}`).join(", ")}`);
  }

  const limit = parseInt(limitStr, 10);
  if (!isNaN(limit) && limit > 0) {
    lines.push(`LIMIT  ${Math.min(limit, 1000)}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// NCP-017: Column header formatting and cell value formatting
// ---------------------------------------------------------------------------

/**
 * Turn a raw column name (e.g. "created_at", "totalRevenue", "user_id") into
 * a human-readable header (e.g. "Created At", "Total Revenue", "User Id").
 */
function formatColumnHeader(rawName: string): string {
  // Split on underscores and camelCase word boundaries, then title-case each word.
  return rawName
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Patterns that indicate a column holds date/timestamp values. */
const DATE_COLUMN_PATTERN = /date|time|at|created|updated|timestamp/i;

/**
 * Format a cell value for display.
 * - Dates (ISO strings in date-like columns) → locale string
 * - Numbers → locale-formatted with thousands separators
 * - Booleans → symbolic checkmark or cross
 * - null/undefined → empty dash
 * - Objects → compact JSON
 */
function formatCellValue(value: unknown, columnName: string): { text: string; isBoolean?: boolean; boolValue?: boolean } {
  if (value === null || value === undefined) return { text: "—" };
  if (typeof value === "boolean") return { text: "", isBoolean: true, boolValue: value };
  if (typeof value === "number") return { text: value.toLocaleString() };

  if (typeof value === "string") {
    // Attempt date parsing only for columns with date-like names
    if (DATE_COLUMN_PATTERN.test(columnName)) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return { text: d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) };
      }
    }
    return { text: value };
  }

  if (typeof value === "object") return { text: JSON.stringify(value) };
  return { text: String(value) };
}

// ---------------------------------------------------------------------------
// NCA-010: Date granularity options for GROUP BY
// ---------------------------------------------------------------------------

type DateGranularity = "day" | "week" | "month" | "quarter" | "year";

const DATE_GRANULARITY_OPTIONS: Array<{ value: DateGranularity; label: string; sqlExpr: (field: string) => string }> = [
  { value: "day",     label: "Day",     sqlExpr: (f) => `DATE_TRUNC('day', ${f})` },
  { value: "week",    label: "Week",    sqlExpr: (f) => `DATE_TRUNC('week', ${f})` },
  { value: "month",   label: "Month",   sqlExpr: (f) => `DATE_TRUNC('month', ${f})` },
  { value: "quarter", label: "Quarter", sqlExpr: (f) => `DATE_TRUNC('quarter', ${f})` },
  { value: "year",    label: "Year",    sqlExpr: (f) => `DATE_TRUNC('year', ${f})` },
];

/**
 * Runtime guard for data coming out of localStorage. Dropping invalid entries
 * silently prevents a corrupt saved-query from crashing the page on load.
 */
function isValidSavedQuery(q: unknown): q is SavedQuery {
  if (typeof q !== "object" || q === null) return false;
  const obj = q as Record<string, unknown>;
  return (
    typeof obj["name"] === "string" &&
    typeof obj["entityType"] === "string" &&
    Array.isArray(obj["selectedFields"])
  );
}

/** Load saved queries from localStorage — returns empty array on parse failure. */
function loadSavedQueries(): SavedQuery[] {
  try {
    const raw = localStorage.getItem(SAVED_QUERIES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter out any entries that don't match the SavedQuery shape so that
    // data written by an older version of the app doesn't cause runtime errors.
    return parsed.filter(isValidSavedQuery);
  } catch {
    // Silently ignore malformed data — user can re-save
    return [];
  }
}

/** Persist the saved queries list to localStorage. */
function persistSavedQueries(queries: SavedQuery[]): void {
  localStorage.setItem(SAVED_QUERIES_KEY, JSON.stringify(queries));
}

// ---------------------------------------------------------------------------
// TagInput — reusable tag-style multi-value input for IN / NOT IN operators
// ---------------------------------------------------------------------------

function TagInput({
  values,
  onChange,
  placeholder,
  className,
  "aria-label": ariaLabel,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const [inputValue, setInputValue] = React.useState("");

  function addValue(val: string) {
    const trimmed = val.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setInputValue("");
  }

  function removeValue(val: string) {
    onChange(values.filter((v) => v !== val));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addValue(inputValue);
    } else if (e.key === "Backspace" && inputValue === "" && values.length > 0) {
      removeValue(values[values.length - 1]!);
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-1 rounded-md border border-[var(--color-input)] bg-[var(--color-background)] px-2 py-1 min-h-[36px] ${className ?? ""}`}
      aria-label={ariaLabel}
    >
      {values.map((val) => (
        <span
          key={val}
          className="inline-flex items-center gap-0.5 rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)] px-2 py-0.5 text-xs"
        >
          {val}
          <button
            type="button"
            onClick={() => removeValue(val)}
            className="ml-0.5 rounded-full hover:bg-[var(--color-primary)]/20 p-0.5"
            aria-label={`Remove ${val}`}
          >
            <X className="h-2.5 w-2.5" aria-hidden />
          </button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[80px] border-0 bg-transparent text-xs outline-none placeholder:text-[var(--color-muted-foreground)]"
        placeholder={values.length === 0 ? placeholder : ""}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (inputValue.trim()) addValue(inputValue); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: query builder rows
// ---------------------------------------------------------------------------

interface WhereClauseRowProps {
  clause: WhereClauseUI;
  fieldOptions: Array<{ slug: string; name: string }>;
  onChange: (updated: WhereClauseUI) => void;
  onRemove: () => void;
}

function WhereClauseRow({ clause, fieldOptions, onChange, onRemove }: WhereClauseRowProps) {
  const labelId = useId();
  const isNullary = NULLARY_OPERATORS.has(clause.operator);

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="sr-only">Where condition</span>

      <Select
        value={clause.field}
        onValueChange={(v) => onChange({ ...clause, field: v })}
      >
        <SelectTrigger className="w-full sm:w-40" aria-label="Field">
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {fieldOptions.map((f) => (
            <SelectItem key={f.slug} value={f.slug}>
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={clause.operator}
        onValueChange={(v) => onChange({ ...clause, operator: v as WhereOperator, value: "" })}
      >
        <SelectTrigger className="w-full sm:w-36" aria-label="Operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(OPERATOR_LABELS) as WhereOperator[]).map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {!isNullary && (clause.operator === "in" || clause.operator === "not_in" ? (
        <TagInput
          values={clause.value ? clause.value.split(",").map((v) => v.trim()).filter(Boolean) : []}
          onChange={(tags) => onChange({ ...clause, value: tags.join(", ") })}
          placeholder="Type a value and press Enter"
          aria-label="Values"
          className="w-full sm:w-48"
        />
      ) : (
        <Input
          className="w-full sm:w-48"
          placeholder="value"
          value={clause.value}
          onChange={(e) => onChange({ ...clause, value: e.target.value })}
          aria-label="Value"
        />
      ))}

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove condition"
        className="shrink-0 self-end sm:self-auto"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

interface GroupByRowProps {
  groupBy: GroupByUI;
  fieldOptions: Array<{ slug: string; name: string; fieldType?: string }>;
  onChange: (updated: GroupByUI) => void;
  onRemove: () => void;
}

function GroupByRow({ groupBy, fieldOptions, onChange, onRemove }: GroupByRowProps) {
  // Detect if the currently selected field is a date/timestamp type so we can
  // show the date granularity selector only when it makes sense.
  const selectedFieldMeta = fieldOptions.find((f) => f.slug === groupBy.field);
  const isDateField =
    selectedFieldMeta !== undefined &&
    (selectedFieldMeta.fieldType !== undefined
      ? /date|time|timestamp/i.test(selectedFieldMeta.fieldType)
      : DATE_COLUMN_PATTERN.test(groupBy.field));

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-wrap">
      <Select
        value={groupBy.field}
        onValueChange={(v) => { const { dateGranularity: _drop, ...rest } = groupBy; void _drop; onChange({ ...rest, field: v }); }}
      >
        <SelectTrigger className="w-full sm:w-40" aria-label="Group by field">
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {fieldOptions.map((f) => (
            <SelectItem key={f.slug} value={f.slug}>
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Date granularity selector — only shown for date/timestamp fields (NCA-010) */}
      {isDateField && (
        <Select
          value={groupBy.dateGranularity ?? ""}
          onValueChange={(v) =>
            onChange(v === "" ? (({ dateGranularity: _drop, ...rest }) => { void _drop; return rest; })(groupBy) : { ...groupBy, dateGranularity: v as DateGranularity })
          }
        >
          <SelectTrigger className="w-full sm:w-32" aria-label="Date granularity">
            <SelectValue placeholder="Granularity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">No grouping</SelectItem>
            {DATE_GRANULARITY_OPTIONS.map((g) => (
              <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove group"
        className="shrink-0 self-end sm:self-auto"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

interface CalculatedFieldRowProps {
  field: CalculatedFieldUI;
  onChange: (updated: CalculatedFieldUI) => void;
  onRemove: () => void;
}

function CalculatedFieldRow({ field, onChange, onRemove }: CalculatedFieldRowProps) {
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
      {/* Raw expression input */}
      <Input
        className="flex-1 font-mono text-xs"
        placeholder="Expression, e.g. price * quantity"
        value={field.expression}
        onChange={(e) => onChange({ ...field, expression: e.target.value })}
        aria-label="Calculated field expression"
      />

      {/* Column alias */}
      <Input
        className="w-full sm:w-36"
        placeholder="alias (required)"
        value={field.alias}
        onChange={(e) => onChange({ ...field, alias: e.target.value })}
        aria-label="Calculated field alias"
      />

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove calculated field"
        className="shrink-0 self-end sm:self-auto"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

interface AggregateRowProps {
  aggregate: AggregateUI;
  fieldOptions: Array<{ slug: string; name: string }>;
  onChange: (updated: AggregateUI) => void;
  onRemove: () => void;
}

function AggregateRow({ aggregate, fieldOptions, onChange, onRemove }: AggregateRowProps) {
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
      {/* Aggregate function */}
      <Select
        value={aggregate.fn}
        onValueChange={(v) => onChange({ ...aggregate, fn: v as AggregateFunction })}
      >
        <SelectTrigger className="w-full sm:w-28" aria-label="Aggregate function">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(AGGREGATE_LABELS) as AggregateFunction[]).map((fn) => (
            <SelectItem key={fn} value={fn}>
              {AGGREGATE_LABELS[fn]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Field to aggregate */}
      <Select
        value={aggregate.field}
        onValueChange={(v) => onChange({ ...aggregate, field: v })}
      >
        <SelectTrigger className="w-full sm:w-40" aria-label="Field to aggregate">
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {/* COUNT(*) makes sense — keep the star as an option */}
          <SelectItem value="*">* (all rows)</SelectItem>
          {fieldOptions.map((f) => (
            <SelectItem key={f.slug} value={f.slug}>
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Optional alias */}
      <Input
        className="w-full sm:w-36"
        placeholder="alias (optional)"
        value={aggregate.alias}
        onChange={(e) => onChange({ ...aggregate, alias: e.target.value })}
        aria-label="Column alias"
      />

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove aggregate"
        className="shrink-0"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NCA-009: JOIN row component
// ---------------------------------------------------------------------------

const JOIN_TYPES: JoinType[] = ["INNER", "LEFT", "RIGHT"];

interface JoinRowProps {
  join: JoinUI;
  primaryFieldOptions: Array<{ slug: string; name: string }>;
  availableEntityTypes: Array<{ slug: string; name: string }>;
  onJoinEntityChange: (joinId: string, entitySlug: string) => void;
  joinedFieldOptions: Array<{ slug: string; name: string }>;
  onChange: (updated: JoinUI) => void;
  onRemove: () => void;
}

function JoinRow({ join, primaryFieldOptions, availableEntityTypes, joinedFieldOptions, onChange, onRemove }: JoinRowProps) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/20 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Join type */}
        <Select
          value={join.joinType}
          onValueChange={(v) => onChange({ ...join, joinType: v as JoinType })}
        >
          <SelectTrigger className="w-28" aria-label="Join type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {JOIN_TYPES.map((jt) => (
              <SelectItem key={jt} value={jt}>{jt} JOIN</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Join entity type */}
        <Select
          value={join.joinEntityType}
          onValueChange={(v) => onChange({ ...join, joinEntityType: v, rightField: "" })}
        >
          <SelectTrigger className="w-40" aria-label="Join entity">
            <SelectValue placeholder="Entity" />
          </SelectTrigger>
          <SelectContent>
            {availableEntityTypes.map((e) => (
              <SelectItem key={e.slug} value={e.slug}>{e.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label="Remove join"
          className="ml-auto shrink-0"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {/* Join condition: left field = right field */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
        <span className="font-medium">ON</span>

        <Select
          value={join.leftField}
          onValueChange={(v) => onChange({ ...join, leftField: v })}
        >
          <SelectTrigger className="w-36 h-8" aria-label="Left join field">
            <SelectValue placeholder="Left field" />
          </SelectTrigger>
          <SelectContent>
            {primaryFieldOptions.map((f) => (
              <SelectItem key={f.slug} value={f.slug}>{f.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span>=</span>

        <Select
          value={join.rightField}
          onValueChange={(v) => onChange({ ...join, rightField: v })}
          disabled={join.joinEntityType === ""}
        >
          <SelectTrigger className="w-36 h-8" aria-label="Right join field">
            <SelectValue placeholder="Right field" />
          </SelectTrigger>
          <SelectContent>
            {joinedFieldOptions.map((f) => (
              <SelectItem key={f.slug} value={f.slug}>{f.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NCA-009: JoinRowContainer — fetches the joined entity's fields
// ---------------------------------------------------------------------------

interface JoinRowContainerProps {
  join: JoinUI;
  primaryFieldOptions: Array<{ slug: string; name: string }>;
  availableEntityTypes: Array<{ slug: string; name: string }>;
  onChange: (updated: JoinUI) => void;
  onRemove: () => void;
}

/**
 * Wraps JoinRow and owns the useQuery that loads the fields of the joined
 * entity. Rendering this as a dedicated component (one per join row) keeps each
 * hook call bound to a stable component instance, so the parent page's hook
 * count never changes as joins are added or removed.
 */
function JoinRowContainer({ join, primaryFieldOptions, availableEntityTypes, onChange, onRemove }: JoinRowContainerProps) {
  const client = useApiClient();

  const { data: joinedEntityData } = useQuery({
    queryKey: ["ontology", join.joinEntityType],
    queryFn: () =>
      client.get<{ data: EntityDetail }>(`/v1/ontology/${join.joinEntityType}`),
    enabled: join.joinEntityType !== "",
  });

  const joinedEntity =
    (joinedEntityData as unknown as { data?: { data: EntityDetail } })?.data?.data ??
    (joinedEntityData as { data: EntityDetail } | undefined)?.data;

  const joinedFieldOptions: Array<{ slug: string; name: string }> = joinedEntity
    ? [
        { slug: "_id", name: "_id (system)" },
        { slug: "_created_at", name: "_created_at (system)" },
        { slug: "_updated_at", name: "_updated_at (system)" },
        ...joinedEntity.fields.map((f) => ({ slug: f.slug, name: f.name })),
      ]
    : [];

  return (
    <JoinRow
      join={join}
      primaryFieldOptions={primaryFieldOptions}
      availableEntityTypes={availableEntityTypes}
      onJoinEntityChange={(joinId, entitySlug) =>
        onChange({ ...join, id: joinId, joinEntityType: entitySlug, rightField: "" })
      }
      joinedFieldOptions={joinedFieldOptions}
      onChange={onChange}
      onRemove={onRemove}
    />
  );
}

interface OrderByRowProps {
  orderBy: OrderByUI;
  fieldOptions: Array<{ slug: string; name: string }>;
  onChange: (updated: OrderByUI) => void;
  onRemove: () => void;
}

function OrderByRow({ orderBy, fieldOptions, onChange, onRemove }: OrderByRowProps) {
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
      <Select
        value={orderBy.field}
        onValueChange={(v) => onChange({ ...orderBy, field: v })}
      >
        <SelectTrigger className="w-full sm:w-40" aria-label="Order by field">
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {fieldOptions.map((f) => (
            <SelectItem key={f.slug} value={f.slug}>
              {f.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={orderBy.direction}
        onValueChange={(v) => onChange({ ...orderBy, direction: v as "asc" | "desc" })}
      >
        <SelectTrigger className="w-full sm:w-28" aria-label="Direction">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="asc">Ascending</SelectItem>
          <SelectItem value="desc">Descending</SelectItem>
        </SelectContent>
      </Select>

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove order"
        className="shrink-0 self-end sm:self-auto"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// QueryResultTable — renders columns + paginated rows
// ---------------------------------------------------------------------------

interface QueryResultTableProps {
  result: QueryResult;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

function QueryResultTable({ result, page, pageSize, onPageChange }: QueryResultTableProps) {
  const totalPages = Math.max(1, Math.ceil(result.totalCount / pageSize));

  return (
    <div className="space-y-3">
      {/* Stats bar */}
      <div className="flex items-center justify-between text-sm text-[var(--color-muted-foreground)]">
        <span>
          {result.totalCount.toLocaleString()} row{result.totalCount !== 1 ? "s" : ""}
          {" "}&middot; {result.executionTimeMs}ms
        </span>
        <span>
          Page {page + 1} of {totalPages}
        </span>
      </div>

      {/* Data table */}
      <div className="rounded-md border border-[var(--color-border)] overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {result.columns.map((col) => (
                // NCP-017: human-readable header (capitalize, no underscores)
                // with the raw type retained in a smaller badge for power users
                <TableHead key={col.name} className="text-xs whitespace-nowrap">
                  {formatColumnHeader(col.name)}
                  <Badge variant="outline" className="ml-1.5 text-[10px] py-0 font-mono">
                    {col.type}
                  </Badge>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={result.columns.length || 1}
                  className="text-center text-[var(--color-muted-foreground)] py-8"
                >
                  No rows returned.
                </TableCell>
              </TableRow>
            ) : (
              result.rows.map((row, rowIdx) => (
                // rowIdx is stable within a page result set — key is acceptable here
                <TableRow key={rowIdx}>
                  {result.columns.map((col) => {
                    const formatted = formatCellValue(row[col.name], col.name);
                    return (
                      <TableCell key={col.name} className="text-xs whitespace-nowrap max-w-xs truncate">
                        {formatted.isBoolean === true ? (
                          // NCP-017: boolean values rendered as checkmark/cross icons
                          <span
                            aria-label={formatted.boolValue === true ? "True" : "False"}
                            className={formatted.boolValue === true
                              ? "text-emerald-600 font-bold"
                              : "text-red-500 font-bold"}
                          >
                            {formatted.boolValue === true ? "✓" : "✗"}
                          </span>
                        ) : (
                          formatted.text
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page === 0}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages - 1}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChartVisualization — renders result data as bar / line / pie chart
// ---------------------------------------------------------------------------

interface ChartConfig {
  chartType: ChartType;
  xField: string;
  yFields: string[];
}

interface ChartVisualizationProps {
  result: QueryResult;
  config: ChartConfig;
  onConfigChange: (cfg: ChartConfig) => void;
}

function ChartVisualization({ result, config, onConfigChange }: ChartVisualizationProps) {
  const numericColumns = result.columns.filter((c) =>
    // Treat columns that look numeric as candidates for Y axis.
    // The backend returns type strings like "integer", "float", "number".
    /int|float|num|double|decimal|count|sum|avg|min|max/i.test(c.type) ||
    // Fallback: if type is unknown, check whether first non-null value parses as number.
    result.rows.some((r) => {
      const v = r[c.name];
      return v !== null && v !== undefined && !isNaN(Number(v));
    }),
  );

  const allColumnNames = result.columns.map((c) => c.name);

  const chartData = result.rows.map((row) => {
    const entry: Record<string, string | number> = {};
    allColumnNames.forEach((name) => {
      const v = row[name];
      if (v === null || v === undefined) {
        entry[name] = "";
      } else {
        const num = Number(v);
        entry[name] = isNaN(num) ? String(v) : num;
      }
    });
    return entry;
  });

  const xField = config.xField || allColumnNames[0] || "";
  const yFields = config.yFields.length > 0 ? config.yFields : (numericColumns[0] ? [numericColumns[0].name] : []);

  function toggleYField(name: string) {
    const next = config.yFields.includes(name)
      ? config.yFields.filter((f) => f !== name)
      : [...config.yFields, name];
    onConfigChange({ ...config, yFields: next });
  }

  return (
    <div className="space-y-4">
      {/* Chart config controls */}
      <div className="flex flex-wrap items-end gap-4">
        {/* Chart type */}
        <div className="space-y-1">
          <Label className="text-xs text-[var(--color-muted-foreground)]">Chart type</Label>
          <div className="flex gap-1" role="group" aria-label="Chart type">
            {(["bar", "line", "pie"] as ChartType[]).map((type) => {
              const Icon = type === "bar" ? BarChart3 : type === "line" ? LineChartIcon : PieChartIcon;
              return (
                <Button
                  key={type}
                  variant={config.chartType === type ? "default" : "outline"}
                  size="sm"
                  onClick={() => onConfigChange({ ...config, chartType: type })}
                  aria-pressed={config.chartType === type}
                  aria-label={`${type} chart`}
                >
                  <Icon className="h-3.5 w-3.5 mr-1" aria-hidden />
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </Button>
              );
            })}
          </div>
        </div>

        {/* X axis — not applicable for pie in the same way, but still useful as the label */}
        <div className="space-y-1">
          <Label className="text-xs text-[var(--color-muted-foreground)]">
            {config.chartType === "pie" ? "Label field" : "X axis"}
          </Label>
          <Select
            value={xField}
            onValueChange={(v) => onConfigChange({ ...config, xField: v })}
          >
            <SelectTrigger className="w-40" aria-label="X axis field">
              <SelectValue placeholder="Select field" />
            </SelectTrigger>
            <SelectContent>
              {allColumnNames.map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Y axis / value field(s) */}
        <div className="space-y-1">
          <Label className="text-xs text-[var(--color-muted-foreground)]">
            {config.chartType === "pie" ? "Value field" : "Y axis fields"}
          </Label>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Y axis fields">
            {result.columns
              .filter((c) => c.name !== xField)
              .map((col) => {
                const isSelected = config.yFields.includes(col.name) || (config.yFields.length === 0 && col.name === yFields[0]);
                return (
                  <button
                    key={col.name}
                    type="button"
                    onClick={() => toggleYField(col.name)}
                    className={[
                      "inline-flex items-center px-2 py-1 rounded border text-xs transition-colors",
                      isSelected
                        ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)]"
                        : "border-[var(--color-border)] hover:bg-[var(--color-accent)]",
                    ].join(" ")}
                    aria-pressed={isSelected}
                    aria-label={`Toggle ${col.name} as Y axis`}
                  >
                    {col.name}
                  </button>
                );
              })}
          </div>
        </div>
      </div>

      {/* Chart render area */}
      {chartData.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No data to chart.</p>
      ) : (
        <div className="w-full h-72">
          <ResponsiveContainer width="100%" height="100%">
            {config.chartType === "pie" ? (
              <PieChart>
                <Pie
                  data={chartData}
                  dataKey={yFields[0] ?? ""}
                  nameKey={xField}
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={({ name, percent }) =>
                    `${String(name)} (${(percent * 100).toFixed(1)}%)`
                  }
                >
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            ) : config.chartType === "line" ? (
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                {yFields.map((field, i) => (
                  <Line
                    key={field}
                    type="monotone"
                    dataKey={field}
                    stroke={CHART_COLORS[i % CHART_COLORS.length]}
                    dot={false}
                    strokeWidth={2}
                  />
                ))}
              </LineChart>
            ) : (
              /* Default: bar chart */
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                {yFields.map((field, i) => (
                  <Bar
                    key={field}
                    dataKey={field}
                    fill={CHART_COLORS[i % CHART_COLORS.length]}
                    radius={[2, 2, 0, 0]}
                  />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PivotTable — client-side cross-tabulation of query results (NCA-012)
// ---------------------------------------------------------------------------

type PivotAggFn = "count" | "sum" | "avg" | "min" | "max";

interface PivotConfig {
  rowField: string;
  colField: string;
  valueField: string;
  aggFn: PivotAggFn;
}

interface PivotTableProps {
  result: QueryResult;
  config: PivotConfig;
  onConfigChange: (cfg: PivotConfig) => void;
}

function applyPivotAgg(values: number[], fn: PivotAggFn): number | null {
  if (values.length === 0) return null;
  switch (fn) {
    case "count": return values.length;
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
  }
}

function PivotTable({ result, config, onConfigChange }: PivotTableProps) {
  const columns = result.columns.map((c) => c.name);

  // Derive the pivot cross-tabulation from the raw rows.
  // For performance we keep this inside a useMemo — recomputing only when
  // the result rows or config changes.
  const pivotData = React.useMemo(() => {
    if (!config.rowField || !config.colField || !config.valueField) return null;

    // Collect all unique column values for the pivot header
    const colValues = new Set<string>();
    for (const row of result.rows) {
      const cv = row[config.colField];
      if (cv !== null && cv !== undefined) colValues.add(String(cv));
    }
    const colHeaders = Array.from(colValues).sort();

    // Group by (rowField, colField) → array of valueField numbers
    const cells = new Map<string, Map<string, number[]>>();
    const rowKeys = new Set<string>();

    for (const row of result.rows) {
      const rk = String(row[config.rowField] ?? "(empty)");
      const ck = String(row[config.colField] ?? "(empty)");
      rowKeys.add(rk);

      if (!cells.has(rk)) cells.set(rk, new Map());
      const colMap = cells.get(rk)!;
      if (!colMap.has(ck)) colMap.set(ck, []);
      const rawVal = row[config.valueField];
      const n = Number(rawVal);
      if (!Number.isNaN(n)) colMap.get(ck)!.push(n);
    }

    const rowHeaders = Array.from(rowKeys).sort();
    return { rowHeaders, colHeaders, cells };
  }, [result.rows, config.rowField, config.colField, config.valueField]);

  const formatPivotCell = (v: number | null): string => {
    if (v === null) return "";
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  };

  return (
    <div className="space-y-4">
      {/* Config row */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-[var(--color-muted-foreground)]">Row field</Label>
          <Select
            value={config.rowField}
            onValueChange={(v) => onConfigChange({ ...config, rowField: v })}
          >
            <SelectTrigger className="w-36 h-8">
              <SelectValue placeholder="Row" />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-[var(--color-muted-foreground)]">Column field</Label>
          <Select
            value={config.colField}
            onValueChange={(v) => onConfigChange({ ...config, colField: v })}
          >
            <SelectTrigger className="w-36 h-8">
              <SelectValue placeholder="Column" />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-[var(--color-muted-foreground)]">Value field</Label>
          <Select
            value={config.valueField}
            onValueChange={(v) => onConfigChange({ ...config, valueField: v })}
          >
            <SelectTrigger className="w-36 h-8">
              <SelectValue placeholder="Value" />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-[var(--color-muted-foreground)]">Aggregation</Label>
          <Select
            value={config.aggFn}
            onValueChange={(v) => onConfigChange({ ...config, aggFn: v as PivotAggFn })}
          >
            <SelectTrigger className="w-28 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="count">Count</SelectItem>
              <SelectItem value="sum">Sum</SelectItem>
              <SelectItem value="avg">Average</SelectItem>
              <SelectItem value="min">Min</SelectItem>
              <SelectItem value="max">Max</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Pivot table output */}
      {!pivotData ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Select a row field, column field, and value field to build the pivot table.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]/40">
                <th className="px-3 py-2 text-left font-medium text-[var(--color-foreground)]">
                  {config.rowField}
                </th>
                {pivotData.colHeaders.map((col) => (
                  <th key={col} className="px-3 py-2 text-right font-medium text-[var(--color-foreground)]">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pivotData.rowHeaders.map((rk, ri) => (
                <tr
                  key={rk}
                  className={ri % 2 === 0 ? "" : "bg-[var(--color-muted)]/20"}
                >
                  <td className="px-3 py-2 font-medium text-[var(--color-foreground)]">{rk}</td>
                  {pivotData.colHeaders.map((ck) => {
                    const nums = pivotData.cells.get(rk)?.get(ck) ?? [];
                    const val = applyPivotAgg(nums, config.aggFn);
                    return (
                      <td
                        key={ck}
                        className="px-3 py-2 text-right tabular-nums text-[var(--color-muted-foreground)]"
                      >
                        {formatPivotCell(val)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SqlPreview — read-only syntax-highlighted SQL preview block
// ---------------------------------------------------------------------------

interface SqlPreviewProps {
  sql: string;
}

/**
 * HTML-escape raw text before it is inserted via dangerouslySetInnerHTML.
 * Must run BEFORE the keyword-highlighting regex so that user-supplied data
 * (field slugs, alias names, values) cannot inject markup.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function SqlPreview({ sql }: SqlPreviewProps) {
  // Minimal keyword highlighting — avoids adding a syntax-highlight dependency.
  // We wrap SQL keywords in styled spans after HTML-escaping the whole string.
  const SQL_KEYWORDS = /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|GROUP BY|ORDER BY|LIMIT|AS|ASC|DESC|LIKE)\b/g;

  // Escape first so that any user-supplied field slugs or values containing
  // '<', '>', or '"' cannot break out of the text context into markup.
  const escaped = escapeHtml(sql);
  const highlighted = escaped.replace(SQL_KEYWORDS, (kw) =>
    `<span style="color:hsl(220,70%,50%);font-weight:600">${kw}</span>`,
  );

  return (
    <div className="relative">
      <pre
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-4 text-xs font-mono overflow-x-auto text-[var(--color-foreground)] leading-relaxed"
        aria-label="SQL preview"
        // Safe: the sql string is HTML-escaped before the keyword regex runs,
        // so no user-supplied data can appear as raw HTML.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SavedQueriesPanel — save / load query configurations in localStorage
// ---------------------------------------------------------------------------

interface SavedQueriesPanelProps {
  currentQuery: Omit<SavedQuery, "name">;
  onLoad: (query: SavedQuery) => void;
}

function SavedQueriesPanel({ currentQuery, onLoad }: SavedQueriesPanelProps) {
  const [savedQueries, setSavedQueries] = React.useState<SavedQuery[]>(() => loadSavedQueries());
  const [saveName, setSaveName] = React.useState("");

  function handleSave() {
    const trimmed = saveName.trim();
    if (!trimmed) {
      toast({ title: "Enter a name for the saved query", variant: "destructive" });
      return;
    }
    const next = [
      // Replace any existing query with the same name
      ...savedQueries.filter((q) => q.name !== trimmed),
      { ...currentQuery, name: trimmed },
    ];
    persistSavedQueries(next);
    setSavedQueries(next);
    setSaveName("");
    toast({ title: `Query "${trimmed}" saved` });
  }

  function handleDelete(name: string) {
    const next = savedQueries.filter((q) => q.name !== name);
    persistSavedQueries(next);
    setSavedQueries(next);
    toast({ title: `Query "${name}" deleted` });
  }

  return (
    <div className="space-y-3">
      {/* Save current query */}
      <div className="flex gap-2">
        <Input
          placeholder="Query name…"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          aria-label="Saved query name"
          className="max-w-xs"
        />
        <Button size="sm" onClick={handleSave} disabled={!saveName.trim()}>
          <Save className="h-3.5 w-3.5 mr-1" aria-hidden />
          Save
        </Button>
      </div>

      {/* List of saved queries */}
      {savedQueries.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No saved queries yet.</p>
      ) : (
        <ul className="space-y-1" aria-label="Saved queries">
          {savedQueries.map((q) => (
            <li key={q.name} className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] px-3 py-2 text-sm">
              <span className="font-medium truncate">{q.name}</span>
              <span className="text-xs text-[var(--color-muted-foreground)] shrink-0">
                {q.entityType}
              </span>
              <div className="flex gap-1 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onLoad(q)}
                  aria-label={`Load query ${q.name}`}
                >
                  <FolderOpen className="h-3.5 w-3.5 mr-1" aria-hidden />
                  Load
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(q.name)}
                  aria-label={`Delete query ${q.name}`}
                  className="text-[var(--color-destructive)] hover:text-[var(--color-destructive)]"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScheduleReportDialog — schedule a saved query to run on a recurring cadence
// ---------------------------------------------------------------------------

type ReportFrequency = "daily" | "weekly" | "monthly";
type ReportFormat = "csv" | "json";

interface ScheduledReport {
  id: string;
  queryName: string;
  /** Snapshot of the query at scheduling time */
  query: Omit<SavedQuery, "name">;
  frequency: ReportFrequency;
  recipients: string;
  format: ReportFormat;
  createdAt: string;
}

function loadScheduledReports(): ScheduledReport[] {
  try {
    const raw = localStorage.getItem(SCHEDULED_REPORTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScheduledReport[]) : [];
  } catch {
    return [];
  }
}

function persistScheduledReports(reports: ScheduledReport[]): void {
  localStorage.setItem(SCHEDULED_REPORTS_KEY, JSON.stringify(reports));
}

interface ScheduleReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queryName: string;
  currentQuery: Omit<SavedQuery, "name">;
}

function ScheduleReportDialog({ open, onOpenChange, queryName, currentQuery }: ScheduleReportDialogProps) {
  const [frequency, setFrequency] = React.useState<ReportFrequency>("daily");
  const [recipients, setRecipients] = React.useState("");
  const [format, setFormat] = React.useState<ReportFormat>("csv");

  function handleSchedule() {
    const trimmedRecipients = recipients.trim();
    if (!trimmedRecipients) {
      toast({ title: "Enter at least one email recipient", variant: "destructive" });
      return;
    }

    const existing = loadScheduledReports();
    const newReport: ScheduledReport = {
      id: crypto.randomUUID(),
      queryName,
      query: currentQuery,
      frequency,
      recipients: trimmedRecipients,
      format,
      createdAt: new Date().toISOString(),
    };
    persistScheduledReports([...existing, newReport]);

    toast({
      title: "Report scheduled",
      description: `"${queryName}" will run ${frequency} and be sent to ${trimmedRecipients}.`,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule report</DialogTitle>
          <DialogDescription>
            Set up a recurring report for{" "}
            <span className="font-semibold">{queryName || "this query"}</span>.
            The configuration is saved locally and would be sent to the scheduling API.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="sched-frequency" className="text-sm">Frequency</Label>
            <Select
              value={frequency}
              onValueChange={(v) => setFrequency(v as ReportFrequency)}
            >
              <SelectTrigger id="sched-frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sched-recipients" className="text-sm">Email recipients</Label>
            <Input
              id="sched-recipients"
              type="text"
              placeholder="alice@example.com, bob@example.com"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Comma-separated list of email addresses.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sched-format" className="text-sm">Export format</Label>
            <Select
              value={format}
              onValueChange={(v) => setFormat(v as ReportFormat)}
            >
              <SelectTrigger id="sched-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="json">JSON</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSchedule}>
            <Calendar className="h-4 w-4 mr-1.5" aria-hidden />
            Schedule report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// QueryBuilderPage — main page component
// ---------------------------------------------------------------------------

export function QueryBuilderPage() {
  const client = useApiClient();
  const navigate = useNavigate();

  // --- Entity type selection ---
  const [selectedEntityType, setSelectedEntityType] = useState<string>("");

  // --- Field selection (checkboxes) ---
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());

  // --- WHERE clauses ---
  const [whereClauses, setWhereClauses] = useState<WhereClauseUI[]>([]);

  // --- GROUP BY ---
  const [groupByClauses, setGroupByClauses] = useState<GroupByUI[]>([]);

  // --- Aggregate functions (only meaningful when groupBy is active) ---
  const [aggregates, setAggregates] = useState<AggregateUI[]>([]);

  // --- Calculated fields (user-defined expressions in the SELECT clause) ---
  const [calculatedFields, setCalculatedFields] = useState<CalculatedFieldUI[]>([]);

  // --- JOINs (NCA-009) ---
  const [joins, setJoins] = useState<JoinUI[]>([]);

  // --- SQL Mode: when true the user edits raw SQL instead of the visual builder ---
  const [sqlMode, setSqlMode] = useState(false);
  // Holds the text in the SQL Mode textarea, initialised from the visual builder preview.
  const [rawSql, setRawSql] = useState("");

  // --- ORDER BY ---
  const [orderByClauses, setOrderByClauses] = useState<OrderByUI[]>([]);

  // --- Limit / Offset ---
  const [limitStr, setLimitStr] = useState<string>("100");
  const [page, setPage] = useState(0);

  // --- Results view tabs: table / chart / sql ---
  const [resultTab, setResultTab] = useState<ResultViewTab>("table");

  // --- Chart config ---
  const [chartConfig, setChartConfig] = useState<ChartConfig>({
    chartType: "bar",
    xField: "",
    yFields: [],
  });

  // --- Pivot config ---
  const [pivotConfig, setPivotConfig] = useState<PivotConfig>({
    rowField: "",
    colField: "",
    valueField: "",
    aggFn: "count",
  });

  // --- Saved queries panel visibility ---
  const [showSavedQueries, setShowSavedQueries] = useState(false);

  // --- Schedule report dialog ---
  const [showScheduleReport, setShowScheduleReport] = useState(false);

  // --- Query results ---
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);

  // --- Fetch entity list for the dropdown ---
  const { data: entityListData, isLoading: isLoadingEntities } = useQuery({
    queryKey: ["ontology"],
    queryFn: () => client.get<PaginatedResponse<EntitySummary>>("/v1/ontology"),
  });

  // --- Fetch entity detail (fields) when an entity type is selected ---
  const { data: entityDetailData, isLoading: isLoadingFields } = useQuery({
    queryKey: ["ontology", selectedEntityType],
    queryFn: () =>
      client.get<{ data: EntityDetail }>(`/v1/ontology/${selectedEntityType}`),
    enabled: selectedEntityType !== "",
  });

  const entityListInner = (entityListData as unknown as { data?: PaginatedResponse<EntitySummary> & { items?: EntitySummary[] } })?.data ?? entityListData;
  const entityList: EntitySummary[] = Array.isArray(entityListInner?.data) ? entityListInner.data : ((entityListInner as { items?: EntitySummary[] })?.items ?? []);
  const entityDetail = (entityDetailData as unknown as { data?: { data: EntityDetail } })?.data?.data ?? (entityDetailData as { data: EntityDetail } | undefined)?.data;

  const fieldOptions: Array<{ slug: string; name: string; fieldType?: string }> = entityDetail
    ? [
        { slug: "_id", name: "_id (system)", fieldType: "uuid" },
        { slug: "_created_at", name: "_created_at (system)", fieldType: "timestamp" },
        { slug: "_updated_at", name: "_updated_at (system)", fieldType: "timestamp" },
        ...entityDetail.fields.map((f) => ({ slug: f.slug, name: f.name, fieldType: f.fieldType })),
      ]
    : [];

  // When entity detail loads, initialize selectedFields to all field slugs so
  // the visual "all checked" state matches the actual selection state.
  React.useEffect(() => {
    if (fieldOptions.length > 0 && selectedFields.size === 0) {
      setSelectedFields(new Set(fieldOptions.map((f) => f.slug)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldOptions.length]);

  // Reset chart config when results arrive so the axis defaults pick up the new columns.
  const resetChartConfig = useCallback(() => {
    setChartConfig({ chartType: "bar", xField: "", yFields: [] });
  }, []);

  // --- Entity type change resets all query state ---
  const handleEntityTypeChange = useCallback((slug: string) => {
    setSelectedEntityType(slug);
    setSelectedFields(new Set());
    setWhereClauses([]);
    setGroupByClauses([]);
    setAggregates([]);
    setCalculatedFields([]);
    setJoins([]);
    setOrderByClauses([]);
    setQueryResult(null);
    setPage(0);
    setSqlMode(false);
    setRawSql("");
    resetChartConfig();
  }, [resetChartConfig]);

  const toggleField = useCallback((slug: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }, []);

  const toggleAllFields = useCallback(() => {
    setSelectedFields((prev) => {
      if (prev.size === fieldOptions.length) {
        return new Set();
      }
      return new Set(fieldOptions.map((f) => f.slug));
    });
  }, [fieldOptions]);

  // --- WHERE clause mutations ---
  const addWhereClause = useCallback(() => {
    const firstField = fieldOptions[0]?.slug ?? "";
    setWhereClauses((prev) => [
      ...prev,
      { id: makeId(), field: firstField, operator: "eq", value: "" },
    ]);
  }, [fieldOptions]);

  const updateWhereClause = useCallback((id: string, updated: WhereClauseUI) => {
    setWhereClauses((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const removeWhereClause = useCallback((id: string) => {
    setWhereClauses((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // --- GROUP BY mutations ---
  const addGroupBy = useCallback(() => {
    const firstField = fieldOptions[0]?.slug ?? "";
    setGroupByClauses((prev) => [...prev, { id: makeId(), field: firstField }]);
  }, [fieldOptions]);

  const updateGroupBy = useCallback((id: string, updated: GroupByUI) => {
    setGroupByClauses((prev) => prev.map((g) => (g.id === id ? updated : g)));
  }, []);

  const removeGroupBy = useCallback((id: string) => {
    setGroupByClauses((prev) => prev.filter((g) => g.id !== id));
  }, []);

  // --- Aggregate mutations ---
  const addAggregate = useCallback(() => {
    setAggregates((prev) => [
      ...prev,
      { id: makeId(), fn: "COUNT", field: "*", alias: "" },
    ]);
  }, []);

  const updateAggregate = useCallback((id: string, updated: AggregateUI) => {
    setAggregates((prev) => prev.map((a) => (a.id === id ? updated : a)));
  }, []);

  const removeAggregate = useCallback((id: string) => {
    setAggregates((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // --- Calculated field mutations ---
  const addCalculatedField = useCallback(() => {
    setCalculatedFields((prev) => [
      ...prev,
      { id: makeId(), expression: "", alias: "" },
    ]);
  }, []);

  const updateCalculatedField = useCallback((id: string, updated: CalculatedFieldUI) => {
    setCalculatedFields((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const removeCalculatedField = useCallback((id: string) => {
    setCalculatedFields((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // --- JOIN mutations (NCA-009) ---
  const addJoin = useCallback(() => {
    setJoins((prev) => [
      ...prev,
      { id: makeId(), joinType: "INNER", joinEntityType: "", leftField: fieldOptions[0]?.slug ?? "", rightField: "" },
    ]);
  }, [fieldOptions]);

  const updateJoin = useCallback((id: string, updated: JoinUI) => {
    setJoins((prev) => prev.map((j) => (j.id === id ? updated : j)));
  }, []);

  const removeJoin = useCallback((id: string) => {
    setJoins((prev) => prev.filter((j) => j.id !== id));
  }, []);

  // --- ORDER BY mutations ---
  const addOrderBy = useCallback(() => {
    const firstField = fieldOptions[0]?.slug ?? "";
    setOrderByClauses((prev) => [
      ...prev,
      { id: makeId(), field: firstField, direction: "asc" },
    ]);
  }, [fieldOptions]);

  const updateOrderBy = useCallback((id: string, updated: OrderByUI) => {
    setOrderByClauses((prev) => prev.map((ob) => (ob.id === id ? updated : ob)));
  }, []);

  const removeOrderBy = useCallback((id: string) => {
    setOrderByClauses((prev) => prev.filter((ob) => ob.id !== id));
  }, []);

  // --- Execute query ---
  const runQueryMutation = useMutation({
    mutationFn: ({ requestPage }: { requestPage: number }) => {
      const limit = Math.min(Math.max(parseInt(limitStr, 10) || PAGE_SIZE, 1), 1000);
      const offset = requestPage * limit;

      // Regular field selects + aggregate expressions + calculated fields encoded as strings.
      // The backend structuredQuerySchema accepts an array of strings in `select`;
      // aggregate functions are expressed as "COUNT(field) AS alias" strings.
      const selectFields = selectedFields.size === 0 ? ["*"] : Array.from(selectedFields);
      const aggregateSelects = aggregates
        .filter((a) => a.field)
        .map((a) => {
          const expr = `${a.fn}(${a.field})`;
          return a.alias ? `${expr} AS ${a.alias}` : expr;
        });
      const calculatedSelects = calculatedFields
        .filter((c) => c.expression.trim() && c.alias.trim())
        .map((c) => `${c.expression.trim()} AS ${c.alias.trim()}`);

      const query: StructuredQuery = {
        entityType: selectedEntityType,
        select: [...selectFields, ...aggregateSelects, ...calculatedSelects],
        ...(whereClauses.length > 0 ? {
          where: whereClauses
            .filter((c) => c.field !== "")
            .map(toWireWhereClause),
        } : {}),
        ...(groupByClauses.length > 0 ? {
          groupBy: groupByClauses.filter((g) => g.field !== "").map((g) => g.field),
        } : {}),
        ...(orderByClauses.length > 0 ? {
          orderBy: orderByClauses
            .filter((ob) => ob.field !== "")
            .map((ob) => ({ field: ob.field, direction: ob.direction })),
        } : {}),
        limit,
        offset,
      };

      return client.post<{ data: QueryResult }>("/v1/ontology/query", query);
    },
    onSuccess: (response, { requestPage }) => {
      setQueryResult(response.data);
      setPage(requestPage);
      // Reset chart config so axis defaults apply to the new column set
      resetChartConfig();
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Query failed";
      toast({ title: "Query error", description: message, variant: "destructive" });
    },
  });

  const handleRunQuery = useCallback(() => {
    if (!selectedEntityType) {
      toast({ title: "Select an entity type first", variant: "destructive" });
      return;
    }
    runQueryMutation.mutate({ requestPage: 0 });
  }, [selectedEntityType, runQueryMutation]);

  const handlePageChange = useCallback((newPage: number) => {
    runQueryMutation.mutate({ requestPage: newPage });
  }, [runQueryMutation]);

  // --- CSV export (NCA-006) ---
  const handleExportCsv = useCallback(() => {
    if (!queryResult) return;
    const csv = rowsToCsv(queryResult.columns, queryResult.rows);
    const filename = `${selectedEntityType}-query-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadText(csv, filename, "text/csv");
  }, [queryResult, selectedEntityType]);

  // --- JSON export (NCA-006) ---
  const handleExportJson = useCallback(() => {
    if (!queryResult) return;
    const json = rowsToJson(queryResult.columns, queryResult.rows);
    const filename = `${selectedEntityType}-query-${new Date().toISOString().slice(0, 10)}.json`;
    downloadText(json, filename, "application/json");
  }, [queryResult, selectedEntityType]);

  // --- Saved queries: build the current query snapshot for saving ---
  const currentQuerySnapshot: Omit<SavedQuery, "name"> = {
    entityType: selectedEntityType,
    selectedFields: Array.from(selectedFields),
    whereClauses,
    groupByClauses,
    orderByClauses,
    aggregates,
    calculatedFields,
    joins,
    limitStr,
  };

  // --- Saved queries: load a saved query into state ---
  const handleLoadQuery = useCallback((q: SavedQuery) => {
    // Entity type change clears everything, so set it first then re-apply
    setSelectedEntityType(q.entityType);
    setSelectedFields(new Set(q.selectedFields));
    setWhereClauses(q.whereClauses);
    setGroupByClauses(q.groupByClauses ?? []);
    setAggregates(q.aggregates ?? []);
    setCalculatedFields(q.calculatedFields ?? []);
    setJoins(q.joins ?? []);
    setOrderByClauses(q.orderByClauses);
    setLimitStr(q.limitStr);
    setQueryResult(null);
    setPage(0);
    setSqlMode(false);
    setRawSql("");
    resetChartConfig();
    setShowSavedQueries(false);
    toast({ title: `Loaded query "${q.name}"` });
  }, [resetChartConfig]);

  // --- SQL preview ---
  const sqlPreview = buildSqlPreview({
    entityType: selectedEntityType,
    selectedFields,
    aggregates,
    calculatedFields,
    whereClauses,
    groupByClauses,
    orderByClauses,
    joins,
    limitStr,
  });

  // When the user enables SQL Mode, pre-populate the textarea with the current
  // visual builder SQL so they can refine it rather than starting from scratch.
  const handleToggleSqlMode = useCallback(() => {
    setSqlMode((prev) => {
      if (!prev) {
        // Switching to SQL mode — pre-populate from the visual builder
        setRawSql(sqlPreview);
      }
      return !prev;
    });
  }, [sqlPreview]);

  const hasGroupBy = groupByClauses.some((g) => g.field !== "");

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Query Builder"
        description="Build and run structured queries against your ontology data."
        breadcrumbs={[
          { label: "Platform" },
          { label: "Ontology", href: "/ontology" },
          { label: "Query Builder" },
        ]}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSavedQueries((v) => !v)}
              aria-pressed={showSavedQueries}
              aria-label="Toggle saved queries panel"
            >
              <FolderOpen className="h-4 w-4 mr-1.5" aria-hidden />
              Saved queries
            </Button>
            {selectedEntityType && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowScheduleReport(true)}
                aria-label="Schedule this query as a recurring report"
              >
                <Calendar className="h-4 w-4 mr-1.5" aria-hidden />
                Schedule report
              </Button>
            )}
            {selectedEntityType && (
              <Button
                variant={sqlMode ? "default" : "outline"}
                size="sm"
                onClick={handleToggleSqlMode}
                aria-pressed={sqlMode}
                aria-label="Toggle SQL mode"
              >
                <Code className="h-4 w-4 mr-1.5" aria-hidden />
                SQL mode
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => void navigate({ to: "/ontology" })}
            >
              Back to ontology
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6 max-w-6xl">

        {/* --- AI natural-language query input (NCP-016) --- */}
        {/* Placeholder UI: AI query integration is planned for a future release.
            The input is intentionally disabled so users know the feature is coming
            without it appearing broken. */}
        <section aria-labelledby="ai-query-label">
          <h2 id="ai-query-label" className="text-sm font-medium text-[var(--color-foreground)] mb-1.5">
            Ask a question
          </h2>
          <div className="flex items-center gap-2">
            <Input
              disabled
              placeholder="Ask a question about your data..."
              aria-label="AI natural language query (coming soon)"
              className="max-w-lg opacity-60 cursor-not-allowed"
            />
            <span className="text-xs text-[var(--color-muted-foreground)] italic whitespace-nowrap">
              AI query coming soon
            </span>
          </div>
        </section>

        {/* --- Saved queries panel --- */}
        {showSavedQueries && (
          <section aria-labelledby="saved-section-label" className="rounded-md border border-[var(--color-border)] p-4 space-y-3">
            <h2 id="saved-section-label" className="text-sm font-medium text-[var(--color-foreground)] flex items-center gap-1.5">
              <FolderOpen className="h-4 w-4" aria-hidden />
              Saved queries
            </h2>
            <SavedQueriesPanel currentQuery={currentQuerySnapshot} onLoad={handleLoadQuery} />
          </section>
        )}

        {/* --- Entity type selector --- */}
        <section aria-labelledby="entity-section-label">
          <h2 id="entity-section-label" className="text-sm font-medium text-[var(--color-foreground)] mb-2">
            Entity type
          </h2>
          {isLoadingEntities ? (
            <Skeleton className="h-10 w-64" />
          ) : (
            <Select value={selectedEntityType} onValueChange={handleEntityTypeChange}>
              <SelectTrigger className="w-64" aria-label="Entity type">
                <SelectValue placeholder="Select an entity…" />
              </SelectTrigger>
              <SelectContent>
                {entityList.flatMap((e) => {
                  const entity = e as EntitySummary & { slug?: string };
                  if (!entity.slug) {
                    // An entity without a slug cannot be queried — warn once
                    // so the developer knows the ontology record is incomplete.
                    // We use flatMap so the missing-slug entity is skipped in
                    // the dropdown rather than falling back to a derived value
                    // that may not match the backend's routing.
                    console.warn(
                      `[QueryBuilder] Entity "${entity.name}" has no slug — skipping. Update the ontology record to add a slug.`,
                    );
                    return [];
                  }
                  return [
                    <SelectItem key={entity.slug} value={entity.slug}>
                      {entity.name}
                    </SelectItem>,
                  ];
                })}
              </SelectContent>
            </Select>
          )}
        </section>

        {/* --- All query configuration sections (only when entity type selected) --- */}
        {selectedEntityType && (
          <>
            {/* --- SQL Mode textarea --- */}
            {sqlMode && (
              <>
                <Separator />
                <section aria-labelledby="sql-mode-section-label">
                  <div className="flex items-center gap-2 mb-2">
                    <Code className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
                    <h2 id="sql-mode-section-label" className="text-sm font-medium text-[var(--color-foreground)]">
                      SQL Mode
                    </h2>
                    <span className="text-xs text-[var(--color-muted-foreground)]">
                      — write raw SQL instead of using the visual builder
                    </span>
                  </div>
                  <textarea
                    className="w-full min-h-[180px] rounded-md border border-[var(--color-input)] bg-[var(--color-background)] p-3 text-xs font-mono text-[var(--color-foreground)] resize-y focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                    aria-label="Raw SQL query"
                    value={rawSql}
                    onChange={(e) => setRawSql(e.target.value)}
                    placeholder="SELECT * FROM EntityType WHERE ..."
                    spellCheck={false}
                  />
                  <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)]">
                    This SQL is sent directly to the query engine. Switch off SQL mode to return to the visual builder.
                  </p>
                </section>
              </>
            )}

            {/* --- Visual builder sections (hidden in SQL mode) --- */}
            {!sqlMode && (
            <>
            {/* --- Field selector --- */}
            <Separator />
            <section aria-labelledby="fields-section-label">
              <div className="flex items-center justify-between mb-2">
                <h2 id="fields-section-label" className="text-sm font-medium text-[var(--color-foreground)]">
                  Columns to select
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleAllFields}
                  className="text-xs"
                >
                  {selectedFields.size === fieldOptions.length ? "Deselect all" : "Select all"}
                </Button>
              </div>

              {isLoadingFields ? (
                <div className="flex flex-wrap gap-2">
                  {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7 w-24" />)}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Fields">
                  {fieldOptions.map((f) => {
                    const checked = selectedFields.has(f.slug);
                    return (
                      <label
                        key={f.slug}
                        className={[
                          "inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs cursor-pointer select-none transition-colors",
                          checked
                            ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)]"
                            : "bg-transparent text-[var(--color-foreground)] border-[var(--color-border)] hover:bg-[var(--color-accent)]",
                        ].join(" ")}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={checked}
                          onChange={() => toggleField(f.slug)}
                        />
                        {f.name}
                      </label>
                    );
                  })}
                </div>
              )}
              {selectedFields.size === 0 && fieldOptions.length > 0 && (
                <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)]">
                  Select at least one column to include in the query.
                </p>
              )}
            </section>

            {/* --- Calculated fields (expression columns) --- */}
            <Separator />
            <section aria-labelledby="calc-section-label">
              <div className="flex items-center justify-between mb-2">
                <h2 id="calc-section-label" className="text-sm font-medium text-[var(--color-foreground)]">
                  Calculated fields
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addCalculatedField}
                  disabled={!selectedEntityType}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" aria-hidden />
                  Add calculated field
                </Button>
              </div>

              {calculatedFields.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  No calculated fields. Add an expression column like <code className="font-mono text-xs">price * quantity</code>.
                </p>
              ) : (
                <div className="space-y-2">
                  {calculatedFields.map((c) => (
                    <CalculatedFieldRow
                      key={c.id}
                      field={c}
                      onChange={(updated) => updateCalculatedField(c.id, updated)}
                      onRemove={() => removeCalculatedField(c.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* --- JOIN section (NCA-009) --- */}
            <Separator />
            <section aria-labelledby="join-section-label">
              <div className="flex items-center justify-between mb-2">
                <h2 id="join-section-label" className="text-sm font-medium text-[var(--color-foreground)]">
                  Joins
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addJoin}
                  disabled={fieldOptions.length === 0 || entityList.length === 0}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" aria-hidden />
                  Add join
                </Button>
              </div>

              {joins.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">No joins configured.</p>
              ) : (
                <div className="space-y-2">
                  {joins.map((join) => (
                    // JoinRowContainer owns the useQuery that loads the joined
                    // entity's fields so the right-side "ON" field dropdown is
                    // populated once a join entity is selected.
                    <JoinRowContainer
                      key={join.id}
                      join={join}
                      primaryFieldOptions={fieldOptions}
                      availableEntityTypes={entityList.flatMap((e) => {
                        const ent = e as { slug?: string; name: string };
                        if (!ent.slug) return [];
                        return [{ slug: ent.slug, name: ent.name }];
                      })}
                      onChange={(updated) => updateJoin(join.id, updated)}
                      onRemove={() => removeJoin(join.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* --- WHERE clauses --- */}
            <Separator />
            <section aria-labelledby="where-section-label">
              <div className="flex items-center justify-between mb-2">
                <h2 id="where-section-label" className="text-sm font-medium text-[var(--color-foreground)]">
                  Filters
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addWhereClause}
                  disabled={fieldOptions.length === 0}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" aria-hidden />
                  Add filter
                </Button>
              </div>

              {whereClauses.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">No filters added.</p>
              ) : (
                <div className="space-y-2">
                  {whereClauses.map((clause) => (
                    <WhereClauseRow
                      key={clause.id}
                      clause={clause}
                      fieldOptions={fieldOptions}
                      onChange={(updated) => updateWhereClause(clause.id, updated)}
                      onRemove={() => removeWhereClause(clause.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* --- GROUP BY --- */}
            <Separator />
            <section aria-labelledby="groupby-section-label">
              <div className="flex items-center justify-between mb-2">
                <h2 id="groupby-section-label" className="text-sm font-medium text-[var(--color-foreground)] flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5" aria-hidden />
                  Group by
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addGroupBy}
                  disabled={fieldOptions.length === 0}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" aria-hidden />
                  Add group
                </Button>
              </div>

              {groupByClauses.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">No grouping configured.</p>
              ) : (
                <div className="space-y-2">
                  {groupByClauses.map((g) => (
                    <GroupByRow
                      key={g.id}
                      groupBy={g}
                      fieldOptions={fieldOptions}
                      onChange={(updated) => updateGroupBy(g.id, updated)}
                      onRemove={() => removeGroupBy(g.id)}
                    />
                  ))}
                </div>
              )}

              {/* Aggregate functions — only surfaced when GROUP BY is active */}
              {hasGroupBy && (
                <div className="mt-3 pl-4 border-l-2 border-[var(--color-border)] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[var(--color-muted-foreground)]">
                      Aggregate expressions
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={addAggregate}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" aria-hidden />
                      Add aggregate
                    </Button>
                  </div>
                  {aggregates.length === 0 ? (
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      No aggregates — add one to compute COUNT, SUM, AVG, MIN, or MAX.
                    </p>
                  ) : (
                    aggregates.map((a) => (
                      <AggregateRow
                        key={a.id}
                        aggregate={a}
                        fieldOptions={fieldOptions}
                        onChange={(updated) => updateAggregate(a.id, updated)}
                        onRemove={() => removeAggregate(a.id)}
                      />
                    ))
                  )}
                </div>
              )}
            </section>

            {/* --- ORDER BY --- */}
            <Separator />
            <section aria-labelledby="orderby-section-label">
              <div className="flex items-center justify-between mb-2">
                <h2 id="orderby-section-label" className="text-sm font-medium text-[var(--color-foreground)]">
                  Order by
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addOrderBy}
                  disabled={fieldOptions.length === 0}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" aria-hidden />
                  Add sort
                </Button>
              </div>

              {orderByClauses.length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">No ordering configured.</p>
              ) : (
                <div className="space-y-2">
                  {orderByClauses.map((ob) => (
                    <OrderByRow
                      key={ob.id}
                      orderBy={ob}
                      fieldOptions={fieldOptions}
                      onChange={(updated) => updateOrderBy(ob.id, updated)}
                      onRemove={() => removeOrderBy(ob.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* --- Limit --- */}
            <Separator />
            <section aria-labelledby="limit-section-label">
              <h2 id="limit-section-label" className="text-sm font-medium text-[var(--color-foreground)] mb-2">
                Row limit
              </h2>
              <div className="flex items-center gap-3">
                <div className="w-36">
                  <Label htmlFor="limit-input" className="text-xs text-[var(--color-muted-foreground)] mb-1 block">
                    Limit (max 1000)
                  </Label>
                  <Input
                    id="limit-input"
                    type="number"
                    min={1}
                    max={1000}
                    value={limitStr}
                    onChange={(e) => setLimitStr(e.target.value)}
                    onBlur={(e) => {
                      // Clamp to valid range on blur so the displayed value
                      // always reflects what will actually be sent to the API.
                      const v = parseInt(e.target.value, 10);
                      if (isNaN(v) || v < 1) setLimitStr("1");
                      else if (v > 1000) setLimitStr("1000");
                    }}
                  />
                </div>
              </div>
            </section>

            {/* End of visual builder — the sections below are shown in both visual and SQL modes */}
            </>
            )}

            {/* --- Run / Export row --- */}
            <Separator />
            <div className="flex items-center gap-3">
              <Button
                onClick={handleRunQuery}
                disabled={runQueryMutation.isPending}
              >
                <Play className="h-4 w-4 mr-1.5" aria-hidden />
                {runQueryMutation.isPending ? "Running…" : "Run query"}
              </Button>

              {/* NCA-006: Export format selection — CSV or JSON */}
              {queryResult && (
                <div className="relative inline-flex" role="group" aria-label="Export options">
                  <Button
                    variant="outline"
                    className="rounded-r-none border-r-0"
                    onClick={handleExportCsv}
                    aria-label="Export as CSV"
                  >
                    <Download className="h-4 w-4 mr-1.5" aria-hidden />
                    CSV
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-l-none"
                    onClick={handleExportJson}
                    aria-label="Export as JSON"
                  >
                    JSON
                  </Button>
                </div>
              )}
            </div>

            {/* --- Error state --- */}
            {runQueryMutation.isError && (
              <div
                className="flex items-start gap-2 rounded-md border border-[var(--color-destructive)] bg-[var(--color-destructive)]/10 p-3 text-sm text-[var(--color-destructive)]"
                role="alert"
              >
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
                <span>
                  {runQueryMutation.error instanceof ApiError
                    ? runQueryMutation.error.message
                    : "Query failed. Check your filters and try again."}
                </span>
              </div>
            )}

            {/* --- Results section --- */}
            {queryResult && (
              <section aria-labelledby="results-section-label">
                <div className="flex items-center justify-between mb-3">
                  <h2 id="results-section-label" className="text-sm font-medium text-[var(--color-foreground)]">
                    Results
                  </h2>

                  {/* View tab switcher: Table | Chart | Pivot | SQL */}
                  <div
                    className="flex rounded-md border border-[var(--color-border)] overflow-hidden"
                    role="tablist"
                    aria-label="Result view"
                  >
                    {([
                      { key: "table", label: "Table",  Icon: null },
                      { key: "chart", label: "Chart",  Icon: BarChart3 },
                      { key: "pivot", label: "Pivot",  Icon: Layers },
                      { key: "sql",   label: "SQL",    Icon: Eye },
                    ] as const).map(({ key, label, Icon }) => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={resultTab === key}
                        onClick={() => setResultTab(key)}
                        className={[
                          "flex items-center gap-1 px-3 py-1.5 text-xs font-medium transition-colors",
                          resultTab === key
                            ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                            : "hover:bg-[var(--color-accent)] text-[var(--color-foreground)]",
                        ].join(" ")}
                      >
                        {Icon && <Icon className="h-3.5 w-3.5" aria-hidden />}
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {resultTab === "table" && (
                  <QueryResultTable
                    result={queryResult}
                    page={page}
                    pageSize={Math.min(Math.max(parseInt(limitStr, 10) || PAGE_SIZE, 1), 1000)}
                    onPageChange={handlePageChange}
                  />
                )}

                {resultTab === "chart" && (
                  <ChartVisualization
                    result={queryResult}
                    config={chartConfig}
                    onConfigChange={setChartConfig}
                  />
                )}

                {resultTab === "pivot" && (
                  <PivotTable
                    result={queryResult}
                    config={pivotConfig}
                    onConfigChange={setPivotConfig}
                  />
                )}

                {resultTab === "sql" && (
                  <div className="space-y-2">
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Read-only preview — this is a simplified representation of the structured query sent to the API.
                    </p>
                    <SqlPreview sql={sqlPreview} />
                  </div>
                )}
              </section>
            )}

            {/* --- SQL preview available before running (visual mode only) --- */}
            {!queryResult && selectedEntityType && !sqlMode && (
              <section aria-labelledby="sql-preview-section-label">
                <div className="flex items-center gap-2 mb-2">
                  <Eye className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
                  <h2 id="sql-preview-section-label" className="text-sm font-medium text-[var(--color-foreground)]">
                    Query preview
                  </h2>
                </div>
                <SqlPreview sql={sqlPreview} />
              </section>
            )}
          </>
        )}
      </div>

      {/* Schedule Report dialog */}
      <ScheduleReportDialog
        open={showScheduleReport}
        onOpenChange={setShowScheduleReport}
        queryName={selectedEntityType}
        currentQuery={currentQuerySnapshot}
      />
    </div>
  );
}
