/**
 * QueryBuilderPage — visual SQL query builder for ontology entity data.
 * Route: /ontology/query
 *
 * Users pick an entity type, choose columns, add WHERE conditions, configure
 * ordering, set limit/offset, and run the query. Results render in a paginated
 * table. The export button downloads the current result set as CSV.
 */
import React, { useState, useCallback, useId } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Trash2, Play, Download, ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
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
// Domain types (mirrors services/ontology/src/services/query-service.ts)
// ---------------------------------------------------------------------------

type WhereOperator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "like" | "in" | "not_in" | "is_null" | "is_not_null";

const OPERATOR_LABELS: Record<WhereOperator, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  in: "IN",
  not_in: "NOT IN",
  is_null: "IS NULL",
  is_not_null: "IS NOT NULL",
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

interface StructuredQuery {
  entityType: string;
  select: string[];
  where?: Array<{ field: string; operator: WhereOperator; value?: unknown }>;
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
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

// ---------------------------------------------------------------------------
// Sub-components
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

      {/* Field selector */}
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

      {/* Operator selector */}
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

      {/* Value input — hidden for nullary operators */}
      {!isNullary && (
        <Input
          className="w-48"
          placeholder={
            clause.operator === "in" || clause.operator === "not_in"
              ? "a, b, c"
              : "value"
          }
          value={clause.value}
          onChange={(e) => onChange({ ...clause, value: e.target.value })}
          aria-label="Value"
        />
      )}

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
// QueryBuilderPage — main page component
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

export function QueryBuilderPage() {
  const client = useApiClient();
  const navigate = useNavigate();

  // --- Entity type selection ---
  const [selectedEntityType, setSelectedEntityType] = useState<string>("");

  // --- Field selection (checkboxes) ---
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());

  // --- WHERE clauses ---
  const [whereClauses, setWhereClauses] = useState<WhereClauseUI[]>([]);

  // --- ORDER BY ---
  const [orderByClauses, setOrderByClauses] = useState<OrderByUI[]>([]);

  // --- Limit / Offset ---
  const [limitStr, setLimitStr] = useState<string>("100");
  const [page, setPage] = useState(0);

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

  const entityList = entityListData?.data.items ?? (entityListData as { data?: { items: EntitySummary[] } } | undefined)?.data?.items ?? [];
  const entityDetail = entityDetailData?.data;

  const fieldOptions: Array<{ slug: string; name: string }> = entityDetail
    ? [
        { slug: "_id", name: "_id (system)" },
        { slug: "_created_at", name: "_created_at (system)" },
        { slug: "_updated_at", name: "_updated_at (system)" },
        ...entityDetail.fields.map((f) => ({ slug: f.slug, name: f.name })),
      ]
    : [];

  // Reset field selections when entity type changes
  const handleEntityTypeChange = useCallback((slug: string) => {
    setSelectedEntityType(slug);
    setSelectedFields(new Set());
    setWhereClauses([]);
    setOrderByClauses([]);
    setQueryResult(null);
    setPage(0);
  }, []);

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

      const selectFields = selectedFields.size === 0 ? ["*"] : Array.from(selectedFields);

      const query: StructuredQuery = {
        entityType: selectedEntityType,
        select: selectFields,
        ...(whereClauses.length > 0 ? {
          where: whereClauses
            .filter((c) => c.field !== "")
            .map(toWireWhereClause),
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
          <Button
            variant="outline"
            onClick={() => void navigate({ to: "/ontology" })}
          >
            Back to ontology
          </Button>
        }
      />

      <div className="p-6 space-y-6 max-w-6xl">
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
                {entityList.map((e) => (
                  <SelectItem key={e.slug ?? e.name} value={e.slug ?? e.name.toLowerCase().replace(/\s+/g, "_")}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </section>

        {/* --- Field selector --- */}
        {selectedEntityType && (
          <>
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
                    const checked = selectedFields.size === 0 || selectedFields.has(f.slug);
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
                          onChange={() => {
                            // When nothing is explicitly selected we treat that as "all".
                            // The first toggle into the "some selected" state selects only
                            // the clicked field, so the user can then deselect others.
                            if (selectedFields.size === 0) {
                              setSelectedFields(new Set([f.slug]));
                            } else {
                              toggleField(f.slug);
                            }
                          }}
                        />
                        {f.name}
                      </label>
                    );
                  })}
                </div>
              )}
              {selectedFields.size === 0 && fieldOptions.length > 0 && (
                <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)]">
                  All columns will be returned when none are selected.
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

            {/* --- Limit / Offset --- */}
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

            {/* --- Run button --- */}
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

            {/* --- Results --- */}
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

            {queryResult && (
              <section aria-labelledby="results-section-label">
                <h2 id="results-section-label" className="text-sm font-medium text-[var(--color-foreground)] mb-3">
                  Results
                </h2>
                <QueryResultTable
                  result={queryResult}
                  page={page}
                  pageSize={Math.min(Math.max(parseInt(limitStr, 10) || PAGE_SIZE, 1), 1000)}
                  onPageChange={handlePageChange}
                />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
