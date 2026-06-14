/**
 * client.apiKeys namespace — API key lifecycle management.
 *
 * Note: create() and rotate() return a CreatedApiKey with the full key value.
 * The key is returned exactly once — store it securely.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type { ApiKey, CreatedApiKey, CreateApiKeyRequest } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';

/**
 * Namespace for API key lifecycle management.
 *
 * Accessible as `client.apiKeys`.
 *
 * **Security:** `create()` and `rotate()` return a {@link CreatedApiKey} that
 * contains the full key value. The secret is returned exactly once — store it
 * in a secrets manager immediately.
 */
export interface ApiKeyNamespace {
  /** Lists all API keys for the tenant (secrets are never included in list responses). */
  list(options?: ListOptions): PaginatedIterable<ApiKey>;

  /**
   * Creates a new API key.
   *
   * @returns A {@link CreatedApiKey} containing the plaintext secret. Store it immediately.
   */
  create(data: CreateApiKeyRequest): Promise<CreatedApiKey>;

  /**
   * Permanently revokes an API key. Any request authenticated with it will
   * receive 401 after revocation.
   */
  revoke(id: string): Promise<void>;

  /**
   * Replaces an existing key with a freshly generated one.
   *
   * @returns A {@link CreatedApiKey} containing the new plaintext secret.
   */
  rotate(id: string): Promise<CreatedApiKey>;
}

export function createApiKeyNamespace(transport: Transport): ApiKeyNamespace {
  const BASE = '/api/v1/api-keys';

  return {
    list(options?: ListOptions): PaginatedIterable<ApiKey> {
      const pageSize = options?.limit ?? 50;
      return new Paginator<ApiKey>(async (cursor, limit) => {
        const result = await transport.request<{
          items: ApiKey[];
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

    async create(data: CreateApiKeyRequest): Promise<CreatedApiKey> {
      return transport.request<CreatedApiKey>({ method: 'POST', path: BASE, body: data });
    },

    async revoke(id: string): Promise<void> {
      await transport.request<void>({
        method: 'DELETE',
        path: `${BASE}/${encodeURIComponent(id)}`,
      });
    },

    async rotate(id: string): Promise<CreatedApiKey> {
      return transport.request<CreatedApiKey>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(id)}/rotate`,
      });
    },
  };
}
