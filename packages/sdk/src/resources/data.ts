/**
 * client.data namespace — ontology-typed entity CRUD.
 *
 * Each entity type is accessed as client.data.entity('Product').list()
 * or, with generated typed clients, as client.data.Product.list().
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions, GetOptions, MutationOptions } from '../types/resources.js';
import type { FilterBuilder } from '../filter-builder/filter-builder.js';
import type { BulkOperation, BulkResult } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';

function serializeListQuery(
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
    if (typeof options.filter === 'object' && typeof (options.filter as FilterBuilder).toParams === 'function') {
      filterParams = (options.filter as FilterBuilder).toParams();
    } else {
      filterParams = options.filter as Record<string, string>;
    }
  }

  return { ...query, ...filterParams } as Record<string, string | string[] | number | boolean | undefined>;
}

export interface EntityResource<T> {
  list(options?: ListOptions): PaginatedIterable<T>;
  get(id: string, options?: GetOptions): Promise<T>;
  create(data: Partial<T>, options?: MutationOptions): Promise<T>;
  update(id: string, data: Partial<T>, options?: MutationOptions): Promise<T>;
  replace(id: string, data: T, options?: MutationOptions): Promise<T>;
  delete(id: string): Promise<void>;
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
        throw new Error('[OnePlatform SDK] entity.get() requires a non-empty id');
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
        throw new Error('[OnePlatform SDK] entity.update() requires a non-empty id');
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
        throw new Error('[OnePlatform SDK] entity.replace() requires a non-empty id');
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
        throw new Error('[OnePlatform SDK] entity.delete() requires a non-empty id');
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

export interface DataNamespace {
  /**
   * Access a typed entity resource by entity type name.
   * Example: client.data.entity('Product').list()
   */
  entity(entityType: string): EntityResource<Record<string, unknown>>;

  /** Index signature enables generated typed clients to add named accessors. */
  [entityType: string]: EntityResource<Record<string, unknown>> | ((entityType: string) => EntityResource<Record<string, unknown>>);
}

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
        throw new Error('[OnePlatform SDK] entity() requires a non-empty entityType name');
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
