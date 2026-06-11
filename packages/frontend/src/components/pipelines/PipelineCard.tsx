/**
 * PipelineCard — summary card for a single pipeline in the list view.
 * Shows name, trigger type, last run status badge, and next scheduled run time.
 */
import * as React from "react";
import { CalendarClock, Zap, MousePointerClick, type LucideProps } from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { RunStatusBadge, type RunStatus } from "./RunStatusBadge.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerType = "cron" | "event" | "manual";

export interface PipelineCardData {
  id: string;
  name: string;
  triggerType: TriggerType;
  /** Last run status; undefined if the pipeline has never run */
  lastRunStatus?: RunStatus;
  /** ISO string for the most recent run start time */
  lastRunAt?: string;
  /** ISO string for the next scheduled run; only applies when triggerType === "cron" */
  nextRunAt?: string;
}

export interface PipelineCardProps {
  pipeline: PipelineCardData;
  onClick?: (id: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Trigger icon
// ---------------------------------------------------------------------------

// Lucide icons are ForwardRefExoticComponents; we cast to a safe render type
type IconComponent = ForwardRefExoticComponent<Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>>;

const TRIGGER_ICONS: Record<TriggerType, IconComponent> = {
  cron: CalendarClock,
  event: Zap,
  manual: MousePointerClick,
};

const TRIGGER_LABELS: Record<TriggerType, string> = {
  cron: "Scheduled",
  event: "Event-driven",
  manual: "Manual",
};

// ---------------------------------------------------------------------------
// PipelineCard component
// ---------------------------------------------------------------------------

export function PipelineCard({ pipeline, onClick, className }: PipelineCardProps) {
  const { id, name, triggerType, lastRunStatus, lastRunAt, nextRunAt } = pipeline;
  const TriggerIcon = TRIGGER_ICONS[triggerType];

  return (
    <Card
      className={cn(
        "transition-shadow hover:shadow-md",
        onClick !== undefined && "cursor-pointer",
        className,
      )}
      onClick={() => onClick?.(id)}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate text-base font-semibold">{name}</CardTitle>
          {lastRunStatus !== undefined && <RunStatusBadge status={lastRunStatus} />}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
          <TriggerIcon className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{TRIGGER_LABELS[triggerType]}</span>
        </div>
      </CardHeader>

      <CardContent className="space-y-1 text-xs text-[var(--color-muted-foreground)]">
        {lastRunAt !== undefined && (
          <div>
            Last run: <RelativeTime value={lastRunAt} />
          </div>
        )}
        {triggerType === "cron" && nextRunAt !== undefined && (
          <div>
            Next run: <RelativeTime value={nextRunAt} />
          </div>
        )}
        {lastRunAt === undefined && lastRunStatus === undefined && (
          <div>Never run</div>
        )}
      </CardContent>
    </Card>
  );
}
