/**
 * InfiniteTable — cursor-paginated table using TanStack Query infinite queries.
 *
 * Renders data from an infinite query with "Load more" pagination. Uses the
 * Table primitives from ui/table.tsx for consistent table styling.
 *
 * The column definition type is kept minimal — callers pass header labels and
 * a cell renderer function. This avoids a heavy table library dependency for
 * the common paginated list case.
 */
import * as React from "react";
import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import type { PaginatedResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnDef<T> {
  /** Column header label */
  header: string;
  /** Unique key for React reconciliation */
  key: string;
  /** Renders a cell for the given row. */
  cell: (row: T) => React.ReactNode;
  /** Optional column header className */
  headerClassName?: string;
  /** Optional cell className */
  cellClassName?: string;
}

export interface InfiniteTableProps<T> {
  // The columns we accept need exact type alignment with PaginatedResponse<T>
  query: UseInfiniteQueryResult<InfiniteData<PaginatedResponse<T>>, Error>;
  columns: ColumnDef<T>[];
  /** Used as the key for each row — must be unique across all pages. */
  rowKey: (row: T) => string;
  /** Shown when the query succeeds but all pages are empty. */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Label for the "load more" button. Defaults to "Load more". */
  loadMoreLabel?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Skeleton rows shown during initial load
// ---------------------------------------------------------------------------

function SkeletonRows({ columnCount, rowCount }: { columnCount: number; rowCount: number }) {
  return (
    <>
      {Array.from({ length: rowCount }).map((_, rowIndex) => (
        <TableRow key={rowIndex}>
          {Array.from({ length: columnCount }).map((_, colIndex) => (
            <TableCell key={colIndex}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// InfiniteTable component
// ---------------------------------------------------------------------------

export function InfiniteTable<T>({
  query,
  columns,
  rowKey,
  emptyTitle = "No results",
  emptyDescription,
  loadMoreLabel = "Load more",
  className,
}: InfiniteTableProps<T>) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  // Flatten all pages into a single row array
  const rows: T[] = React.useMemo(
    () => data?.pages.flatMap((page) => page.data) ?? [],
    [data],
  );

  if (isError) {
    return (
      <EmptyState
        title="Failed to load data"
        description="Check your connection and try again."
        actionLabel="Retry"
        onAction={() => void query.refetch()}
      />
    );
  }

  return (
    <div className={className}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} className={col.headerClassName}>
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <SkeletonRows columnCount={columns.length} rowCount={5} />
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center py-12">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--color-foreground)]">
                    {emptyTitle}
                  </p>
                  {emptyDescription !== undefined && (
                    <p className="text-sm text-[var(--color-muted-foreground)]">
                      {emptyDescription}
                    </p>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={rowKey(row)}>
                {columns.map((col) => (
                  <TableCell key={col.key} className={col.cellClassName}>
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Load more / pagination */}
      {hasNextPage === true && (
        <div className="flex justify-center py-4">
          <Button
            variant="outline"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            aria-busy={isFetchingNextPage}
          >
            {isFetchingNextPage ? (
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                  aria-hidden="true"
                />
                Loading...
              </span>
            ) : (
              loadMoreLabel
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
