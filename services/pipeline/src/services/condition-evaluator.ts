// Condition evaluator for conditional pipeline steps.
//
// Deliberately free of async I/O — condition checks must be synchronous and
// complete in microseconds so they never become the bottleneck in step routing.
// JSONata-based conditions (the older expression field) are handled separately
// in the execution engine; this module owns the structured Condition type only.

// ---------------------------------------------------------------------------
// Types — exported so execution-engine.ts and tests can import them directly
// ---------------------------------------------------------------------------

export type ConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "exists"
  | "not_exists"
  | "matches";

export interface Condition {
  field: string;
  operator: ConditionOperator;
  // value is optional because exists/not_exists do not need a comparand
  value?: unknown;
}

// ---------------------------------------------------------------------------
// Field access
//
// Supports dot-notation paths such as "user.profile.email".  Array index
// syntax is intentionally not supported here — pipelines deal with object
// graphs, not positional arrays at the routing layer.
// ---------------------------------------------------------------------------

function getFieldValue(
  data: Record<string, unknown>,
  field: string,
): { present: boolean; value: unknown } {
  if (!field || field.length === 0) {
    return { present: false, value: undefined };
  }

  const parts = field.split(".");
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return { present: false, value: undefined };
    }
    const obj = current as Record<string, unknown>;
    // Use hasOwnProperty check so we can distinguish an explicitly set
    // `undefined` value from a key that simply does not exist.
    if (!Object.prototype.hasOwnProperty.call(obj, part)) {
      return { present: false, value: undefined };
    }
    current = obj[part];
  }

  return { present: true, value: current };
}

// ---------------------------------------------------------------------------
// Numeric coercion
//
// When comparing a string that looks like a number with a numeric condition
// value (or vice-versa), we coerce both sides to number.  This matches
// real-world pipeline data where integers arrive as JSON strings from
// upstream connectors.
// ---------------------------------------------------------------------------

function toNumberMaybe(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluates a structured Condition against a data context.
 *
 * Returns true when the condition is satisfied, false otherwise.
 * Never throws — a condition that cannot be evaluated (e.g., regex compile
 * error) returns false so the pipeline routes to the else branch rather than
 * crashing the run.
 */
export function evaluateCondition(
  data: Record<string, unknown>,
  condition: Condition,
): boolean {
  const { field, operator, value: condValue } = condition;

  const { present, value: fieldValue } = getFieldValue(data, field);

  // exists / not_exists only care about key presence, never about the value
  if (operator === "exists") {
    return present;
  }
  if (operator === "not_exists") {
    return !present;
  }

  // All remaining operators require the field to exist
  if (!present) {
    return false;
  }

  switch (operator) {
    case "eq": {
      // Numeric coercion: "42" == 42
      const fieldNum = toNumberMaybe(fieldValue);
      const condNum = toNumberMaybe(condValue);
      if (fieldNum !== null && condNum !== null) {
        return fieldNum === condNum;
      }
      return fieldValue === condValue;
    }

    case "neq": {
      const fieldNum = toNumberMaybe(fieldValue);
      const condNum = toNumberMaybe(condValue);
      if (fieldNum !== null && condNum !== null) {
        return fieldNum !== condNum;
      }
      return fieldValue !== condValue;
    }

    case "gt": {
      const fieldNum = toNumberMaybe(fieldValue);
      const condNum = toNumberMaybe(condValue);
      if (fieldNum === null || condNum === null) return false;
      return fieldNum > condNum;
    }

    case "gte": {
      const fieldNum = toNumberMaybe(fieldValue);
      const condNum = toNumberMaybe(condValue);
      if (fieldNum === null || condNum === null) return false;
      return fieldNum >= condNum;
    }

    case "lt": {
      const fieldNum = toNumberMaybe(fieldValue);
      const condNum = toNumberMaybe(condValue);
      if (fieldNum === null || condNum === null) return false;
      return fieldNum < condNum;
    }

    case "lte": {
      const fieldNum = toNumberMaybe(fieldValue);
      const condNum = toNumberMaybe(condValue);
      if (fieldNum === null || condNum === null) return false;
      return fieldNum <= condNum;
    }

    case "contains": {
      // Works for strings (substring) and arrays (element membership)
      if (typeof fieldValue === "string") {
        return typeof condValue === "string" && fieldValue.includes(condValue);
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(condValue);
      }
      return false;
    }

    case "not_contains": {
      if (typeof fieldValue === "string") {
        return !(typeof condValue === "string" && fieldValue.includes(condValue));
      }
      if (Array.isArray(fieldValue)) {
        return !fieldValue.includes(condValue);
      }
      // Field is neither string nor array — "not_contains" is vacuously true
      // because you can never find condValue in it
      return true;
    }

    case "matches": {
      // condValue must be a regex pattern string; compile failures return false
      // rather than crashing so a typo in a pipeline definition doesn't kill a run.
      if (typeof fieldValue !== "string" || typeof condValue !== "string") {
        return false;
      }
      // Reject overly complex patterns that could cause catastrophic backtracking.
      // Patterns with nested quantifiers (e.g., (a+)+) are the primary ReDoS vector.
      if (/([+*])\s*[)]\s*[+*{]/.test(condValue) || condValue.length > 256) {
        return false;
      }
      try {
        const re = new RegExp(condValue);
        return re.test(fieldValue);
      } catch {
        // Malformed regex — treat as non-match rather than propagating the error
        return false;
      }
    }

    default: {
      // TypeScript exhaustive check — will fail at compile time if a new
      // operator is added to ConditionOperator without a case here.
      const _exhaustive: never = operator;
      void _exhaustive;
      return false;
    }
  }
}
