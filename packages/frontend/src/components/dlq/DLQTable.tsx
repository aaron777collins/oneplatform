/**
 * DLQTable — table listing dead-letter queue jobs.
 *
 * Columns: job ID, queue name, error message, failed at, retry count, actions.
 * Clicking a row expands the DLQJobDetail inline. Supports bulk replay/discard.
 */
import * as React from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
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
import { DLQActions } from "./DLQActions.js";
import { DLQJobDetail } from "./DLQJobDetail.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PaginatedResponse } from "@/lib/api-client.js";
import { truncate } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DLQJob {
  id: string;
  queueName: string;
  errorMessage: string;
  errorStack?: string;
  failedAt: string;
  retryCount: number;
  /** Original job payload — arbitrary object */
  payload: unknown;
}

export interface DLQTableProps {
  /** Optional queue name filter */
  queueName?: string;
  /** Optional search string filter (client-side on errorMessage) */
  search?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// DLQTable component
// ---------------------------------------------------------------------------

export function DLQTable({ queueName, search = "", className }: DLQTableProps) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: ["dlq", { queueName }],
    queryFn: ({ pageParam, signal }) =>
      client.get<PaginatedResponse<DLQJob>>(
        "/v1/dlq",
        {
          limit: "50",
          sort: "-failedAt",
          ...(queueName !== undefined ? { "filter[queueName][eq]": queueName } : {}),
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        },
        { signal },
      ),
    getNextPageParam: (lastPage) => {
      const inner = (lastPage as any)?.data ?? lastPage;
      return inner?.pagination?.nextCursor ?? undefined;
    },
    initialPageParam: undefined as string | undefined,
  });

  const allJobs = React.useMemo(
    () =>
      query.data?.pages.flatMap((p) => {
        const inner = (p as any)?.data ?? p;
        return Array.isArray(inner?.data) ? inner.data : Array.isArray(inner) ? inner : [];
      }) ?? [],
    [query.data],
  );

  const filteredJobs = React.useMemo(() => {
    if (search === "") return allJobs;
    const lower = search.toLowerCase();
    return allJobs.filter(
      (j) =>
        j.errorMessage.toLowerCase().includes(lower) ||
        j.queueName.toLowerCase().includes(lower) ||
        j.id.toLowerCase().includes(lower),
    );
  }, [allJobs, search]);

  const replayMutation = useMutation({
    mutationFn: (jobId: string) =>
      client.post(`/v1/dlq/${jobId}/replay`),
    onSuccess: () => {
      toast({ title: "Job requeued" });
      void queryClient.invalidateQueries({ queryKey: ["dlq"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Replay failed.";
      toast({ title: "Replay failed", description: message, variant: "destructive" });
    },
  });

  const discardMutation = useMutation({
    mutationFn: (jobId: string) =>
      client.delete(`/v1/dlq/${jobId}`),
    onSuccess: () => {
      toast({ title: "Job discarded" });
      void queryClient.invalidateQueries({ queryKey: ["dlq"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Discard failed.";
      toast({ title: "Discard failed", description: message, variant: "destructive" });
    },
  });

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <div className={className}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Job ID</TableHead>
            <TableHead>Queue</TableHead>
            <TableHead>Error</TableHead>
            <TableHead>Failed</TableHead>
            <TableHead>Retries</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 7 }).map((__, j) => (
                  <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                ))}
              </TableRow>
            ))
          ) : filteredJobs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">
                {allJobs.length === 0 ? "Dead letter queue is empty." : "No jobs match the current filters."}
              </TableCell>
            </TableRow>
          ) : (
            filteredJobs.flatMap((job) => {
              const isExpanded = expandedId === job.id;
              return [
                <TableRow
                  key={job.id}
                  className="cursor-pointer hover:bg-[var(--color-muted)]/50"
                  onClick={() => toggleExpand(job.id)}
                >
                  <TableCell>
                    <span aria-hidden="true">
                      {isExpanded
                        ? <ChevronDown className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                        : <ChevronRight className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                      }
                    </span>
                    <span className="sr-only">{isExpanded ? "Collapse" : "Expand"} details</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{job.id.slice(0, 8)}</TableCell>
                  <TableCell className="text-sm">{job.queueName}</TableCell>
                  <TableCell className="max-w-[240px] text-sm text-[var(--color-destructive)]">
                    {truncate(job.errorMessage, 80)}
                  </TableCell>
                  <TableCell className="text-sm">
                    <RelativeTime value={job.failedAt} />
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">{job.retryCount}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DLQActions
                      jobId={job.id}
                      onReplay={(id) => replayMutation.mutate(id)}
                      onDiscard={(id) => discardMutation.mutate(id)}
                      isReplaying={replayMutation.isPending && replayMutation.variables === job.id}
                      isDiscarding={discardMutation.isPending && discardMutation.variables === job.id}
                    />
                  </TableCell>
                </TableRow>,
                isExpanded && (
                  <TableRow key={`${job.id}-detail`} className="bg-[var(--color-muted)]/30">
                    <TableCell colSpan={7} className="p-4">
                      <DLQJobDetail
                        job={job}
                        onRetry={(id) => replayMutation.mutate(id)}
                        isRetrying={replayMutation.isPending && replayMutation.variables === job.id}
                      />
                    </TableCell>
                  </TableRow>
                ),
              ].filter(Boolean);
            })
          )}
        </TableBody>
      </Table>

      {query.hasNextPage === true && (
        <div className="flex justify-center py-4">
          <Button
            variant="outline"
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
