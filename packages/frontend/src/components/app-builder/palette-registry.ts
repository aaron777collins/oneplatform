/**
 * Palette registry — the catalogue of all drag-and-droppable components.
 *
 * Every entry in PALETTE_ENTRIES maps to an app-sdk component (or a built-in
 * custom block). The config panel reads propSchema to build its form.
 * The code generator uses the `type` field to emit the correct JSX tag.
 *
 * This module has no React dependency so it can be imported from tests.
 */

import type { PaletteEntry } from "./types.js";

export const PALETTE_ENTRIES: PaletteEntry[] = [
  // ---------------------------------------------------------------------------
  // Data Display
  // ---------------------------------------------------------------------------
  {
    type: "DataTable",
    label: "Data Table",
    description: "Sortable, paginated, searchable table.",
    category: "Data Display",
    icon: "Table",
    defaultProps: {
      data: [],
      columns: [],
      pageSize: 10,
      emptyMessage: "No data to display.",
      "aria-label": "Data table",
    },
    propSchema: [
      { key: "pageSize", label: "Page size", inputType: "number", defaultValue: 10 },
      { key: "emptyMessage", label: "Empty message", inputType: "text", defaultValue: "No data to display." },
      { key: "aria-label", label: "Accessible label", inputType: "text", defaultValue: "Data table" },
      {
        key: "columns",
        label: "Column configuration",
        inputType: "json",
        defaultValue: [],
        description: "Array of column definitions. Each column has: header (display name), field (data key), width (optional CSS width), sortable (boolean).",
        jsonSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              header: { type: "string", description: "Column display header" },
              field: { type: "string", description: "Data field key to display" },
              width: { type: "string", description: "CSS width, e.g. '150px' or '20%'" },
              sortable: { type: "boolean", description: "Whether column is sortable" },
            },
            required: ["header", "field"],
          },
        },
      },
    ],
  },
  {
    type: "StatCard",
    label: "Stat Card",
    description: "Key metric display with optional trend indicator.",
    category: "Data Display",
    icon: "TrendingUp",
    defaultProps: {
      title: "Metric",
      value: "0",
      variant: "default",
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "Metric" },
      { key: "value", label: "Value", inputType: "text", defaultValue: "0" },
      { key: "change", label: "Change (%)", inputType: "number" },
      {
        key: "variant",
        label: "Variant",
        inputType: "select",
        defaultValue: "default",
        options: [
          { label: "Default", value: "default" },
          { label: "Success", value: "success" },
          { label: "Warning", value: "warning" },
          { label: "Danger", value: "danger" },
        ],
      },
    ],
  },
  {
    type: "StatusBadge",
    label: "Status Badge",
    description: "Colour-coded status indicator.",
    category: "Data Display",
    icon: "Badge",
    defaultProps: {
      status: "active",
    },
    propSchema: [
      {
        key: "status",
        label: "Status",
        inputType: "select",
        defaultValue: "active",
        options: [
          { label: "Active", value: "active" },
          { label: "Inactive", value: "inactive" },
          { label: "Pending", value: "pending" },
          { label: "Error", value: "error" },
          { label: "Warning", value: "warning" },
        ],
      },
      { key: "label", label: "Custom label", inputType: "text" },
    ],
  },
  {
    type: "DetailPanel",
    label: "Detail Panel",
    description: "Key–value detail view for a single entity.",
    category: "Data Display",
    icon: "PanelRight",
    defaultProps: {
      title: "Details",
      fields: [],
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "Details" },
    ],
  },

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  {
    type: "FilterBar",
    label: "Filter Bar",
    description: "Composable filter controls for list views.",
    category: "Input",
    icon: "Filter",
    defaultProps: {
      filters: [],
      values: {},
    },
    propSchema: [
      { key: "filterField", label: "Filter field", inputType: "text", description: "Data field key to filter on" },
      {
        key: "filterType",
        label: "Filter type",
        inputType: "select",
        defaultValue: "text",
        options: [
          { label: "Text search", value: "text" },
          { label: "Select / dropdown", value: "select" },
          { label: "Date range", value: "date-range" },
          { label: "Number range", value: "number-range" },
          { label: "Boolean toggle", value: "boolean" },
        ],
      },
      { key: "label", label: "Filter label", inputType: "text", description: "Label shown above the filter control" },
      { key: "placeholder", label: "Placeholder text", inputType: "text", description: "Placeholder shown inside the filter input" },
    ],
  },

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------
  {
    type: "PageHeader",
    label: "Page Header",
    description: "Page title with optional breadcrumb and actions.",
    category: "Layout",
    icon: "Heading",
    defaultProps: {
      title: "Page Title",
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "Page Title" },
      { key: "description", label: "Description", inputType: "text" },
    ],
  },
  {
    type: "EmptyState",
    label: "Empty State",
    description: "Zero-state view for lists and sections.",
    category: "Layout",
    icon: "LayoutTemplate",
    defaultProps: {
      title: "Nothing here yet",
      description: "Add data to get started.",
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "Nothing here yet" },
      { key: "description", label: "Description", inputType: "text" },
    ],
  },

  // ---------------------------------------------------------------------------
  // Custom
  // ---------------------------------------------------------------------------
  {
    type: "HtmlBlock",
    label: "HTML Block",
    description: "Raw HTML or Markdown content block.",
    category: "Custom",
    icon: "Code",
    defaultProps: {
      html: "<p>Edit this HTML block.</p>",
    },
    propSchema: [
      { key: "html", label: "HTML content", inputType: "richtext", defaultValue: "<p>Edit this HTML block.</p>", description: "Rich text editor (WYSIWYG). Supports formatting, links, images, and raw HTML." },
    ],
  },
  {
    type: "MarkdownBlock",
    label: "Markdown Block",
    description: "Rendered Markdown content block.",
    category: "Custom",
    icon: "FileText",
    defaultProps: {
      content: "## Heading\n\nEdit this Markdown block.",
    },
    propSchema: [
      { key: "content", label: "Markdown content", inputType: "richtext", defaultValue: "## Heading\n\nEdit this Markdown block.", description: "Rich text editor (WYSIWYG). Supports headings, lists, bold, italic, links, and standard Markdown syntax." },
    ],
  },
];

/** Look up a palette entry by component type. Returns undefined for unknown types. */
export function getPaletteEntry(type: string): PaletteEntry | undefined {
  return PALETTE_ENTRIES.find((e) => e.type === type);
}

/** All distinct categories in palette order. */
export const PALETTE_CATEGORIES: string[] = [
  "Data Display",
  "Input",
  "Layout",
  "Custom",
];
