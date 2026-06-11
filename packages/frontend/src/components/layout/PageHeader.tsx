/**
 * PageHeader — breadcrumb trail + page title + optional right-aligned action slot.
 *
 * Breadcrumbs are passed as items with optional hrefs. The last item is the
 * current page and is rendered without a link (aria-current="page").
 * The action slot accepts any React node (buttons, dropdowns, etc.).
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BreadcrumbItem {
  label: string;
  /** If present, renders as a link. The last item should omit href. */
  href?: string;
}

export interface PageHeaderProps {
  title: string;
  breadcrumbs?: BreadcrumbItem[];
  /** Renders in the top-right corner — pass buttons or other actions here. */
  actions?: React.ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// PageHeader component
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  breadcrumbs,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-background)] px-6 py-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {/* Breadcrumb trail */}
        {breadcrumbs !== undefined && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol role="list" className="flex flex-wrap items-center gap-1">
              {breadcrumbs.map((item, index) => {
                const isLast = index === breadcrumbs.length - 1;
                return (
                  <li key={index} className="flex items-center gap-1">
                    {index > 0 && (
                      <ChevronRight
                        className="h-3 w-3 shrink-0 text-[var(--color-muted-foreground)]"
                        aria-hidden="true"
                      />
                    )}
                    {isLast || item.href === undefined ? (
                      <span
                        className="text-xs text-[var(--color-muted-foreground)]"
                        aria-current={isLast ? "page" : undefined}
                      >
                        {item.label}
                      </span>
                    ) : (
                      <Link
                        to={item.href}
                        className="text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] rounded-sm"
                      >
                        {item.label}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}

        {/* Page title */}
        <h1 className="truncate text-2xl font-bold tracking-tight text-[var(--color-foreground)]">
          {title}
        </h1>
      </div>

      {/* Action slot */}
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>
      )}
    </header>
  );
}
