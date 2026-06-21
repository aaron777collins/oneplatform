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
  PieChart as PieChartIcon, Save, FolderOpen, Eye, Layers,
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

type ResultViewTab = "table" | "chart" | "sql";
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
}

interface AggregateUI {
  id: string;
  fn: AggregateFunction;
  field: string;
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
  limitStr: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(): string {
  return Math.random().toString(36).slice(2);
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
        if (typeof v === "object") return JSON.stringify(JSON.stringify(v));
        return JSON.stringify(String(v));
      })
      .join(","),
  );
  return [header, ...dataRows].join("\n");
}

/** Download a string as a file via a synthetic anchor click. */
function downloadText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  whereClauses: WhereClauseUI[];
  groupByClauses: GroupByUI[];
  orderByClauses: OrderByUI[];
  limitStr: string;
}): string {
  const { entityType, selectedFields, aggregates, whereClauses, groupByClauses, orderByClauses, limitStr } = params;

  if (!entityType) return "-- Select an entity type to preview the query";

  const selectParts: string[] = [
    ...(selectedFields.size === 0 ? ["*"] : Array.from(selectedFields)),
    ...aggregates
      .filter((a) => a.field)
      .map((a) => {
        const expr = `${a.fn}(${a.field})`;
        return a.alias ? `${expr} AS ${a.alias}` : expr;
      }),
  ];

  const lines: string[] = [
    `SELECT ${selectParts.join(",\n       ")}`,
    `FROM   ${entityType}`,
  ];

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
    lines.push(`GROUP BY ${activeGroupBy.map((g) => g.field).join(", ")}`);
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

/** Load saved queries from localStorage — returns empty array on parse failure. */
function loadSavedQueries(): SavedQuery[] {
  try {
    const raw = localStorage.getItem(SAVED_QUERIES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SavedQuery[];
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
    <div className="flex items-center gap-2" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="sr-only">Where condition</span>

      <Select
        value={clause.field}
        onValueChange={(v) => onChange({ ...clause, field: v })}
      >
        <SelectTrigger className="w-40" aria-label="Field">
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
        <SelectTrigger className="w-36" aria-label="Operator">
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
          className="w-48"
        />
      ) : (
        <Input
          className="w-48"
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
        className="shrink-0"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

interface GroupByRowProps {
  groupBy: GroupByUI;
  fieldOptions: Array<{ slug: string; name: string }>;
  onChange: (updated: GroupByUI) => void;
  onRemove: () => void;
}

function GroupByRow({ groupBy, fieldOptions, onChange, onRemove }: GroupByRowProps) {
  return (
    <div className="flex items-center gap-2">
      <Select
        value={groupBy.field}
        onValueChange={(v) => onChange({ ...groupBy, field: v })}
      >
        <SelectTrigger className="w-40" aria-label="Group by field">
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

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove group"
        className="shrink-0"
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
    <div className="flex items-center gap-2">
      {/* Aggregate function */}
      <Select
        value={aggregate.fn}
        onValueChange={(v) => onChange({ ...aggregate, fn: v as AggregateFunction })}
      >
        <SelectTrigger className="w-28" aria-label="Aggregate function">
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
        <SelectTrigger className="w-40" aria-label="Field to aggregate">
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
        className="w-36"
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

interface OrderByRowProps {
  orderBy: OrderByUI;
  fieldOptions: Array<{ slug: string; name: string }>;
  onChange: (updated: OrderByUI) => void;
  onRemove: () => void;
}

function OrderByRow({ orderBy, fieldOptions, onChange, onRemove }: OrderByRowProps) {
  return (
    <div className="flex items-center gap-2">
      <Select
        value={orderBy.field}
        onValueChange={(v) => onChange({ ...orderBy, field: v })}
      >
        <SelectTrigger className="w-40" aria-label="Order by field">
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
        <SelectTrigger className="w-28" aria-label="Direction">
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
        className="shrink-0"
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

  const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };

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
                <TableHead key={col.name} className="font-mono text-xs whitespace-nowrap">
                  {col.name}
                  <Badge variant="outline" className="ml-1.5 text-[10px] py-0">
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
                  {result.columns.map((col) => (
                    <TableCell key={col.name} className="font-mono text-xs whitespace-nowrap max-w-xs truncate">
                      {formatCell(row[col.name])}
                    </TableCell>
                  ))}
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
// SqlPreview — read-only syntax-highlighted SQL preview block
// ---------------------------------------------------------------------------

interface SqlPreviewProps {
  sql: string;
}

function SqlPreview({ sql }: SqlPreviewProps) {
  // Minimal keyword highlighting — avoids adding a syntax-highlight dependency.
  // We split the SQL text and wrap SQL keywords in styled spans.
  const SQL_KEYWORDS = /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|GROUP BY|ORDER BY|LIMIT|AS|ASC|DESC|LIKE)\b/g;

  const highlighted = sql.replace(SQL_KEYWORDS, (kw) =>
    `<span style="color:hsl(220,70%,50%);font-weight:600">${kw}</span>`,
  );

  return (
    <div className="relative">
      <pre
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-4 text-xs font-mono overflow-x-auto text-[var(--color-foreground)] leading-relaxed"
        aria-label="SQL preview"
        // The highlighted HTML comes entirely from our own template — no user
        // input is interpolated as HTML. The SQL keyword spans are safe.
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

  // --- Saved queries panel visibility ---
  const [showSavedQueries, setShowSavedQueries] = useState(false);

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

  const entityList = entityListData?.data ?? [];
  const entityDetail = entityDetailData?.data;

  const fieldOptions: Array<{ slug: string; name: string }> = entityDetail
    ? [
        { slug: "_id", name: "_id (system)" },
        { slug: "_created_at", name: "_created_at (system)" },
        { slug: "_updated_at", name: "_updated_at (system)" },
        ...entityDetail.fields.map((f) => ({ slug: f.slug, name: f.name })),
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
    setOrderByClauses([]);
    setQueryResult(null);
    setPage(0);
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

      // Regular field selects + aggregate expressions encoded as strings.
      // The backend structuredQuerySchema accepts an array of strings in `select`;
      // aggregate functions are expressed as "COUNT(field) AS alias" strings.
      const selectFields = selectedFields.size === 0 ? ["*"] : Array.from(selectedFields);
      const aggregateSelects = aggregates
        .filter((a) => a.field)
        .map((a) => {
          const expr = `${a.fn}(${a.field})`;
          return a.alias ? `${expr} AS ${a.alias}` : expr;
        });

      const query: StructuredQuery = {
        entityType: selectedEntityType,
        select: [...selectFields, ...aggregateSelects],
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

  // --- CSV export ---
  const handleExportCsv = useCallback(() => {
    if (!queryResult) return;
    const csv = rowsToCsv(queryResult.columns, queryResult.rows);
    const filename = `${selectedEntityType}-query-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadText(csv, filename, "text/csv");
  }, [queryResult, selectedEntityType]);

  // --- Saved queries: build the current query snapshot for saving ---
  const currentQuerySnapshot: Omit<SavedQuery, "name"> = {
    entityType: selectedEntityType,
    selectedFields: Array.from(selectedFields),
    whereClauses,
    groupByClauses,
    orderByClauses,
    aggregates,
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
    setOrderByClauses(q.orderByClauses);
    setLimitStr(q.limitStr);
    setQueryResult(null);
    setPage(0);
    resetChartConfig();
    setShowSavedQueries(false);
    toast({ title: `Loaded query "${q.name}"` });
  }, [resetChartConfig]);

  // --- SQL preview ---
  const sqlPreview = buildSqlPreview({
    entityType: selectedEntityType,
    selectedFields,
    aggregates,
    whereClauses,
    groupByClauses,
    orderByClauses,
    limitStr,
  });

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
                {entityList.map((e) => {
                  const entity = e as EntitySummary & { slug?: string };
                  const value = entity.slug ?? entity.name.toLowerCase().replace(/\s+/g, "_");
                  return (
                    <SelectItem key={value} value={value}>
                      {entity.name}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </section>

        {/* --- All query configuration sections (only when entity type selected) --- */}
        {selectedEntityType && (
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
                  />
                </div>
              </div>
            </section>

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

              {queryResult && (
                <Button variant="outline" onClick={handleExportCsv}>
                  <Download className="h-4 w-4 mr-1.5" aria-hidden />
                  Export CSV
                </Button>
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

                  {/* View tab switcher: Table | Chart | SQL */}
                  <div
                    className="flex rounded-md border border-[var(--color-border)] overflow-hidden"
                    role="tablist"
                    aria-label="Result view"
                  >
                    {([
                      { key: "table", label: "Table", Icon: null },
                      { key: "chart", label: "Chart", Icon: BarChart3 },
                      { key: "sql",   label: "SQL",   Icon: Eye },
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

            {/* --- SQL preview also available before running --- */}
            {!queryResult && selectedEntityType && (
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
    </div>
  );
}
