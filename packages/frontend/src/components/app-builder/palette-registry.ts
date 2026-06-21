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
      {
        key: "fields",
        label: "Fields",
        inputType: "json",
        defaultValue: [],
        description: "Array of field definitions. Each field has: label (display name), key (data field key), format (optional: 'date', 'number', 'currency', 'boolean', 'link').",
        jsonSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Display label for the field" },
              key: { type: "string", description: "Data field key to display" },
              format: {
                type: "string",
                description: "Optional display format",
                enum: ["date", "number", "currency", "boolean", "link"],
              },
            },
            required: ["label", "key"],
          },
        },
      },
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
  // Charts
  // ---------------------------------------------------------------------------
  {
    type: "BarChart",
    label: "Bar Chart",
    description: "Configurable vertical bar chart using Recharts.",
    category: "Charts",
    icon: "BarChart3",
    defaultProps: {
      title: "Sales by Region",
      data: [
        { region: "North", sales: 4200 },
        { region: "South", sales: 3100 },
        { region: "East", sales: 5400 },
        { region: "West", sales: 2900 },
        { region: "Central", sales: 3800 },
      ],
      xField: "region",
      yField: "sales",
      color: "#6366f1",
      showGrid: true,
      showLegend: false,
      height: 300,
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "Sales by Region" },
      {
        key: "data",
        label: "Data",
        inputType: "json",
        defaultValue: [
          { region: "North", sales: 4200 },
          { region: "South", sales: 3100 },
          { region: "East", sales: 5400 },
          { region: "West", sales: 2900 },
        ],
        description: "Array of data objects. Each object must have keys matching xField and yField.",
        jsonSchema: { type: "array", items: { type: "object" } },
      },
      { key: "xField", label: "X-axis field", inputType: "text", defaultValue: "region", description: "Data field key for the X axis (categories)" },
      { key: "yField", label: "Y-axis field", inputType: "text", defaultValue: "sales", description: "Data field key for the Y axis (values)" },
      { key: "color", label: "Bar color", inputType: "text", defaultValue: "#6366f1", description: "CSS color string, e.g. #6366f1 or hsl(262,83%,58%)" },
      { key: "showGrid", label: "Show grid lines", inputType: "boolean", defaultValue: true },
      { key: "showLegend", label: "Show legend", inputType: "boolean", defaultValue: false },
      { key: "height", label: "Height (px)", inputType: "number", defaultValue: 300 },
    ],
  },
  {
    type: "LineChart",
    label: "Line Chart",
    description: "Multi-series line chart with optional dots.",
    category: "Charts",
    icon: "LineChart",
    defaultProps: {
      title: "Monthly Revenue",
      data: [
        { month: "Jan", revenue: 12000, target: 10000 },
        { month: "Feb", revenue: 14500, target: 12000 },
        { month: "Mar", revenue: 13200, target: 13000 },
        { month: "Apr", revenue: 16800, target: 14000 },
        { month: "May", revenue: 15600, target: 15000 },
        { month: "Jun", revenue: 19200, target: 16000 },
      ],
      xField: "month",
      yFields: ["revenue", "target"],
      colors: ["#6366f1", "#10b981"],
      showGrid: true,
      showDots: true,
      height: 300,
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "Monthly Revenue" },
      {
        key: "data",
        label: "Data",
        inputType: "json",
        defaultValue: [],
        description: "Array of data objects for the time series.",
        jsonSchema: { type: "array", items: { type: "object" } },
      },
      { key: "xField", label: "X-axis field", inputType: "text", defaultValue: "month" },
      {
        key: "yFields",
        label: "Y-axis fields",
        inputType: "json",
        defaultValue: ["value"],
        description: "Array of data field keys to plot as separate lines.",
        jsonSchema: { type: "array", items: { type: "string" } },
      },
      {
        key: "colors",
        label: "Line colors",
        inputType: "json",
        defaultValue: ["#6366f1"],
        description: "Array of CSS color strings — one per Y field.",
        jsonSchema: { type: "array", items: { type: "string" } },
      },
      { key: "showGrid", label: "Show grid lines", inputType: "boolean", defaultValue: true },
      { key: "showDots", label: "Show data dots", inputType: "boolean", defaultValue: true },
      { key: "height", label: "Height (px)", inputType: "number", defaultValue: 300 },
    ],
  },
  {
    type: "PieChart",
    label: "Pie Chart",
    description: "Pie or donut chart for category distributions.",
    category: "Charts",
    icon: "PieChart",
    defaultProps: {
      title: "Traffic by Source",
      data: [
        { source: "Organic", visits: 4800 },
        { source: "Direct", visits: 2400 },
        { source: "Referral", visits: 1800 },
        { source: "Social", visits: 1200 },
        { source: "Email", visits: 900 },
      ],
      nameField: "source",
      valueField: "visits",
      donut: false,
      showLabels: true,
      height: 300,
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "Traffic by Source" },
      {
        key: "data",
        label: "Data",
        inputType: "json",
        defaultValue: [],
        description: "Array of objects with name and value fields.",
        jsonSchema: { type: "array", items: { type: "object" } },
      },
      { key: "nameField", label: "Name field", inputType: "text", defaultValue: "source", description: "Data field key for slice label" },
      { key: "valueField", label: "Value field", inputType: "text", defaultValue: "value", description: "Data field key for slice size" },
      { key: "donut", label: "Donut style", inputType: "boolean", defaultValue: false },
      { key: "showLabels", label: "Show labels", inputType: "boolean", defaultValue: true },
      { key: "height", label: "Height (px)", inputType: "number", defaultValue: 300 },
    ],
  },
  {
    type: "AreaChart",
    label: "Area Chart",
    description: "Filled area chart for trend visualisation.",
    category: "Charts",
    icon: "TrendingUp",
    defaultProps: {
      title: "User Growth",
      data: [
        { week: "W1", users: 1200 },
        { week: "W2", users: 1850 },
        { week: "W3", users: 2300 },
        { week: "W4", users: 2900 },
        { week: "W5", users: 3400 },
        { week: "W6", users: 4100 },
        { week: "W7", users: 4800 },
        { week: "W8", users: 5600 },
      ],
      xField: "week",
      yField: "users",
      color: "#6366f1",
      gradient: true,
      height: 300,
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "User Growth" },
      {
        key: "data",
        label: "Data",
        inputType: "json",
        defaultValue: [],
        description: "Array of data points for the trend line.",
        jsonSchema: { type: "array", items: { type: "object" } },
      },
      { key: "xField", label: "X-axis field", inputType: "text", defaultValue: "week" },
      { key: "yField", label: "Y-axis field", inputType: "text", defaultValue: "users" },
      { key: "color", label: "Fill color", inputType: "text", defaultValue: "#6366f1" },
      { key: "gradient", label: "Gradient fill", inputType: "boolean", defaultValue: true },
      { key: "height", label: "Height (px)", inputType: "number", defaultValue: 300 },
    ],
  },
  {
    type: "KPICard",
    label: "KPI Card",
    description: "Key performance indicator with optional sparkline. Supports auto-calculation from bound entity data.",
    category: "Charts",
    icon: "Activity",
    defaultProps: {
      title: "Monthly Revenue",
      value: "$48,250",
      change: 12.4,
      trend: "up",
      sparklineData: [3200, 3800, 3500, 4200, 4000, 4800, 4600, 5100, 4900, 5400],
      format: "currency",
      // Auto-calculation defaults: off so existing manual cards are unaffected
      autoCalculate: false,
      aggregation: "sum",
      aggregationField: "",
    },
    propSchema: [
      { key: "title", label: "Title", inputType: "text", defaultValue: "Monthly Revenue" },
      // autoCalculate controls whether value is static or derived from entity data
      { key: "autoCalculate", label: "Auto-calculate from data", inputType: "boolean", defaultValue: false, description: "When enabled, the value is computed from an entity data field rather than entered manually." },
      { key: "value", label: "Display value (manual)", inputType: "text", defaultValue: "$48,250", description: "Used when auto-calculate is off." },
      {
        key: "aggregation",
        label: "Aggregation function",
        inputType: "select",
        defaultValue: "sum",
        description: "How to aggregate the selected field when auto-calculate is on.",
        options: [
          { label: "Count", value: "count" },
          { label: "Sum", value: "sum" },
          { label: "Average", value: "avg" },
          { label: "Min", value: "min" },
          { label: "Max", value: "max" },
        ],
      },
      { key: "aggregationField", label: "Aggregation field", inputType: "text", defaultValue: "", description: "Entity data field to aggregate (e.g. revenue, quantity). Required when auto-calculate is on." },
      { key: "change", label: "Change (%)", inputType: "number", defaultValue: 12.4, description: "Positive or negative percentage change" },
      {
        key: "trend",
        label: "Trend direction",
        inputType: "select",
        defaultValue: "up",
        options: [
          { label: "Up", value: "up" },
          { label: "Down", value: "down" },
          { label: "Flat", value: "flat" },
        ],
      },
      {
        key: "sparklineData",
        label: "Sparkline data",
        inputType: "json",
        defaultValue: [3200, 3800, 3500, 4200, 4800],
        description: "Array of numbers for the sparkline preview chart.",
        jsonSchema: { type: "array", items: { type: "number" } },
      },
      {
        key: "format",
        label: "Value format",
        inputType: "select",
        defaultValue: "number",
        options: [
          { label: "Number", value: "number" },
          { label: "Currency", value: "currency" },
          { label: "Percent", value: "percent" },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Form Inputs
  // ---------------------------------------------------------------------------
  {
    type: "TextInput",
    label: "Text Input",
    description: "Single-line text field with label and validation.",
    category: "Form Inputs",
    icon: "Type",
    defaultProps: {
      label: "Label",
      placeholder: "Enter value…",
      required: false,
      helpText: "",
      type: "text",
    },
    propSchema: [
      { key: "label", label: "Label", inputType: "text", defaultValue: "Label" },
      { key: "placeholder", label: "Placeholder", inputType: "text", defaultValue: "Enter value…" },
      { key: "required", label: "Required", inputType: "boolean", defaultValue: false },
      { key: "helpText", label: "Help text", inputType: "text", description: "Hint shown below the field" },
      {
        key: "type",
        label: "Input type",
        inputType: "select",
        defaultValue: "text",
        options: [
          { label: "Text", value: "text" },
          { label: "Email", value: "email" },
          { label: "Password", value: "password" },
          { label: "URL", value: "url" },
        ],
      },
    ],
  },
  {
    type: "NumberInput",
    label: "Number Input",
    description: "Numeric field with min, max, step and optional prefix/suffix.",
    category: "Form Inputs",
    icon: "Hash",
    defaultProps: {
      label: "Amount",
      placeholder: "0",
      prefix: "",
      suffix: "",
    },
    propSchema: [
      { key: "label", label: "Label", inputType: "text", defaultValue: "Amount" },
      { key: "placeholder", label: "Placeholder", inputType: "text", defaultValue: "0" },
      { key: "min", label: "Min value", inputType: "number" },
      { key: "max", label: "Max value", inputType: "number" },
      { key: "step", label: "Step", inputType: "number", defaultValue: 1 },
      { key: "prefix", label: "Prefix (e.g. $)", inputType: "text" },
      { key: "suffix", label: "Suffix (e.g. kg)", inputType: "text" },
    ],
  },
  {
    type: "DatePicker",
    label: "Date Picker",
    description: "Date, datetime, or date-range picker.",
    category: "Form Inputs",
    icon: "Calendar",
    defaultProps: {
      label: "Date",
      type: "date",
    },
    propSchema: [
      { key: "label", label: "Label", inputType: "text", defaultValue: "Date" },
      {
        key: "type",
        label: "Picker type",
        inputType: "select",
        defaultValue: "date",
        options: [
          { label: "Date", value: "date" },
          { label: "Date + Time", value: "datetime" },
          { label: "Date Range", value: "daterange" },
        ],
      },
      { key: "minDate", label: "Min date (ISO)", inputType: "text", description: "ISO date string, e.g. 2024-01-01" },
      { key: "maxDate", label: "Max date (ISO)", inputType: "text", description: "ISO date string, e.g. 2024-12-31" },
    ],
  },
  {
    type: "SelectInput",
    label: "Select Input",
    description: "Dropdown select — single or multi-select with optional search.",
    category: "Form Inputs",
    icon: "ChevronDown",
    defaultProps: {
      label: "Select an option",
      placeholder: "Choose…",
      options: [
        { label: "Option A", value: "a" },
        { label: "Option B", value: "b" },
        { label: "Option C", value: "c" },
      ],
      multiple: false,
      searchable: false,
    },
    propSchema: [
      { key: "label", label: "Label", inputType: "text", defaultValue: "Select an option" },
      { key: "placeholder", label: "Placeholder", inputType: "text", defaultValue: "Choose…" },
      {
        key: "options",
        label: "Options",
        inputType: "json",
        defaultValue: [
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
        ],
        description: "Array of {label, value} objects shown as dropdown items.",
        jsonSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
      },
      { key: "multiple", label: "Allow multiple", inputType: "boolean", defaultValue: false },
      { key: "searchable", label: "Searchable", inputType: "boolean", defaultValue: false },
    ],
  },
  {
    type: "CheckboxGroup",
    label: "Checkbox Group",
    description: "Group of labelled checkboxes for multi-select input.",
    category: "Form Inputs",
    icon: "CheckSquare",
    defaultProps: {
      label: "Select all that apply",
      options: [
        { label: "Option A", value: "a" },
        { label: "Option B", value: "b" },
        { label: "Option C", value: "c" },
      ],
      direction: "vertical",
    },
    propSchema: [
      { key: "label", label: "Group label", inputType: "text", defaultValue: "Select all that apply" },
      {
        key: "options",
        label: "Options",
        inputType: "json",
        defaultValue: [
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
        ],
        description: "Array of {label, value} objects.",
        jsonSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
            },
            required: ["label", "value"],
          },
        },
      },
      {
        key: "direction",
        label: "Layout direction",
        inputType: "select",
        defaultValue: "vertical",
        options: [
          { label: "Vertical (stacked)", value: "vertical" },
          { label: "Horizontal (inline)", value: "horizontal" },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Interactive
  // ---------------------------------------------------------------------------
  {
    type: "ActionButton",
    label: "Action Button",
    description: "Clickable button that fires an action or event.",
    category: "Interactive",
    icon: "MousePointer",
    defaultProps: {
      label: "Submit",
      variant: "default",
      size: "md",
      icon: "",
      disabled: false,
    },
    propSchema: [
      { key: "label", label: "Button label", inputType: "text", defaultValue: "Submit" },
      {
        key: "variant",
        label: "Variant",
        inputType: "select",
        defaultValue: "default",
        options: [
          { label: "Default (primary)", value: "default" },
          { label: "Outline", value: "outline" },
          { label: "Destructive", value: "destructive" },
          { label: "Ghost", value: "ghost" },
        ],
      },
      {
        key: "size",
        label: "Size",
        inputType: "select",
        defaultValue: "md",
        options: [
          { label: "Small", value: "sm" },
          { label: "Medium", value: "md" },
          { label: "Large", value: "lg" },
        ],
      },
      { key: "icon", label: "Lucide icon name", inputType: "text", description: "Optional Lucide icon name to show before the label, e.g. Plus" },
      { key: "disabled", label: "Disabled", inputType: "boolean", defaultValue: false },
    ],
  },
  {
    type: "LinkButton",
    label: "Link Button",
    description: "Navigation link styled as a button.",
    category: "Interactive",
    icon: "Link2",
    defaultProps: {
      label: "Go to page",
      href: "/",
      target: "_self",
      variant: "outline",
    },
    propSchema: [
      { key: "label", label: "Label", inputType: "text", defaultValue: "Go to page" },
      { key: "href", label: "URL / path", inputType: "text", defaultValue: "/" },
      {
        key: "target",
        label: "Open in",
        inputType: "select",
        defaultValue: "_self",
        options: [
          { label: "Same tab", value: "_self" },
          { label: "New tab", value: "_blank" },
        ],
      },
      {
        key: "variant",
        label: "Variant",
        inputType: "select",
        defaultValue: "outline",
        options: [
          { label: "Default (primary)", value: "default" },
          { label: "Outline", value: "outline" },
        ],
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------
  {
    type: "ProgressBar",
    label: "Progress Bar",
    description: "Linear progress indicator with optional label and value.",
    category: "Progress",
    icon: "Gauge",
    defaultProps: {
      value: 65,
      max: 100,
      label: "Completion",
      showValue: true,
      variant: "default",
    },
    propSchema: [
      { key: "label", label: "Label", inputType: "text", defaultValue: "Completion" },
      { key: "value", label: "Current value", inputType: "number", defaultValue: 65 },
      { key: "max", label: "Max value", inputType: "number", defaultValue: 100 },
      { key: "showValue", label: "Show value text", inputType: "boolean", defaultValue: true },
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
    type: "MetricGauge",
    label: "Metric Gauge",
    description: "Radial gauge with configurable warning and danger thresholds.",
    category: "Progress",
    icon: "Gauge",
    defaultProps: {
      value: 72,
      max: 100,
      label: "CPU Usage",
      unit: "%",
      thresholds: { warning: 70, danger: 90 },
    },
    propSchema: [
      { key: "label", label: "Label", inputType: "text", defaultValue: "CPU Usage" },
      { key: "value", label: "Current value", inputType: "number", defaultValue: 72 },
      { key: "max", label: "Max value", inputType: "number", defaultValue: 100 },
      { key: "unit", label: "Unit suffix", inputType: "text", defaultValue: "%", description: "Appended after the value, e.g. %, ms, GB" },
      {
        key: "thresholds",
        label: "Thresholds",
        inputType: "json",
        defaultValue: { warning: 70, danger: 90 },
        description: "Object with warning and danger threshold numbers.",
        jsonSchema: {
          type: "object",
          properties: {
            warning: { type: "number", description: "Yellow threshold value" },
            danger: { type: "number", description: "Red threshold value" },
          },
          required: ["warning", "danger"],
        },
      },
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
  "Charts",
  "Form Inputs",
  "Interactive",
  "Progress",
  "Input",
  "Layout",
  "Custom",
];
