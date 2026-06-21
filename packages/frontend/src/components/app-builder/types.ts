/**
 * Layout model for the visual app builder.
 *
 * The model uses a row-column grid. Each column occupies 1–12 of 12 grid units
 * (matching Tailwind's 12-column grid). A column holds at most one component.
 *
 * This model is the single source of truth shared between the canvas, the code
 * generator, and the config panel. All mutations go through the builder store
 * rather than the model directly — this keeps undo history centralised.
 */

// ---------------------------------------------------------------------------
// Core layout model
// ---------------------------------------------------------------------------

export interface AppLayout {
  rows: LayoutRow[];
}

export interface LayoutRow {
  id: string;
  columns: LayoutColumn[];
  /** Optional explicit height CSS value, e.g. "200px" or "auto". */
  height?: string;
}

export interface LayoutColumn {
  id: string;
  /** Width in grid columns (1–12). All columns in a row must sum to ≤ 12. */
  width: number;
  component?: PlacedComponent;
}

export interface PlacedComponent {
  id: string;
  /** Component display name, e.g. "DataTable", "StatCard". */
  type: string;
  props: Record<string, unknown>;
  dataBinding?: DataBinding;
  styles?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Data binding
// ---------------------------------------------------------------------------

export interface DataBinding {
  /** Ontology entity type slug, e.g. "orders". */
  entityType: string;
  /**
   * Maps component prop names to entity field names.
   * e.g. { "data": "records", "title": "name" }
   */
  fieldMap: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Palette component descriptor
// ---------------------------------------------------------------------------

export type ComponentCategory =
  | "Data Display"
  | "Input"
  | "Layout"
  | "Charts"
  | "Form Inputs"
  | "Interactive"
  | "Progress"
  | "Custom";

export interface PaletteEntry {
  type: string;
  label: string;
  description: string;
  category: ComponentCategory;
  /** Default props seeded when the component is first placed. */
  defaultProps: Record<string, unknown>;
  /** Prop descriptors drive the config panel form. */
  propSchema: PropDescriptor[];
  icon: string; // Lucide icon name
}

// ---------------------------------------------------------------------------
// Prop schema for config panel
// ---------------------------------------------------------------------------

export type PropInputType =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "color"
  | "textarea"
  | "richtext"
  | "json";

export interface PropDescriptor {
  key: string;
  label: string;
  inputType: PropInputType;
  /** For inputType === "select". */
  options?: Array<{ label: string; value: string }>;
  defaultValue?: unknown;
  description?: string;
  /** For inputType === "json" — describes the expected JSON structure. */
  jsonSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Builder mode
// ---------------------------------------------------------------------------

export type BuilderMode = "edit" | "preview";

// ---------------------------------------------------------------------------
// Drag state — tracked in component state, not the store
// ---------------------------------------------------------------------------

export interface DragState {
  /** "palette" = dragging a new component from the palette. */
  source: "palette" | "canvas";
  /** Palette entry type when source === "palette". */
  paletteType?: string;
  /** Component id when source === "canvas". */
  componentId?: string;
  /** Column id being dragged from canvas. */
  fromColumnId?: string;
}

// ---------------------------------------------------------------------------
// Drop target descriptor
// ---------------------------------------------------------------------------

export interface DropTarget {
  rowId: string;
  columnId: string;
}
