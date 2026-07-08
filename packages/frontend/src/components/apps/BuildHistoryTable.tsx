/**
 * BuildHistoryTable — paginated table of builds for an app.
 *
 * Columns: status, duration, triggered by, commit SHA, created date.
 * Provides a "View diff" action per row (diff against current VFS is §11.8).
 */
import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { formatDistanceStrict } from "date-fns";
import { GitCommit } from "lucide-react";
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
import { BuildStatusBadge, type BuildStatus } from "./BuildStatusBadge.js";
import { useApiClient } from "@/lib/api-client.js";
import type { PaginatedResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppBuild {
  id: string;
  appId: string;
  status: BuildStatus;
  /** ISO string when build was created (queued) */
  createdAt: string;
  /** ISO string when build finished; undefined while in progress */
  finishedAt?: string;
  /** Who or what triggered this build: "user:<id>" | "api" | "cli" */
  triggeredBy: string;
  /** Short git commit SHA, if the build was triggered from a commit */
  commitSha?: string;
  /** Short commit message */
  commitMessage?: string;
}

export interface BuildHistoryTableProps {
  appId: string;
  /** Called when user clicks "View diff" on a build row */
  onViewDiff?: (build: AppBuild) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Duration helper
// ---------------------------------------------------------------------------

function buildDuration(build: AppBuild): string {
  if (build.finishedAt === undefined) {
    return "—";
  }
  return formatDistanceStrict(new Date(build.createdAt), new Date(build.finishedAt));
}

function formatTriggeredBy(value: string): string {
  if (value.startsWith("user:")) return `User ${value.slice(5).slice(0, 8)}`;
  if (value === "api") return "API";
  if (value === "cli") return "CLI";
  return value;
}

// ---------------------------------------------------------------------------
// BuildHistoryTable component
// ---------------------------------------------------------------------------

export function BuildHistoryTable({ appId, onViewDiff, className }: BuildHistoryTableProps) {
  const client = useApiClient();

  const query = useInfiniteQuery({
    queryKey: ["apps", appId, "builds"],
    queryFn: ({ pageParam, signal }) =>
      client.get<PaginatedResponse<AppBuild>>(
        `/v1/apps/${appId}/builds`,
        {
          limit: "20",
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        },
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.pagination?.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
  });

  const builds: AppBuild[] = React.useMemo(
    () => query.data?.pages.flatMap((p) => p.data) ?? [],
    [query.data],
  );

  if (query.isLoading) {
    return (
      <div className={className}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Triggered by</TableHead>
              <TableHead>Commit</TableHead>
              <TableHead>Started</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 6 }).map((__, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className={className}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Triggered by</TableHead>
            <TableHead>Commit</TableHead>
            <TableHead>Started</TableHead>
            {onViewDiff !== undefined && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {builds.length === 0 ? (
            <TableRow>
              <TableCell colSpan={onViewDiff !== undefined ? 6 : 5} className="py-12 text-center text-sm text-[var(--color-muted-foreground)]">
                No builds yet. Trigger a build from the editor.
              </TableCell>
            </TableRow>
          ) : (
            builds.map((build) => (
              <TableRow key={build.id}>
                <TableCell>
                  <BuildStatusBadge status={build.status} />
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {buildDuration(build)}
                </TableCell>
                <TableCell className="text-sm">
                  {formatTriggeredBy(build.triggeredBy)}
                </TableCell>
                <TableCell className="text-sm">
                  {build.commitSha !== undefined ? (
                    <span className="flex items-center gap-1.5">
                      <GitCommit className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                      <span
                        className="font-mono text-xs"
                        title={build.commitMessage}
                      >
                        {build.commitSha.slice(0, 7)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-[var(--color-muted-foreground)]">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  <RelativeTime value={build.createdAt} />
                </TableCell>
                {onViewDiff !== undefined && (
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onViewDiff(build)}
                    >
                      View diff
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {query.hasNextPage === true && (
        <div className="flex justify-center py-4">
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            aria-busy={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
