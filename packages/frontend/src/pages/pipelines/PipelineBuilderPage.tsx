/**
 * PipelineBuilderPage — full-page pipeline builder.
 * Route: /pipelines/$id/edit (id === "new" for creation)
 */
import React from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { PipelineBuilder } from "@/components/pipelines/PipelineBuilder.js";
import { useApiClient, type ApiResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PipelineStep } from "@/components/pipelines/PipelineStepNode.js";
import type { TriggerType } from "@/components/pipelines/PipelineCard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineConfig {
  id: string;
  name: string;
  triggerType: TriggerType;
  cronExpression?: string;
  steps: PipelineStep[];
}

// ---------------------------------------------------------------------------
// PipelineBuilderPage component
// ---------------------------------------------------------------------------

export function PipelineBuilderPage() {
  const { id } = useParams({ from: "/authenticated/pipelines/$id/edit" });
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isNew = id === "new";

  const [name, setName] = React.useState("");
  const [triggerType, setTriggerType] = React.useState<TriggerType>("manual");
  const [cronExpression, setCronExpression] = React.useState("");
  const [initialSteps, setInitialSteps] = React.useState<PipelineStep[]>([]);
  const [loaded, setLoaded] = React.useState(isNew);

  const { isLoading } = useQuery({
    queryKey: ["pipelines", id],
    queryFn: () => client.get<ApiResponse<PipelineConfig>>(`/v1/pipelines/${id}`),
    enabled: !isNew,
    select: (data) => data.data,
    // Populate local state once loaded
  });

  // We use a separate query with onSuccess behavior
  const { data: pipelineData } = useQuery({
    queryKey: ["pipelines", id],
    queryFn: () => client.get<ApiResponse<PipelineConfig>>(`/v1/pipelines/${id}`),
    enabled: !isNew,
  });

  // Populate form state from fetched data (once)
  React.useEffect(() => {
    if (pipelineData?.data !== undefined && !loaded) {
      const p = pipelineData.data;
      setName(p.name);
      setTriggerType(p.triggerType);
      if (p.cronExpression !== undefined) setCronExpression(p.cronExpression);
      setInitialSteps(p.steps);
      setLoaded(true);
    }
  }, [pipelineData, loaded]);

  const createPipeline = useMutation({
    mutationFn: (body: { name: string; triggerType: TriggerType; cronExpression?: string; steps: PipelineStep[] }) =>
      client.post<ApiResponse<{ id: string }>>("/v1/pipelines", body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
      toast({ title: "Pipeline created" });
      void navigate({ to: "/pipelines/$id", params: { id: result.data.id } });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to create pipeline";
      toast({ title: message, variant: "destructive" });
    },
  });

  const updatePipeline = useMutation({
    mutationFn: (body: { name: string; triggerType: TriggerType; cronExpression?: string; steps: PipelineStep[] }) =>
      client.patch<ApiResponse<PipelineConfig>>(`/v1/pipelines/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
      void queryClient.invalidateQueries({ queryKey: ["pipelines", id] });
      toast({ title: "Pipeline saved" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to save pipeline";
      toast({ title: message, variant: "destructive" });
    },
  });

  const isSaving = createPipeline.isPending || updatePipeline.isPending;

  async function handleSave(steps: PipelineStep[]) {
    const body = {
      name,
      triggerType,
      ...(triggerType === "cron" && cronExpression.trim().length > 0
        ? { cronExpression: cronExpression.trim() }
        : {}),
      steps,
    };
    if (isNew) {
      createPipeline.mutate(body);
    } else {
      updatePipeline.mutate(body);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title={isNew ? "New pipeline" : "Edit pipeline"}
        breadcrumbs={[
          { label: "Platform" },
          { label: "Pipelines", href: "/pipelines" },
          { label: isNew ? "New" : (pipelineData?.data?.name ?? id) },
        ]}
      />

      <div className="p-6 max-w-2xl space-y-6">
        {!isNew && isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <>
            {/* Pipeline metadata */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pipeline-name">
                  Name
                  <span className="ml-1 text-[var(--color-destructive)]" aria-hidden>*</span>
                </Label>
                <Input
                  id="pipeline-name"
                  placeholder="e.g. Sync customers daily"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="pipeline-trigger">Trigger type</Label>
                <Select
                  value={triggerType}
                  onValueChange={(v) => setTriggerType(v as TriggerType)}
                >
                  <SelectTrigger id="pipeline-trigger">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="cron">Scheduled (cron)</SelectItem>
                    <SelectItem value="event">Event-driven</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {triggerType === "cron" && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="cron-expression">Cron expression</Label>
                  <Input
                    id="cron-expression"
                    placeholder="e.g. 0 2 * * * (every day at 2am)"
                    value={cronExpression}
                    onChange={(e) => setCronExpression(e.target.value)}
                    className="font-mono"
                  />
                </div>
              )}
            </div>

            {/* Step builder */}
            <div>
              <h2 className="mb-3 text-sm font-semibold">Pipeline steps</h2>
              {loaded && (
                <PipelineBuilder
                  initialSteps={initialSteps}
                  onSave={(steps) => void handleSave(steps)}
                  isSaving={isSaving}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
