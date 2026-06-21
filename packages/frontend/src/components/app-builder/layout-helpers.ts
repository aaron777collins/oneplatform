/**
 * Pure layout mutation helpers.
 *
 * All functions return new layout trees — they never mutate in place. This
 * makes it trivial to implement undo by keeping a stack of layout snapshots.
 *
 * Functions throw with descriptive messages on invalid input rather than
 * silently returning the original layout — callers (the store) catch and
 * surface these to the user.
 *
 * Note: `component` is an optional property. With exactOptionalPropertyTypes
 * we omit the property rather than assigning `undefined` when creating empty columns.
 */

import { nanoid } from "nanoid";
import type { AppLayout, LayoutRow, LayoutColumn, PlacedComponent } from "./types.js";

// ---------------------------------------------------------------------------
// Preset column layouts
// ---------------------------------------------------------------------------

/** Named layout presets expressed as column width arrays (must sum to 12). */
export type ColumnPreset = "1col" | "2col" | "3col" | "1-2" | "2-1";

export const COLUMN_PRESETS: Record<ColumnPreset, { label: string; widths: number[] }> = {
  "1col":  { label: "1 column",    widths: [12] },
  "2col":  { label: "2 equal",     widths: [6, 6] },
  "3col":  { label: "3 equal",     widths: [4, 4, 4] },
  "1-2":   { label: "1/3 + 2/3",  widths: [4, 8] },
  "2-1":   { label: "2/3 + 1/3",  widths: [8, 4] },
};

/**
 * Apply a column preset to a row, preserving existing components where column
 * indices overlap. Excess components are dropped (the user already saw a warning
 * in the UI before committing). Each new column gets a fresh id.
 */
export function applyRowPreset(
  layout: AppLayout,
  rowId: string,
  preset: ColumnPreset,
): AppLayout {
  const { widths } = COLUMN_PRESETS[preset];
  return mapRow(layout, rowId, (row) => {
    const existingComponents = row.columns
      .filter((c) => c.component !== undefined)
      .map((c) => c.component!);
    const columns: LayoutColumn[] = widths.map((width, i) => {
      const col: LayoutColumn = { id: nanoid(), width };
      const kept = existingComponents[i];
      if (kept !== undefined) {
        return { ...col, component: kept };
      }
      return col;
    });
    return { ...row, columns };
  });
}

// ---------------------------------------------------------------------------
// Row operations
// ---------------------------------------------------------------------------

/** Append an empty row with a single 12-column column. */
export function addRow(layout: AppLayout): AppLayout {
  const row: LayoutRow = {
    id: nanoid(),
    columns: [{ id: nanoid(), width: 12 }],
  };
  return { ...layout, rows: [...layout.rows, row] };
}

/** Remove a row by id. Throws if the row is not found. */
export function removeRow(layout: AppLayout, rowId: string): AppLayout {
  const exists = layout.rows.some((r) => r.id === rowId);
  if (!exists) {
    throw new Error(`removeRow: row "${rowId}" not found.`);
  }
  return { ...layout, rows: layout.rows.filter((r) => r.id !== rowId) };
}

/** Move row from `fromIndex` to `toIndex`. */
export function moveRow(layout: AppLayout, fromIndex: number, toIndex: number): AppLayout {
  if (fromIndex < 0 || fromIndex >= layout.rows.length) {
    throw new Error(`moveRow: fromIndex ${fromIndex} out of range.`);
  }
  if (toIndex < 0 || toIndex >= layout.rows.length) {
    throw new Error(`moveRow: toIndex ${toIndex} out of range.`);
  }
  const rows = [...layout.rows];
  const [row] = rows.splice(fromIndex, 1);
  rows.splice(toIndex, 0, row!);
  return { ...layout, rows };
}

// ---------------------------------------------------------------------------
// Column operations
// ---------------------------------------------------------------------------

/** Add a column to an existing row. Width defaults to 4 (one-third). */
export function addColumn(
  layout: AppLayout,
  rowId: string,
  width = 4,
): AppLayout {
  return mapRow(layout, rowId, (row) => {
    const used = row.columns.reduce((s, c) => s + c.width, 0);
    if (used + width > 12) {
      throw new Error(
        `addColumn: adding ${width} cols would exceed 12 (current sum: ${used}).`,
      );
    }
    const col: LayoutColumn = { id: nanoid(), width };
    return { ...row, columns: [...row.columns, col] };
  });
}

/** Remove a column. Throws if column has a component (must remove component first). */
export function removeColumn(
  layout: AppLayout,
  rowId: string,
  columnId: string,
): AppLayout {
  return mapRow(layout, rowId, (row) => {
    const col = row.columns.find((c) => c.id === columnId);
    if (col === undefined) {
      throw new Error(`removeColumn: column "${columnId}" not found in row "${rowId}".`);
    }
    if (col.component !== undefined) {
      throw new Error(
        `removeColumn: column "${columnId}" still holds a component. Remove it first.`,
      );
    }
    return { ...row, columns: row.columns.filter((c) => c.id !== columnId) };
  });
}

// ---------------------------------------------------------------------------
// Component operations
// ---------------------------------------------------------------------------

/** Place a component into a column. Throws if the column is already occupied. */
export function placeComponent(
  layout: AppLayout,
  rowId: string,
  columnId: string,
  component: PlacedComponent,
): AppLayout {
  return mapColumn(layout, rowId, columnId, (col) => {
    if (col.component !== undefined) {
      throw new Error(
        `placeComponent: column "${columnId}" already has component "${col.component.id}". Remove it first.`,
      );
    }
    return { ...col, component };
  });
}

/** Remove a component from a column by component id. */
export function removeComponent(
  layout: AppLayout,
  componentId: string,
): AppLayout {
  return {
    ...layout,
    rows: layout.rows.map((row) => ({
      ...row,
      columns: row.columns.map((col): LayoutColumn => {
        if (col.component?.id !== componentId) return col;
        // Omit `component` property — required by exactOptionalPropertyTypes
        const { component: _removed, ...rest } = col;
        return rest;
      }),
    })),
  };
}

/** Update props of a placed component. */
export function updateComponentProps(
  layout: AppLayout,
  componentId: string,
  props: Record<string, unknown>,
): AppLayout {
  return mapComponent(layout, componentId, (c) => ({ ...c, props }));
}

/** Update styles of a placed component. */
export function updateComponentStyles(
  layout: AppLayout,
  componentId: string,
  styles: Record<string, string>,
): AppLayout {
  return mapComponent(layout, componentId, (c) => ({ ...c, styles }));
}

/**
 * Move a component from one column to another.
 * If the target column is occupied, the two components are swapped.
 */
export function moveComponent(
  layout: AppLayout,
  fromColumnId: string,
  toColumnId: string,
): AppLayout {
  if (fromColumnId === toColumnId) return layout;

  // Extract components first (read-only pass)
  const fromComponent = findComponentByColumn(layout, fromColumnId);
  const toComponent = findComponentByColumn(layout, toColumnId);

  if (fromComponent === null) {
    throw new Error(`moveComponent: source column "${fromColumnId}" is empty.`);
  }

  // Swap: place fromComponent in target, place toComponent (may be null) in source
  return {
    ...layout,
    rows: layout.rows.map((row) => ({
      ...row,
      columns: row.columns.map((col): LayoutColumn => {
        if (col.id === fromColumnId) {
          if (toComponent !== null) {
            return { ...col, component: toComponent };
          }
          // Target was empty — source becomes empty too
          const { component: _removed, ...rest } = col;
          return rest;
        }
        if (col.id === toColumnId) {
          return { ...col, component: fromComponent };
        }
        return col;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Layout queries
// ---------------------------------------------------------------------------

/** Find a placed component by id. Returns null if not found. */
export function findComponent(
  layout: AppLayout,
  componentId: string,
): PlacedComponent | null {
  for (const row of layout.rows) {
    for (const col of row.columns) {
      if (col.component?.id === componentId) return col.component;
    }
  }
  return null;
}

/** Find the component in a column. Returns null if the column is empty or not found. */
export function findComponentByColumn(
  layout: AppLayout,
  columnId: string,
): PlacedComponent | null {
  for (const row of layout.rows) {
    for (const col of row.columns) {
      if (col.id === columnId) return col.component ?? null;
    }
  }
  return null;
}

/** Total number of placed components across all rows/columns. */
export function countComponents(layout: AppLayout): number {
  return layout.rows.reduce(
    (total, row) =>
      total + row.columns.filter((col) => col.component !== undefined).length,
    0,
  );
}

/** Create a new empty layout. */
export function createEmptyLayout(): AppLayout {
  return {
    rows: [
      {
        id: nanoid(),
        columns: [{ id: nanoid(), width: 12 }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — not exported (pure plumbing)
// ---------------------------------------------------------------------------

function mapRow(
  layout: AppLayout,
  rowId: string,
  fn: (row: LayoutRow) => LayoutRow,
): AppLayout {
  const rowIndex = layout.rows.findIndex((r) => r.id === rowId);
  if (rowIndex === -1) {
    throw new Error(`Layout operation failed: row "${rowId}" not found.`);
  }
  const rows = [...layout.rows];
  rows[rowIndex] = fn(rows[rowIndex]!);
  return { ...layout, rows };
}

function mapColumn(
  layout: AppLayout,
  rowId: string,
  columnId: string,
  fn: (col: LayoutColumn) => LayoutColumn,
): AppLayout {
  return mapRow(layout, rowId, (row) => {
    const colIndex = row.columns.findIndex((c) => c.id === columnId);
    if (colIndex === -1) {
      throw new Error(`Layout operation failed: column "${columnId}" not found in row "${rowId}".`);
    }
    const columns = [...row.columns];
    columns[colIndex] = fn(columns[colIndex]!);
    return { ...row, columns };
  });
}

function mapComponent(
  layout: AppLayout,
  componentId: string,
  fn: (c: PlacedComponent) => PlacedComponent,
): AppLayout {
  return {
    ...layout,
    rows: layout.rows.map((row) => ({
      ...row,
      columns: row.columns.map((col) =>
        col.component?.id === componentId
          ? { ...col, component: fn(col.component) }
          : col,
      ),
    })),
  };
}
