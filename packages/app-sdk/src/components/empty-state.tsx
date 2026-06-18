/**
 * EmptyState — zero-state component for list sections and full pages.
 *
 * Rendered when a data fetch succeeds but returns an empty set. Provides a
 * visually centered layout with an optional icon, title, description, and a
 * single primary CTA to guide the user toward populating the empty resource.
 *
 * The optional action accepts a `variant` to distinguish between primary
 * creation actions (default) and secondary navigation actions (outline).
 */

import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "outline";
}

export interface EmptyStateProps {
  /** Lucide icon component or any component accepting `className` and `aria-hidden`. */
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  className?: string;
}

// ---------------------------------------------------------------------------
// EmptyState component
// ---------------------------------------------------------------------------

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={[
        "flex flex-col items-center justify-center gap-4 py-16 text-center",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {Icon !== undefined && (
        <div
          className="rounded-full bg-[var(--color-muted,#f3f4f6)] p-4"
          aria-hidden="true"
        >
          <Icon
            className="h-8 w-8 text-[var(--color-muted-foreground,#6b7280)]"
            aria-hidden="true"
          />
        </div>
      )}

      <div className="space-y-1">
        <p className="text-base font-semibold text-[var(--color-foreground,#111)]">
          {title}
        </p>
        {description !== undefined && (
          <p className="max-w-sm text-sm text-[var(--color-muted-foreground,#6b7280)]">
            {description}
          </p>
        )}
      </div>

      {action !== undefined && (
        <ActionButton action={action} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionButton — primary or outline CTA
// ---------------------------------------------------------------------------

function ActionButton({ action }: { action: EmptyStateAction }) {
  const variant = action.variant ?? "primary";

  const baseClass =
    "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring,#6366f1)] focus-visible:ring-offset-2 transition-colors";

  const variantClass =
    variant === "primary"
      ? "bg-[var(--color-primary,#6366f1)] text-white hover:bg-[var(--color-primary,#6366f1)]/90"
      : "border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] text-[var(--color-foreground,#111)] hover:bg-[var(--color-muted,#f3f4f6)]";

  return (
    <button
      type="button"
      onClick={action.onClick}
      className={[baseClass, variantClass].join(" ")}
    >
      {action.label}
    </button>
  );
}
