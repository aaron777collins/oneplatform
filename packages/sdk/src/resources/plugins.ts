/**
 * client.plugins namespace — plugin lifecycle management.
 *
 * Accessible as `client.plugins`. Plugins extend the platform with connectors,
 * transformers, destinations, auth providers, and widgets.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type { Plugin, CreatePluginRequest, UpdatePluginRequest } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';
import { serializeListQuery } from './list-query.js';

/**
 * Namespace for plugin management operations.
 *
 * Accessible as `client.plugins`.
 */
export interface PluginNamespace {
  /** Lists all installed plugins for the tenant. */
  list(options?: ListOptions): PaginatedIterable<Plugin>;
  /** Fetches a single plugin by ID or slug. */
  get(id: string): Promise<Plugin>;
  /** Installs a new plugin from a registry bundle or URL. */
  create(data: CreatePluginRequest): Promise<Plugin>;
  /** Updates plugin configuration or triggers a version upgrade. */
  update(id: string, data: UpdatePluginRequest): Promise<Plugin>;
  /** Uninstalls a plugin; running connectors using it will fail after deletion. */
  delete(id: string): Promise<void>;
}

export function createPluginNamespace(transport: Transport): PluginNamespace {
  const BASE = '/api/v1/plugins';

  return {
    list(options?: ListOptions): PaginatedIterable<Plugin> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);
      return new Paginator<Plugin>(async (cursor, limit) => {
        const result = await transport.request<{
          items: Plugin[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: BASE,
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      }, pageSize);
    },

    async get(id: string): Promise<Plugin> {
      return transport.request<Plugin>({ method: 'GET', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async create(data: CreatePluginRequest): Promise<Plugin> {
      return transport.request<Plugin>({ method: 'POST', path: BASE, body: data });
    },

    async update(id: string, data: UpdatePluginRequest): Promise<Plugin> {
      return transport.request<Plugin>({
        method: 'PATCH',
        path: `${BASE}/${encodeURIComponent(id)}`,
        body: data,
      });
    },

    async delete(id: string): Promise<void> {
      await transport.request<void>({ method: 'DELETE', path: `${BASE}/${encodeURIComponent(id)}` });
    },
  };
}
