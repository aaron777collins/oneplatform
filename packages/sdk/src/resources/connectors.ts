/**
 * client.connectors namespace — connector lifecycle management.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type {
  ConnectorInstance,
  CreateConnectorRequest,
  UpdateConnectorRequest,
  ConnectorTestResult,
  PipelineRun,
} from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';

export interface ConnectorNamespace {
  list(options?: ListOptions): PaginatedIterable<ConnectorInstance>;
  get(id: string): Promise<ConnectorInstance>;
  create(data: CreateConnectorRequest): Promise<ConnectorInstance>;
  update(id: string, data: UpdateConnectorRequest): Promise<ConnectorInstance>;
  delete(id: string): Promise<void>;
  test(id: string): Promise<ConnectorTestResult>;
  trigger(id: string): Promise<PipelineRun>;
}

export function createConnectorNamespace(transport: Transport): ConnectorNamespace {
  const BASE = '/api/v1/connectors';

  return {
    list(options?: ListOptions): PaginatedIterable<ConnectorInstance> {
      const pageSize = options?.limit ?? 50;
      return new Paginator<ConnectorInstance>(async (cursor, limit) => {
        const result = await transport.request<{
          items: ConnectorInstance[];
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

    async get(id: string): Promise<ConnectorInstance> {
      return transport.request<ConnectorInstance>({ method: 'GET', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async create(data: CreateConnectorRequest): Promise<ConnectorInstance> {
      return transport.request<ConnectorInstance>({ method: 'POST', path: BASE, body: data });
    },

    async update(id: string, data: UpdateConnectorRequest): Promise<ConnectorInstance> {
      return transport.request<ConnectorInstance>({
        method: 'PATCH',
        path: `${BASE}/${encodeURIComponent(id)}`,
        body: data,
      });
    },

    async delete(id: string): Promise<void> {
      await transport.request<void>({ method: 'DELETE', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async test(id: string): Promise<ConnectorTestResult> {
      return transport.request<ConnectorTestResult>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(id)}/test`,
      });
    },

    async trigger(id: string): Promise<PipelineRun> {
      return transport.request<PipelineRun>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(id)}/trigger`,
      });
    },
  };
}
