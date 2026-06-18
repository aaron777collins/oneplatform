/**
 * App builder Zustand store.
 *
 * Owns layout state, undo/redo history, selected component, and builder mode.
 * All layout mutations go through this store so the history stack stays
 * consistent. Components never mutate layout directly.
 *
 * History is capped at MAX_HISTORY_SIZE entries to bound memory usage.
 */

import { create } from "zustand";
import { nanoid } from "nanoid";
import type { AppLayout, PlacedComponent, DataBinding, BuilderMode } from "./types.js";
import {
  createEmptyLayout,
  addRow,
  removeRow,
  moveRow,
  placeComponent,
  removeComponent,
  updateComponentProps,
  updateComponentStyles,
  moveComponent,
} from "./layout-helpers.js";
import { getPaletteEntry } from "./palette-registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY_SIZE = 50;

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface BuilderState {
  layout: AppLayout;
  /** Full snapshots for undo, newest last. */
  history: AppLayout[];
  /** Full snapshots for redo, newest last. */
  future: AppLayout[];

  selectedComponentId: string | null;
  mode: BuilderMode;

  // ---- Layout actions ----
  addRow: () => void;
  removeRow: (rowId: string) => void;
  moveRow: (fromIndex: number, toIndex: number) => void;

  /** Drop a component from the palette into a column. */
  dropFromPalette: (paletteType: string, rowId: string, columnId: string) => void;

  /** Move an existing placed component to another column. */
  moveComponent: (fromColumnId: string, toColumnId: string) => void;

  removeComponent: (componentId: string) => void;
  updateProps: (componentId: string, props: Record<string, unknown>) => void;
  updateStyles: (componentId: string, styles: Record<string, string>) => void;
  updateDataBinding: (componentId: string, binding: DataBinding | undefined) => void;

  // ---- Selection ----
  selectComponent: (componentId: string | null) => void;

  // ---- Mode ----
  setMode: (mode: BuilderMode) => void;

  // ---- History ----
  undo: () => void;
  redo: () => void;

  // ---- Load / reset ----
  loadLayout: (layout: AppLayout) => void;
  resetLayout: () => void;
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export const useBuilderStore = create<BuilderState>()((set, get) => ({
  layout: createEmptyLayout(),
  history: [],
  future: [],
  selectedComponentId: null,
  mode: "edit",

  // ---- Mutation helper (private) ---- captured in closure below
  addRow: () => {
    set((s) => mutate(s, addRow(s.layout)));
  },

  removeRow: (rowId: string) => {
    const { layout } = get();
    set((s) => mutate(s, removeRow(layout, rowId)));
  },

  moveRow: (fromIndex: number, toIndex: number) => {
    const { layout } = get();
    set((s) => mutate(s, moveRow(layout, fromIndex, toIndex)));
  },

  dropFromPalette: (paletteType: string, rowId: string, columnId: string) => {
    const { layout } = get();
    const entry = getPaletteEntry(paletteType);
    if (entry === undefined) {
      throw new Error(`dropFromPalette: unknown component type "${paletteType}".`);
    }
    const component: PlacedComponent = {
      id: nanoid(),
      type: paletteType,
      props: { ...entry.defaultProps },
    };
    const next = placeComponent(layout, rowId, columnId, component);
    set((s) => ({ ...mutate(s, next), selectedComponentId: component.id }));
  },

  moveComponent: (fromColumnId: string, toColumnId: string) => {
    const { layout } = get();
    set((s) => mutate(s, moveComponent(layout, fromColumnId, toColumnId)));
  },

  removeComponent: (componentId: string) => {
    const { layout } = get();
    set((s) => ({
      ...mutate(s, removeComponent(layout, componentId)),
      selectedComponentId: s.selectedComponentId === componentId ? null : s.selectedComponentId,
    }));
  },

  updateProps: (componentId: string, props: Record<string, unknown>) => {
    const { layout } = get();
    set((s) => mutate(s, updateComponentProps(layout, componentId, props)));
  },

  updateStyles: (componentId: string, styles: Record<string, string>) => {
    const { layout } = get();
    set((s) => mutate(s, updateComponentStyles(layout, componentId, styles)));
  },

  updateDataBinding: (componentId: string, binding: DataBinding | undefined) => {
    const { layout } = get();
    const nextLayout: AppLayout = {
      ...layout,
      rows: layout.rows.map((row) => ({
        ...row,
        columns: row.columns.map((col) => {
          if (col.component?.id !== componentId) return col;
          if (binding === undefined) {
            // Remove dataBinding property — required by exactOptionalPropertyTypes
            const { dataBinding: _removed, ...rest } = col.component;
            return { ...col, component: rest };
          }
          return { ...col, component: { ...col.component, dataBinding: binding } };
        }),
      })),
    };
    set((s) => mutate(s, nextLayout));
  },

  selectComponent: (componentId: string | null) => {
    set({ selectedComponentId: componentId });
  },

  setMode: (mode: BuilderMode) => {
    set({ mode });
  },

  undo: () => {
    const { history, layout } = get();
    if (history.length === 0) return;
    const prev = history[history.length - 1]!;
    set((s) => ({
      layout: prev,
      history: s.history.slice(0, -1),
      future: [layout, ...s.future],
      selectedComponentId: null,
    }));
  },

  redo: () => {
    const { future, layout } = get();
    if (future.length === 0) return;
    const next = future[0]!;
    set((s) => ({
      layout: next,
      history: [...s.history, layout].slice(-MAX_HISTORY_SIZE),
      future: s.future.slice(1),
      selectedComponentId: null,
    }));
  },

  loadLayout: (layout: AppLayout) => {
    set({ layout, history: [], future: [], selectedComponentId: null });
  },

  resetLayout: () => {
    set({
      layout: createEmptyLayout(),
      history: [],
      future: [],
      selectedComponentId: null,
    });
  },
}));

// ---------------------------------------------------------------------------
// Internal helper — push to history and clear redo stack
// ---------------------------------------------------------------------------

function mutate(
  state: Pick<BuilderState, "layout" | "history">,
  nextLayout: AppLayout,
): Pick<BuilderState, "layout" | "history" | "future"> {
  return {
    layout: nextLayout,
    history: [...state.history, state.layout].slice(-MAX_HISTORY_SIZE),
    future: [],
  };
}
