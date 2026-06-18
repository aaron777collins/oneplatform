/**
 * PageHeader — top-of-page header with breadcrumbs, title, description, and actions.
 *
 * App-SDK variant intentionally avoids a router dependency. Breadcrumb links are
 * rendered as plain <a> tags so they work with any routing library or no router at
 * all. Callers that use React Router / TanStack Router can pass an onClick handler
 * and href="" to intercept navigation without full page reloads.
 *
 * Actions are structured (label + onClick + variant) rather than ReactNode to
 * enable future serialization / analytics integration by the OnePlatform shell.
 */

import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BreadcrumbItem {
  label: string;
  /** Rendered as an <a> href when present. The last crumb is never linked. */
  href?: string;
  /** Optional click handler — use with href="" to intercept SPA navigation. */
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}

export type ActionVariant = "primary" | "outline" | "destructive";

export interface ActionItem {
  label: string;
  onClick: () => void;
  variant?: ActionVariant;
  disabled?: boolean;
}

export interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumbs?: BreadcrumbItem[];
  actions?: ActionItem[];
  className?: string;
}

// ---------------------------------------------------------------------------
// Action button styles
// ---------------------------------------------------------------------------

const ACTION_STYLES: Record<ActionVariant, string> = {
  primary:
    "bg-[var(--color-primary,#6366f1)] text-white hover:bg-[var(--color-primary,#6366f1)]/90",
  outline:
    "border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] text-[var(--color-foreground,#111)] hover:bg-[var(--color-muted,#f3f4f6)]",
  destructive:
    "bg-red-600 text-white hover:bg-red-700",
};

const ACTION_BASE =
  "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring,#6366f1)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------------------
// PageHeader component
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={[
        "flex items-start justify-between gap-4 border-b border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-6 py-4",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="min-w-0 flex-1">
        {/* Breadcrumb trail */}
        {breadcrumbs !== undefined && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol role="list" className="flex flex-wrap items-center gap-1">
              {breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <li key={index} className="flex items-center gap-1">
                    {index > 0 && (
                      <span
                        className="text-xs text-[var(--color-muted-foreground,#9ca3af)]"
                        aria-hidden="true"
                      >
                        /
                      </span>
                    )}
                    {isLast || crumb.href === undefined ? (
                      <span
                        className="text-xs text-[var(--color-muted-foreground,#6b7280)]"
                        aria-current={isLast ? "page" : undefined}
                      >
                        {crumb.label}
                      </span>
                    ) : (
                      <a
                        href={crumb.href}
                        onClick={crumb.onClick}
                        className="text-xs text-[var(--color-muted-foreground,#6b7280)] hover:text-[var(--color-foreground,#111)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring,#6366f1)] rounded-sm"
                      >
                        {crumb.label}
                      </a>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        {/* Page title */}
        <h1 className="truncate text-2xl font-bold tracking-tight text-[var(--color-foreground,#111)]">
          {title}
        </h1>
        {description !== undefined && (
          <p className="mt-0.5 text-sm text-[var(--color-muted-foreground,#6b7280)]">
            {description}
          </p>
        )}
      </div>

      {/* Action buttons */}
      {actions !== undefined && actions.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {actions.map((action, index) => {
            const variant = action.variant ?? "outline";
            return (
              <button
                key={index}
                type="button"
                onClick={action.onClick}
                disabled={action.disabled === true}
                className={[ACTION_BASE, ACTION_STYLES[variant]].join(" ")}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      )}
    </header>
  );
}
