/**
 * RunHistoryTable — paginated table of pipeline run history.
 *
 * Uses InfiniteTable for cursor-based pagination. Columns: status, trigger,
 * started time, duration. Each row links to the run detail page.
 */
import * as React from "react";
import type { UseInfiniteQueryResult, InfiniteData } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InfiniteTable, type ColumnDef } from "@/components/shared/InfiniteTable.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import type { PaginatedResponse } from "@/lib/api-client.js";
import { RunStatusBadge, type RunStatus } from "./RunStatusBadge.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineRun {
  id: string;
  status: RunStatus;
  /** "manual" | "cron" | "event" | "api" */
  triggeredBy: string;
  startedAt: string;
  /** ISO string; undefined while still running */
  completedAt?: string;
  /** Error message; only present when status === "failed" */
  error?: string;
}

export interface RunHistoryTableProps {
  query: UseInfiniteQueryResult<InfiniteData<PaginatedResponse<PipelineRun>>, Error>;
}

// ---------------------------------------------------------------------------
// Duration formatter
// ---------------------------------------------------------------------------

function formatDuration(startedAt: string, completedAt?: string): string {
  const end = completedAt !== undefined ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - new Date(startedAt).getTime();
  if (diffMs < 0) return "—";

  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDef<PipelineRun>[] = [
  {
    key: "status",
    header: "Status",
    cell: (run) => <RunStatusBadge status={run.status} />,
    headerClassName: "w-28",
  },
  {
    key: "trigger",
    header: "Trigger",
    cell: (run) => (
      <span className="capitalize text-sm text-[var(--color-muted-foreground)]">
        {run.triggeredBy}
      </span>
    ),
  },
  {
    key: "started",
    header: "Started",
    cell: (run) => <RelativeTime value={run.startedAt} className="text-sm" />,
  },
  {
    key: "duration",
    header: "Duration",
    cell: (run) => (
      <span className="text-sm text-[var(--color-muted-foreground)]">
        {formatDuration(run.startedAt, run.completedAt)}
      </span>
    ),
  },
  {
    key: "actions",
    header: "",
    cell: (run) => (
      <Link
        to="/pipeline-runs/$runId"
        params={{ runId: run.id }}
        className="text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] rounded-sm"
      >
        View logs
      </Link>
    ),
    headerClassName: "w-24",
  },
];

// ---------------------------------------------------------------------------
// RunHistoryTable component
// ---------------------------------------------------------------------------

export function RunHistoryTable({ query }: RunHistoryTableProps) {
  return (
    <InfiniteTable<PipelineRun>
      query={query}
      columns={COLUMNS}
      rowKey={(run) => run.id}
      emptyTitle="No runs yet"
      emptyDescription="Trigger the pipeline manually or wait for the next scheduled run."
      loadMoreLabel="Load more runs"
    />
  );
}
