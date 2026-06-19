/**
 * RunDetailPage — single pipeline run detail page with SSE log streaming.
 * Route: /pipeline-runs/$runId
 */
import React from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { RunStatusBadge } from "@/components/pipelines/RunStatusBadge.js";
import { RunLogViewer } from "@/components/pipelines/RunLogViewer.js";
import { useApiClient, type ApiResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { RunStatus } from "@/components/pipelines/RunStatusBadge.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunDetail {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: RunStatus;
  triggeredBy: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Friendly trigger labels
// ---------------------------------------------------------------------------

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual trigger",
  schedule: "Scheduled run",
  cron: "Scheduled (cron)",
  webhook: "Webhook trigger",
  api: "API call",
  event: "Event-driven",
  retry: "Automatic retry",
  system: "System trigger",
  user: "User-initiated",
};

function getFriendlyTrigger(raw: string): string {
  return TRIGGER_LABELS[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ---------------------------------------------------------------------------
// Error classification for run errors
// ---------------------------------------------------------------------------

interface ClassifiedRunError {
  category: string;
  title: string;
  suggestion: string;
}

function classifyRunError(error: string): ClassifiedRunError {
  const lower = error.toLowerCase();

  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline")) {
    return {
      category: "Timeout",
      title: "Execution timed out",
      suggestion: "Consider increasing the timeout limit or optimizing the step that timed out.",
    };
  }
  if (lower.includes("permission") || lower.includes("forbidden") || lower.includes("unauthorized") || lower.includes("access denied")) {
    return {
      category: "Permission",
      title: "Permission denied",
      suggestion: "Check that the pipeline's service account has the required permissions for all connected resources.",
    };
  }
  if (lower.includes("connection") || lower.includes("network") || lower.includes("econnrefused") || lower.includes("enotfound")) {
    return {
      category: "Connection",
      title: "Connection failed",
      suggestion: "Verify that all external services and databases are reachable. Check network configuration and firewall rules.",
    };
  }
  if (lower.includes("syntax") || lower.includes("parse") || lower.includes("unexpected token") || lower.includes("invalid")) {
    return {
      category: "Validation",
      title: "Validation or syntax error",
      suggestion: "Review the pipeline step configuration for syntax errors or invalid data.",
    };
  }
  if (lower.includes("memory") || lower.includes("oom") || lower.includes("heap")) {
    return {
      category: "Resource",
      title: "Out of memory",
      suggestion: "The pipeline ran out of memory. Try processing data in smaller batches or increasing resource limits.",
    };
  }
  return {
    category: "Error",
    title: "Execution failed",
    suggestion: "Review the error details and logs below for more information.",
  };
}

// ---------------------------------------------------------------------------
// Run number helper — derive a short run number from the run ID
// ---------------------------------------------------------------------------

function formatRunNumber(runId: string): string {
  // Use the first 8 hex chars as a short identifier
  return `#${runId.slice(0, 8).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Duration helper
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
// RunDetailPage component
// ---------------------------------------------------------------------------

export function RunDetailPage() {
  const { runId } = useParams({ from: "/authenticated/pipeline-runs/$runId" });
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["pipeline-runs", runId],
    queryFn: () => client.get<ApiResponse<RunDetail>>(`/v1/pipeline-runs/${runId}`),
    // Refresh every 5s while run is still active
    refetchInterval: (query) => {
      const run = query.state.data?.data;
      if (run === undefined) return false;
      return run.status === "running" || run.status === "queued" ? 5000 : false;
    },
  });

  const cancelRun = useMutation({
    mutationFn: () => client.post<void>(`/v1/pipeline-runs/${runId}/cancel`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pipeline-runs", runId] });
      toast({ title: "Run cancelled" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to cancel run";
      toast({ title: message, variant: "destructive" });
    },
  });

  const run = data?.data;

  if (isError) {
    return (
      <div className="flex-1 p-6">
        <EmptyState
          title="Run not found"
          actionLabel="Back to pipelines"
          onAction={() => void navigate({ to: "/pipelines" })}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title={run ? `${run.pipelineName} ${formatRunNumber(runId)}` : `Run ${formatRunNumber(runId)}`}
        breadcrumbs={[
          { label: "Platform" },
          { label: "Pipelines", href: "/pipelines" },
          ...(run !== undefined
            ? [{ label: run.pipelineName, href: `/pipelines/${run.pipelineId}` }]
            : []),
          { label: "Run" },
        ]}
        actions={
          run?.status === "running" || run?.status === "queued" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => cancelRun.mutate()}
              disabled={cancelRun.isPending}
              className="text-[var(--color-destructive)]"
            >
              <X className="h-4 w-4" aria-hidden />
              Cancel run
            </Button>
          ) : undefined
        }
      />

      <div className="p-6 space-y-4">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : run !== undefined ? (
          <>
            {/* Run metadata */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                    Status
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RunStatusBadge status={run.status} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                    Triggered by
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm">{getFriendlyTrigger(run.triggeredBy)}</CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                    Started
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <RelativeTime value={run.startedAt} className="text-sm" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                    Duration
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm">
                  {formatDuration(run.startedAt, run.completedAt)}
                </CardContent>
              </Card>
            </div>

            {/* Error message — categorized with actionable suggestions */}
            {run.error !== undefined && (() => {
              const classified = classifyRunError(run.error);
              return (
                <div
                  className="rounded-md border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/10 px-4 py-3"
                  role="alert"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-[var(--color-destructive)]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-destructive)] uppercase tracking-wide">
                      {classified.category}
                    </span>
                    <p className="text-sm font-semibold text-[var(--color-destructive)]">{classified.title}</p>
                  </div>
                  <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{run.error}</p>
                  <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)] italic">{classified.suggestion}</p>
                </div>
              );
            })()}

            {/* Log viewer */}
            <div>
              <h2 className="mb-3 text-sm font-semibold">Logs</h2>
              <RunLogViewer runId={runId} height={500} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
