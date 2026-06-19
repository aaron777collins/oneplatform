/**
 * Shared helper for serializing ListOptions into HTTP query parameters.
 *
 * Handles filter (FilterBuilder DSL or raw Record), sort, fields, limit,
 * and cursor — producing a flat key/value object suitable for transport.request().
 */

import type { ListOptions } from '../types/resources.js';
import type { FilterBuilder } from '../filter-builder/filter-builder.js';

/**
 * Converts a {@link ListOptions} object into a flat query parameter record
 * that the transport layer can append to the request URL.
 *
 * - `filter`: serialized via FilterBuilder.toParams() or spread as-is for raw records.
 * - `sort`: joined with ',' when given as an array.
 * - `fields`: joined with ','.
 * - `limit` and `cursor`: passed through directly.
 */
export function serializeListQuery(
  options?: ListOptions,
): Record<string, string | string[] | number | boolean | undefined> {
  if (options === undefined) return {};

  const query: Record<string, string | string[] | number | boolean | undefined> = {};

  if (options.limit !== undefined) query['limit'] = options.limit;
  if (options.cursor !== undefined) query['cursor'] = options.cursor;
  if (options.sort !== undefined) {
    query['sort'] = Array.isArray(options.sort) ? options.sort.join(',') : options.sort;
  }
  if (options.fields !== undefined) {
    query['fields'] = options.fields.join(',');
  }

  let filterParams: Record<string, string> = {};
  if (options.filter !== undefined) {
    // Discriminate FilterBuilder (has toParams method) from raw Record<string, string>
    if (
      typeof options.filter === 'object' &&
      typeof (options.filter as FilterBuilder).toParams === 'function'
    ) {
      filterParams = (options.filter as FilterBuilder).toParams();
    } else {
      filterParams = options.filter as Record<string, string>;
    }
  }

  return { ...query, ...filterParams } as Record<
    string,
    string | string[] | number | boolean | undefined
  >;
}
