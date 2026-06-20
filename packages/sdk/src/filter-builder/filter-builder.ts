/**
 * Type-safe filter DSL for building query filter parameters.
 *
 * Produces `filter[field][operator]=value` query parameter objects
 * matching the platform's filter spec. The builder is immutable —
 * each method returns a new instance, making it safe to branch and reuse.
 *
 * Usage:
 *   filter('status').eq('active').and('price').gt(100).toParams()
 *   // → { 'filter[status][eq]': 'active', 'filter[price][gt]': '100' }
 */

import { ValidationError } from '../errors/client-errors.js';

/** Represents a single accumulated filter condition. */
interface FilterCondition {
  readonly field: string;
  readonly operator: string;
  readonly value: string;
}

/**
 * Core filter builder. Accumulates conditions and serializes to query params.
 * Every public method returns `this` to enable chaining.
 */
export interface FilterBuilder {
  /** Add a condition on a new field. Returns a FieldConditionBuilder for operator selection. */
  and(field: string): FieldConditionBuilder;

  /** Serialize all accumulated conditions to query param key/value pairs. */
  toParams(): Record<string, string>;
}

/** Extends FilterBuilder with operator methods. Returned by filter() and and(). */
export interface FieldConditionBuilder extends FilterBuilder {
  eq(value: string | number | boolean): FilterBuilder;
  neq(value: string | number | boolean): FilterBuilder;
  gt(value: number | string): FilterBuilder;
  gte(value: number | string): FilterBuilder;
  lt(value: number | string): FilterBuilder;
  lte(value: number | string): FilterBuilder;
  like(pattern: string): FilterBuilder;
  in(values: Array<string | number>): FilterBuilder;
  /** true = filter to null values; false = filter to non-null values. */
  null(isNull: boolean): FilterBuilder;
}

// --- Internal implementation ---

/** Validates that a field name contains only safe characters to prevent injection. */
function assertValidFieldName(field: string): void {
  if (!/^[\w.[\]]+$/.test(field)) {
    // Reject at the DSL boundary so callers get a typed error they can catch.
    throw new ValidationError({
      code: 'VALIDATION_ERROR',
      message: `[OnePlatform SDK] Invalid filter field name: "${field}". Field names must contain only word characters, dots, and brackets.`,
      retryable: false,
      fields: [{ field, message: 'Field name must contain only word characters, dots, and brackets.' }],
    });
  }
}

class FilterBuilderImpl implements FilterBuilder {
  constructor(protected readonly conditions: FilterCondition[]) {}

  and(field: string): FieldConditionBuilder {
    assertValidFieldName(field);
    return new FieldConditionBuilderImpl(this.conditions, field);
  }

  toParams(): Record<string, string> {
    const params: Record<string, string> = {};
    for (const condition of this.conditions) {
      const key = `filter[${condition.field}][${condition.operator}]`;
      if (key in params) {
        throw new ValidationError({
          code: 'VALIDATION_ERROR',
          message: `[OnePlatform SDK] Duplicate filter condition: field "${condition.field}" with operator "${condition.operator}" appears more than once. Only the last value would be sent, discarding earlier conditions.`,
          retryable: false,
          fields: [{ field: condition.field, message: `Duplicate operator "${condition.operator}" for field "${condition.field}".` }],
        });
      }
      params[key] = condition.value;
    }
    return params;
  }
}

class FieldConditionBuilderImpl extends FilterBuilderImpl implements FieldConditionBuilder {
  constructor(
    conditions: FilterCondition[],
    private readonly currentField: string,
  ) {
    super(conditions);
  }

  private addCondition(operator: string, value: string): FilterBuilder {
    return new FilterBuilderImpl([
      ...this.conditions,
      { field: this.currentField, operator, value },
    ]);
  }

  eq(value: string | number | boolean): FilterBuilder {
    return this.addCondition('eq', String(value));
  }

  neq(value: string | number | boolean): FilterBuilder {
    return this.addCondition('neq', String(value));
  }

  gt(value: number | string): FilterBuilder {
    return this.addCondition('gt', String(value));
  }

  gte(value: number | string): FilterBuilder {
    return this.addCondition('gte', String(value));
  }

  lt(value: number | string): FilterBuilder {
    return this.addCondition('lt', String(value));
  }

  lte(value: number | string): FilterBuilder {
    return this.addCondition('lte', String(value));
  }

  like(pattern: string): FilterBuilder {
    return this.addCondition('like', pattern);
  }

  in(values: Array<string | number>): FilterBuilder {
    // URL-encode commas within individual values so they are not confused with
    // the comma delimiter when the server splits the parameter.
    const encoded = values.map((v) => String(v).replace(/,/g, '%2C'));
    return this.addCondition('in', encoded.join(','));
  }

  null(isNull: boolean): FilterBuilder {
    return this.addCondition('null', String(isNull));
  }
}

/**
 * Entry point for the filter DSL. Returns a FieldConditionBuilder primed
 * to add a condition on the named field.
 *
 * Example:
 *   filter('status').eq('active').and('price').gt(100)
 */
export function filter(field: string): FieldConditionBuilder {
  assertValidFieldName(field);
  return new FieldConditionBuilderImpl([], field);
}

/** Sort specification type alias for IDE discoverability. */
export type SortSpec = string | string[];
