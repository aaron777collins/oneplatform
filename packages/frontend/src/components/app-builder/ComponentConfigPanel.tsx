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
import { AlignLeft, AlignCenter, AlignRight, AlignVerticalJustifyStart, Plus, Trash2, ChevronDown, ChevronUp, type LucideIcon } from "lucide-react";
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
            key={component.id}
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
// Individual prop field — handles all inputTypes including json and richtext
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

  if (descriptor.inputType === "richtext") {
    // A multiline textarea that accepts HTML or Markdown content.
    // A full WYSIWYG editor would require an external dependency; this provides
    // the core editing surface with clear labelling so users know what to expect.
    return (
      <div>
        {labelEl}
        <textarea
          id={id}
          value={strValue}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          className={`${inputClass} font-mono resize-y`}
          placeholder="Enter HTML or Markdown content…"
        />
        <p className="mt-1 text-[10px] text-[var(--color-muted-foreground,#6b7280)]">
          Supports HTML and Markdown syntax.
        </p>
        {descriptor.description !== undefined && (
          <p className="mt-0.5 text-[10px] text-[var(--color-muted-foreground,#6b7280)]">
            {descriptor.description}
          </p>
        )}
      </div>
    );
  }

  if (descriptor.inputType === "json") {
    // Use a visual array editor when the schema describes an array of objects,
    // falling back to a raw JSON textarea for other shapes (object, string[], etc.)
    const jsonSchema = descriptor.jsonSchema;
    const rawItems = jsonSchema?.["items"];
    const isArrayOfObjects =
      jsonSchema?.["type"] === "array" &&
      typeof rawItems === "object" &&
      rawItems !== null &&
      (rawItems as Record<string, unknown>)["type"] === "object";

    if (isArrayOfObjects) {
      const itemSchema = rawItems as Record<string, unknown>;
      const properties = (itemSchema["properties"] as Record<string, { type?: string; description?: string }>) ?? {};
      const propKeys = Object.keys(properties);
      const currentArray: Array<Record<string, unknown>> = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];

      return (
        <JsonArrayEditor
          id={id}
          label={descriptor.label}
          description={descriptor.description}
          propKeys={propKeys}
          properties={properties}
          value={currentArray}
          onChange={onChange}
        />
      );
    }

    // Non-array or simple array (e.g. string[] or number[]) — raw JSON textarea
    return (
      <div>
        {labelEl}
        {descriptor.description !== undefined && (
          <p className="mb-1 text-[10px] text-[var(--color-muted-foreground,#6b7280)]">
            {descriptor.description}
          </p>
        )}
        <JsonTextEditor id={id} value={value} onChange={onChange} />
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
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}
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
// JSON array visual editor (for DataTable columns, DetailPanel fields, etc.)
// ---------------------------------------------------------------------------

interface JsonArrayEditorProps {
  id: string;
  label: string;
  /** Undefined when the schema has no description. */
  description: string | undefined;
  propKeys: string[];
  properties: Record<string, { type?: string | undefined; description?: string | undefined }>;
  value: Array<Record<string, unknown>>;
  onChange: (value: unknown) => void;
}

function JsonArrayEditor({ id, label, description, propKeys, properties, value, onChange }: JsonArrayEditorProps) {
  function handleItemChange(index: number, key: string, fieldValue: string | boolean) {
    const next = value.map((item, i) => {
      if (i !== index) return item;
      return { ...item, [key]: fieldValue };
    });
    onChange(next);
  }

  function handleAddItem() {
    // Seed new item with empty defaults — boolean fields default to false
    const newItem: Record<string, unknown> = {};
    for (const key of propKeys) {
      newItem[key] = properties[key]?.type === "boolean" ? false : "";
    }
    onChange([...value, newItem]);
  }

  function handleRemoveItem(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function handleMoveItem(index: number, direction: "up" | "down") {
    const next = [...value];
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= next.length) return;
    [next[index], next[swapIndex]] = [next[swapIndex]!, next[index]!];
    onChange(next);
  }

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-1"
      >
        {label}
      </label>
      {description !== undefined && (
        <p className="mb-2 text-[10px] text-[var(--color-muted-foreground,#6b7280)]">{description}</p>
      )}

      <div className="space-y-2">
        {value.map((item, index) => (
          <div
            key={index}
            className="rounded-md border border-[var(--color-border,#e5e7eb)] bg-[var(--color-muted,#f9fafb)] p-2"
          >
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-[var(--color-muted-foreground,#6b7280)]">
                Item {index + 1}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => handleMoveItem(index, "up")}
                  disabled={index === 0}
                  aria-label={`Move item ${index + 1} up`}
                  className="rounded p-0.5 text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-border,#e5e7eb)] disabled:opacity-30"
                >
                  <ChevronUp className="h-3 w-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => handleMoveItem(index, "down")}
                  disabled={index === value.length - 1}
                  aria-label={`Move item ${index + 1} down`}
                  className="rounded p-0.5 text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-border,#e5e7eb)] disabled:opacity-30"
                >
                  <ChevronDown className="h-3 w-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveItem(index)}
                  aria-label={`Remove item ${index + 1}`}
                  className="rounded p-0.5 text-red-500 hover:bg-red-50"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="space-y-1">
              {propKeys.map((key) => {
                const fieldMeta = properties[key];
                const fieldValue = item[key];
                const isBool = fieldMeta?.type === "boolean";
                const strVal = fieldValue === undefined || fieldValue === null ? "" : String(fieldValue);

                return (
                  <div key={key} className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-[9px] font-medium text-[var(--color-muted-foreground,#6b7280)] capitalize">
                      {key}
                    </span>
                    {isBool ? (
                      <input
                        type="checkbox"
                        checked={fieldValue === true}
                        onChange={(e) => handleItemChange(index, key, e.target.checked)}
                        className="h-3.5 w-3.5 rounded accent-[var(--color-primary,#6366f1)]"
                        aria-label={`${key} for item ${index + 1}`}
                      />
                    ) : (
                      <input
                        type="text"
                        value={strVal}
                        onChange={(e) => handleItemChange(index, key, e.target.value)}
                        placeholder={fieldMeta?.description ?? key}
                        aria-label={`${key} for item ${index + 1}`}
                        className="flex-1 min-w-0 rounded border border-[var(--color-border,#e5e7eb)] bg-white px-1.5 py-0.5 text-[10px] text-[var(--color-foreground,#111)] focus:outline-none focus:ring-1 focus:ring-[var(--color-ring,#6366f1)]"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={handleAddItem}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-[var(--color-border,#e5e7eb)] py-1.5 text-[10px] text-[var(--color-muted-foreground,#6b7280)] hover:border-[var(--color-primary,#6366f1)]/50 hover:text-[var(--color-primary,#6366f1)] transition-colors"
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
        Add item
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raw JSON textarea — parse-on-blur to prevent mid-edit disruption
// ---------------------------------------------------------------------------

interface JsonTextEditorProps {
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
}

function JsonTextEditor({ id, value, onChange }: JsonTextEditorProps) {
  const serialized = React.useMemo(
    () => (value === undefined ? "" : JSON.stringify(value, null, 2)),
    [value],
  );
  const [draft, setDraft] = React.useState(serialized);
  const [parseError, setParseError] = React.useState<string | null>(null);

  // Sync draft when the prop changes externally (e.g. undo)
  React.useEffect(() => {
    setDraft(serialized);
    setParseError(null);
  }, [serialized]);

  function handleBlur() {
    if (draft.trim() === "") {
      onChange(undefined);
      setParseError(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(draft);
      onChange(parsed);
      setParseError(null);
    } catch {
      setParseError("Invalid JSON — changes will not be saved until fixed.");
    }
  }

  return (
    <div>
      <textarea
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        rows={5}
        className={`${inputClass} font-mono resize-y`}
        spellCheck={false}
        aria-invalid={parseError !== null}
        aria-describedby={parseError !== null ? `${id}-error` : undefined}
      />
      {parseError !== null && (
        <p id={`${id}-error`} className="mt-1 text-[10px] text-red-600" role="alert">
          {parseError}
        </p>
      )}
    </div>
  );
}

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

interface OntologyField {
  name: string;
  slug?: string;
  type?: string;
}

function DataBindingTab({ component, propSchema, onUpdateDataBinding }: DataBindingTabProps) {
  const client = useApiClient();
  const { data: ontologyData, isLoading: entitiesLoading } = useQuery({
    queryKey: ["ontology", "entity-types"],
    queryFn: () => client.get<OntologyEntitySummary[]>("/v1/ontology"),
    staleTime: 60_000,
  });

  const entityTypes: Array<{ slug: string; name: string }> = React.useMemo(() => {
    if (!ontologyData) return [];
    const items = Array.isArray(ontologyData) ? ontologyData : (ontologyData as unknown as { data: OntologyEntitySummary[] }).data ?? [];
    return items.map((e) => ({
      slug: e.slug ?? e.name.toLowerCase().replace(/\s+/g, "_"),
      name: e.name,
    }));
  }, [ontologyData]);

  const binding = component.dataBinding;
  const [entityType, setEntityType] = React.useState(binding?.entityType ?? "");
  const [fieldMap, setFieldMap] = React.useState<Record<string, string>>(
    binding?.fieldMap ?? {},
  );

  // Fetch entity fields when an entity type is selected — drives the field picker
  const { data: fieldsData, isLoading: fieldsLoading } = useQuery({
    queryKey: ["ontology", "entity-fields", entityType],
    queryFn: () =>
      client.get<{ fields: OntologyField[] } | OntologyField[]>(`/v1/ontology/${entityType}/fields`),
    enabled: entityType !== "",
    staleTime: 30_000,
  });

  const fields: OntologyField[] = React.useMemo(() => {
    if (!fieldsData) return [];
    if (Array.isArray(fieldsData)) return fieldsData;
    if ("fields" in (fieldsData as object)) {
      return (fieldsData as { fields: OntologyField[] }).fields;
    }
    return [];
  }, [fieldsData]);

  // Fetch a small data preview for the selected entity type
  const { data: previewData } = useQuery({
    queryKey: ["ontology", "entity-preview", entityType],
    queryFn: () =>
      client.get<{ data: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
        `/v1/ontology/${entityType}/data`,
        { limit: 3 },
      ),
    enabled: entityType !== "",
    staleTime: 30_000,
    // A missing /data endpoint should not break the panel — treat as empty
    retry: false,
  });

  const previewRows: Array<Record<string, unknown>> = React.useMemo(() => {
    if (!previewData) return [];
    if (Array.isArray(previewData)) return previewData.slice(0, 3);
    if ("data" in (previewData as object)) {
      return ((previewData as { data: Array<Record<string, unknown>> }).data ?? []).slice(0, 3);
    }
    return [];
  }, [previewData]);

  const isMountRef = React.useRef(true);

  React.useEffect(() => {
    if (isMountRef.current) {
      isMountRef.current = false;
      return;
    }
    if (entityType === "") {
      onUpdateDataBinding(undefined);
    } else {
      onUpdateDataBinding({ entityType, fieldMap });
    }
  // The effect intentionally omits onUpdateDataBinding — it is a stable callback
  // passed from the store and would re-trigger on every render if included.
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

  // Reset field map when entity type changes so stale mappings don't linger
  function handleEntityTypeChange(slug: string) {
    setEntityType(slug);
    setFieldMap({});
  }

  return (
    <div className="space-y-4">
      {/* Entity type dropdown */}
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
          onChange={(e) => handleEntityTypeChange(e.target.value)}
          className={inputClass}
          disabled={entitiesLoading}
        >
          <option value="">{entitiesLoading ? "Loading entities…" : "None (static props)"}</option>
          {entityTypes.map((et) => (
            <option key={et.slug} value={et.slug}>
              {et.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-[var(--color-muted-foreground,#6b7280)]">
          {entityTypes.length === 0 && !entitiesLoading
            ? "No entity types found. Create one in the Ontology section first."
            : "Select an ontology entity to populate component props from live data."}
        </p>
      </div>

      {/* Data preview — 3 sample rows to help users understand the data shape */}
      {entityType !== "" && previewRows.length > 0 && (
        <DataPreview rows={previewRows} />
      )}

      {/* Field mapping — visual field picker replaces raw text input */}
      {entityType !== "" && propSchema.length > 0 && (
        <div>
          <p className="text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-2">
            Field mapping
          </p>
          {fieldsLoading && (
            <p className="text-[10px] text-[var(--color-muted-foreground,#6b7280)]">Loading fields…</p>
          )}
          <div className="space-y-2">
            {propSchema.map((descriptor) => (
              <FieldPicker
                key={descriptor.key}
                propKey={descriptor.key}
                entityType={entityType}
                fields={fields}
                selectedField={fieldMap[descriptor.key] ?? ""}
                onSelect={(field) => handleFieldMapChange(descriptor.key, field)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data preview table (NCD-018)
// ---------------------------------------------------------------------------

interface DataPreviewProps {
  rows: Array<Record<string, unknown>>;
}

function DataPreview({ rows }: DataPreviewProps) {
  if (rows.length === 0) return null;

  // Show only the first 5 columns to avoid overflow in the narrow panel
  const allKeys = Object.keys(rows[0] ?? {});
  const visibleKeys = allKeys.slice(0, 5);
  const hiddenCount = allKeys.length - visibleKeys.length;

  return (
    <div>
      <p className="mb-1 text-[10px] font-medium text-[var(--color-muted-foreground,#6b7280)]">
        Data preview (first {rows.length} rows)
      </p>
      <div className="overflow-x-auto rounded-md border border-[var(--color-border,#e5e7eb)]">
        <table className="w-full text-[9px]">
          <thead>
            <tr className="border-b border-[var(--color-border,#e5e7eb)] bg-[var(--color-muted,#f9fafb)]">
              {visibleKeys.map((key) => (
                <th
                  key={key}
                  className="px-1.5 py-1 text-left font-semibold text-[var(--color-foreground,#111)] truncate max-w-[60px]"
                >
                  {key}
                </th>
              ))}
              {hiddenCount > 0 && (
                <th className="px-1.5 py-1 text-[var(--color-muted-foreground,#6b7280)]">
                  +{hiddenCount}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-[var(--color-border,#e5e7eb)] last:border-0"
              >
                {visibleKeys.map((key) => {
                  const val = row[key];
                  const display =
                    val === null || val === undefined
                      ? "—"
                      : typeof val === "object"
                      ? JSON.stringify(val)
                      : String(val);
                  return (
                    <td
                      key={key}
                      className="px-1.5 py-1 text-[var(--color-foreground,#111)] truncate max-w-[60px]"
                      title={display}
                    >
                      {display}
                    </td>
                  );
                })}
                {hiddenCount > 0 && <td />}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field picker chip list (NCD-007)
// ---------------------------------------------------------------------------

interface FieldPickerProps {
  propKey: string;
  entityType: string;
  fields: OntologyField[];
  selectedField: string;
  onSelect: (field: string) => void;
}

function FieldPicker({ propKey, fields, selectedField, onSelect }: FieldPickerProps) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="w-20 shrink-0 text-[10px] text-[var(--color-foreground,#111)] font-mono truncate">
          {propKey}
        </span>
        <span className="text-[10px] text-[var(--color-muted-foreground,#6b7280)]">←</span>
        <select
          value={selectedField}
          onChange={(e) => onSelect(e.target.value)}
          aria-label={`Map ${propKey} to entity field`}
          className="flex-1 min-w-0 rounded border border-[var(--color-border,#e5e7eb)] bg-[var(--color-background,#fff)] px-2 py-0.5 text-[10px] font-mono text-[var(--color-foreground,#111)] focus:outline-none focus:ring-1 focus:ring-[var(--color-ring,#6366f1)]"
        >
          <option value="">Not mapped</option>
          {fields.map((f) => {
            const slug = f.slug ?? f.name.toLowerCase().replace(/\s+/g, "_");
            return (
              <option key={slug} value={slug}>
                {f.name}{f.type !== undefined ? ` (${f.type})` : ""}
              </option>
            );
          })}
        </select>
      </div>
      {/* Chip list for quick field selection when fields are available */}
      {fields.length > 0 && fields.length <= 12 && (
        <div className="flex flex-wrap gap-1 mt-1 ml-[88px]">
          {fields.map((f) => {
            const slug = f.slug ?? f.name.toLowerCase().replace(/\s+/g, "_");
            const isSelected = selectedField === slug;
            return (
              <button
                key={slug}
                type="button"
                onClick={() => onSelect(isSelected ? "" : slug)}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? "Unmap" : "Map to"} field ${f.name}`}
                className={`rounded px-1.5 py-0.5 text-[9px] font-mono transition-colors ${
                  isSelected
                    ? "bg-[var(--color-primary,#6366f1)] text-white"
                    : "bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-primary,#6366f1)]/10 hover:text-[var(--color-primary,#6366f1)]"
                }`}
              >
                {f.name}
                {f.type !== undefined && (
                  <span className="ml-0.5 opacity-60">:{f.type}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style tab — uses plain-language labels and icon buttons for alignment
// ---------------------------------------------------------------------------

interface StyleTabProps {
  component: PlacedComponent;
  onUpdateStyles: (styles: Record<string, string>) => void;
}

const SPACING_OPTIONS = ["0", "4px", "8px", "12px", "16px", "24px", "32px"];

/** Alignment options expressed as user-facing labels with icon buttons. */
const ALIGN_OPTIONS: Array<{ label: string; value: string; Icon: LucideIcon }> = [
  { label: "Left",    value: "flex-start", Icon: AlignLeft },
  { label: "Center",  value: "center",     Icon: AlignCenter },
  { label: "Right",   value: "flex-end",   Icon: AlignRight },
  { label: "Stretch", value: "stretch",    Icon: AlignVerticalJustifyStart },
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

  const currentAlign = styles["alignSelf"] ?? "";

  return (
    <div className="space-y-4">
      {/* Inner spacing (was "Padding") */}
      <div>
        <label
          htmlFor="style-padding"
          className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-1"
        >
          Inner spacing
        </label>
        {/* Visual diagram: box-in-box to convey padding concept */}
        <div className="mb-2 flex items-center justify-center rounded border border-dashed border-[var(--color-border,#e5e7eb)] p-1">
          <div className="flex h-8 w-16 items-center justify-center rounded border border-[var(--color-border,#e5e7eb)] bg-[var(--color-muted,#f3f4f6)]">
            <div className="h-4 w-8 rounded bg-[var(--color-primary,#6366f1)]/20" />
          </div>
          <span className="ml-2 text-[9px] text-[var(--color-muted-foreground,#6b7280)]">
            Space inside the component border
          </span>
        </div>
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

      {/* Outer spacing (was "Margin") */}
      <div>
        <label
          htmlFor="style-margin"
          className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-1"
        >
          Outer spacing
        </label>
        <p className="mb-1 text-[9px] text-[var(--color-muted-foreground,#6b7280)]">
          Space outside the component, pushing other elements away
        </p>
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

      {/* Alignment — icon button row replaces text dropdown */}
      <div>
        <p className="block text-xs font-medium text-[var(--color-muted-foreground,#6b7280)] mb-2">
          Alignment
        </p>
        <div className="flex gap-1" role="group" aria-label="Horizontal alignment">
          {ALIGN_OPTIONS.map(({ label, value, Icon }) => {
            const isActive = currentAlign === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => handleStyleChange("alignSelf", isActive ? "" : value)}
                aria-pressed={isActive}
                aria-label={label}
                title={label}
                className={`flex flex-1 items-center justify-center rounded py-1.5 transition-colors ${
                  isActive
                    ? "bg-[var(--color-primary,#6366f1)] text-white"
                    : "bg-[var(--color-muted,#f3f4f6)] text-[var(--color-muted-foreground,#6b7280)] hover:bg-[var(--color-border,#e5e7eb)]"
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[9px] text-[var(--color-muted-foreground,#6b7280)]">
          Left · Center · Right · Stretch
        </p>
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
