/**
 * client.data namespace — ontology-typed entity CRUD.
 *
 * Each entity type is accessed as client.data.entity('Product').list()
 * or, with generated typed clients, as client.data.Product.list().
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions, GetOptions, MutationOptions } from '../types/resources.js';
import type { BulkOperation, BulkResult } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';
// ValidationError is the correct type for SDK-side input validation failures;
// plain Error would bypass the OnePlatformError hierarchy and break instanceof checks.
import { ValidationError } from '../errors/client-errors.js';
import { serializeListQuery } from './list-query.js';

/**
 * CRUD operations for a single ontology-typed entity.
 *
 * Obtain an instance via `client.data.entity('Product')` or the Proxy shorthand
 * `client.data.Product`. The generic `T` defaults to `Record<string, unknown>`;
 * generated typed clients narrow it to the schema-defined shape.
 */
export interface EntityResource<T> {
  /**
   * Returns a paginated iterable over all records of this entity type.
   *
   * @param options - Filtering, sorting, field selection, and pagination options.
   */
  list(options?: ListOptions): PaginatedIterable<T>;

  /**
   * Fetches a single record by ID.
   *
   * @param id - The entity record ID.
   * @param options - Optional field projection.
   * @throws {@link NotFoundError} when no record with the given ID exists.
   */
  get(id: string, options?: GetOptions): Promise<T>;

  /**
   * Creates a new entity record.
   *
   * @param data - The fields to set on the new record.
   * @param options - Optional idempotency key to prevent duplicate creates.
   */
  create(data: Partial<T>, options?: MutationOptions): Promise<T>;

  /**
   * Applies a partial update (PATCH) to an existing record.
   *
   * @param id - The entity record ID.
   * @param data - The fields to update; unspecified fields are left unchanged.
   * @param options - Optional idempotency key.
   */
  update(id: string, data: Partial<T>, options?: MutationOptions): Promise<T>;

  /**
   * Replaces an existing record in full (PUT).
   *
   * @param id - The entity record ID.
   * @param data - The complete replacement record.
   * @param options - Optional idempotency key.
   */
  replace(id: string, data: T, options?: MutationOptions): Promise<T>;

  /**
   * Permanently deletes a record.
   *
   * @param id - The entity record ID.
   * @throws {@link NotFoundError} when no record with the given ID exists.
   */
  delete(id: string): Promise<void>;

  /**
   * Executes a bulk create, update, or delete operation in a single request.
   *
   * @param operation - The operation descriptor including records and mode.
   * @returns Per-item results; partial failures do not abort the whole batch.
   */
  bulk(operation: BulkOperation<T>): Promise<BulkResult<T>>;
}

function createEntityResource<T>(
  transport: Transport,
  entityType: string,
): EntityResource<T> {
  const basePath = `/api/v1/data/${encodeURIComponent(entityType)}`;

  return {
    list(options?: ListOptions): PaginatedIterable<T> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);

      return new Paginator<T>(async (cursor, limit) => {
        const query = {
          ...baseQuery,
          limit,
          ...(cursor !== null ? { cursor } : {}),
        };

        const result = await transport.request<{
          items: T[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: basePath,
          query: query as Record<string, string | string[] | number | boolean | undefined>,
        });

        return {
          items: result.items,
          nextCursor: result.nextCursor,
          total: result.total,
          hasMore: result.nextCursor !== null,
        };
      }, pageSize);
    },

    async get(id: string, options?: GetOptions): Promise<T> {
      if (!id || id.trim() === '') {
        throw new ValidationError({ code: 'SDK_INVALID_ARGUMENT', message: '[OnePlatform SDK] entity.get() requires a non-empty id', retryable: false });
      }
      const query: Record<string, string | undefined> = {};
      if (options?.fields !== undefined) {
        query['fields'] = options.fields.join(',');
      }
      return transport.request<T>({
        method: 'GET',
        path: `${basePath}/${encodeURIComponent(id)}`,
        query,
      });
    },

    async create(data: Partial<T>, options?: MutationOptions): Promise<T> {
      return transport.request<T>({
        method: 'POST',
        path: basePath,
        body: data,
        ...(options?.idempotencyKey !== undefined
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
      });
    },

    async update(id: string, data: Partial<T>, options?: MutationOptions): Promise<T> {
      if (!id || id.trim() === '') {
        throw new ValidationError({ code: 'SDK_INVALID_ARGUMENT', message: '[OnePlatform SDK] entity.update() requires a non-empty id', retryable: false });
      }
      return transport.request<T>({
        method: 'PATCH',
        path: `${basePath}/${encodeURIComponent(id)}`,
        body: data,
        ...(options?.idempotencyKey !== undefined
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
      });
    },

    async replace(id: string, data: T, options?: MutationOptions): Promise<T> {
      if (!id || id.trim() === '') {
        throw new ValidationError({ code: 'SDK_INVALID_ARGUMENT', message: '[OnePlatform SDK] entity.replace() requires a non-empty id', retryable: false });
      }
      return transport.request<T>({
        method: 'PUT',
        path: `${basePath}/${encodeURIComponent(id)}`,
        body: data,
        ...(options?.idempotencyKey !== undefined
          ? { idempotencyKey: options.idempotencyKey }
          : {}),
      });
    },

    async delete(id: string): Promise<void> {
      if (!id || id.trim() === '') {
        throw new ValidationError({ code: 'SDK_INVALID_ARGUMENT', message: '[OnePlatform SDK] entity.delete() requires a non-empty id', retryable: false });
      }
      await transport.request<void>({
        method: 'DELETE',
        path: `${basePath}/${encodeURIComponent(id)}`,
      });
    },

    async bulk(operation: BulkOperation<T>): Promise<BulkResult<T>> {
      return transport.request<BulkResult<T>>({
        method: 'POST',
        path: `${basePath}/bulk`,
        body: operation,
      });
    },
  };
}

/**
 * Namespace for ontology-typed entity CRUD operations.
 *
 * Accessible as `client.data`. Supports two calling styles:
 * - `client.data.entity('Product')` — explicit, works with any string type name
 * - `client.data.Product` — Proxy shorthand, identical behaviour
 */
export interface DataNamespace {
  /**
   * Returns an {@link EntityResource} for the given entity type name.
   *
   * @param entityType - The ontology entity type name (e.g. `'Product'`).
   * @throws {@link ValidationError} when `entityType` is empty.
   *
   * @example
   * ```ts
   * const products = client.data.entity('Product').list();
   * for await (const page of products) {
   *   console.log(page.items);
   * }
   * ```
   */
  entity(entityType: string): EntityResource<Record<string, unknown>>;

  /** Index signature enables generated typed clients to add named accessors. */
  [entityType: string]: EntityResource<Record<string, unknown>> | ((entityType: string) => EntityResource<Record<string, unknown>>);
}

// TODO: Add createTypedClient<T>() factory for typed query methods (M-13)
export function createDataNamespace(transport: Transport): DataNamespace {
  const cache = new Map<string, EntityResource<Record<string, unknown>>>();

  // Use a Proxy so that `client.data.Product` routes through the same factory as
  // `client.data.entity('Product')` without requiring code generation.
  const handler: ProxyHandler<DataNamespace> = {
    get(target, prop: string | symbol): unknown {
      if (prop === 'entity') {
        return target.entity;
      }
      if (typeof prop !== 'string') return undefined;
      // Return the entity resource for any string property access
      const existing = cache.get(prop);
      if (existing !== undefined) return existing;
      const resource = createEntityResource<Record<string, unknown>>(transport, prop);
      cache.set(prop, resource);
      return resource;
    },
  };

  const base: DataNamespace = {
    entity(entityType: string): EntityResource<Record<string, unknown>> {
      if (!entityType || entityType.trim() === '') {
        throw new ValidationError({ code: 'SDK_INVALID_ARGUMENT', message: '[OnePlatform SDK] entity() requires a non-empty entityType name', retryable: false });
      }
      const existing = cache.get(entityType);
      if (existing !== undefined) return existing;
      const resource = createEntityResource<Record<string, unknown>>(transport, entityType);
      cache.set(entityType, resource);
      return resource;
    },
  };

  return new Proxy(base, handler);
}
