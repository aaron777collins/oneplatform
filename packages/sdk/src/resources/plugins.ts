/**
 * client.plugins namespace — plugin lifecycle management.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type { Plugin, CreatePluginRequest, UpdatePluginRequest } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';

export interface PluginNamespace {
  list(options?: ListOptions): PaginatedIterable<Plugin>;
  get(id: string): Promise<Plugin>;
  create(data: CreatePluginRequest): Promise<Plugin>;
  update(id: string, data: UpdatePluginRequest): Promise<Plugin>;
  delete(id: string): Promise<void>;
}

export function createPluginNamespace(transport: Transport): PluginNamespace {
  const BASE = '/api/v1/plugins';

  return {
    list(options?: ListOptions): PaginatedIterable<Plugin> {
      const pageSize = options?.limit ?? 50;
      return new Paginator<Plugin>(async (cursor, limit) => {
        const result = await transport.request<{
          items: Plugin[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: BASE,
          query: { limit, ...(cursor !== null ? { cursor } : {}) },
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
