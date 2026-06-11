/**
 * client.apps namespace — application management.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type { App, CreateAppRequest, UpdateAppRequest } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';

export interface AppNamespace {
  list(options?: ListOptions): PaginatedIterable<App>;
  get(id: string): Promise<App>;
  create(data: CreateAppRequest): Promise<App>;
  update(id: string, data: UpdateAppRequest): Promise<App>;
  delete(id: string): Promise<void>;
}

export function createAppNamespace(transport: Transport): AppNamespace {
  const BASE = '/api/v1/apps';

  return {
    list(options?: ListOptions): PaginatedIterable<App> {
      const pageSize = options?.limit ?? 50;
      return new Paginator<App>(async (cursor, limit) => {
        const result = await transport.request<{
          items: App[];
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

    async get(id: string): Promise<App> {
      return transport.request<App>({ method: 'GET', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async create(data: CreateAppRequest): Promise<App> {
      return transport.request<App>({ method: 'POST', path: BASE, body: data });
    },

    async update(id: string, data: UpdateAppRequest): Promise<App> {
      return transport.request<App>({
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
