/**
 * client.users namespace — user management (admin-only operations).
 *
 * Accessible as `client.users`. All methods require an API key or access token
 * with admin scope; requests from end-user sessions are rejected with 403.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type { User, CreateUserRequest, UpdateUserRequest } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';
import { serializeListQuery } from './list-query.js';

/**
 * Namespace for user account management (admin-only).
 *
 * Accessible as `client.users`.
 */
export interface UserNamespace {
  /** Lists all users in the tenant. */
  list(options?: ListOptions): PaginatedIterable<User>;
  /** Fetches a single user by ID or email. */
  get(id: string): Promise<User>;
  /** Provisions a new user account and sends an invitation email. */
  create(data: CreateUserRequest): Promise<User>;
  /** Updates user profile fields or role assignments. */
  update(id: string, data: UpdateUserRequest): Promise<User>;
  /** Permanently deletes a user account. */
  delete(id: string): Promise<void>;
}

export function createUserNamespace(transport: Transport): UserNamespace {
  const BASE = '/api/v1/users';

  return {
    list(options?: ListOptions): PaginatedIterable<User> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);
      return new Paginator<User>(async (cursor, limit) => {
        const result = await transport.request<{
          items: User[];
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
