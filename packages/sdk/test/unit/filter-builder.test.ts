/**
 * Unit tests for the filter DSL builder.
 * Covers: chaining, operator serialization, invalid field names.
 */

import { describe, it, expect } from 'vitest';
import { filter } from '../../src/filter-builder/filter-builder.js';

describe('filter() builder', () => {
  it('serializes eq condition', () => {
    expect(filter('status').eq('active').toParams()).toEqual({
      'filter[status][eq]': 'active',
    });
  });

  it('serializes neq condition', () => {
    expect(filter('status').neq('inactive').toParams()).toEqual({
      'filter[status][neq]': 'inactive',
    });
  });

  it('serializes numeric comparisons', () => {
    const params = filter('price').gt(100).and('qty').lte(50).toParams();
    expect(params).toEqual({
      'filter[price][gt]': '100',
      'filter[qty][lte]': '50',
    });
  });

  it('serializes in operator with comma-joined values', () => {
    expect(filter('tags').in(['featured', 'sale']).toParams()).toEqual({
      'filter[tags][in]': 'featured,sale',
    });
  });

  it('serializes null operator', () => {
    expect(filter('deletedAt').null(true).toParams()).toEqual({
      'filter[deletedAt][null]': 'true',
    });
  });

  it('serializes like operator', () => {
    expect(filter('name').like('acme%').toParams()).toEqual({
      'filter[name][like]': 'acme%',
    });
  });

  it('chains multiple conditions', () => {
    const params = filter('status')
      .eq('active')
      .and('price')
      .gt(10)
      .and('tags')
      .in(['sale'])
      .toParams();

    expect(params).toEqual({
      'filter[status][eq]': 'active',
      'filter[price][gt]': '10',
      'filter[tags][in]': 'sale',
    });
  });

  it('is immutable — branches do not affect each other', () => {
    const base = filter('status').eq('active');
    const branch1 = base.and('price').gt(100);
    const branch2 = base.and('qty').lt(5);

    expect(branch1.toParams()).not.toEqual(branch2.toParams());
    expect(Object.keys(branch1.toParams())).toHaveLength(2);
    expect(Object.keys(branch2.toParams())).toHaveLength(2);
  });

  it('throws on invalid field names', () => {
    expect(() => filter('status; DROP TABLE users')).toThrow();
    expect(() => filter('')).toThrow();
  });

  it('accepts dotted field paths', () => {
    expect(filter('address.city').eq('Toronto').toParams()).toEqual({
      'filter[address.city][eq]': 'Toronto',
    });
  });

  it('serializes boolean values as strings', () => {
    expect(filter('active').eq(true).toParams()).toEqual({
      'filter[active][eq]': 'true',
    });
  });
});
