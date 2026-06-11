/**
 * Shared types for resource method options.
 */

import type { FilterBuilder } from '../filter-builder/filter-builder.js';

export interface FilterOptions {
  /** Type-safe filter DSL or raw query params. */
  readonly filter?: FilterBuilder | Record<string, string>;
}

export interface SortOptions {
  /**
   * Sort specification. Prefix with '-' for descending.
   * Example: '-createdAt' or ['name', '-price']
   */
  readonly sort?: string | string[];
}

export interface FieldSelection {
  /**
   * Fields to include in the response. Reduces payload size.
   * Unknown fields are silently ignored by the server.
   */
  readonly fields?: string[];
}

export interface ListOptions extends FilterOptions, SortOptions, FieldSelection {
  /** Page size hint. Default: 50. Max: 100. */
  readonly limit?: number;

  /**
   * Explicit starting cursor. Usually managed by the Paginator automatically.
   * Pass only when resuming a previous pagination session.
   */
  readonly cursor?: string;
}

export interface GetOptions extends FieldSelection {}

export interface MutationOptions {
  /** Idempotency key for safe POST retries. */
  readonly idempotencyKey?: string;
}

export interface LogQueryOptions extends FilterOptions, SortOptions {
  readonly from?: string;
  readonly to?: string;
  readonly service?: string;
  readonly level?: 'debug' | 'info' | 'warn' | 'error';
  readonly limit?: number;
}

export interface TailOptions {
  readonly service?: string;
  readonly level?: 'debug' | 'info' | 'warn' | 'error';
}

export interface AuditQueryOptions extends FilterOptions, SortOptions {
  readonly from?: string;
  readonly to?: string;
  readonly actorId?: string;
  readonly resourceType?: string;
  readonly limit?: number;
}
