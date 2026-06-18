/**
 * Tests for layout-helpers.ts
 *
 * Pure functions — no React, no DOM, no mocks needed.
 */

import { describe, it, expect } from "vitest";
import {
  createEmptyLayout,
  addRow,
  removeRow,
  moveRow,
  addColumn,
  removeColumn,
  placeComponent,
  removeComponent,
  updateComponentProps,
  updateComponentStyles,
  moveComponent,
  findComponent,
  findComponentByColumn,
  countComponents,
} from "@/components/app-builder/layout-helpers.js";
import type { PlacedComponent } from "@/components/app-builder/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComponent(id = "comp-1"): PlacedComponent {
  return { id, type: "StatCard", props: { title: "Test", value: 0 } };
}

// ---------------------------------------------------------------------------
// createEmptyLayout
// ---------------------------------------------------------------------------

describe("createEmptyLayout", () => {
  it("creates a single row with a single 12-column column", () => {
    const layout = createEmptyLayout();
    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0]!.columns).toHaveLength(1);
    expect(layout.rows[0]!.columns[0]!.width).toBe(12);
    expect(layout.rows[0]!.columns[0]!.component).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// addRow
// ---------------------------------------------------------------------------

describe("addRow", () => {
  it("appends a new row with a 12-column column", () => {
    const layout = createEmptyLayout();
    const next = addRow(layout);
    expect(next.rows).toHaveLength(2);
    expect(next.rows[1]!.columns[0]!.width).toBe(12);
  });

  it("does not mutate the original layout", () => {
    const layout = createEmptyLayout();
    addRow(layout);
    expect(layout.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeRow
// ---------------------------------------------------------------------------

describe("removeRow", () => {
  it("removes the specified row", () => {
    const layout = addRow(createEmptyLayout());
    const rowId = layout.rows[0]!.id;
    const next = removeRow(layout, rowId);
    expect(next.rows).toHaveLength(1);
    expect(next.rows.find((r) => r.id === rowId)).toBeUndefined();
  });

  it("throws for an unknown row id", () => {
    const layout = createEmptyLayout();
    expect(() => removeRow(layout, "nonexistent")).toThrowError(/not found/);
  });
});

// ---------------------------------------------------------------------------
// moveRow
// ---------------------------------------------------------------------------

describe("moveRow", () => {
  it("moves a row from index 0 to index 1", () => {
    const layout = addRow(addRow(createEmptyLayout())); // 3 rows
    const firstId = layout.rows[0]!.id;
    const next = moveRow(layout, 0, 2);
    expect(next.rows[2]!.id).toBe(firstId);
  });

  it("throws for out-of-range indices", () => {
    const layout = createEmptyLayout();
    expect(() => moveRow(layout, 0, 5)).toThrowError(/out of range/);
    expect(() => moveRow(layout, -1, 0)).toThrowError(/out of range/);
  });
});

// ---------------------------------------------------------------------------
// addColumn
// ---------------------------------------------------------------------------

describe("addColumn", () => {
  it("adds a column with the requested width", () => {
    const layout = createEmptyLayout();
    // Start with a 6-wide column
    const rowId = layout.rows[0]!.id;
    // Manually shrink the first column so we have room
    const shrunk = {
      ...layout,
      rows: layout.rows.map((r) => ({
        ...r,
        columns: r.columns.map((c) => ({ ...c, width: 6 })),
      })),
    };
    const next = addColumn(shrunk, rowId, 4);
    expect(next.rows[0]!.columns).toHaveLength(2);
    expect(next.rows[0]!.columns[1]!.width).toBe(4);
  });

  it("throws when the new column would exceed 12 columns", () => {
    const layout = createEmptyLayout(); // col width = 12
    expect(() => addColumn(layout, layout.rows[0]!.id, 1)).toThrowError(/exceed 12/);
  });
});

// ---------------------------------------------------------------------------
// removeColumn
// ---------------------------------------------------------------------------

describe("removeColumn", () => {
  it("removes an empty column", () => {
    // Two-column row (6+6)
    const layout = createEmptyLayout();
    const shrunk = {
      ...layout,
      rows: layout.rows.map((r) => ({
        ...r,
        columns: [
          { ...r.columns[0]!, width: 6 },
          { id: "col-b", width: 6, component: undefined },
        ],
      })),
    };
    const rowId = shrunk.rows[0]!.id;
    const next = removeColumn(shrunk, rowId, "col-b");
    expect(next.rows[0]!.columns).toHaveLength(1);
  });

  it("throws when trying to remove an occupied column", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, makeComponent());
    expect(() => removeColumn(withComp, rowId, colId)).toThrowError(/still holds a component/);
  });
});

// ---------------------------------------------------------------------------
// placeComponent
// ---------------------------------------------------------------------------

describe("placeComponent", () => {
  it("places a component in an empty column", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const comp = makeComponent();

    const next = placeComponent(layout, rowId, colId, comp);
    expect(next.rows[0]!.columns[0]!.component).toEqual(comp);
  });

  it("throws when the column is already occupied", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, makeComponent("a"));
    expect(() => placeComponent(withComp, rowId, colId, makeComponent("b"))).toThrowError(
      /already has component/,
    );
  });
});

// ---------------------------------------------------------------------------
// removeComponent
// ---------------------------------------------------------------------------

describe("removeComponent", () => {
  it("removes a component by id", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const comp = makeComponent("target");
    const withComp = placeComponent(layout, rowId, colId, comp);

    const next = removeComponent(withComp, "target");
    expect(next.rows[0]!.columns[0]!.component).toBeUndefined();
  });

  it("returns the same layout when component id is not found", () => {
    const layout = createEmptyLayout();
    const next = removeComponent(layout, "ghost");
    expect(next.rows).toEqual(layout.rows);
  });
});

// ---------------------------------------------------------------------------
// updateComponentProps
// ---------------------------------------------------------------------------

describe("updateComponentProps", () => {
  it("replaces the props of the target component", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const comp = makeComponent("c1");
    const withComp = placeComponent(layout, rowId, colId, comp);

    const next = updateComponentProps(withComp, "c1", { title: "Updated", value: 42 });
    expect(next.rows[0]!.columns[0]!.component?.props).toEqual({ title: "Updated", value: 42 });
  });
});

// ---------------------------------------------------------------------------
// updateComponentStyles
// ---------------------------------------------------------------------------

describe("updateComponentStyles", () => {
  it("sets styles on the target component", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const comp = makeComponent("c1");
    const withComp = placeComponent(layout, rowId, colId, comp);

    const next = updateComponentStyles(withComp, "c1", { padding: "8px" });
    expect(next.rows[0]!.columns[0]!.component?.styles).toEqual({ padding: "8px" });
  });
});

// ---------------------------------------------------------------------------
// moveComponent
// ---------------------------------------------------------------------------

describe("moveComponent", () => {
  it("moves a component from one column to another (swap when target occupied)", () => {
    // Two-column row
    const base = createEmptyLayout();
    const rowId = base.rows[0]!.id;
    const shrunk = {
      ...base,
      rows: base.rows.map((r) => ({
        ...r,
        columns: [
          { ...r.columns[0]!, width: 6, id: "col-a" },
          { id: "col-b", width: 6, component: undefined },
        ],
      })),
    };

    const compA = makeComponent("comp-a");
    const compB = makeComponent("comp-b");
    const withA = placeComponent(shrunk, rowId, "col-a", compA);
    const withBoth = placeComponent(withA, rowId, "col-b", compB);

    // Swap A and B
    const next = moveComponent(withBoth, "col-a", "col-b");
    expect(next.rows[0]!.columns[0]!.component?.id).toBe("comp-b");
    expect(next.rows[0]!.columns[1]!.component?.id).toBe("comp-a");
  });

  it("moves to an empty column (source becomes empty)", () => {
    const base = createEmptyLayout();
    const rowId = base.rows[0]!.id;
    const shrunk = {
      ...base,
      rows: base.rows.map((r) => ({
        ...r,
        columns: [
          { ...r.columns[0]!, width: 6, id: "col-a" },
          { id: "col-b", width: 6, component: undefined },
        ],
      })),
    };
    const comp = makeComponent("comp-a");
    const withComp = placeComponent(shrunk, rowId, "col-a", comp);

    const next = moveComponent(withComp, "col-a", "col-b");
    expect(next.rows[0]!.columns[0]!.component).toBeUndefined();
    expect(next.rows[0]!.columns[1]!.component?.id).toBe("comp-a");
  });

  it("throws when source column is empty", () => {
    const layout = createEmptyLayout();
    expect(() => moveComponent(layout, layout.rows[0]!.columns[0]!.id, "anywhere")).toThrowError(
      /source column.*is empty/,
    );
  });

  it("returns original layout when source and target are the same", () => {
    const layout = createEmptyLayout();
    const colId = layout.rows[0]!.columns[0]!.id;
    const next = moveComponent(layout, colId, colId);
    expect(next).toBe(layout); // Same reference — no copy made
  });
});

// ---------------------------------------------------------------------------
// findComponent / findComponentByColumn
// ---------------------------------------------------------------------------

describe("findComponent", () => {
  it("returns the component when found", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const comp = makeComponent("find-me");
    const withComp = placeComponent(layout, rowId, colId, comp);

    expect(findComponent(withComp, "find-me")).toEqual(comp);
  });

  it("returns null when not found", () => {
    expect(findComponent(createEmptyLayout(), "ghost")).toBeNull();
  });
});

describe("findComponentByColumn", () => {
  it("returns the component in the given column", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const comp = makeComponent();
    const withComp = placeComponent(layout, rowId, colId, comp);

    expect(findComponentByColumn(withComp, colId)).toEqual(comp);
  });

  it("returns null for an empty column", () => {
    const layout = createEmptyLayout();
    const colId = layout.rows[0]!.columns[0]!.id;
    expect(findComponentByColumn(layout, colId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// countComponents
// ---------------------------------------------------------------------------

describe("countComponents", () => {
  it("counts zero on empty layout", () => {
    expect(countComponents(createEmptyLayout())).toBe(0);
  });

  it("counts correctly with multiple components", () => {
    const layout = addRow(createEmptyLayout());
    const row0Id = layout.rows[0]!.id;
    const col0Id = layout.rows[0]!.columns[0]!.id;
    const row1Id = layout.rows[1]!.id;
    const col1Id = layout.rows[1]!.columns[0]!.id;

    const with1 = placeComponent(layout, row0Id, col0Id, makeComponent("a"));
    const with2 = placeComponent(with1, row1Id, col1Id, makeComponent("b"));
    expect(countComponents(with2)).toBe(2);
  });
});
