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
 * - `client.data.entity('Product')` — explicit method, works with any string type name
 * - `client.data.Product` — Proxy shorthand, identical runtime behaviour
 *
 * ## Typed access with generics
 *
 * Both styles accept a TypeScript generic `<T>` so you can pass your own interface:
 *
 * ```ts
 * interface Product {
 *   id: string;
 *   name: string;
 *   price: number;
 * }
 *
 * // Explicit form — cast to EntityResource<Product>
 * const products = client.data.entity('Product') as EntityResource<Product>;
 * const page = await products.list().next();
 * // page.value.items is Product[]
 *
 * // Proxy shorthand — works identically at runtime
 * const product = await (client.data.Product as EntityResource<Product>).get('prod-1');
 * // product is typed as Product
 * ```
 *
 * ## Generated typed clients (recommended for large codebases)
 *
 * Run `op sdk generate-types` to generate `op-types.d.ts` from your ontology schema.
 * The generated file augments `EntityTypeMap` so the Proxy shorthand is fully typed
 * without any casting:
 *
 * ```ts
 * // After adding op-types.d.ts to your tsconfig "include":
 * import type { EntityTypeMap } from '@oneplatform/app-sdk';
 * import type { DataNamespace } from '@oneplatform/sdk';
 *
 * // Helper type to access a typed resource from the namespace
 * type TypedEntity<K extends keyof EntityTypeMap> = EntityResource<EntityTypeMap[K]>;
 *
 * const products = client.data.entity('Product') as TypedEntity<'Product'>;
 * const list = await products.list().next();
 * // list.value.items is EntityTypeMap['Product'][]
 * ```
 *
 * ## Current limitation
 *
 * The Proxy shorthand (`client.data.Product`) returns `EntityResource<Record<string,unknown>>`
 * in the TypeScript type system because the index signature cannot be parameterised on
 * the string key. Cast the result to `EntityResource<YourType>` or use the `entity()`
 * method with a type assertion. Full mapped-type shorthand support is tracked in M-13.
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
   * // Untyped — fields are Record<string, unknown>
   * const products = client.data.entity('Product').list();
   * for await (const page of products) {
   *   console.log(page.items);
   * }
   *
   * // Typed — cast the result to your interface
   * interface Product { id: string; name: string; price: number }
   * const typed = client.data.entity('Product') as EntityResource<Product>;
   * const product = await typed.get('prod-1');
   * // product.price is typed as number
   * ```
   */
  entity(entityType: string): EntityResource<Record<string, unknown>>;

  /**
   * Index signature that enables the Proxy shorthand `client.data.Product`.
   *
   * TypeScript cannot parameterise the return type on the string key, so the
   * Proxy shorthand always returns `EntityResource<Record<string,unknown>>`.
   * Cast to `EntityResource<YourType>` when you need type safety. See the
   * DataNamespace JSDoc for a full typed-client example.
   */
  [entityType: string]: EntityResource<Record<string, unknown>> | ((entityType: string) => EntityResource<Record<string, unknown>>);
}

// TODO: Add createTypedClient<T>() factory for typed query methods (M-13)
export function createDataNamespace(transport: Transport): DataNamespace {
  const cache = new Map<string, EntityResource<Record<string, unknown>>>();

  // Built-in JavaScript property names that must not be treated as entity type names.
  // '.then' is particularly critical: a thenable Proxy causes `await client.data` to
  // attempt to call client.data.then() as a function, producing a confusing error.
  // Constructor, toJSON, toString etc. are included to avoid breaking debugging tools.
  const RESERVED_PROPERTIES = new Set([
    'then', 'catch', 'finally',              // Promise protocol — must not be thenables
    'constructor', 'toString', 'toJSON',     // Object built-ins
    'valueOf', 'toLocaleString', 'hasOwnProperty',
    'isPrototypeOf', 'propertyIsEnumerable',
    Symbol.toPrimitive, Symbol.toStringTag, Symbol.iterator,
  ]);

  // Use a Proxy so that `client.data.Product` routes through the same factory as
  // `client.data.entity('Product')` without requiring code generation.
  const handler: ProxyHandler<DataNamespace> = {
    get(target, prop: string | symbol): unknown {
      if (prop === 'entity') {
        return target.entity;
      }
      // Pass through reserved built-in properties to avoid breaking Promise semantics,
      // debugging tools, and JSON serialization. Without this guard, `await client.data`
      // would try to call client.data.then() as a function and throw a type error.
      if (RESERVED_PROPERTIES.has(prop)) {
        return (target as unknown as Record<string | symbol, unknown>)[prop];
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
