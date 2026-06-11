/**
 * PipelineDetailPage — pipeline overview, run history, and settings.
 * Route: /pipelines/$id
 */
import React from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { RunHistoryTable } from "@/components/pipelines/RunHistoryTable.js";
import { RunStatusBadge } from "@/components/pipelines/RunStatusBadge.js";
import { useApiClient, type ApiResponse, type PaginatedResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { RunStatus } from "@/components/pipelines/RunStatusBadge.js";
import type { TriggerType } from "@/components/pipelines/PipelineCard.js";
import type { PipelineRun } from "@/components/pipelines/RunHistoryTable.js";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface PipelineDetail {
  id: string;
  name: string;
  triggerType: TriggerType;
  cronExpression?: string;
  lastRunStatus?: RunStatus;
  lastRunAt?: string;
  nextRunAt?: string;
  stepCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// PipelineDetailPage component
// ---------------------------------------------------------------------------

export function PipelineDetailPage() {
  const { id } = useParams({ from: "/authenticated/pipelines/$id" });
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["pipelines", id],
    queryFn: () => client.get<ApiResponse<PipelineDetail>>(`/v1/pipelines/${id}`),
  });

  const runsQuery = useInfiniteQuery({
    queryKey: ["pipelines", id, "runs"],
    queryFn: ({ pageParam }) =>
      client.get<PaginatedResponse<PipelineRun>>(
        `/v1/pipelines/${id}/runs`,
        { ...(pageParam !== undefined ? { cursor: pageParam as string } : {}) },
      ),
    getNextPageParam: (lastPage) => lastPage.pagination.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
  });

  const triggerRun = useMutation({
    mutationFn: () => client.post<void>(`/v1/pipelines/${id}/trigger`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pipelines", id, "runs"] });
      toast({ title: "Pipeline triggered" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to trigger pipeline";
      toast({ title: message, variant: "destructive" });
    },
  });

  const deletePipeline = useMutation({
    mutationFn: () => client.delete(`/v1/pipelines/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
      toast({ title: "Pipeline deleted" });
      void navigate({ to: "/pipelines" });
    },
  });

  const pipeline = data?.data;

  if (isError) {
    return (
      <main id="main-content" tabIndex={-1} className="flex-1 p-6">
        <EmptyState
          title="Pipeline not found"
          actionLabel="Back to pipelines"
          onAction={() => void navigate({ to: "/pipelines" })}
        />
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto">
      <PageHeader
        title={isLoading ? "Loading…" : (pipeline?.name ?? id)}
        breadcrumbs={[
          { label: "Platform" },
          { label: "Pipelines", href: "/pipelines" },
          { label: pipeline?.name ?? id },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigate({ to: "/pipelines/$id/edit", params: { id } })}
            >
              <Pencil className="h-4 w-4" aria-hidden />
              Edit
            </Button>
            <Button
              size="sm"
              onClick={() => triggerRun.mutate()}
              disabled={triggerRun.isPending}
              aria-busy={triggerRun.isPending}
            >
              <Play className="h-4 w-4" aria-hidden />
              {triggerRun.isPending ? "Triggering…" : "Run now"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-[var(--color-destructive)]"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        }
      />

      <div className="p-6">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : pipeline !== undefined ? (
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="runs">Run History</TabsTrigger>
            </TabsList>

            {/* Overview */}
            <TabsContent value="overview" className="mt-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                      Last run
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {pipeline.lastRunStatus !== undefined && (
                      <RunStatusBadge status={pipeline.lastRunStatus} />
                    )}
                    {pipeline.lastRunAt !== undefined && (
                      <RelativeTime value={pipeline.lastRunAt} className="text-xs text-[var(--color-muted-foreground)]" />
                    )}
                    {pipeline.lastRunStatus === undefined && (
                      <span className="text-sm text-[var(--color-muted-foreground)]">Never run</span>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                      Trigger
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm capitalize">{pipeline.triggerType}</p>
                    {pipeline.cronExpression !== undefined && (
                      <p className="mt-0.5 font-mono text-xs text-[var(--color-muted-foreground)]">
                        {pipeline.cronExpression}
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                      Next run
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {pipeline.nextRunAt !== undefined ? (
                      <RelativeTime value={pipeline.nextRunAt} className="text-sm" />
                    ) : (
                      <span className="text-sm text-[var(--color-muted-foreground)]">—</span>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
                      Steps
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <span className="text-sm">{pipeline.stepCount}</span>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            {/* Runs */}
            <TabsContent value="runs" className="mt-4">
              <RunHistoryTable query={runsQuery} />
            </TabsContent>
          </Tabs>
        ) : null}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete pipeline?"
        description="All run history and schedules for this pipeline will be permanently deleted."
        confirmLabel="Delete pipeline"
        onConfirm={() => deletePipeline.mutate()}
        isLoading={deletePipeline.isPending}
      />
    </main>
  );
}
