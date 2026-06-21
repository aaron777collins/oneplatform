/**
 * PipelineBuilderPage — full-page pipeline builder.
 * Route: /pipelines/$id/edit (id === "new" for creation)
 *
 * When creating a new pipeline (id === "new") we show the TemplateGallery
 * wizard first. The wizard collects the trigger type, name, and optionally a
 * starting template graph. Once the user completes the wizard we move to the
 * standard visual editor pre-populated with that data.
 *
 * Editing an existing pipeline skips the wizard entirely and goes straight to
 * the editor with the data loaded from the API.
 */
import React from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { PipelineBuilder } from "@/components/pipelines/PipelineBuilder.js";
import { VisualPipelineEditor } from "@/components/pipeline-editor/VisualPipelineEditor.js";
import { TemplateGallery, type TemplateGalleryResult } from "@/components/pipeline-editor/TemplateGallery.js";
import { ScheduleBuilder } from "@/components/pipelines/ScheduleBuilder.js";
import { useApiClient, type ApiResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PipelineStep } from "@/components/pipelines/PipelineStepNode.js";
import type { TriggerType } from "@/components/pipelines/PipelineCard.js";
import type { PipelineGraph } from "@/components/pipeline-editor/graph-model.js";
import { graphToPipelineDefinition } from "@/components/pipeline-editor/graph-converter.js";

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
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [triggerType, setTriggerType] = React.useState<TriggerType>("manual");
  const [cronExpression, setCronExpression] = React.useState("");
  const [initialSteps, setInitialSteps] = React.useState<PipelineStep[]>([]);
  const [loaded, setLoaded] = React.useState(isNew);
  const [editorMode, setEditorMode] = React.useState<"visual" | "steps">("visual");

  // When creating a new pipeline, the wizard is shown until the user completes
  // or skips it. Once dismissed, wizardDismissed stays true for the session.
  const [wizardDismissed, setWizardDismissed] = React.useState(false);
  // Template graph chosen in the wizard (undefined = start blank)
  const [templateGraph, setTemplateGraph] = React.useState<PipelineGraph | undefined>(undefined);

  const showWizard = isNew && !wizardDismissed;

  // Listen for "Switch to Visual Editor" event from PipelineBuilder component
  React.useEffect(() => {
    function handleSwitchToVisual() {
      setEditorMode("visual");
    }
    window.addEventListener("switch-to-visual-editor", handleSwitchToVisual);
    return () => window.removeEventListener("switch-to-visual-editor", handleSwitchToVisual);
  }, []);

  const { data: pipelineData, isLoading } = useQuery({
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
    if (name.trim().length === 0) {
      setNameError("Pipeline name is required.");
      return;
    }
    setNameError(null);
    const body = {
      name: name.trim(),
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

  // -------------------------------------------------------------------------
  // Wizard completion handler
  // -------------------------------------------------------------------------

  function handleWizardComplete(result: TemplateGalleryResult) {
    setName(result.name);
    setTriggerType(result.triggerType);
    setTemplateGraph(result.graph);
    setWizardDismissed(true);
  }

  function handleWizardCancel() {
    void navigate({ to: "/pipelines" });
  }

  // -------------------------------------------------------------------------
  // Derive the initialDefinition for the VisualPipelineEditor.
  // When a template graph was chosen, convert it to a ConvertibleDefinition.
  // When steps were loaded from the API, use those.
  // -------------------------------------------------------------------------

  const initialDefinition = React.useMemo(() => {
    if (templateGraph !== undefined) {
      try {
        return graphToPipelineDefinition(templateGraph);
      } catch {
        // Malformed template graph — fall back to empty editor
        return undefined;
      }
    }
    if (initialSteps.length > 0) {
      return {
        version: 1 as const,
        entryStepId: initialSteps[0]!.id,
        steps: initialSteps.map((s) => ({ id: s.id, type: s.type, name: s.name })),
      };
    }
    return undefined;
  }, [templateGraph, initialSteps]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Show the wizard overlay for new pipelines before the user has made choices
  if (showWizard) {
    return (
      <TemplateGallery
        onComplete={handleWizardComplete}
        onCancel={handleWizardCancel}
      />
    );
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
                  onChange={(e) => {
                    setName(e.target.value);
                    if (e.target.value.trim().length > 0) setNameError(null);
                  }}
                  aria-invalid={nameError !== null ? true : undefined}
                />
                {nameError !== null && (
                  <p className="text-xs text-[var(--color-destructive)]" role="alert">
                    {nameError}
                  </p>
                )}
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
                    <SelectItem value="manual">Run manually (on-demand)</SelectItem>
                    <SelectItem value="cron">Run on a schedule</SelectItem>
                    <SelectItem value="event">Run when data arrives</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {triggerType === "cron" && (
                <div className="sm:col-span-2">
                  <ScheduleBuilder
                    value={cronExpression}
                    onChange={setCronExpression}
                  />
                </div>
              )}
            </div>

            {/* Editor mode toggle */}
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Pipeline steps</h2>
              <div className="ml-auto flex items-center gap-1 rounded-md border border-[var(--color-border)] p-0.5">
                <Button
                  variant={editorMode === "visual" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setEditorMode("visual")}
                  className="h-7 text-xs"
                >
                  Visual Editor
                </Button>
                <Button
                  variant={editorMode === "steps" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setEditorMode("steps")}
                  className="h-7 text-xs"
                >
                  Step List
                </Button>
              </div>
            </div>

            {/* Step builder / visual editor */}
            <div>
              {loaded && editorMode === "visual" && (
                <div className="h-[500px] rounded-md border border-[var(--color-border)]">
                  <VisualPipelineEditor
                    {...(initialDefinition !== undefined ? { initialDefinition } : {})}
                  />
                </div>
              )}
              {loaded && editorMode === "steps" && (
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
