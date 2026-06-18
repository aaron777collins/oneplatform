/**
 * Tests for builder.store.ts
 *
 * Uses Zustand's testing pattern: get a fresh store instance by resetting
 * state between tests. We call the store actions directly (no React rendering).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useBuilderStore } from "@/components/app-builder/builder.store.js";
import { placeComponent } from "@/components/app-builder/layout-helpers.js";
import type { PlacedComponent } from "@/components/app-builder/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStore() {
  return useBuilderStore.getState();
}

function makePlacedComp(id: string, type = "StatCard"): PlacedComponent {
  return { id, type, props: { title: "T", value: 0 } };
}

// Reset store before each test so mutations don't bleed between tests
beforeEach(() => {
  useBuilderStore.getState().resetLayout();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts with a single empty row", () => {
    const { layout } = getStore();
    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0]!.columns[0]!.component).toBeUndefined();
  });

  it("starts in edit mode", () => {
    expect(getStore().mode).toBe("edit");
  });

  it("starts with empty history and future", () => {
    const { history, future } = getStore();
    expect(history).toHaveLength(0);
    expect(future).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// addRow
// ---------------------------------------------------------------------------

describe("addRow", () => {
  it("appends a row and pushes to history", () => {
    getStore().addRow();
    const { layout, history } = getStore();
    expect(layout.rows).toHaveLength(2);
    expect(history).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeRow
// ---------------------------------------------------------------------------

describe("removeRow", () => {
  it("removes the specified row", () => {
    getStore().addRow();
    const { layout } = getStore();
    const rowId = layout.rows[0]!.id;
    getStore().removeRow(rowId);
    expect(getStore().layout.rows).toHaveLength(1);
    expect(getStore().layout.rows.find((r) => r.id === rowId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// moveRow
// ---------------------------------------------------------------------------

describe("moveRow", () => {
  it("reorders rows correctly", () => {
    getStore().addRow();
    const firstId = getStore().layout.rows[0]!.id;
    getStore().moveRow(0, 1);
    expect(getStore().layout.rows[1]!.id).toBe(firstId);
  });
});

// ---------------------------------------------------------------------------
// dropFromPalette
// ---------------------------------------------------------------------------

describe("dropFromPalette", () => {
  it("places a component and selects it", () => {
    const { layout } = getStore();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;

    getStore().dropFromPalette("StatCard", rowId, colId);

    const { layout: next, selectedComponentId } = getStore();
    const placed = next.rows[0]!.columns[0]!.component;
    expect(placed?.type).toBe("StatCard");
    expect(selectedComponentId).toBe(placed?.id);
  });

  it("throws for an unknown palette type", () => {
    const { layout } = getStore();
    expect(() =>
      getStore().dropFromPalette("NonExistentWidget", layout.rows[0]!.id, layout.rows[0]!.columns[0]!.id),
    ).toThrowError(/unknown component type/);
  });
});

// ---------------------------------------------------------------------------
// moveComponent
// ---------------------------------------------------------------------------

describe("moveComponent", () => {
  it("swaps components between columns", () => {
    // Set up a two-column row by replacing the layout
    getStore().loadLayout({
      rows: [
        {
          id: "row-1",
          columns: [
            { id: "col-a", width: 6, component: makePlacedComp("comp-a") },
            { id: "col-b", width: 6, component: makePlacedComp("comp-b") },
          ],
        },
      ],
    });

    getStore().moveComponent("col-a", "col-b");

    const { layout } = getStore();
    expect(layout.rows[0]!.columns[0]!.component?.id).toBe("comp-b");
    expect(layout.rows[0]!.columns[1]!.component?.id).toBe("comp-a");
  });
});

// ---------------------------------------------------------------------------
// removeComponent
// ---------------------------------------------------------------------------

describe("removeComponent", () => {
  it("removes the component and deselects it", () => {
    const { layout } = getStore();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;

    getStore().dropFromPalette("StatCard", rowId, colId);
    const compId = getStore().layout.rows[0]!.columns[0]!.component!.id;

    getStore().removeComponent(compId);

    expect(getStore().layout.rows[0]!.columns[0]!.component).toBeUndefined();
    expect(getStore().selectedComponentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateProps
// ---------------------------------------------------------------------------

describe("updateProps", () => {
  it("updates the props of the selected component", () => {
    const { layout } = getStore();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    getStore().dropFromPalette("StatCard", rowId, colId);
    const compId = getStore().layout.rows[0]!.columns[0]!.component!.id;

    getStore().updateProps(compId, { title: "Updated", value: 99 });

    const comp = getStore().layout.rows[0]!.columns[0]!.component;
    expect(comp?.props["title"]).toBe("Updated");
    expect(comp?.props["value"]).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// updateStyles
// ---------------------------------------------------------------------------

describe("updateStyles", () => {
  it("sets styles on the component", () => {
    const { layout } = getStore();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    getStore().dropFromPalette("StatCard", rowId, colId);
    const compId = getStore().layout.rows[0]!.columns[0]!.component!.id;

    getStore().updateStyles(compId, { padding: "8px" });

    expect(getStore().layout.rows[0]!.columns[0]!.component?.styles).toEqual({ padding: "8px" });
  });
});

// ---------------------------------------------------------------------------
// updateDataBinding
// ---------------------------------------------------------------------------

describe("updateDataBinding", () => {
  it("sets the data binding on the component", () => {
    const { layout } = getStore();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    getStore().dropFromPalette("DataTable", rowId, colId);
    const compId = getStore().layout.rows[0]!.columns[0]!.component!.id;

    getStore().updateDataBinding(compId, {
      entityType: "orders",
      fieldMap: { data: "records" },
    });

    const comp = getStore().layout.rows[0]!.columns[0]!.component;
    expect(comp?.dataBinding?.entityType).toBe("orders");
    expect(comp?.dataBinding?.fieldMap["data"]).toBe("records");
  });

  it("clears data binding when undefined is passed", () => {
    const { layout } = getStore();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    getStore().dropFromPalette("DataTable", rowId, colId);
    const compId = getStore().layout.rows[0]!.columns[0]!.component!.id;

    getStore().updateDataBinding(compId, { entityType: "orders", fieldMap: {} });
    getStore().updateDataBinding(compId, undefined);

    expect(getStore().layout.rows[0]!.columns[0]!.component?.dataBinding).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selectComponent / mode
// ---------------------------------------------------------------------------

describe("selectComponent", () => {
  it("sets the selected component id", () => {
    getStore().selectComponent("abc");
    expect(getStore().selectedComponentId).toBe("abc");
  });

  it("deselects when null is passed", () => {
    getStore().selectComponent("abc");
    getStore().selectComponent(null);
    expect(getStore().selectedComponentId).toBeNull();
  });
});

describe("setMode", () => {
  it("toggles to preview mode", () => {
    getStore().setMode("preview");
    expect(getStore().mode).toBe("preview");
  });

  it("toggles back to edit mode", () => {
    getStore().setMode("preview");
    getStore().setMode("edit");
    expect(getStore().mode).toBe("edit");
  });
});

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

describe("undo / redo", () => {
  it("undoes a mutation and restores the previous layout", () => {
    const original = getStore().layout;
    getStore().addRow();
    expect(getStore().layout.rows).toHaveLength(2);

    getStore().undo();
    expect(getStore().layout.rows).toHaveLength(original.rows.length);
  });

  it("redo re-applies an undone mutation", () => {
    getStore().addRow();
    getStore().undo();
    getStore().redo();
    expect(getStore().layout.rows).toHaveLength(2);
  });

  it("undo does nothing when history is empty", () => {
    const { layout } = getStore();
    getStore().undo();
    expect(getStore().layout).toBe(layout);
  });

  it("redo does nothing when future is empty", () => {
    const { layout } = getStore();
    getStore().redo();
    expect(getStore().layout).toBe(layout);
  });

  it("clears the redo stack after a new mutation", () => {
    getStore().addRow();
    getStore().undo();
    getStore().addRow(); // New mutation after undo
    expect(getStore().future).toHaveLength(0);
  });

  it("undo clears selectedComponentId", () => {
    getStore().selectComponent("some-id");
    getStore().addRow();
    getStore().undo();
    expect(getStore().selectedComponentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadLayout
// ---------------------------------------------------------------------------

describe("loadLayout", () => {
  it("replaces layout and clears history", () => {
    getStore().addRow(); // Creates history entry
    const newLayout = {
      rows: [{ id: "new-row", columns: [{ id: "new-col", width: 12 as const }] }],
    };
    getStore().loadLayout(newLayout);

    expect(getStore().layout).toBe(newLayout);
    expect(getStore().history).toHaveLength(0);
    expect(getStore().future).toHaveLength(0);
    expect(getStore().selectedComponentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resetLayout
// ---------------------------------------------------------------------------

describe("resetLayout", () => {
  it("returns to a single empty row and clears all state", () => {
    getStore().addRow();
    getStore().addRow();
    getStore().selectComponent("x");
    getStore().resetLayout();

    const { layout, history, future, selectedComponentId } = getStore();
    expect(layout.rows).toHaveLength(1);
    expect(history).toHaveLength(0);
    expect(future).toHaveLength(0);
    expect(selectedComponentId).toBeNull();
  });
});
