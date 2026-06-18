/**
 * Tests for code-generator.ts
 *
 * Verifies round-tripping, import correctness, and fallback behaviour.
 * No DOM or React rendering needed — pure string manipulation.
 */

import { describe, it, expect } from "vitest";
import { layoutToReactCode, reactCodeToLayout } from "@/components/app-builder/code-generator.js";
import {
  createEmptyLayout,
  placeComponent,
  addRow,
} from "@/components/app-builder/layout-helpers.js";
import type { AppLayout, PlacedComponent } from "@/components/app-builder/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statCard(id: string): PlacedComponent {
  return {
    id,
    type: "StatCard",
    props: { title: "Revenue", value: 1000, variant: "success" },
  };
}

function dataTable(id: string): PlacedComponent {
  return {
    id,
    type: "DataTable",
    props: { data: [], columns: [], pageSize: 10, "aria-label": "My table" },
  };
}

function htmlBlock(id: string, html = "<p>Hello</p>"): PlacedComponent {
  return { id, type: "HtmlBlock", props: { html } };
}

function markdownBlock(id: string, content = "# Title"): PlacedComponent {
  return { id, type: "MarkdownBlock", props: { content } };
}

// ---------------------------------------------------------------------------
// layoutToReactCode — import generation
// ---------------------------------------------------------------------------

describe("layoutToReactCode — imports", () => {
  it("emits only the SDK components actually used", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, statCard("s1"));

    const code = layoutToReactCode(withComp);
    expect(code).toContain("StatCard");
    expect(code).not.toContain("DataTable");
    expect(code).not.toContain("FilterBar");
  });

  it("imports multiple SDK components when multiple types are placed", () => {
    let layout = createEmptyLayout();
    layout = addRow(layout);
    const row0Id = layout.rows[0]!.id;
    const row1Id = layout.rows[1]!.id;
    const col0Id = layout.rows[0]!.columns[0]!.id;
    const col1Id = layout.rows[1]!.columns[0]!.id;

    layout = placeComponent(layout, row0Id, col0Id, statCard("s1"));
    layout = placeComponent(layout, row1Id, col1Id, dataTable("d1"));

    const code = layoutToReactCode(layout);
    expect(code).toContain("StatCard");
    expect(code).toContain("DataTable");
    // Imports are sorted alphabetically
    const importLine = code.split("\n").find((l) => l.includes("@oneplatform/app-sdk")) ?? "";
    expect(importLine.indexOf("DataTable")).toBeLessThan(importLine.indexOf("StatCard"));
  });

  it("does not emit an SDK import line for custom blocks", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withBlock = placeComponent(layout, rowId, colId, htmlBlock("h1"));

    const code = layoutToReactCode(withBlock);
    expect(code).not.toContain("@oneplatform/app-sdk");
  });

  it("always includes the React import", () => {
    const code = layoutToReactCode(createEmptyLayout());
    expect(code).toContain(`import React from "react"`);
  });
});

// ---------------------------------------------------------------------------
// layoutToReactCode — JSX structure
// ---------------------------------------------------------------------------

describe("layoutToReactCode — JSX structure", () => {
  it("wraps each row in a grid-cols-12 div", () => {
    const code = layoutToReactCode(createEmptyLayout());
    expect(code).toContain("grid-cols-12");
  });

  it("emits col-span-N for the column width", () => {
    const code = layoutToReactCode(createEmptyLayout()); // col width = 12
    expect(code).toContain("col-span-12");
  });

  it("emits string props as JSX string attributes", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, statCard("s1"));

    const code = layoutToReactCode(withComp);
    expect(code).toContain(`title="Revenue"`);
    expect(code).toContain(`variant="success"`);
  });

  it("emits numeric props as JSX expressions", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, statCard("s1"));

    const code = layoutToReactCode(withComp);
    expect(code).toContain(`value={1000}`);
  });

  it("renders HtmlBlock with dangerouslySetInnerHTML", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, htmlBlock("h1"));

    const code = layoutToReactCode(withComp);
    expect(code).toContain("dangerouslySetInnerHTML");
    expect(code).toContain("Hello");
  });

  it("renders MarkdownBlock as a <pre> element", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, markdownBlock("m1"));

    const code = layoutToReactCode(withComp);
    expect(code).toContain("<pre");
    expect(code).toContain("</pre>");
  });

  it("emits data binding comments when dataBinding is set", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const comp: PlacedComponent = {
      ...dataTable("d1"),
      dataBinding: {
        entityType: "orders",
        fieldMap: { data: "records" },
      },
    };
    const withComp = placeComponent(layout, rowId, colId, comp);
    const code = layoutToReactCode(withComp);
    expect(code).toContain(`entityType="orders"`);
    expect(code).toContain(`fieldMap`);
  });

  it("emits style attribute when component has styles", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const comp: PlacedComponent = {
      ...statCard("s1"),
      styles: { padding: "16px" },
    };
    const withComp = placeComponent(layout, rowId, colId, comp);
    const code = layoutToReactCode(withComp);
    expect(code).toContain("padding");
    expect(code).toContain("16px");
  });
});

// ---------------------------------------------------------------------------
// reactCodeToLayout — parse generated code back
// ---------------------------------------------------------------------------

describe("reactCodeToLayout", () => {
  function roundTrip(layout: AppLayout): AppLayout {
    return reactCodeToLayout(layoutToReactCode(layout));
  }

  it("recovers the correct number of rows from generated code", () => {
    let layout = createEmptyLayout();
    layout = addRow(layout);
    const recovered = roundTrip(layout);
    expect(recovered.rows).toHaveLength(2);
  });

  it("recovers the column width for each column", () => {
    const layout = createEmptyLayout(); // col-span-12
    const recovered = roundTrip(layout);
    expect(recovered.rows[0]!.columns[0]!.width).toBe(12);
  });

  it("recovers the component type from an SDK tag", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, statCard("s1"));

    const recovered = roundTrip(withComp);
    expect(recovered.rows[0]!.columns[0]!.component?.type).toBe("StatCard");
  });

  it("recovers HtmlBlock type from dangerouslySetInnerHTML", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, htmlBlock("h1", "<em>Hello</em>"));

    const recovered = roundTrip(withComp);
    expect(recovered.rows[0]!.columns[0]!.component?.type).toBe("HtmlBlock");
  });

  it("recovers MarkdownBlock type from <pre>", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, markdownBlock("m1", "# Hello"));

    const recovered = roundTrip(withComp);
    expect(recovered.rows[0]!.columns[0]!.component?.type).toBe("MarkdownBlock");
  });

  it("falls back to a single HtmlBlock when code has no row markers", () => {
    const raw = `function App() { return <div>Hello</div>; }`;
    const layout = reactCodeToLayout(raw);
    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0]!.columns[0]!.component?.type).toBe("HtmlBlock");
  });
});

// ---------------------------------------------------------------------------
// layoutToReactCode — determinism
// ---------------------------------------------------------------------------

describe("layoutToReactCode — determinism", () => {
  it("produces the same output for the same layout", () => {
    const layout = createEmptyLayout();
    const rowId = layout.rows[0]!.id;
    const colId = layout.rows[0]!.columns[0]!.id;
    const withComp = placeComponent(layout, rowId, colId, statCard("s1"));

    expect(layoutToReactCode(withComp)).toBe(layoutToReactCode(withComp));
  });
});
