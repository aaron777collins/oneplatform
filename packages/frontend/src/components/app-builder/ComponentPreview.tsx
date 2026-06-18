/**
 * ComponentPreview — renders a placed component with its configured props.
 *
 * SDK components are instantiated directly (no iframe required for the
 * visual builder canvas — isolation happens at runtime in the full app shell).
 * Custom blocks (HtmlBlock, MarkdownBlock) render inline previews.
 *
 * In preview mode this IS the final output. In edit mode ComponentWrapper
 * wraps this with selection chrome.
 *
 * Unknown component types display a fallback card so the canvas never crashes.
 */

import * as React from "react";
import type { PlacedComponent } from "./types.js";
import {
  DataTable,
  StatCard,
  StatusBadge,
  FilterBar,
  EmptyState,
  PageHeader,
  DetailPanel,
} from "@oneplatform/app-sdk/components";
import type {
  DataTableProps,
  StatCardProps,
  StatusBadgeProps,
  FilterBarProps,
  EmptyStateProps,
  PageHeaderProps,
  DetailPanelProps,
} from "@oneplatform/app-sdk/components";

// ---------------------------------------------------------------------------
// ComponentPreview
// ---------------------------------------------------------------------------

interface ComponentPreviewProps {
  component: PlacedComponent;
}

export function ComponentPreview({ component }: ComponentPreviewProps) {
  const { type, props, styles } = component;
  const style = styles as React.CSSProperties | undefined;

  switch (type) {
    case "DataTable":
      return (
        <div style={style}>
          <DataTable {...(props as unknown as DataTableProps<Record<string, unknown>>)} />
        </div>
      );

    case "StatCard":
      return (
        <div style={style}>
          <StatCard {...(props as unknown as StatCardProps)} />
        </div>
      );

    case "StatusBadge":
      return (
        <div style={style}>
          <StatusBadge {...(props as unknown as StatusBadgeProps)} />
        </div>
      );

    case "FilterBar":
      // FilterBar requires onChange — provide a no-op in the builder preview
      // so the component renders without runtime errors.
      return (
        <div style={style}>
          <FilterBar
            {...(props as unknown as FilterBarProps)}
            onChange={() => {
              // Preview-only no-op — events are wired up in generated code
            }}
          />
        </div>
      );

    case "EmptyState":
      return (
        <div style={style}>
          <EmptyState {...(props as unknown as EmptyStateProps)} />
        </div>
      );

    case "PageHeader":
      return (
        <div style={style}>
          <PageHeader {...(props as unknown as PageHeaderProps)} />
        </div>
      );

    case "DetailPanel":
      return (
        <div style={style}>
          <DetailPanel {...(props as unknown as DetailPanelProps)} />
        </div>
      );

    case "HtmlBlock": {
      const html = String(props["html"] ?? "");
      return (
        <div
          style={style}
          // This is an intentional builder feature — the user explicitly
          // placed an HTML block and controls the content.
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: html }}
          className="text-sm text-[var(--color-foreground,#111)]"
        />
      );
    }

    case "MarkdownBlock": {
      const content = String(props["content"] ?? "");
      // Plain pre-formatted text — markdown rendering is done by the full app
      // shell at runtime. The builder shows raw content as a faithful preview.
      return (
        <pre
          style={style}
          className="whitespace-pre-wrap text-sm text-[var(--color-foreground,#111)] font-mono"
        >
          {content}
        </pre>
      );
    }

    default:
      return <UnknownComponentFallback type={type} />;
  }
}

// ---------------------------------------------------------------------------
// Fallback for unrecognised component types (e.g. from old layout snapshots)
// ---------------------------------------------------------------------------

function UnknownComponentFallback({ type }: { type: string }) {
  return (
    <div className="flex items-center justify-center rounded border border-dashed border-[var(--color-border,#e5e7eb)] bg-[var(--color-muted,#f9fafb)] p-4">
      <span className="text-xs text-[var(--color-muted-foreground,#6b7280)]">
        Unknown component: <code className="font-mono">{type}</code>
      </span>
    </div>
  );
}
