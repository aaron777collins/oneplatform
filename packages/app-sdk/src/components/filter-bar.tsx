/**
 * FilterBar — composable filter controls for list views.
 *
 * Each FilterDef describes one filter — its type determines which input widget
 * is rendered. The component is deliberately uncontrolled in its layout (flex-wrap
 * row) so it adapts naturally to the number of active filters without requiring
 * callers to manage grid/flex layout.
 *
 * All state lives in the parent via the `values` + `onChange` props so that
 * filter state can be persisted to the URL or a context by the caller.
 */

import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FilterType = "text" | "select" | "date-range" | "boolean";

export interface SelectOption {
  label: string;
  value: string;
}

export interface FilterDef {
  /** Unique identifier used as the key in FilterValues. */
  key: string;
  label: string;
  type: FilterType;
  /** Required when type === "select". */
  options?: SelectOption[];
  placeholder?: string;
}

export type FilterValues = Record<string, string | boolean | DateRange | undefined>;

export interface DateRange {
  from?: string;
  to?: string;
}

export interface FilterBarProps {
  filters: FilterDef[];
  values: FilterValues;
  onChange: (key: string, value: string | boolean | DateRange | undefined) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// FilterBar component
// ---------------------------------------------------------------------------

export function FilterBar({ filters, values, onChange, className }: FilterBarProps) {
  if (filters.length === 0) return null;

  return (
    <div
      role="search"
      aria-label="Filter controls"
      className={[
        "flex flex-wrap items-end gap-3",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {filters.map((filter) => (
        <FilterControl
          key={filter.key}
          filter={filter}
          value={values[filter.key]}
          onChange={(val) => onChange(filter.key, val)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterControl — renders the appropriate input for each filter type
// ---------------------------------------------------------------------------

interface FilterControlProps {
  filter: FilterDef;
  value: string | boolean | DateRange | undefined;
  onChange: (value: string | boolean | DateRange | undefined) => void;
}

function FilterControl({ filter, value, onChange }: FilterControlProps) {
  const labelId = `filter-label-${filter.key}`;

  return (
    <div className="flex flex-col gap-1">
      <label
        id={labelId}
        htmlFor={`filter-${filter.key}`}
        className="text-xs font-medium text-[var(--color-muted-foreground,#6b7280)]"
      >
        {filter.label}
      </label>

      {filter.type === "text" && (
        <input
          id={`filter-${filter.key}`}
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          placeholder={filter.placeholder ?? `Filter by ${filter.label.toLowerCase()}...`}
          aria-labelledby={labelId}
          className="rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-3 py-1.5 text-sm text-[var(--color-foreground,#111)] placeholder:text-[var(--color-muted-foreground,#9ca3af)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring,#6366f1)]"
        />
      )}

      {filter.type === "select" && (
        <select
          id={`filter-${filter.key}`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          aria-labelledby={labelId}
          className="rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-3 py-1.5 text-sm text-[var(--color-foreground,#111)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring,#6366f1)]"
        >
          <option value="">All</option>
          {(filter.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {filter.type === "date-range" && (
        <DateRangeInput
          id={`filter-${filter.key}`}
          value={value instanceof Object && !Array.isArray(value) && typeof value !== "string" && typeof value !== "boolean" ? value as DateRange : undefined}
          onChange={onChange}
          ariaLabelledBy={labelId}
        />
      )}

      {filter.type === "boolean" && (
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-3 py-1.5 text-sm">
          <input
            id={`filter-${filter.key}`}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked ? true : undefined)}
            aria-labelledby={labelId}
            className="h-4 w-4 rounded border-[var(--color-border,#e5e7eb)] accent-[var(--color-primary,#6366f1)]"
          />
          <span className="text-[var(--color-foreground,#111)]">
            {filter.placeholder ?? filter.label}
          </span>
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DateRangeInput — two date pickers for a from–to range
// ---------------------------------------------------------------------------

interface DateRangeInputProps {
  id: string;
  value: DateRange | undefined;
  onChange: (value: DateRange | undefined) => void;
  ariaLabelledBy: string;
}

function DateRangeInput({ id, value, onChange, ariaLabelledBy }: DateRangeInputProps) {
  const from = value?.from ?? "";
  const to = value?.to ?? "";

  function handleChange(field: "from" | "to", raw: string) {
    const next: DateRange = { from, to, [field]: raw === "" ? undefined : raw };
    // Emit undefined when both ends are cleared so the parent knows the filter
    // is inactive — avoids sending empty DateRange objects to the query layer.
    const isEmpty = (next.from === undefined || next.from === "") && (next.to === undefined || next.to === "");
    onChange(isEmpty ? undefined : next);
  }

  return (
    <div className="flex items-center gap-1.5" aria-labelledby={ariaLabelledBy}>
      <input
        id={id}
        type="date"
        value={from}
        onChange={(e) => handleChange("from", e.target.value)}
        aria-label="From date"
        className="rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-2 py-1.5 text-sm text-[var(--color-foreground,#111)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring,#6366f1)]"
      />
      <span className="text-xs text-[var(--color-muted-foreground,#6b7280)]" aria-hidden="true">
        to
      </span>
      <input
        type="date"
        value={to}
        min={from}
        onChange={(e) => handleChange("to", e.target.value)}
        aria-label="To date"
        className="rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-2 py-1.5 text-sm text-[var(--color-foreground,#111)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring,#6366f1)]"
      />
    </div>
  );
}
