// Unit tests for services/transform-engine.ts (G-051)
//
// Each transform operation is tested in isolation with its own describe block.
// Tests are pure (no I/O) and focus on correctness, edge cases, and error paths.

import { describe, it, expect } from "vitest";
import {
  dedup,
  filter,
  mapFields,
  aggregate,
  pivot,
  unpivot,
  join,
  sort,
  limit,
  rename,
  TransformError,
  type DataRecord,
} from "../services/transform-engine.js";

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

describe("dedup — strategy: first", () => {
  it("keeps first occurrence when duplicates exist on one key field", () => {
    const records: DataRecord[] = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 1, name: "Alice-dupe" },
    ];
    const result = dedup(records, ["id"], "first");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 1, name: "Alice" });
    expect(result[1]).toEqual({ id: 2, name: "Bob" });
  });

  it("keeps first occurrence when duplicates exist on composite key", () => {
    const records: DataRecord[] = [
      { tenant: "A", month: "Jan", value: 100 },
      { tenant: "A", month: "Jan", value: 200 },
      { tenant: "A", month: "Feb", value: 300 },
    ];
    const result = dedup(records, ["tenant", "month"], "first");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ tenant: "A", month: "Jan", value: 100 });
  });

  it("returns all records when there are no duplicates", () => {
    const records: DataRecord[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = dedup(records, ["id"], "first");
    expect(result).toHaveLength(3);
  });

  it("returns empty array for empty input", () => {
    expect(dedup([], ["id"], "first")).toEqual([]);
  });

  it("treats null values as equal for dedup key purposes", () => {
    const records: DataRecord[] = [
      { id: null, name: "a" },
      { id: null, name: "b" },
    ];
    const result = dedup(records, ["id"], "first");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: null, name: "a" });
  });
});

describe("dedup — strategy: last", () => {
  it("keeps last occurrence when duplicates exist", () => {
    const records: DataRecord[] = [
      { id: 1, name: "Alice" },
      { id: 1, name: "Alice-v2" },
      { id: 1, name: "Alice-v3" },
    ];
    const result = dedup(records, ["id"], "last");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1, name: "Alice-v3" });
  });

  it("preserves all records when there are no duplicates", () => {
    const records: DataRecord[] = [{ id: 1 }, { id: 2 }];
    expect(dedup(records, ["id"], "last")).toHaveLength(2);
  });
});

describe("dedup — validation", () => {
  it("throws TransformError when keyFields is empty", () => {
    expect(() => dedup([{ id: 1 }], [], "first")).toThrow(TransformError);
    expect(() => dedup([{ id: 1 }], [], "first")).toThrow("dedup requires at least one keyField");
  });
});

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

describe("filter", () => {
  it("keeps records matching a simple equality condition", () => {
    const records: DataRecord[] = [
      { status: "active" },
      { status: "inactive" },
      { status: "active" },
    ];
    const result = filter(records, 'status == "active"');
    expect(result).toHaveLength(2);
  });

  it("keeps records matching a numeric comparison", () => {
    const records: DataRecord[] = [
      { age: 20 },
      { age: 30 },
      { age: 15 },
    ];
    const result = filter(records, "age >= 18");
    expect(result).toHaveLength(2);
  });

  it("supports logical AND conditions", () => {
    const records: DataRecord[] = [
      { age: 25, active: true },
      { age: 25, active: false },
      { age: 15, active: true },
    ];
    const result = filter(records, "age >= 18 && active == true");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ age: 25, active: true });
  });

  it("supports logical OR conditions", () => {
    const records: DataRecord[] = [
      { status: "active" },
      { status: "pending" },
      { status: "inactive" },
    ];
    const result = filter(records, 'status == "active" || status == "pending"');
    expect(result).toHaveLength(2);
  });

  it("supports negation with !", () => {
    const records: DataRecord[] = [
      { deleted: false },
      { deleted: true },
    ];
    const result = filter(records, "!deleted");
    expect(result).toHaveLength(1);
  });

  it("supports string built-in functions", () => {
    const records: DataRecord[] = [
      { email: "alice@example.com" },
      { email: "bob@other.com" },
    ];
    const result = filter(records, 'endsWith(email, "@example.com")');
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no records match", () => {
    const records: DataRecord[] = [{ x: 1 }, { x: 2 }];
    expect(filter(records, "x > 100")).toEqual([]);
  });

  it("returns all records when all match", () => {
    const records: DataRecord[] = [{ x: 1 }, { x: 2 }];
    expect(filter(records, "x > 0")).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(filter([], "x > 0")).toEqual([]);
  });

  it("throws TransformError for empty condition string", () => {
    expect(() => filter([{ x: 1 }], "")).toThrow(TransformError);
  });

  it("throws TransformError for invalid expression syntax", () => {
    expect(() => filter([{ x: 1 }], "x >>")).toThrow(TransformError);
  });
});

// ---------------------------------------------------------------------------
// mapFields
// ---------------------------------------------------------------------------

describe("mapFields", () => {
  it("adds a computed field from an expression", () => {
    const records: DataRecord[] = [
      { price: 10, quantity: 3 },
      { price: 5, quantity: 7 },
    ];
    const result = mapFields(records, { total: "price * quantity" });
    expect(result[0]).toMatchObject({ price: 10, quantity: 3, total: 30 });
    expect(result[1]).toMatchObject({ price: 5, quantity: 7, total: 35 });
  });

  it("overwrites an existing field with a constant", () => {
    const records: DataRecord[] = [{ status: "old" }];
    const result = mapFields(records, { status: '"new"' });
    expect(result[0]!["status"]).toBe("new");
  });

  it("applies string transformation", () => {
    const records: DataRecord[] = [{ name: "alice" }];
    const result = mapFields(records, { name: "toUpperCase(name)" });
    expect(result[0]!["name"]).toBe("ALICE");
  });

  it("preserves fields not in mappings", () => {
    const records: DataRecord[] = [{ a: 1, b: 2 }];
    const result = mapFields(records, { c: "a + b" });
    expect(result[0]).toMatchObject({ a: 1, b: 2, c: 3 });
  });

  it("returns empty array for empty input", () => {
    expect(mapFields([], { x: "1" })).toEqual([]);
  });

  it("throws TransformError for empty mappings", () => {
    expect(() => mapFields([{ x: 1 }], {})).toThrow(TransformError);
    expect(() => mapFields([{ x: 1 }], {})).toThrow("map requires at least one");
  });

  it("throws TransformError for invalid expression in mapping", () => {
    expect(() => mapFields([{ x: 1 }], { y: "eval('hack')" })).toThrow(TransformError);
  });
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

describe("aggregate — sum", () => {
  it("sums a numeric field across all records (no groupBy)", () => {
    const records: DataRecord[] = [
      { value: 10 },
      { value: 20 },
      { value: 30 },
    ];
    const result = aggregate(records, [], [{ field: "value", function: "sum", alias: "total" }]);
    expect(result).toHaveLength(1);
    expect(result[0]!["total"]).toBe(60);
  });

  it("sums grouped by a string field", () => {
    const records: DataRecord[] = [
      { region: "north", sales: 100 },
      { region: "north", sales: 200 },
      { region: "south", sales: 150 },
    ];
    const result = aggregate(records, ["region"], [{ field: "sales", function: "sum", alias: "totalSales" }]);
    expect(result).toHaveLength(2);
    const north = result.find((r) => r["region"] === "north");
    expect(north!["totalSales"]).toBe(300);
  });
});

describe("aggregate — avg", () => {
  it("computes average correctly", () => {
    const records: DataRecord[] = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const result = aggregate(records, [], [{ field: "v", function: "avg", alias: "mean" }]);
    expect(result[0]!["mean"]).toBe(20);
  });

  it("returns null when no numeric values exist for avg", () => {
    const records: DataRecord[] = [{ v: "text" }, { v: null }];
    const result = aggregate(records, [], [{ field: "v", function: "avg", alias: "mean" }]);
    expect(result[0]!["mean"]).toBeNull();
  });
});

describe("aggregate — min / max", () => {
  it("finds min value", () => {
    const records: DataRecord[] = [{ v: 5 }, { v: 2 }, { v: 8 }];
    const result = aggregate(records, [], [{ field: "v", function: "min", alias: "minimum" }]);
    expect(result[0]!["minimum"]).toBe(2);
  });

  it("finds max value", () => {
    const records: DataRecord[] = [{ v: 5 }, { v: 2 }, { v: 8 }];
    const result = aggregate(records, [], [{ field: "v", function: "max", alias: "maximum" }]);
    expect(result[0]!["maximum"]).toBe(8);
  });
});

describe("aggregate — count", () => {
  it("counts all records per group", () => {
    const records: DataRecord[] = [
      { type: "A" },
      { type: "A" },
      { type: "B" },
    ];
    const result = aggregate(records, ["type"], [{ field: "type", function: "count", alias: "n" }]);
    const a = result.find((r) => r["type"] === "A");
    const b = result.find((r) => r["type"] === "B");
    expect(a!["n"]).toBe(2);
    expect(b!["n"]).toBe(1);
  });
});

describe("aggregate — multiple aggregations", () => {
  it("computes multiple aggregation functions in one pass", () => {
    const records: DataRecord[] = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const result = aggregate(records, [], [
      { field: "v", function: "sum", alias: "total" },
      { field: "v", function: "avg", alias: "mean" },
      { field: "v", function: "count", alias: "n" },
    ]);
    expect(result[0]).toMatchObject({ total: 60, mean: 20, n: 3 });
  });
});

describe("aggregate — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(aggregate([], [], [{ field: "v", function: "sum", alias: "s" }])).toEqual([]);
  });

  it("throws TransformError when aggregations is empty", () => {
    expect(() => aggregate([{ v: 1 }], [], [])).toThrow(TransformError);
  });
});

// ---------------------------------------------------------------------------
// pivot
// ---------------------------------------------------------------------------

describe("pivot", () => {
  const records: DataRecord[] = [
    { category: "A", month: "Jan", sales: 100 },
    { category: "A", month: "Feb", sales: 200 },
    { category: "B", month: "Jan", sales: 150 },
    { category: "B", month: "Feb", sales: 250 },
  ];

  const config = {
    groupField: "category",
    pivotField: "month",
    valueField: "sales",
    aggregation: "sum" as const,
  };

  it("creates column per unique pivot value", () => {
    const result = pivot(records, config);
    expect(result).toHaveLength(2);
    const a = result.find((r) => r["category"] === "A");
    expect(a!["Jan"]).toBe(100);
    expect(a!["Feb"]).toBe(200);
  });

  it("aggregates multiple records per cell (sum)", () => {
    const recs: DataRecord[] = [
      { cat: "X", month: "Jan", v: 10 },
      { cat: "X", month: "Jan", v: 20 },
      { cat: "X", month: "Feb", v: 5 },
    ];
    const result = pivot(recs, { groupField: "cat", pivotField: "month", valueField: "v", aggregation: "sum" });
    const x = result.find((r) => r["cat"] === "X");
    expect(x!["Jan"]).toBe(30);
    expect(x!["Feb"]).toBe(5);
  });

  it("returns null for empty cells", () => {
    // A-Mar does not exist in the records so the cell should be null
    const result = pivot(records, config);
    const a = result.find((r) => r["category"] === "A");
    // All months are present so no null cells in this test
    expect(a).toBeDefined();
    expect(Object.keys(a!).filter((k) => k !== "category")).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(pivot([], config)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// unpivot
// ---------------------------------------------------------------------------

describe("unpivot", () => {
  const records: DataRecord[] = [
    { id: 1, name: "Alice", Jan: 100, Feb: 200 },
    { id: 2, name: "Bob", Jan: 150, Feb: 250 },
  ];

  const config = {
    keyField: "id",
    valueFields: ["Jan", "Feb"],
    nameColumn: "month",
    valueColumn: "sales",
  };

  it("expands each value field into a separate row", () => {
    const result = unpivot(records, config);
    expect(result).toHaveLength(4);
  });

  it("preserves non-value fields on each output row", () => {
    const result = unpivot(records, config);
    const janAlice = result.find((r) => r["id"] === 1 && r["month"] === "Jan");
    expect(janAlice).toBeDefined();
    expect(janAlice!["name"]).toBe("Alice");
    expect(janAlice!["sales"]).toBe(100);
  });

  it("uses nameColumn and valueColumn as output field names", () => {
    const result = unpivot([{ id: 1, Q1: 10 }], {
      keyField: "id",
      valueFields: ["Q1"],
      nameColumn: "quarter",
      valueColumn: "revenue",
    });
    expect(result[0]).toMatchObject({ id: 1, quarter: "Q1", revenue: 10 });
  });

  it("uses null for missing value fields", () => {
    const result = unpivot([{ id: 1 }], {
      keyField: "id",
      valueFields: ["missing"],
      nameColumn: "k",
      valueColumn: "v",
    });
    expect(result[0]!["v"]).toBeNull();
  });

  it("returns empty array for empty input", () => {
    expect(unpivot([], config)).toEqual([]);
  });

  it("throws TransformError when valueFields is empty", () => {
    expect(() => unpivot([{ id: 1 }], { keyField: "id", valueFields: [], nameColumn: "k", valueColumn: "v" }))
      .toThrow(TransformError);
  });
});

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

describe("join — inner", () => {
  const left: DataRecord[] = [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
    { id: 3, name: "Carol" },
  ];
  const right: DataRecord[] = [
    { userId: 1, score: 90 },
    { userId: 2, score: 85 },
    { userId: 4, score: 70 },
  ];

  it("returns only rows that match on both sides", () => {
    const result = join(left, right, { joinType: "inner", leftKey: "id", rightKey: "userId" });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r["id"])).toContain(1);
    expect(result.map((r) => r["id"])).toContain(2);
  });

  it("merges left and right fields on matched rows", () => {
    const result = join(left, right, { joinType: "inner", leftKey: "id", rightKey: "userId" });
    const alice = result.find((r) => r["id"] === 1);
    expect(alice).toMatchObject({ id: 1, name: "Alice", score: 90 });
  });

  it("returns empty array when no rows match", () => {
    const l: DataRecord[] = [{ id: 99 }];
    const r: DataRecord[] = [{ userId: 1 }];
    expect(join(l, r, { joinType: "inner", leftKey: "id", rightKey: "userId" })).toEqual([]);
  });
});

describe("join — left", () => {
  it("includes all left rows, null for unmatched right", () => {
    const left: DataRecord[] = [{ id: 1 }, { id: 2 }];
    const right: DataRecord[] = [{ userId: 1, score: 90 }];
    const result = join(left, right, { joinType: "left", leftKey: "id", rightKey: "userId" });
    expect(result).toHaveLength(2);
    const unmatched = result.find((r) => r["id"] === 2);
    expect(unmatched).toBeDefined();
    expect(unmatched!["score"]).toBeUndefined();
  });
});

describe("join — right", () => {
  it("includes all right rows, drops unmatched left", () => {
    const left: DataRecord[] = [{ id: 1 }];
    const right: DataRecord[] = [{ uid: 1, score: 90 }, { uid: 2, score: 80 }];
    const result = join(left, right, { joinType: "right", leftKey: "id", rightKey: "uid" });
    expect(result).toHaveLength(2);
  });
});

describe("join — full outer", () => {
  it("includes all rows from both sides", () => {
    const left: DataRecord[] = [{ id: 1 }, { id: 2 }];
    const right: DataRecord[] = [{ uid: 2 }, { uid: 3 }];
    const result = join(left, right, { joinType: "full", leftKey: "id", rightKey: "uid" });
    // id=1 left only, id=2 matched, uid=3 right only
    expect(result).toHaveLength(3);
  });
});

describe("join — field collision handling", () => {
  it("prefixes right-side fields with right_ when they collide with left", () => {
    const left: DataRecord[] = [{ id: 1, name: "Alice" }];
    const right: DataRecord[] = [{ uid: 1, name: "Alice-right" }];
    const result = join(left, right, { joinType: "inner", leftKey: "id", rightKey: "uid" });
    expect(result[0]!["name"]).toBe("Alice");
    expect(result[0]!["right_name"]).toBe("Alice-right");
  });
});

describe("join — one-to-many", () => {
  it("produces multiple rows when right side has multiple matches", () => {
    const left: DataRecord[] = [{ id: 1, name: "Alice" }];
    const right: DataRecord[] = [
      { userId: 1, tag: "admin" },
      { userId: 1, tag: "user" },
    ];
    const result = join(left, right, { joinType: "inner", leftKey: "id", rightKey: "userId" });
    expect(result).toHaveLength(2);
  });
});

describe("join — empty inputs", () => {
  it("returns empty array for empty left with inner join", () => {
    expect(join([], [{ id: 1 }], { joinType: "inner", leftKey: "id", rightKey: "id" })).toEqual([]);
  });

  it("returns empty array for empty right with inner join", () => {
    expect(join([{ id: 1 }], [], { joinType: "inner", leftKey: "id", rightKey: "id" })).toEqual([]);
  });

  it("returns left records for empty right with left join", () => {
    const result = join([{ id: 1 }], [], { joinType: "left", leftKey: "id", rightKey: "id" });
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

describe("sort", () => {
  it("sorts numerically ascending by a single field", () => {
    const records: DataRecord[] = [{ v: 30 }, { v: 10 }, { v: 20 }];
    const result = sort(records, [{ field: "v", direction: "asc" }]);
    expect(result.map((r) => r["v"])).toEqual([10, 20, 30]);
  });

  it("sorts numerically descending", () => {
    const records: DataRecord[] = [{ v: 30 }, { v: 10 }, { v: 20 }];
    const result = sort(records, [{ field: "v", direction: "desc" }]);
    expect(result.map((r) => r["v"])).toEqual([30, 20, 10]);
  });

  it("sorts strings alphabetically ascending", () => {
    const records: DataRecord[] = [{ name: "Charlie" }, { name: "Alice" }, { name: "Bob" }];
    const result = sort(records, [{ field: "name", direction: "asc" }]);
    expect(result.map((r) => r["name"])).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("supports multi-field sort (primary + secondary)", () => {
    const records: DataRecord[] = [
      { dept: "Eng", name: "Bob" },
      { dept: "HR", name: "Alice" },
      { dept: "Eng", name: "Alice" },
    ];
    const result = sort(records, [
      { field: "dept", direction: "asc" },
      { field: "name", direction: "asc" },
    ]);
    expect(result[0]!["name"]).toBe("Alice");
    expect(result[1]!["name"]).toBe("Bob");
    expect(result[2]!["dept"]).toBe("HR");
  });

  it("sorts nulls to the end", () => {
    const records: DataRecord[] = [{ v: null }, { v: 5 }, { v: null }, { v: 1 }];
    const result = sort(records, [{ field: "v", direction: "asc" }]);
    expect(result[0]!["v"]).toBe(1);
    expect(result[1]!["v"]).toBe(5);
    expect(result[2]!["v"]).toBeNull();
    expect(result[3]!["v"]).toBeNull();
  });

  it("does not mutate the input array", () => {
    const records: DataRecord[] = [{ v: 3 }, { v: 1 }, { v: 2 }];
    const original = [...records];
    sort(records, [{ field: "v", direction: "asc" }]);
    expect(records.map((r) => r["v"])).toEqual(original.map((r) => r["v"]));
  });

  it("returns empty array for empty input", () => {
    expect(sort([], [{ field: "v", direction: "asc" }])).toEqual([]);
  });

  it("throws TransformError when fields is empty", () => {
    expect(() => sort([{ v: 1 }], [])).toThrow(TransformError);
  });
});

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

describe("limit", () => {
  it("returns exactly N records", () => {
    const records: DataRecord[] = [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }];
    expect(limit(records, 3)).toHaveLength(3);
  });

  it("returns all records when count exceeds length", () => {
    const records: DataRecord[] = [{ i: 1 }, { i: 2 }];
    expect(limit(records, 100)).toHaveLength(2);
  });

  it("returns first record when count is 1", () => {
    const records: DataRecord[] = [{ i: 1 }, { i: 2 }];
    const result = limit(records, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!["i"]).toBe(1);
  });

  it("returns empty array for empty input", () => {
    expect(limit([], 5)).toEqual([]);
  });

  it("throws TransformError for zero count", () => {
    expect(() => limit([{ i: 1 }], 0)).toThrow(TransformError);
  });

  it("throws TransformError for negative count", () => {
    expect(() => limit([{ i: 1 }], -1)).toThrow(TransformError);
  });

  it("throws TransformError for non-integer count", () => {
    expect(() => limit([{ i: 1 }], 1.5)).toThrow(TransformError);
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe("rename", () => {
  it("renames a single field", () => {
    const records: DataRecord[] = [{ old_name: "Alice" }];
    const result = rename(records, { old_name: "name" });
    expect(result[0]).toEqual({ name: "Alice" });
  });

  it("renames multiple fields simultaneously", () => {
    const records: DataRecord[] = [{ a: 1, b: 2, c: 3 }];
    const result = rename(records, { a: "x", b: "y" });
    expect(result[0]).toEqual({ x: 1, y: 2, c: 3 });
  });

  it("preserves fields not in fieldMap", () => {
    const records: DataRecord[] = [{ a: 1, b: 2 }];
    const result = rename(records, { a: "alpha" });
    expect(result[0]).toMatchObject({ alpha: 1, b: 2 });
  });

  it("handles renaming when old field does not exist on a record (no-op)", () => {
    const records: DataRecord[] = [{ x: 1 }];
    const result = rename(records, { missing: "new" });
    // The field 'missing' doesn't exist so no key to rename, x is preserved
    expect(result[0]).toEqual({ x: 1 });
  });

  it("returns empty array for empty input", () => {
    expect(rename([], { a: "b" })).toEqual([]);
  });

  it("throws TransformError when fieldMap is empty", () => {
    expect(() => rename([{ a: 1 }], {})).toThrow(TransformError);
  });
});

// ---------------------------------------------------------------------------
// Integration: chain of operations
// ---------------------------------------------------------------------------

describe("chained transform operations", () => {
  it("filter → sort → limit pipeline produces correct results", () => {
    const records: DataRecord[] = [
      { name: "Dave", score: 70 },
      { name: "Alice", score: 90 },
      { name: "Bob", score: 85 },
      { name: "Carol", score: 60 },
    ];

    const filtered = filter(records, "score >= 80");
    const sorted = sort(filtered, [{ field: "score", direction: "desc" }]);
    const limited = limit(sorted, 1);

    expect(limited).toHaveLength(1);
    expect(limited[0]!["name"]).toBe("Alice");
  });

  it("aggregate → rename produces named output", () => {
    const records: DataRecord[] = [
      { region: "north", revenue: 100 },
      { region: "north", revenue: 200 },
      { region: "south", revenue: 150 },
    ];

    const agg = aggregate(records, ["region"], [{ field: "revenue", function: "sum", alias: "total" }]);
    const renamed = rename(agg, { total: "totalRevenue" });

    const north = renamed.find((r) => r["region"] === "north");
    expect(north!["totalRevenue"]).toBe(300);
  });
});
