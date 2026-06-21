/**
 * InfiniteTable — cursor-paginated table using TanStack Query infinite queries.
 *
 * Renders data from an infinite query with "Load more" pagination. Uses the
 * Table primitives from ui/table.tsx for consistent table styling.
 *
 * The column definition type is kept minimal — callers pass header labels and
 * a cell renderer function. This avoids a heavy table library dependency for
 * the common paginated list case.
 *
 * Mobile UX (MU-007): the scroll container uses scroll-snap for smoother
 * column panning and shows edge shadow indicators when content overflows
 * horizontally. A one-time "Scroll" hint fades out after 2 s on first render
 * so mobile users know the table is horizontally scrollable.
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
// ScrollableTableContainer — wraps the table with mobile overflow UX
// ---------------------------------------------------------------------------

/**
 * Wraps its children in an overflow-x:auto container and renders left/right
 * gradient shadow indicators whenever content can be scrolled in that direction.
 * The shadows appear/disappear reactively as the user scrolls.
 *
 * A "Scroll" text hint (aria-hidden) is shown on first mount and fades out
 * after 2 seconds — it only appears when the table is actually overflowing,
 * so it never shows on desktop where the full table fits in the viewport.
 */
function ScrollableTableContainer({ children }: { children: React.ReactNode }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);
  // Show the scroll hint on first render; it fades out automatically after 2 s.
  const [showHint, setShowHint] = React.useState(true);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;

    function update() {
      if (el === null) return;
      setCanScrollLeft(el.scrollLeft > 0);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    }

    update();
    el.addEventListener("scroll", update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, []);

  // Dismiss the scroll hint after 2 s — it's a one-time orientation aid.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setShowHint(false);
    }, 2000);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="relative">
      {/* Left scroll shadow — only visible when the user has scrolled right */}
      {canScrollLeft && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-gradient-to-r from-[var(--color-background,#fff)] to-transparent"
          aria-hidden="true"
        />
      )}

      {/* Right scroll shadow + optional scroll hint — only when content overflows */}
      {canScrollRight && (
        <>
          <div
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-[var(--color-background,#fff)] to-transparent"
            aria-hidden="true"
          />
          {showHint && (
            <div
              className="pointer-events-none absolute bottom-2 right-2 z-20 rounded bg-[var(--color-foreground,#111)]/70 px-2 py-0.5 text-[10px] text-white transition-opacity duration-700"
              aria-hidden="true"
              // Inline opacity transition driven by state so no extra CSS needed
              style={{ opacity: showHint ? 1 : 0 }}
            >
              Scroll →
            </div>
          )}
        </>
      )}

      {/* scroll-snap-type gives smoother column-by-column panning on mobile */}
      <div
        ref={scrollRef}
        className="overflow-x-auto"
        style={{ scrollSnapType: "x proximity" }}
      >
        {children}
      </div>
    </div>
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
      <ScrollableTableContainer>
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
      </ScrollableTableContainer>

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
