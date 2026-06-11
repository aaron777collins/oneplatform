/**
 * PipelineStepNode — single step in the visual pipeline builder.
 *
 * Displays an icon, step name, type description, and inline config summary.
 * Edit and delete buttons are presented as icon buttons to keep the node compact.
 * The node's step type is visually differentiated by color.
 */
import * as React from "react";
import { Pencil, Trash2, ArrowDown, Database, Cpu, Target, type LucideProps } from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepType = "source" | "transform" | "destination";

export interface PipelineStep {
  id: string;
  type: StepType;
  /** Human-readable name, e.g. "Filter nulls" */
  name: string;
  /** Config summary string to display below the name */
  configSummary?: string;
}

export interface PipelineStepNodeProps {
  step: PipelineStep;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onEdit: (stepId: string) => void;
  onDelete: (stepId: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Step type config
// ---------------------------------------------------------------------------

type IconComponent = ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;

const STEP_TYPE_ICONS: Record<StepType, IconComponent> = {
  source: Database,
  transform: Cpu,
  destination: Target,
};

const STEP_TYPE_LABELS: Record<StepType, string> = {
  source: "Source",
  transform: "Transform",
  destination: "Destination",
};

const STEP_TYPE_COLORS: Record<StepType, string> = {
  source: "border-l-[var(--color-primary)] bg-[var(--color-primary)]/5",
  transform: "border-l-[var(--color-status-warning)] bg-[var(--color-status-warning)]/5",
  destination: "border-l-[var(--color-status-success)] bg-[var(--color-status-success)]/5",
};

// ---------------------------------------------------------------------------
// PipelineStepNode component
// ---------------------------------------------------------------------------

export function PipelineStepNode({
  step,
  index,
  isFirst,
  isLast,
  onEdit,
  onDelete,
  className,
}: PipelineStepNodeProps) {
  const Icon = STEP_TYPE_ICONS[step.type];

  return (
    <div className="flex flex-col items-center">
      {/* Connector arrow from previous step */}
      {!isFirst && (
        <div className="flex h-6 w-px items-center justify-center">
          <ArrowDown
            className="h-4 w-4 text-[var(--color-muted-foreground)]"
            aria-hidden="true"
          />
        </div>
      )}

      {/* Step card */}
      <div
        className={cn(
          "flex w-full items-center gap-3 rounded-md border border-l-4 bg-[var(--color-card)] p-3 shadow-sm",
          STEP_TYPE_COLORS[step.type],
          className,
        )}
      >
        {/* Step number + icon */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-background)] text-xs font-bold">
          {index + 1}
        </div>

        {/* Step info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
            <span className="text-xs font-medium text-[var(--color-muted-foreground)] uppercase tracking-wide">
              {STEP_TYPE_LABELS[step.type]}
            </span>
          </div>
          <p className="mt-0.5 truncate text-sm font-semibold text-[var(--color-foreground)]">
            {step.name}
          </p>
          {step.configSummary !== undefined && (
            <p className="mt-0.5 truncate text-xs text-[var(--color-muted-foreground)]">
              {step.configSummary}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onEdit(step.id)}
            aria-label={`Edit step: ${step.name}`}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
            onClick={() => onDelete(step.id)}
            aria-label={`Delete step: ${step.name}`}
            disabled={isFirst && isLast}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
