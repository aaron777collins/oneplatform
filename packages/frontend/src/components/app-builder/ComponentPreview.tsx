/**
 * ComponentPreview — renders a placed component with its configured props.
 *
 * SDK components are instantiated directly (no iframe required for the
 * visual builder canvas — isolation happens at runtime in the full app shell).
 * Custom blocks (HtmlBlock, MarkdownBlock) render inline previews.
 * Chart, form, interactive, and progress components render lightweight
 * builder-only previews using Recharts and plain HTML so the canvas looks
 * representative without pulling in a separate runtime package.
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
import {
  BarChart as RechartsBarChart,
  Bar,
  LineChart as RechartsLineChart,
  Line,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  RadialBarChart,
  RadialBar,
} from "recharts";

// ---------------------------------------------------------------------------
// Default palette for recharts slices when no explicit colors are provided
// ---------------------------------------------------------------------------

const DEFAULT_CHART_COLORS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
];

// ---------------------------------------------------------------------------
// Variant colour maps for progress components
// ---------------------------------------------------------------------------

const PROGRESS_VARIANT_COLORS: Record<string, string> = {
  default: "#6366f1",
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
};

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

    // -----------------------------------------------------------------------
    // Charts
    // -----------------------------------------------------------------------

    case "BarChart":
      return <BarChartPreview props={props} style={style} />;

    case "LineChart":
      return <LineChartPreview props={props} style={style} />;

    case "PieChart":
      return <PieChartPreview props={props} style={style} />;

    case "AreaChart":
      return <AreaChartPreview props={props} style={style} />;

    case "KPICard":
      return <KPICardPreview props={props} style={style} />;

    // -----------------------------------------------------------------------
    // Form Inputs
    // -----------------------------------------------------------------------

    case "TextInput":
      return <TextInputPreview props={props} style={style} />;

    case "NumberInput":
      return <NumberInputPreview props={props} style={style} />;

    case "DatePicker":
      return <DatePickerPreview props={props} style={style} />;

    case "SelectInput":
      return <SelectInputPreview props={props} style={style} />;

    case "CheckboxGroup":
      return <CheckboxGroupPreview props={props} style={style} />;

    // -----------------------------------------------------------------------
    // Interactive
    // -----------------------------------------------------------------------

    case "ActionButton":
      return <ActionButtonPreview props={props} style={style} />;

    case "LinkButton":
      return <LinkButtonPreview props={props} style={style} />;

    // -----------------------------------------------------------------------
    // Progress
    // -----------------------------------------------------------------------

    case "ProgressBar":
      return <ProgressBarPreview props={props} style={style} />;

    case "MetricGauge":
      return <MetricGaugePreview props={props} style={style} />;

    default:
      return <UnknownComponentFallback type={type} />;
  }
}

// ---------------------------------------------------------------------------
// Shared preview prop types
// ---------------------------------------------------------------------------

interface PreviewProps {
  props: Record<string, unknown>;
  // style is taken directly from component.styles which may be undefined
  style: React.CSSProperties | undefined;
}

// ---------------------------------------------------------------------------
// Chart previews
// ---------------------------------------------------------------------------

function BarChartPreview({ props, style }: PreviewProps) {
  const title = String(props["title"] ?? "");
  const data = (props["data"] as object[] | undefined) ?? [];
  const xField = String(props["xField"] ?? "x");
  const yField = String(props["yField"] ?? "y");
  const color = String(props["color"] ?? DEFAULT_CHART_COLORS[0]);
  const showGrid = props["showGrid"] !== false;
  const showLegend = props["showLegend"] === true;
  const height = Number(props["height"] ?? 300);

  return (
    <div style={style} className="p-3">
      {title !== "" && (
        <p className="mb-2 text-sm font-semibold text-[var(--color-foreground,#111)]">{title}</p>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <RechartsBarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />}
          <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} width={40} />
          <Tooltip />
          {showLegend && <Legend />}
          <Bar dataKey={yField} fill={color} radius={[3, 3, 0, 0]} />
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LineChartPreview({ props, style }: PreviewProps) {
  const title = String(props["title"] ?? "");
  const data = (props["data"] as object[] | undefined) ?? [];
  const xField = String(props["xField"] ?? "x");
  const yFields = (props["yFields"] as string[] | undefined) ?? ["value"];
  const colors = (props["colors"] as string[] | undefined) ?? DEFAULT_CHART_COLORS;
  const showGrid = props["showGrid"] !== false;
  const showDots = props["showDots"] !== false;
  const height = Number(props["height"] ?? 300);

  return (
    <div style={style} className="p-3">
      {title !== "" && (
        <p className="mb-2 text-sm font-semibold text-[var(--color-foreground,#111)]">{title}</p>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <RechartsLineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />}
          <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} width={40} />
          <Tooltip />
          {yFields.length > 1 && <Legend />}
          {yFields.map((field, i) => (
            <Line
              key={field}
              type="monotone"
              dataKey={field}
              stroke={colors[i] ?? DEFAULT_CHART_COLORS[i % DEFAULT_CHART_COLORS.length]}
              strokeWidth={2}
              dot={showDots ? { r: 3 } : false}
            />
          ))}
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PieChartPreview({ props, style }: PreviewProps) {
  const title = String(props["title"] ?? "");
  const data = (props["data"] as object[] | undefined) ?? [];
  const nameField = String(props["nameField"] ?? "name");
  const valueField = String(props["valueField"] ?? "value");
  const donut = props["donut"] === true;
  const showLabels = props["showLabels"] !== false;
  const height = Number(props["height"] ?? 300);

  // Recharts Pie requires the name/value keys to match
  const normalized = data.map((d) => ({
    name: String((d as Record<string, unknown>)[nameField] ?? ""),
    value: Number((d as Record<string, unknown>)[valueField] ?? 0),
  }));

  const innerRadius = donut ? "55%" : "0%";

  return (
    <div style={style} className="p-3">
      {title !== "" && (
        <p className="mb-2 text-sm font-semibold text-[var(--color-foreground,#111)]">{title}</p>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <RechartsPieChart>
          <Pie
            data={normalized}
            cx="50%"
            cy="50%"
            innerRadius={innerRadius}
            outerRadius="75%"
            dataKey="value"
            nameKey="name"
            label={showLabels ? (entry: { name: string }) => entry.name : false}
            labelLine={showLabels}
          >
            {normalized.map((_, i) => (
              <Cell
                key={`cell-${i}`}
                fill={DEFAULT_CHART_COLORS[i % DEFAULT_CHART_COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip />
          <Legend />
        </RechartsPieChart>
      </ResponsiveContainer>
    </div>
  );
}

function AreaChartPreview({ props, style }: PreviewProps) {
  const title = String(props["title"] ?? "");
  const data = (props["data"] as object[] | undefined) ?? [];
  const xField = String(props["xField"] ?? "x");
  const yField = String(props["yField"] ?? "y");
  const color = String(props["color"] ?? DEFAULT_CHART_COLORS[0]);
  const gradient = props["gradient"] !== false;
  const height = Number(props["height"] ?? 300);

  const gradientId = "area-preview-gradient";

  return (
    <div style={style} className="p-3">
      {title !== "" && (
        <p className="mb-2 text-sm font-semibold text-[var(--color-foreground,#111)]">{title}</p>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <RechartsAreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          {gradient && (
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
          )}
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} width={40} />
          <Tooltip />
          <Area
            type="monotone"
            dataKey={yField}
            stroke={color}
            strokeWidth={2}
            fill={gradient ? `url(#${gradientId})` : color}
            fillOpacity={gradient ? 1 : 0.1}
          />
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function KPICardPreview({ props, style }: PreviewProps) {
  const title = String(props["title"] ?? "");
  const value = String(props["value"] ?? "0");
  const change = Number(props["change"] ?? 0);
  const trend = String(props["trend"] ?? "flat");
  const sparklineData = (props["sparklineData"] as number[] | undefined) ?? [];

  // Normalise sparkline data for Recharts
  const chartData = sparklineData.map((v, i) => ({ i, v }));

  const trendColor =
    trend === "up" ? "#10b981" : trend === "down" ? "#ef4444" : "#6b7280";
  const trendSymbol = trend === "up" ? "▲" : trend === "down" ? "▼" : "—";
  const changeStr = `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;

  return (
    <div
      style={style}
      className="rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] p-4"
    >
      <p className="text-xs text-[var(--color-muted-foreground,#6b7280)]">{title}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <div>
          <p className="text-2xl font-bold text-[var(--color-foreground,#111)]">{value}</p>
          <p className="mt-1 text-xs font-medium" style={{ color: trendColor }}>
            {trendSymbol} {changeStr}
          </p>
        </div>
        {chartData.length > 0 && (
          <ResponsiveContainer width={80} height={40}>
            <RechartsAreaChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="kpi-sparkline-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={trendColor} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={trendColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={trendColor}
                strokeWidth={1.5}
                fill="url(#kpi-sparkline-fill)"
                dot={false}
              />
            </RechartsAreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form input previews — static read-only representations of the field UI
// ---------------------------------------------------------------------------

const inputPreviewClass =
  "w-full rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-3 py-2 text-sm text-[var(--color-muted-foreground,#9ca3af)]";

const labelPreviewClass =
  "block text-xs font-medium text-[var(--color-foreground,#111)] mb-1";

function TextInputPreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "Label");
  const placeholder = String(props["placeholder"] ?? "Enter value…");
  const required = props["required"] === true;
  const helpText = String(props["helpText"] ?? "");

  return (
    <div style={style} className="p-3 space-y-1">
      <label className={labelPreviewClass}>
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      <div className={`${inputPreviewClass} cursor-default`}>{placeholder}</div>
      {helpText !== "" && (
        <p className="text-[10px] text-[var(--color-muted-foreground,#9ca3af)]">{helpText}</p>
      )}
    </div>
  );
}

function NumberInputPreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "Amount");
  const placeholder = String(props["placeholder"] ?? "0");
  const prefix = String(props["prefix"] ?? "");
  const suffix = String(props["suffix"] ?? "");

  return (
    <div style={style} className="p-3 space-y-1">
      <label className={labelPreviewClass}>{label}</label>
      <div className="flex items-center rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)]">
        {prefix !== "" && (
          <span className="px-2 py-2 text-sm text-[var(--color-muted-foreground,#6b7280)] border-r border-[var(--color-border,#e5e7eb)]">
            {prefix}
          </span>
        )}
        <span className="flex-1 px-3 py-2 text-sm text-[var(--color-muted-foreground,#9ca3af)]">
          {placeholder}
        </span>
        {suffix !== "" && (
          <span className="px-2 py-2 text-sm text-[var(--color-muted-foreground,#6b7280)] border-l border-[var(--color-border,#e5e7eb)]">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function DatePickerPreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "Date");
  const type = String(props["type"] ?? "date");
  const placeholderMap: Record<string, string> = {
    date: "MM/DD/YYYY",
    datetime: "MM/DD/YYYY HH:MM",
    daterange: "MM/DD/YYYY — MM/DD/YYYY",
  };

  return (
    <div style={style} className="p-3 space-y-1">
      <label className={labelPreviewClass}>{label}</label>
      <div className={`${inputPreviewClass} flex items-center justify-between cursor-default`}>
        <span>{placeholderMap[type] ?? "MM/DD/YYYY"}</span>
        <span className="text-[var(--color-muted-foreground,#6b7280)]">📅</span>
      </div>
    </div>
  );
}

function SelectInputPreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "Select an option");
  const placeholder = String(props["placeholder"] ?? "Choose…");

  return (
    <div style={style} className="p-3 space-y-1">
      <label className={labelPreviewClass}>{label}</label>
      <div className={`${inputPreviewClass} flex items-center justify-between cursor-default`}>
        <span>{placeholder}</span>
        <span className="text-[var(--color-muted-foreground,#6b7280)]">▾</span>
      </div>
    </div>
  );
}

function CheckboxGroupPreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "Select all that apply");
  const options = (props["options"] as Array<{ label: string; value: string }> | undefined) ?? [];
  const direction = String(props["direction"] ?? "vertical");
  const isHorizontal = direction === "horizontal";

  return (
    <div style={style} className="p-3 space-y-2">
      <p className={labelPreviewClass}>{label}</p>
      <div className={`flex ${isHorizontal ? "flex-row flex-wrap gap-4" : "flex-col gap-2"}`}>
        {options.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-2 text-sm text-[var(--color-foreground,#111)] cursor-default"
          >
            <input type="checkbox" disabled className="h-3.5 w-3.5 rounded" readOnly />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interactive previews
// ---------------------------------------------------------------------------

const BUTTON_VARIANT_CLASSES: Record<string, string> = {
  default:
    "bg-[var(--color-primary,#6366f1)] text-white hover:opacity-90",
  outline:
    "border border-[var(--color-primary,#6366f1)] text-[var(--color-primary,#6366f1)] bg-transparent",
  destructive: "bg-red-600 text-white",
  ghost:
    "text-[var(--color-foreground,#111)] hover:bg-[var(--color-muted,#f3f4f6)]",
};

const BUTTON_SIZE_CLASSES: Record<string, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-base",
};

function ActionButtonPreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "Submit");
  const variant = String(props["variant"] ?? "default");
  const size = String(props["size"] ?? "md");
  const disabled = props["disabled"] === true;

  const variantClass = BUTTON_VARIANT_CLASSES[variant] ?? BUTTON_VARIANT_CLASSES["default"]!;
  const sizeClass = BUTTON_SIZE_CLASSES[size] ?? BUTTON_SIZE_CLASSES["md"]!;

  return (
    <div style={style} className="p-3">
      <button
        type="button"
        disabled={disabled}
        // Builder preview — events are wired in generated code, not here
        className={`rounded-md font-medium transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ${variantClass} ${sizeClass}`}
      >
        {label}
      </button>
    </div>
  );
}

function LinkButtonPreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "Go to page");
  const variant = String(props["variant"] ?? "outline");

  const variantClass =
    variant === "default"
      ? BUTTON_VARIANT_CLASSES["default"]!
      : BUTTON_VARIANT_CLASSES["outline"]!;

  return (
    <div style={style} className="p-3">
      <span
        className={`inline-block rounded-md px-4 py-2 text-sm font-medium cursor-default ${variantClass}`}
      >
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress previews
// ---------------------------------------------------------------------------

function ProgressBarPreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "");
  const value = Number(props["value"] ?? 0);
  const max = Number(props["max"] ?? 100);
  const showValue = props["showValue"] !== false;
  const variant = String(props["variant"] ?? "default");

  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const trackColor = PROGRESS_VARIANT_COLORS[variant] ?? PROGRESS_VARIANT_COLORS["default"]!;

  return (
    <div style={style} className="p-3 space-y-1.5">
      {(label !== "" || showValue) && (
        <div className="flex items-center justify-between">
          {label !== "" && (
            <span className="text-xs font-medium text-[var(--color-foreground,#111)]">{label}</span>
          )}
          {showValue && (
            <span className="text-xs text-[var(--color-muted-foreground,#6b7280)]">
              {value} / {max}
            </span>
          )}
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-muted,#f3f4f6)]">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: trackColor }}
        />
      </div>
    </div>
  );
}

function MetricGaugePreview({ props, style }: PreviewProps) {
  const label = String(props["label"] ?? "");
  const value = Number(props["value"] ?? 0);
  const max = Number(props["max"] ?? 100);
  const unit = String(props["unit"] ?? "");
  const thresholds = (props["thresholds"] as { warning: number; danger: number } | undefined) ?? {
    warning: 70,
    danger: 90,
  };

  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

  // Pick track colour based on thresholds — shows at a glance whether the
  // metric is healthy, borderline, or critical.
  let gaugeColor = PROGRESS_VARIANT_COLORS["default"]!;
  if (value >= thresholds.danger) {
    gaugeColor = PROGRESS_VARIANT_COLORS["danger"]!;
  } else if (value >= thresholds.warning) {
    gaugeColor = PROGRESS_VARIANT_COLORS["warning"]!;
  }

  const chartData = [{ name: label, value: pct, fill: gaugeColor }];

  return (
    <div style={style} className="p-3 flex flex-col items-center">
      <ResponsiveContainer width="100%" height={160}>
        <RadialBarChart
          cx="50%"
          cy="80%"
          innerRadius="60%"
          outerRadius="90%"
          startAngle={180}
          endAngle={0}
          data={chartData}
          barSize={14}
        >
          <RadialBar background dataKey="value" />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="-mt-10 text-center">
        <p className="text-2xl font-bold text-[var(--color-foreground,#111)]" style={{ color: gaugeColor }}>
          {value}{unit}
        </p>
        {label !== "" && (
          <p className="mt-1 text-xs text-[var(--color-muted-foreground,#6b7280)]">{label}</p>
        )}
      </div>
    </div>
  );
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
