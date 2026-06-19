/**
 * AuditLogTable — cursor-paginated table of audit events.
 *
 * Columns: timestamp, actor, action, resource, trace ID.
 * Uses InfiniteTable for consistent cursor pagination UI.
 */
import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input.js";
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
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { TraceIdLink } from "./TraceIdLink.js";
import { useApiClient } from "@/lib/api-client.js";
import type { PaginatedResponse } from "@/lib/api-client.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  traceId: string;
  actorId: string;
  actorType: string;
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogTableProps {
  /** Optional date range filter */
  from?: string;
  to?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// AuditLogTable component
// ---------------------------------------------------------------------------

export function AuditLogTable({ from, to, className }: AuditLogTableProps) {
  const client = useApiClient();
  const [search, setSearch] = React.useState("");

  const query = useInfiniteQuery({
    queryKey: ["audit-logs", { from, to }],
    queryFn: ({ pageParam, signal }) =>
      client.get<PaginatedResponse<AuditEvent>>(
        "/v1/audit-events",
        {
          limit: "50",
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        },
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.pagination.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
  });

  const allEvents = React.useMemo(
    () => query.data?.pages.flatMap((p) => p.data) ?? [],
    [query.data],
  );

  const filteredEvents = React.useMemo(() => {
    if (search === "") return allEvents;
    const lower = search.toLowerCase();
    return allEvents.filter(
      (e) =>
        e.actorId.toLowerCase().includes(lower) ||
        e.action.toLowerCase().includes(lower) ||
        e.resourceType.toLowerCase().includes(lower) ||
        e.resourceId.toLowerCase().includes(lower),
    );
  }, [allEvents, search]);

  return (
    <div className={cn("space-y-3", className)}>
      {/* Search */}
      <div className="relative max-w-sm">
        <Search
          className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
          aria-hidden="true"
        />
        <Input
          placeholder="Search actor, action, resource type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8"
          aria-label="Search audit log (searches loaded results)"
        />
        {search !== "" && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-[var(--color-muted-foreground)] pointer-events-none">
            (searches loaded results)
          </span>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Resource</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Trace</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.isLoading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 6 }).map((__, j) => (
                  <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                ))}
              </TableRow>
            ))
          ) : filteredEvents.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">
                No audit events found.
              </TableCell>
            </TableRow>
          ) : (
            filteredEvents.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="text-sm tabular-nums">
                  <RelativeTime value={event.createdAt} />
                </TableCell>
                <TableCell className="max-w-[120px] truncate font-mono text-xs">
                  <span title={`${event.actorType}:${event.actorId}`}>
                    {event.actorType === "user"
                      ? `User ${event.actorId.slice(0, 8)}...`
                      : event.actorType === "api-key"
                        ? `Key ${event.actorId.slice(0, 8)}...`
                        : `${event.actorType}:${event.actorId.slice(0, 8)}...`}
                  </span>
                </TableCell>
                <TableCell className="text-sm">{event.action}</TableCell>
                <TableCell className="max-w-[180px] truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                  {event.resourceType}:{event.resourceId}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-semibold",
                      event.result === "success"
                        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                        : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
                    )}
                    role="status"
                  >
                    {event.result}
                  </span>
                </TableCell>
                <TableCell>
                  {event.traceId ? (
                    <TraceIdLink traceId={event.traceId} />
                  ) : (
                    <span className="text-[var(--color-muted-foreground)]">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {query.hasNextPage === true && (
        <div className="flex justify-center py-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
