/**
 * client.users namespace — user management (admin-only operations).
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type { User, CreateUserRequest, UpdateUserRequest } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';

export interface UserNamespace {
  list(options?: ListOptions): PaginatedIterable<User>;
  get(id: string): Promise<User>;
  create(data: CreateUserRequest): Promise<User>;
  update(id: string, data: UpdateUserRequest): Promise<User>;
  delete(id: string): Promise<void>;
}

export function createUserNamespace(transport: Transport): UserNamespace {
  const BASE = '/api/v1/users';

  return {
    list(options?: ListOptions): PaginatedIterable<User> {
      const pageSize = options?.limit ?? 50;
      return new Paginator<User>(async (cursor, limit) => {
        const result = await transport.request<{
          items: User[];
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

    async get(id: string): Promise<User> {
      return transport.request<User>({ method: 'GET', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async create(data: CreateUserRequest): Promise<User> {
      return transport.request<User>({ method: 'POST', path: BASE, body: data });
    },

    async update(id: string, data: UpdateUserRequest): Promise<User> {
      return transport.request<User>({
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
