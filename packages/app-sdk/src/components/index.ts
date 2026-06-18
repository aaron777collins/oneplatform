/**
 * @module components
 *
 * Re-exports every UI component from the app-sdk component library.
 * All exports are named (no default exports) so tree-shaking works correctly
 * with every bundler that supports ESM static analysis.
 */

// Data display
export { DataTable } from "./data-table.js";
export type { Column, DataTableProps } from "./data-table.js";

export { StatCard } from "./stat-card.js";
export type { StatCardProps, StatCardVariant } from "./stat-card.js";

export { StatusBadge } from "./status-badge.js";
export type { StatusBadgeProps, PredefinedStatus, StatusColor } from "./status-badge.js";

export { FilterBar } from "./filter-bar.js";
export type {
  FilterBarProps,
  FilterDef,
  FilterValues,
  FilterType,
  SelectOption,
  DateRange,
} from "./filter-bar.js";

export { EmptyState } from "./empty-state.js";
export type { EmptyStateProps, EmptyStateAction } from "./empty-state.js";

// Layout
export { PageHeader } from "./page-header.js";
export type { PageHeaderProps, BreadcrumbItem, ActionItem, ActionVariant } from "./page-header.js";

export { DetailPanel } from "./detail-panel.js";
export type { DetailPanelProps } from "./detail-panel.js";
