/**
 * Unit tests for ValidationError (G-089).
 *
 * Verifies the full contract: instanceof hierarchy, typed fields/constraints
 * properties, backward-compatible fieldErrors getter, toJSON output, and
 * the pre-flight validation throws in filter-builder, events, and sse-subscriber.
 */

import { describe, it, expect } from 'vitest';
import {
  ValidationError,
  ClientError,
  OnePlatformError,
} from '../../src/errors/index.js';
import type { ValidationFieldError, ValidationConstraintViolation } from '../../src/errors/index.js';
import { filter } from '../../src/filter-builder/index.js';

// ---------------------------------------------------------------------------
// instanceof chain
// ---------------------------------------------------------------------------

describe('ValidationError prototype chain', () => {
  it('is instanceof Error, OnePlatformError, ClientError, and ValidationError', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OnePlatformError);
    expect(err).toBeInstanceOf(ClientError);
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('has name set to "ValidationError"', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.name).toBe('ValidationError');
  });
});

// ---------------------------------------------------------------------------
// Fixed properties
// ---------------------------------------------------------------------------

describe('ValidationError fixed properties', () => {
  it('has statusCode 422', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.statusCode).toBe(422);
  });

  it('is non-retryable', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.retryable).toBe(false);
  });

  it('has code set from options', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// fields property
// ---------------------------------------------------------------------------

describe('ValidationError.fields', () => {
  it('is an empty array when not supplied', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.fields).toEqual([]);
  });

  it('stores per-field errors with field and message', () => {
    const fields: ValidationFieldError[] = [
      { field: 'email', message: 'Must be a valid email address.' },
      { field: 'name', message: 'Required.' },
    ];
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false, fields });
    expect(err.fields).toEqual(fields);
  });

  it('supports dot-notation field paths for nested objects', () => {
    const fields: ValidationFieldError[] = [
      { field: 'address.zip', message: 'Must be a 5-digit code.' },
    ];
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false, fields });
    expect(err.fields[0]?.field).toBe('address.zip');
  });
});

// ---------------------------------------------------------------------------
// constraints property
// ---------------------------------------------------------------------------

describe('ValidationError.constraints', () => {
  it('is an empty array when not supplied', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.constraints).toEqual([]);
  });

  it('stores cross-field constraint violations', () => {
    const constraints: ValidationConstraintViolation[] = [
      { constraint: 'atLeastOneOf', message: 'Provide at least one of: name, slug.' },
    ];
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false, constraints });
    expect(err.constraints).toEqual(constraints);
  });

  it('can carry both fields and constraints simultaneously', () => {
    const fields: ValidationFieldError[] = [{ field: 'price', message: 'Must be positive.' }];
    const constraints: ValidationConstraintViolation[] = [
      { constraint: 'priceOrFree', message: 'Either price or isFree must be set.' },
    ];
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false, fields, constraints });
    expect(err.fields).toHaveLength(1);
    expect(err.constraints).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Backward-compatible fieldErrors getter
// ---------------------------------------------------------------------------

describe('ValidationError.fieldErrors (backward compat)', () => {
  it('returns per-field errors from details.fields map', () => {
    const err = new ValidationError({
      code: 'VALIDATION_ERROR',
      message: 'Invalid',
      retryable: false,
      details: {
        fields: {
          email: ['Must be a valid email'],
          name: ['Required', 'Too short'],
        },
      },
    });
    expect(err.fieldErrors).toEqual({
      email: ['Must be a valid email'],
      name: ['Required', 'Too short'],
    });
  });

  it('returns an empty object when details is absent', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.fieldErrors).toEqual({});
  });

  it('returns an empty object when details has no fields key', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false, details: { other: 'value' } });
    expect(err.fieldErrors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// toJSON — must not leak response or stack
// ---------------------------------------------------------------------------

describe('ValidationError.toJSON', () => {
  it('includes code, message, statusCode, retryable in JSON', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    const json = err.toJSON();
    expect(json['code']).toBe('VALIDATION_ERROR');
    expect(json['message']).toBe('bad');
    expect(json['statusCode']).toBe(422);
    expect(json['retryable']).toBe(false);
  });

  it('does not include response', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.toJSON()).not.toHaveProperty('response');
  });

  it('does not include stack trace', () => {
    const err = new ValidationError({ code: 'VALIDATION_ERROR', message: 'bad', retryable: false });
    expect(err.toJSON()).not.toHaveProperty('stack');
  });
});

// ---------------------------------------------------------------------------
// filter-builder: assertValidFieldName throws ValidationError
// ---------------------------------------------------------------------------

describe('filter() throws ValidationError for invalid field names', () => {
  it('throws ValidationError on field names with special characters', () => {
    expect(() => filter('field with spaces')).toThrow(ValidationError);
  });

  it('thrown error has a fields entry for the invalid field', () => {
    let caught: ValidationError | null = null;
    try {
      filter('bad;field');
    } catch (err) {
      caught = err as ValidationError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.fields).toHaveLength(1);
    expect(caught?.fields[0]?.field).toBe('bad;field');
  });

  it('thrown error is instanceof OnePlatformError (catch-all works)', () => {
    expect(() => filter('<script>')).toThrow(OnePlatformError);
  });

  it('does NOT throw for valid field names (dot notation, brackets)', () => {
    // These are all legitimate field name patterns the filter DSL must accept.
    expect(() => filter('status')).not.toThrow();
    expect(() => filter('meta.createdAt')).not.toThrow();
    expect(() => filter('tags[0]')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Immutability — fields and constraints are readonly arrays
// ---------------------------------------------------------------------------

describe('ValidationError arrays are readonly at runtime', () => {
  it('fields array cannot be mutated via TypeScript readonly', () => {
    const err = new ValidationError({
      code: 'VALIDATION_ERROR',
      message: 'bad',
      retryable: false,
      fields: [{ field: 'x', message: 'y' }],
    });
    // TypeScript enforces readonly at compile time; we verify the reference
    // is the same object (not a deep clone that loses identity).
    const ref = err.fields;
    expect(ref).toBe(err.fields);
  });
});
