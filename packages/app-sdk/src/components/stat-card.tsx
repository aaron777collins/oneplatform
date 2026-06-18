/**
 * StatCard — key metric display for dashboards.
 *
 * Renders a title, large numeric value, optional trend indicator (delta + arrow),
 * and optional icon. Color variants communicate severity/state without relying
 * on color alone — the trend arrow (▲/▼) and sign (+/−) provide redundant cues
 * per §14.4 of the design guidelines.
 */

import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatCardVariant = "default" | "success" | "warning" | "danger";

export interface StatCardProps {
  title: string;
  /** The primary metric value. Numbers are formatted with toLocaleString(); strings are rendered as-is. */
  value: number | string;
  /**
   * Percentage change for the trend indicator. Positive values show an upward
   * arrow (green), negative show a downward arrow (red), zero hides the indicator.
   */
  change?: number;
  /** Lucide icon component (or any component accepting `className`). */
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  variant?: StatCardVariant;
  className?: string;
}

// ---------------------------------------------------------------------------
// Variant styles
// ---------------------------------------------------------------------------

const VARIANT_STYLES: Record<StatCardVariant, {
  card: string;
  title: string;
  icon: string;
}> = {
  default: {
    card: "bg-[var(--color-background,#fff)] border border-[var(--color-border,#e5e7eb)]",
    title: "text-[var(--color-muted-foreground,#6b7280)]",
    icon: "bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)]",
  },
  success: {
    card: "bg-[var(--color-background,#fff)] border border-green-200 dark:border-green-800",
    title: "text-green-700 dark:text-green-400",
    icon: "bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400",
  },
  warning: {
    card: "bg-[var(--color-background,#fff)] border border-yellow-200 dark:border-yellow-800",
    title: "text-yellow-700 dark:text-yellow-400",
    icon: "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400",
  },
  danger: {
    card: "bg-[var(--color-background,#fff)] border border-red-200 dark:border-red-800",
    title: "text-red-700 dark:text-red-400",
    icon: "bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400",
  },
};

// ---------------------------------------------------------------------------
// StatCard component
// ---------------------------------------------------------------------------

export function StatCard({
  title,
  value,
  change,
  icon: Icon,
  variant = "default",
  className,
}: StatCardProps) {
  const styles = VARIANT_STYLES[variant];
  const displayValue =
    typeof value === "number" ? value.toLocaleString() : value;

  return (
    <div
      className={[
        "rounded-lg p-4 shadow-sm",
        styles.card,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className={["text-xs font-medium uppercase tracking-wide", styles.title].join(" ")}>
            {title}
          </p>
          <p className="mt-1 text-2xl font-bold text-[var(--color-foreground,#111)]">
            {displayValue}
          </p>
          {change !== undefined && change !== 0 && (
            <TrendIndicator change={change} />
          )}
        </div>

        {Icon !== undefined && (
          <div
            className={["shrink-0 rounded-lg p-2", styles.icon].join(" ")}
            aria-hidden="true"
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrendIndicator — arrow + percentage
// ---------------------------------------------------------------------------

function TrendIndicator({ change }: { change: number }) {
  const isPositive = change > 0;
  const absChange = Math.abs(change);
  const label = `${isPositive ? "Up" : "Down"} ${absChange.toFixed(1)}% from previous period`;

  return (
    <p
      className={[
        "mt-1.5 flex items-center gap-1 text-xs font-medium",
        isPositive
          ? "text-green-600 dark:text-green-400"
          : "text-red-600 dark:text-red-400",
      ].join(" ")}
      aria-label={label}
    >
      {/* Arrow glyph provides direction cue independent of color */}
      <span aria-hidden="true">{isPositive ? "▲" : "▼"}</span>
      <span>
        {isPositive ? "+" : "−"}
        {absChange.toFixed(1)}%
      </span>
    </p>
  );
}
