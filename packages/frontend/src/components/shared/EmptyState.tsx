/**
 * EmptyState — zero-state component for list pages and sections.
 * Used when a query returns an empty array rather than an error.
 * Should include a context-appropriate CTA to guide the user forward.
 */
import * as React from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";

export interface EmptyStateProps {
  /** Lucide icon component or custom SVG */
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  /** Label for the primary action button */
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 py-16 text-center",
        className,
      )}
    >
      {Icon !== undefined && (
        <div className="rounded-full bg-[var(--color-muted)] p-4">
          <Icon className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden="true" />
        </div>
      )}

      <div className="space-y-1">
        <p className="text-base font-semibold text-[var(--color-foreground)]">
          {title}
        </p>
        {description !== undefined && (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {description}
          </p>
        )}
      </div>

      {actionLabel !== undefined && onAction !== undefined && (
        <Button onClick={onAction}>{actionLabel}</Button>
      )}
    </div>
  );
}
