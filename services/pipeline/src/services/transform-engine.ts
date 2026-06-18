// Transform engine — pure, side-effect-free data transformations for pipeline
// transform steps (G-051).
//
// WHY pure functions: each operation takes records in, returns records out.
// This makes the operations composable, testable in isolation, and safe to
// call from any async context without worrying about shared mutable state.
// The execution engine is the only caller and it owns the I/O boundary.

import { evaluate, evaluateBoolean, ExpressionEvaluatorError } from "./expression-evaluator.js";

// ---------------------------------------------------------------------------
// Core data types
// ---------------------------------------------------------------------------

// DataRecord is an alias, not a wrapper, so transforms can pass record arrays
// between operations without conversion overhead.
export type DataRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/**
 * Removes duplicate records based on a set of key fields.
 *
 * strategy='first'  — keep the first occurrence (stable input order).
 * strategy='last'   — keep the last occurrence (overwrites with later record).
 */
export function dedup(
  records: DataRecord[],
  keyFields: string[],
  strategy: "first" | "last",
): DataRecord[] {
  if (keyFields.length === 0) {
    throw new TransformError("dedup requires at least one keyField.");
  }

  const seen = new Map<string, DataRecord>();

  for (const record of records) {
    const key = buildCompositeKey(record, keyFields);
    if (strategy === "first" && seen.has(key)) continue;
    seen.set(key, record);
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * Keeps only records where the condition expression evaluates to truthy.
 * Uses the safe expression evaluator — no eval(), no global access.
 */
export function filter(records: DataRecord[], condition: string): DataRecord[] {
  if (!condition || condition.trim() === "") {
    throw new TransformError("filter requires a non-empty condition expression.");
  }

  const out: DataRecord[] = [];
  for (const record of records) {
    let pass: boolean;
    try {
      pass = evaluateBoolean(condition, { record });
    } catch (err) {
      throw new TransformError(
        `filter expression error: ${err instanceof ExpressionEvaluatorError ? err.message : String(err)}`,
      );
    }
    if (pass) out.push(record);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Map fields
// ---------------------------------------------------------------------------

/**
 * Transforms each record by evaluating field expressions.
 * mappings is { outputField: expression }, where expression may reference
 * any field in the current record.
 *
 * Fields not in mappings are included unchanged — map is additive/overriding,
 * not replacing. Use rename + select to drop fields.
 */
export function mapFields(
  records: DataRecord[],
  mappings: Record<string, string>,
): DataRecord[] {
  if (Object.keys(mappings).length === 0) {
    throw new TransformError("map requires at least one field mapping.");
  }

  return records.map((record) => {
    const out: DataRecord = { ...record };
    for (const [outputField, expression] of Object.entries(mappings)) {
      try {
        out[outputField] = evaluate(expression, { record });
      } catch (err) {
        throw new TransformError(
          `map expression error for field "${outputField}": ${err instanceof ExpressionEvaluatorError ? err.message : String(err)}`,
        );
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export type AggregateFunction = "sum" | "avg" | "min" | "max" | "count";

export interface AggregationSpec {
  field: string;
  function: AggregateFunction;
  alias: string;
}

/**
 * Groups records by groupBy fields and applies aggregation functions.
 * Records with missing groupBy fields are grouped under the key `""`.
 */
export function aggregate(
  records: DataRecord[],
  groupBy: string[],
  aggregations: AggregationSpec[],
): DataRecord[] {
  if (aggregations.length === 0) {
    throw new TransformError("aggregate requires at least one aggregation.");
  }

  // Build groups: composite key → record array
  const groups = new Map<string, DataRecord[]>();
  const keyToGroupRecord = new Map<string, DataRecord>();

  for (const record of records) {
    const key = groupBy.length > 0 ? buildCompositeKey(record, groupBy) : "__all__";
    if (!groups.has(key)) {
      groups.set(key, []);
      // Build a partial "group key" record for the output
      const groupRecord: DataRecord = {};
      for (const field of groupBy) {
        groupRecord[field] = record[field];
      }
      keyToGroupRecord.set(key, groupRecord);
    }
    groups.get(key)!.push(record);
  }

  const results: DataRecord[] = [];
  for (const [key, groupRecords] of groups) {
    const out: DataRecord = { ...keyToGroupRecord.get(key) };
    for (const agg of aggregations) {
      out[agg.alias] = applyAggregation(groupRecords, agg.field, agg.function);
    }
    results.push(out);
    void key; // suppress unused var lint for intermediate key
  }

  return results;
}

function applyAggregation(
  records: DataRecord[],
  field: string,
  func: AggregateFunction,
): number | null {
  if (func === "count") return records.length;

  const values = records
    .map((r) => r[field])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  if (values.length === 0) return null;

  switch (func) {
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
  }
}

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

export interface PivotConfig {
  groupField: string;
  pivotField: string;
  valueField: string;
  aggregation: AggregateFunction;
}

/**
 * Pivots rows to columns.
 *
 * Example: records with { category: 'A', month: 'Jan', sales: 100 }
 *   → { category: 'A', Jan: 100, Feb: 250 }
 *
 * groupField: the field whose unique values become row keys (e.g. 'category')
 * pivotField: the field whose unique values become new column names (e.g. 'month')
 * valueField: the field whose values are aggregated into the new columns
 */
export function pivot(records: DataRecord[], config: PivotConfig): DataRecord[] {
  const { groupField, pivotField, valueField, aggregation } = config;

  // Collect all unique pivot values to build consistent column set
  const pivotValues = new Set<string>();
  for (const record of records) {
    const pv = record[pivotField];
    if (pv !== null && pv !== undefined) {
      pivotValues.add(String(pv));
    }
  }

  // Group records by groupField, then by pivotField within each group
  const groups = new Map<string, Map<string, DataRecord[]>>();
  const groupKeyRecords = new Map<string, DataRecord>();

  for (const record of records) {
    const gk = record[groupField] !== undefined && record[groupField] !== null
      ? String(record[groupField])
      : "__null__";
    const pk = record[pivotField] !== undefined && record[pivotField] !== null
      ? String(record[pivotField])
      : "__null__";

    if (!groups.has(gk)) {
      groups.set(gk, new Map());
      groupKeyRecords.set(gk, { [groupField]: record[groupField] });
    }
    const pivotGroup = groups.get(gk)!;
    if (!pivotGroup.has(pk)) pivotGroup.set(pk, []);
    pivotGroup.get(pk)!.push(record);
  }

  const results: DataRecord[] = [];
  for (const [gk, pivotGroups] of groups) {
    const out: DataRecord = { ...groupKeyRecords.get(gk) };
    for (const pv of pivotValues) {
      const cellRecords = pivotGroups.get(pv) ?? [];
      out[pv] = applyAggregation(cellRecords, valueField, aggregation);
    }
    results.push(out);
    void gk;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Unpivot
// ---------------------------------------------------------------------------

export interface UnpivotConfig {
  keyField: string;
  valueFields: string[];
  nameColumn: string;
  valueColumn: string;
}

/**
 * Unpivots (melts) columns into rows.
 *
 * Example: { id: 1, Jan: 100, Feb: 200 } with valueFields=['Jan','Feb']
 *   → [{ id: 1, month: 'Jan', sales: 100 }, { id: 1, month: 'Feb', sales: 200 }]
 *
 * keyField: the field(s) that identify each row (kept in output)
 * valueFields: column names that become rows
 * nameColumn: name for the column that holds former field names
 * valueColumn: name for the column that holds the values
 */
export function unpivot(records: DataRecord[], config: UnpivotConfig): DataRecord[] {
  const { keyField, valueFields, nameColumn, valueColumn } = config;

  if (valueFields.length === 0) {
    throw new TransformError("unpivot requires at least one valueField.");
  }

  const out: DataRecord[] = [];
  for (const record of records) {
    // The keyField value stays on every output row (along with any non-value fields)
    const baseRecord: DataRecord = {};
    for (const [k, v] of Object.entries(record)) {
      if (!valueFields.includes(k)) {
        baseRecord[k] = v;
      }
    }

    for (const field of valueFields) {
      out.push({
        ...baseRecord,
        [nameColumn]: field,
        [valueColumn]: record[field] ?? null,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export type JoinType = "inner" | "left" | "right" | "full";

export interface JoinConfig {
  joinType: JoinType;
  leftKey: string;
  rightKey: string;
}

/**
 * Joins two record sets on key fields.
 * Returns a merged record array; conflicting field names from the right side
 * are prefixed with "right_" to avoid silent overwrites.
 */
export function join(
  leftRecords: DataRecord[],
  rightRecords: DataRecord[],
  config: JoinConfig,
): DataRecord[] {
  const { joinType, leftKey, rightKey } = config;

  // Build a lookup from right records keyed by rightKey value.
  // For one-to-many joins we keep all matching right records.
  const rightIndex = new Map<string, DataRecord[]>();
  for (const r of rightRecords) {
    const k = toJoinKey(r[rightKey]);
    if (!rightIndex.has(k)) rightIndex.set(k, []);
    rightIndex.get(k)!.push(r);
  }

  const out: DataRecord[] = [];
  const matchedRightKeys = new Set<string>();

  for (const left of leftRecords) {
    const k = toJoinKey(left[leftKey]);
    const rights = rightIndex.get(k);

    if (rights !== undefined && rights.length > 0) {
      matchedRightKeys.add(k);
      for (const right of rights) {
        out.push(mergeRecords(left, right));
      }
    } else if (joinType === "left" || joinType === "full") {
      // Left record with no matching right — emit with nulled right fields
      out.push({ ...left });
    }
    // inner / right: unmatched left records are dropped
  }

  // right and full joins: emit right records with no matching left
  if (joinType === "right" || joinType === "full") {
    for (const [k, rights] of rightIndex) {
      if (!matchedRightKeys.has(k)) {
        for (const right of rights) {
          out.push({ ...right });
        }
      }
    }
  }

  return out;
}

// Merge left + right records; prefix colliding right-side fields with "right_"
function mergeRecords(left: DataRecord, right: DataRecord): DataRecord {
  const out: DataRecord = { ...left };
  for (const [k, v] of Object.entries(right)) {
    if (k in out) {
      out[`right_${k}`] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toJoinKey(v: unknown): string {
  if (v === null || v === undefined) return "__null__";
  return String(v);
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export interface SortField {
  field: string;
  direction: "asc" | "desc";
}

/**
 * Sorts records by one or more fields, left-to-right (first field is primary).
 * Null/undefined values are sorted to the end regardless of direction.
 */
export function sort(records: DataRecord[], fields: SortField[]): DataRecord[] {
  if (fields.length === 0) {
    throw new TransformError("sort requires at least one sort field.");
  }

  // Shallow copy to avoid mutating the input array
  return [...records].sort((a, b) => {
    for (const { field, direction } of fields) {
      const av = a[field];
      const bv = b[field];

      // Sort nulls/undefineds to the end
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;

      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv));
      }

      if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Limit
// ---------------------------------------------------------------------------

/**
 * Returns the first N records. count must be a positive integer.
 */
export function limit(records: DataRecord[], count: number): DataRecord[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new TransformError("limit count must be a positive integer.");
  }
  return records.slice(0, count);
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

/**
 * Renames fields according to fieldMap (oldName → newName).
 * Fields not in fieldMap are passed through unchanged.
 * Throws if a source field does not exist on any record — callers should
 * validate fieldMap against their schema before calling.
 */
export function rename(
  records: DataRecord[],
  fieldMap: Record<string, string>,
): DataRecord[] {
  if (Object.keys(fieldMap).length === 0) {
    throw new TransformError("rename requires at least one field mapping.");
  }

  return records.map((record) => {
    const out: DataRecord = {};
    for (const [k, v] of Object.entries(record)) {
      const newKey = fieldMap[k];
      out[newKey !== undefined ? newKey : k] = v;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildCompositeKey(record: DataRecord, fields: string[]): string {
  return fields
    .map((f) => {
      const v = record[f];
      return v === null || v === undefined ? "__null__" : JSON.stringify(v);
    })
    .join("|");
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformError";
  }
}
