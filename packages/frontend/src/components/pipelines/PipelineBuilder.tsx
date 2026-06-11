/**
 * PipelineBuilder — visual step-based pipeline builder.
 *
 * Steps flow top-to-bottom: source → transform(s) → destination.
 * Each step can be added, edited (via a dialog), reordered (up/down), and deleted.
 * The builder manages local step state and surfaces the final step array via onSave.
 */
import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { PipelineStepNode, type PipelineStep, type StepType } from "./PipelineStepNode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineBuilderProps {
  /** Initial steps for edit mode. Leave empty for new pipeline. */
  initialSteps?: PipelineStep[];
  onSave: (steps: PipelineStep[]) => void | Promise<void>;
  isSaving?: boolean;
}

// ---------------------------------------------------------------------------
// Step editor state
// ---------------------------------------------------------------------------

interface StepEditorState {
  mode: "add" | "edit";
  stepId?: string;
  name: string;
  type: StepType;
  configSummary: string;
}

const DEFAULT_EDITOR: StepEditorState = {
  mode: "add",
  name: "",
  type: "transform",
  configSummary: "",
};

// ---------------------------------------------------------------------------
// PipelineBuilder component
// ---------------------------------------------------------------------------

export function PipelineBuilder({
  initialSteps = [],
  onSave,
  isSaving = false,
}: PipelineBuilderProps) {
  const [steps, setSteps] = React.useState<PipelineStep[]>(initialSteps);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editor, setEditor] = React.useState<StepEditorState>(DEFAULT_EDITOR);

  // --- Step manipulation ---

  function handleAddStep() {
    setEditor(DEFAULT_EDITOR);
    setEditorOpen(true);
  }

  function handleEditStep(stepId: string) {
    const step = steps.find((s) => s.id === stepId);
    if (step === undefined) return;
    setEditor({
      mode: "edit",
      stepId: step.id,
      name: step.name,
      type: step.type,
      configSummary: step.configSummary ?? "",
    });
    setEditorOpen(true);
  }

  function handleDeleteStep(stepId: string) {
    setSteps((prev) => prev.filter((s) => s.id !== stepId));
  }

  function handleEditorSave() {
    if (editor.name.trim().length === 0) return;

    if (editor.mode === "add") {
      const newStep: PipelineStep = {
        id: crypto.randomUUID(),
        type: editor.type,
        name: editor.name.trim(),
        ...(editor.configSummary.trim().length > 0
          ? { configSummary: editor.configSummary.trim() }
          : {}),
      };
      setSteps((prev) => [...prev, newStep]);
    } else {
      setSteps((prev) =>
        prev.map((s) => {
          if (s.id !== editor.stepId) return s;
          return {
            ...s,
            name: editor.name.trim(),
            type: editor.type,
            ...(editor.configSummary.trim().length > 0
              ? { configSummary: editor.configSummary.trim() }
              : {}),
          };
        }),
      );
    }
    setEditorOpen(false);
  }

  // --- Save pipeline ---

  async function handleSave() {
    await onSave(steps);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Step list */}
      <div className="min-h-[120px] rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/20 p-4">
        {steps.length === 0 ? (
          <div className="flex h-20 items-center justify-center text-sm text-[var(--color-muted-foreground)]">
            No steps yet. Add a source step to get started.
          </div>
        ) : (
          <div className="flex flex-col">
            {steps.map((step, index) => (
              <PipelineStepNode
                key={step.id}
                step={step}
                index={index}
                isFirst={index === 0}
                isLast={index === steps.length - 1}
                onEdit={handleEditStep}
                onDelete={handleDeleteStep}
              />
            ))}
          </div>
        )}
      </div>

      {/* Actions row */}
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={handleAddStep}>
          <Plus className="h-4 w-4" aria-hidden />
          Add step
        </Button>

        <Button
          className="ml-auto"
          onClick={() => void handleSave()}
          disabled={isSaving || steps.length === 0}
          aria-busy={isSaving}
        >
          {isSaving ? (
            <span className="flex items-center gap-2">
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden
              />
              Saving…
            </span>
          ) : (
            "Save pipeline"
          )}
        </Button>
      </div>

      {/* Step editor dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editor.mode === "add" ? "Add step" : "Edit step"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="step-type">Type</Label>
              <Select
                value={editor.type}
                onValueChange={(v) =>
                  setEditor((prev) => ({ ...prev, type: v as StepType }))
                }
              >
                <SelectTrigger id="step-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="source">Source</SelectItem>
                  <SelectItem value="transform">Transform</SelectItem>
                  <SelectItem value="destination">Destination</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="step-name">Name</Label>
              <Input
                id="step-name"
                placeholder="e.g. Filter inactive records"
                value={editor.name}
                onChange={(e) =>
                  setEditor((prev) => ({ ...prev, name: e.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="step-summary">Config summary (optional)</Label>
              <Input
                id="step-summary"
                placeholder="Short description of what this step does"
                value={editor.configSummary}
                onChange={(e) =>
                  setEditor((prev) => ({ ...prev, configSummary: e.target.value }))
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleEditorSave}
              disabled={editor.name.trim().length === 0}
            >
              {editor.mode === "add" ? "Add" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
