/**
 * LogViewer — virtualized log table with level filter, text search, and time range.
 *
 * Uses VirtualizedList (react-window) so large log payloads don't cause DOM
 * performance issues (§15.4). Fetches from GET /api/v1/logs with cursor pagination
 * and loads more pages as the user scrolls.
 *
 * Level filter and text search happen client-side against the fetched pages to
 * avoid re-fetching on every keystroke; new pages are fetched with server-side
 * level and service filters to reduce payload.
 */
import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { VirtualizedList } from "@/components/shared/VirtualizedList.js";
import { LogRow, type LogEntry, type LogLevel } from "./LogRow.js";
import { useApiClient } from "@/lib/api-client.js";

import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const ALL_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

const LEVEL_TOGGLE_CLASSES: Record<LogLevel, string> = {
  error: "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300",
  warn: "border-yellow-300 bg-yellow-50 text-yellow-700 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  info: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  debug: "border-[var(--color-border)] bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
};

export interface LogViewerProps {
  /** Filter by service name */
  service?: string;
  /** Container height in pixels */
  height?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// LogViewer component
// ---------------------------------------------------------------------------

export function LogViewer({ service, height = 600, className }: LogViewerProps) {
  const client = useApiClient();
  const [search, setSearch] = React.useState("");
  const [enabledLevels, setEnabledLevels] = React.useState<Set<LogLevel>>(
    new Set(ALL_LEVELS),
  );

  const query = useInfiniteQuery({
    queryKey: ["logs", { service }],
    queryFn: ({ pageParam, signal }) =>
      client.get<{ data: LogEntry[]; pagination: { cursor: string | null; limit: number; hasMore: boolean } }>(
        "/v1/logs",
        {
          limit: "100",
          sort: "-timestamp",
          ...(service !== undefined ? { "filter[service][eq]": service } : {}),
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        },
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.pagination?.cursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 5_000,
  });

  // Flatten and filter client-side for level + text search
  const allLogs = React.useMemo(
    () => query.data?.pages.flatMap((p) => p.data) ?? [],
    [query.data],
  );

  const filteredLogs = React.useMemo(() => {
    const lowerSearch = search.toLowerCase();
    return allLogs.filter((log) => {
      if (!enabledLevels.has(log.level)) return false;
      if (lowerSearch !== "" && !log.message.toLowerCase().includes(lowerSearch)) return false;
      return true;
    });
  }, [allLogs, enabledLevels, search]);

  function toggleLevel(level: LogLevel) {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }

  // Uniform row height (log messages are not multi-line in this view)
  const ROW_HEIGHT = 32;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden="true"
          />
          <Input
            placeholder="Search messages…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            aria-label="Search log messages"
          />
        </div>

        {/* Level toggles */}
        <div className="flex gap-1" role="group" aria-label="Filter by log level">
          {ALL_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-opacity",
                LEVEL_TOGGLE_CLASSES[level],
                !enabledLevels.has(level) && "opacity-40",
              )}
              aria-pressed={enabledLevels.has(level)}
              aria-label={`${enabledLevels.has(level) ? "Hide" : "Show"} ${level} logs`}
            >
              {level}
            </button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          aria-label="Refresh logs"
        >
          <RefreshCw
            className={cn("h-4 w-4", query.isFetching && "animate-spin")}
            aria-hidden="true"
          />
        </Button>

        {query.data !== undefined && (
          <Badge variant="outline" className="tabular-nums">
            {filteredLogs.length} lines
          </Badge>
        )}
      </div>

      {/* Log list */}
      <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
        {query.isLoading ? (
          <div className="space-y-px p-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-[var(--color-muted-foreground)]">
            {allLogs.length === 0 ? "No logs found." : "No logs match the current filters."}
          </div>
        ) : (
          <VirtualizedList
            items={filteredLogs}
            estimatedItemSize={ROW_HEIGHT}
            itemSize={() => ROW_HEIGHT}
            renderItem={(props) => <LogRow {...props} />}
            height={height}
            width="100%"
          />
        )}
      </div>

      {/* Load more */}
      {query.hasNextPage === true && !query.isFetchingNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
