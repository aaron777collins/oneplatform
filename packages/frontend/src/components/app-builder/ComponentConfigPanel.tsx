/**
 * ComponentConfigPanel — side panel for configuring a selected component.
 *
 * Sections:
 *  1. Props — form driven by the component's propSchema from the palette registry
 *  2. Data binding — pick an ontology entity type and map fields to props
 *  3. Style overrides — spacing and alignment shortcuts
 *
 * All changes are committed immediately (no Save button) to keep the canvas
 * in sync with the panel. The builder store's undo/redo handles rollback.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/lib/api-client.js";
import type { PlacedComponent, DataBinding, PropDescriptor } from "./types.js";
import { getPaletteEntry } from "./palette-registry.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ComponentConfigPanelProps {
  component: PlacedComponent;
  onUpdateProps: (props: Record<string, unknown>) => void;
  onUpdateStyles: (styles: Record<string, string>) => void;
  onUpdateDataBinding: (binding: DataBinding | undefined) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// ComponentConfigPanel
// ---------------------------------------------------------------------------

export function ComponentConfigPanel({
  component,
  onUpdateProps,
  onUpdateStyles,
  onUpdateDataBinding,
  onClose,
}: ComponentConfigPanelProps) {
  const entry = getPaletteEntry(component.type);
  const [activeTab, setActiveTab] = React.useState<"props" | "data" | "style">("props");

  return (
    <div className="flex h-full flex-col border-l border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] w-72 shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border,#e5e7eb)]">
        <div>
          <p className="text-sm font-semibold text-[var(--color-foreground,#111)]">
            {entry?.label ?? component.type}
          </p>
          <p className="text-xs text-[var(--color-muted-foreground,#6b7280)]">
            {entry?.description ?? "Configure component"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)]"
          aria-label="Close config panel"
        >
          ×
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--color-border,#e5e7eb)]">
        {(["props", "data", "style"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 text-xs font-medium capitalize transition-colors ${
              activeTab === tab
                ? "border-b-2 border-[var(--color-primary,#6366f1)] text-[var(--color-primary,#6366f1)]"
                : "text-[var(--color-muted-foreground,#6b7280)] hover:text-[var(--color-foreground,#111)]"
            }`}
          >
            {tab === "data" ? "Data" : tab === "style" ? "Style" : "Props"}
          </button>
        ))}
      </div>

      {/* Panel body */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "props" && (
          <PropsTab
            component={component}
            propSchema={entry?.propSchema ?? []}
            onUpdateProps={onUpdateProps}
          />
        )}
        {activeTab === "data" && (
          <DataBindingTab
            component={component}
            propSchema={entry?.propSchema ?? []}
            onUpdateDataBinding={onUpdateDataBinding}
          />
        )}
        {activeTab === "style" && (
          <StyleTab
            component={component}
            onUpdateStyles={onUpdateStyles}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props tab
// ---------------------------------------------------------------------------

interface PropsTabProps {
  component: PlacedComponent;
  propSchema: PropDescriptor[];
  onUpdateProps: (props: Record<string, unknown>) => void;
}

function PropsTab({ component, propSchema, onUpdateProps }: PropsTabProps) {
  function handleChange(key: string, value: unknown) {
    onUpdateProps({ ...component.props, [key]: value });
  }

  if (propSchema.length === 0) {
    return (
      <p className="text-xs text-[var(--color-muted-foreground,#6b7280)]">
        No configurable properties for this component.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {propSchema.map((descriptor) => (
        <PropField
          key={descriptor.key}
          descriptor={descriptor}
          value={component.props[descriptor.key] ?? descriptor.defaultValue}
          onChange={(v) => handleChange(descriptor.key, v)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual prop field
// ---------------------------------------------------------------------------

interface PropFieldProps {
  descriptor: PropDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
}

function PropField({ descriptor, value, onChange }: PropFieldProps) {
  const id = `prop-${descriptor.key}`;
  const strValue = value === undefined || value === null ? "" : String(value);

  const labelEl = (
    <label
      htmlFor={id}
      className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-1"
    >
      {descriptor.label}
    </label>
  );

  if (descriptor.inputType === "boolean") {
    return (
      <div>
        <label className="flex items-center gap-2 text-xs font-medium text-[var(--color-muted-foreground,#6b7280)]">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-[var(--color-primary,#6366f1)]"
          />
          {descriptor.label}
        </label>
      </div>
    );
  }

  if (descriptor.inputType === "select" && descriptor.options !== undefined) {
    return (
      <div>
        {labelEl}
        <select
          id={id}
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          {descriptor.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (descriptor.inputType === "textarea") {
    return (
      <div>
        {labelEl}
        <textarea
          id={id}
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={`${inputClass} font-mono resize-y`}
        />
      </div>
    );
  }

  if (descriptor.inputType === "number") {
    return (
      <div>
        {labelEl}
        <input
          id={id}
          type="number"
          value={value === undefined ? "" : Number(value)}
          onChange={(e) => onChange(e.target.valueAsNumber)}
          className={inputClass}
        />
      </div>
    );
  }

  // Default: text
  return (
    <div>
      {labelEl}
      <input
        id={id}
        type="text"
        value={strValue}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      />
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-2 py-1 text-xs text-[var(--color-foreground,#111)] focus:outline-none focus:ring-1 focus:ring-[var(--color-ring,#6366f1)]";

// ---------------------------------------------------------------------------
// Data binding tab
// ---------------------------------------------------------------------------

interface DataBindingTabProps {
  component: PlacedComponent;
  propSchema: PropDescriptor[];
  onUpdateDataBinding: (binding: DataBinding | undefined) => void;
}

interface OntologyEntitySummary {
  name: string;
  slug?: string;
}

function DataBindingTab({ component, propSchema, onUpdateDataBinding }: DataBindingTabProps) {
  const client = useApiClient();
  const { data: ontologyData, isLoading: entitiesLoading } = useQuery({
    queryKey: ["ontology", "entity-types"],
    queryFn: () => client.get<OntologyEntitySummary[]>("/v1/ontology"),
    staleTime: 60_000,
  });

  const entityTypes: string[] = React.useMemo(() => {
    if (!ontologyData) return [];
    const items = Array.isArray(ontologyData) ? ontologyData : (ontologyData as unknown as { data: OntologyEntitySummary[] }).data ?? [];
    return items.map((e) => e.slug ?? e.name.toLowerCase().replace(/\s+/g, "_"));
  }, [ontologyData]);
  const binding = component.dataBinding;
  const [entityType, setEntityType] = React.useState(binding?.entityType ?? "");
  const [fieldMap, setFieldMap] = React.useState<Record<string, string>>(
    binding?.fieldMap ?? {},
  );

  // Propagate changes immediately
  React.useEffect(() => {
    if (entityType === "") {
      onUpdateDataBinding(undefined);
    } else {
      onUpdateDataBinding({ entityType, fieldMap });
    }
  // Intentionally omitting onUpdateDataBinding — it's a stable callback ref
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, fieldMap]);

  function handleFieldMapChange(propKey: string, entityField: string) {
    setFieldMap((prev) => {
      if (entityField === "") {
        const next = { ...prev };
        delete next[propKey];
        return next;
      }
      return { ...prev, [propKey]: entityField };
    });
  }

  return (
    <div className="space-y-4">
      {/* Entity type selector */}
      <div>
        <label
          htmlFor="entity-type"
          className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-1"
        >
          Entity type
        </label>
        <select
          id="entity-type"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className={inputClass}
          disabled={entitiesLoading}
        >
          <option value="">{entitiesLoading ? "Loading entities..." : "None (static props)"}</option>
          {entityTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-[var(--color-muted-foreground,#6b7280)]">
          {entityTypes.length === 0 && !entitiesLoading
            ? "No entity types found. Create one in the Ontology section first."
            : "Select an ontology entity to populate component props from live data."}
        </p>
      </div>

      {/* Field mapping — only shown when an entity type is selected */}
      {entityType !== "" && propSchema.length > 0 && (
        <div>
          <p className="text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-2">
            Field mapping
          </p>
          <div className="space-y-2">
            {propSchema.map((descriptor) => (
              <div key={descriptor.key} className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-[10px] text-[var(--color-foreground,#111)] font-mono truncate">
                  {descriptor.key}
                </span>
                <span className="text-[10px] text-[var(--color-muted-foreground,#6b7280)]">←</span>
                <input
                  type="text"
                  placeholder={`${entityType}.field`}
                  value={fieldMap[descriptor.key] ?? ""}
                  onChange={(e) => handleFieldMapChange(descriptor.key, e.target.value)}
                  className="flex-1 min-w-0 rounded border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-2 py-0.5 text-[10px] font-mono text-[var(--color-foreground,#111)] focus:outline-none focus:ring-1 focus:ring-[var(--color-ring,#6366f1)]"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style tab
// ---------------------------------------------------------------------------

interface StyleTabProps {
  component: PlacedComponent;
  onUpdateStyles: (styles: Record<string, string>) => void;
}

const SPACING_OPTIONS = ["0", "4px", "8px", "12px", "16px", "24px", "32px"];
const ALIGN_OPTIONS = [
  { label: "Left", value: "flex-start" },
  { label: "Center", value: "center" },
  { label: "Right", value: "flex-end" },
  { label: "Fill", value: "stretch" },
];

function StyleTab({ component, onUpdateStyles }: StyleTabProps) {
  const styles = component.styles ?? {};

  function handleStyleChange(property: string, value: string) {
    const next = { ...styles };
    if (value === "" || value === "0") {
      delete next[property];
    } else {
      next[property] = value;
    }
    onUpdateStyles(next);
  }

  return (
    <div className="space-y-4">
      {/* Padding */}
      <div>
        <label
          htmlFor="style-padding"
          className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-1"
        >
          Padding
        </label>
        <select
          id="style-padding"
          value={styles["padding"] ?? ""}
          onChange={(e) => handleStyleChange("padding", e.target.value)}
          className={inputClass}
        >
          <option value="">Default</option>
          {SPACING_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {/* Margin */}
      <div>
        <label
          htmlFor="style-margin"
          className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-1"
        >
          Margin
        </label>
        <select
          id="style-margin"
          value={styles["margin"] ?? ""}
          onChange={(e) => handleStyleChange("margin", e.target.value)}
          className={inputClass}
        >
          <option value="">Default</option>
          {SPACING_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {/* Alignment */}
      <div>
        <label
          htmlFor="style-align"
          className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-1"
        >
          Alignment
        </label>
        <select
          id="style-align"
          value={styles["alignSelf"] ?? ""}
          onChange={(e) => handleStyleChange("alignSelf", e.target.value)}
          className={inputClass}
        >
          <option value="">Default</option>
          {ALIGN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Visibility */}
      <div>
        <label className="flex items-center gap-2 text-xs font-medium text-[var(--color-muted-foreground,#6b7280)]">
          <input
            type="checkbox"
            checked={styles["display"] !== "none"}
            onChange={(e) =>
              handleStyleChange("display", e.target.checked ? "" : "none")
            }
            className="h-3.5 w-3.5 rounded accent-[var(--color-primary,#6366f1)]"
          />
          Visible
        </label>
      </div>
    </div>
  );
}
