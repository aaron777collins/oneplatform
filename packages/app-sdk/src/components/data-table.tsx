/**
 * DataTable — generic sortable, paginated, searchable table for hosted apps.
 *
 * Designed as a fully self-contained component with no dependency on the
 * frontend package. Styling uses Tailwind CSS v4 CSS-variable tokens that
 * the OnePlatform app shell injects into the page.
 *
 * Generic over T so callers get full type inference on column keys and render
 * callbacks. The Column<T> type constrains `key` to `keyof T` so the default
 * cell renderer is always type-safe.
 */

import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Column<T> {
  /** Must be a key of T for the default cell renderer; use `render` for computed columns. */
  key: keyof T;
  header: string;
  sortable?: boolean;
  /**
   * Custom cell renderer. Receives the raw cell value and the full row so
   * callers can compose multi-field content (e.g. avatar + name).
   */
  render?: (value: T[keyof T], row: T) => React.ReactNode;
  /** Optional className applied to each <th> / <td> pair for this column. */
  headerClassName?: string;
  cellClassName?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  /** Number of rows per page. Defaults to 10. */
  pageSize?: number;
  /** Called when the user clicks a data row. */
  onRowClick?: (row: T) => void;
  /** Displays skeleton rows while true. */
  loading?: boolean;
  /** Message shown when data is empty and not loading. */
  emptyMessage?: string;
  /** Accessible label for the table element. Required for screen readers. */
  "aria-label"?: string;
  className?: string;
}

type SortDirection = "asc" | "desc";

interface SortState<T> {
  key: keyof T;
  direction: SortDirection;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sortData<T>(
  data: T[],
  sort: SortState<T> | null,
): T[] {
  if (sort === null) return data;
  return [...data].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av === bv) return 0;
    const order = av < bv ? -1 : 1;
    return sort.direction === "asc" ? order : -order;
  });
}

function filterData<T>(data: T[], search: string, columns: Column<T>[]): T[] {
  if (search.trim() === "") return data;
  const lower = search.toLowerCase();
  return data.filter((row) =>
    columns.some((col) => {
      const val = row[col.key];
      return String(val ?? "").toLowerCase().includes(lower);
    }),
  );
}

// ---------------------------------------------------------------------------
// SkeletonRows
// ---------------------------------------------------------------------------

function SkeletonRows({ columnCount, rowCount }: { columnCount: number; rowCount: number }) {
  return (
    <>
      {Array.from({ length: rowCount }).map((_, rowIndex) => (
        <tr key={rowIndex} aria-hidden="true">
          {Array.from({ length: columnCount }).map((_, colIndex) => (
            <td
              key={colIndex}
              className="px-4 py-3 border-b border-[var(--color-border,#e5e7eb)]"
            >
              <div className="h-4 rounded bg-[var(--color-muted,#f3f4f6)] animate-pulse" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// DataTable component
// ---------------------------------------------------------------------------

export function DataTable<T>({
  data,
  columns,
  pageSize = 10,
  onRowClick,
  loading = false,
  emptyMessage = "No data to display.",
  "aria-label": ariaLabel,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = React.useState<SortState<T> | null>(null);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  // Track which rows are selected by their index in the filtered/sorted data
  const [selectedKeys, setSelectedKeys] = React.useState<Set<number>>(new Set());

  // Reset to first page whenever the search term or source data changes so
  // the user never lands on a page that no longer has content.
  React.useEffect(() => {
    setPage(1);
    setSelectedKeys(new Set());
  }, [search, data]);

  const filtered = React.useMemo(() => filterData(data, search, columns), [data, search, columns]);
  const sorted = React.useMemo(() => sortData(filtered, sort), [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const allPageSelected =
    pageRows.length > 0 && pageRows.every((_, i) => selectedKeys.has((safePage - 1) * pageSize + i));

  function toggleSort(key: keyof T) {
    setSort((prev) => {
      if (prev?.key === key) {
        return prev.direction === "asc" ? { key, direction: "desc" } : null;
      }
      return { key, direction: "asc" };
    });
  }

  function toggleRowSelection(absoluteIndex: number) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(absoluteIndex)) {
        next.delete(absoluteIndex);
      } else {
        next.add(absoluteIndex);
      }
      return next;
    });
  }

  function togglePageSelection() {
    const indices = pageRows.map((_, i) => (safePage - 1) * pageSize + i);
    if (allPageSelected) {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        indices.forEach((idx) => next.delete(idx));
        return next;
      });
    } else {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        indices.forEach((idx) => next.add(idx));
        return next;
      });
    }
  }

  return (
    <div className={className}>
      {/* Search bar */}
      <div className="mb-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          aria-label="Search table"
          className="w-full max-w-xs rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-3 py-1.5 text-sm text-[var(--color-foreground,#111)] placeholder:text-[var(--color-muted-foreground,#6b7280)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring,#6366f1)]"
        />
      </div>

      <div className="overflow-x-auto rounded-md border border-[var(--color-border,#e5e7eb)]">
        <table
          className="min-w-full text-sm"
          aria-label={ariaLabel ?? "Data table"}
          aria-busy={loading}
        >
          <thead className="bg-[var(--color-muted,#f9fafb)]">
            <tr>
              {/* Select-all checkbox */}
              <th className="w-10 px-4 py-3 text-left" scope="col">
                <input
                  type="checkbox"
                  checked={allPageSelected}
                  onChange={togglePageSelection}
                  aria-label="Select all rows on this page"
                  disabled={loading || pageRows.length === 0}
                  className="h-4 w-4 rounded border-[var(--color-border,#e5e7eb)] accent-[var(--color-primary,#6366f1)]"
                />
              </th>
              {columns.map((col) => (
                <th
                  key={String(col.key)}
                  scope="col"
                  aria-sort={
                    sort?.key === col.key
                      ? sort.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : col.sortable === true
                        ? "none"
                        : undefined
                  }
                  className={[
                    "px-4 py-3 text-left font-semibold text-[var(--color-foreground,#111)]",
                    col.sortable === true
                      ? "cursor-pointer select-none hover:bg-[var(--color-muted,#f3f4f6)]"
                      : "",
                    col.headerClassName ?? "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={col.sortable === true ? () => toggleSort(col.key) : undefined}
                  onKeyDown={
                    col.sortable === true
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleSort(col.key);
                          }
                        }
                      : undefined
                  }
                  tabIndex={col.sortable === true ? 0 : undefined}
                >
                  <span className="flex items-center gap-1">
                    {col.header}
                    {col.sortable === true && (
                      <SortIcon
                        direction={sort?.key === col.key ? sort.direction : null}
                      />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-[var(--color-background,#fff)] divide-y divide-[var(--color-border,#e5e7eb)]">
            {loading ? (
              <SkeletonRows columnCount={columns.length + 1} rowCount={pageSize} />
            ) : pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-4 py-12 text-center text-[var(--color-muted-foreground,#6b7280)]"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pageRows.map((row, rowIndex) => {
                const absoluteIndex = (safePage - 1) * pageSize + rowIndex;
                const isSelected = selectedKeys.has(absoluteIndex);
                return (
                  <tr
                    key={absoluteIndex}
                    onClick={onRowClick !== undefined ? () => onRowClick(row) : undefined}
                    className={[
                      onRowClick !== undefined ? "cursor-pointer hover:bg-[var(--color-muted,#f9fafb)]" : "",
                      isSelected ? "bg-[var(--color-primary,#6366f1)]/5" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-selected={isSelected}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRowSelection(absoluteIndex)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select row ${absoluteIndex + 1}`}
                        className="h-4 w-4 rounded border-[var(--color-border,#e5e7eb)] accent-[var(--color-primary,#6366f1)]"
                      />
                    </td>
                    {columns.map((col) => (
                      <td
                        key={String(col.key)}
                        className={[
                          "px-4 py-3 text-[var(--color-foreground,#111)]",
                          col.cellClassName ?? "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {col.render !== undefined
                          ? col.render(row[col.key], row)
                          : String(row[col.key] ?? "")}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination controls */}
      {!loading && sorted.length > pageSize && (
        <div className="mt-3 flex items-center justify-between text-sm text-[var(--color-muted-foreground,#6b7280)]">
          <span>
            Showing {(safePage - 1) * pageSize + 1}–
            {Math.min(safePage * pageSize, sorted.length)} of {sorted.length}
          </span>
          <nav aria-label="Table pagination" className="flex items-center gap-1">
            <PageButton
              onClick={() => setPage(1)}
              disabled={safePage === 1}
              aria-label="First page"
            >
              {"«"}
            </PageButton>
            <PageButton
              onClick={() => setPage((p) => p - 1)}
              disabled={safePage === 1}
              aria-label="Previous page"
            >
              {"‹"}
            </PageButton>
            <span className="px-2 font-medium text-[var(--color-foreground,#111)]" aria-current="page">
              {safePage} / {totalPages}
            </span>
            <PageButton
              onClick={() => setPage((p) => p + 1)}
              disabled={safePage === totalPages}
              aria-label="Next page"
            >
              {"›"}
            </PageButton>
            <PageButton
              onClick={() => setPage(totalPages)}
              disabled={safePage === totalPages}
              aria-label="Last page"
            >
              {"»"}
            </PageButton>
          </nav>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SortIcon({ direction }: { direction: SortDirection | null }) {
  return (
    <span aria-hidden="true" className="inline-flex flex-col text-[0.6rem] leading-none text-[var(--color-muted-foreground,#6b7280)]">
      <span className={direction === "asc" ? "text-[var(--color-foreground,#111)]" : ""}>▲</span>
      <span className={direction === "desc" ? "text-[var(--color-foreground,#111)]" : ""}>▼</span>
    </span>
  );
}

function PageButton({
  children,
  disabled,
  onClick,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="rounded px-2 py-1 text-sm hover:bg-[var(--color-muted,#f3f4f6)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring,#6366f1)]"
    >
      {children}
    </button>
  );
}
