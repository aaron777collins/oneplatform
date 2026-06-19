/**
 * client.connectors namespace — connector lifecycle management.
 *
 * Accessible as `client.connectors`. Connectors pull data from external systems
 * into OnePlatform and are the source step in most pipelines.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type {
  ConnectorInstance,
  CreateConnectorRequest,
  UpdateConnectorRequest,
  ConnectorTestResult,
  SyncJob,
  SyncProgress,
} from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';
import { serializeListQuery } from './list-query.js';

/**
 * Result returned when triggering a connector sync.
 * Unlike a PipelineRun, this is specific to connector sync operations and
 * contains the sync job ID along with the connector and initial status.
 */
export interface TriggerSyncResult {
  readonly syncJobId: string;
  readonly connectorId: string;
  readonly status: 'queued' | 'running';
  readonly startedAt: string | null;
  readonly message: string;
}

/**
 * Namespace for connector management operations.
 *
 * Accessible as `client.connectors`.
 */
export interface ConnectorNamespace {
  /** Lists all connector instances for the tenant. */
  list(options?: ListOptions): PaginatedIterable<ConnectorInstance>;
  /** Fetches a single connector instance by ID. */
  get(id: string): Promise<ConnectorInstance>;
  /** Registers a new connector instance. */
  create(data: CreateConnectorRequest): Promise<ConnectorInstance>;
  /** Updates connector configuration (credentials, schedule, etc.). */
  update(id: string, data: UpdateConnectorRequest): Promise<ConnectorInstance>;
  /** Deletes a connector instance and stops any scheduled syncs. */
  delete(id: string): Promise<void>;

  /**
   * Validates connectivity to the external system using the stored credentials.
   *
   * @returns A {@link ConnectorTestResult} indicating success or describing the failure.
   */
  test(id: string): Promise<ConnectorTestResult>;

  /**
   * Alias for {@link test}. Returns the connectivity health status of a connector.
   */
  getHealth(id: string): Promise<ConnectorTestResult>;

  /**
   * Enqueues an immediate out-of-schedule sync for the connector.
   *
   * @returns The {@link TriggerSyncResult} describing the queued sync job.
   */
  trigger(id: string): Promise<TriggerSyncResult>;

  /**
   * Alias for {@link trigger}. Enqueues an immediate sync for the connector.
   */
  triggerSync(id: string): Promise<TriggerSyncResult>;

  /** Lists sync jobs for a connector in reverse-chronological order. */
  listSyncs(connectorId: string, options?: ListOptions): PaginatedIterable<SyncJob>;

  /** Returns real-time progress for an in-flight or recently completed sync job. */
  getSyncProgress(connectorId: string, syncJobId: string): Promise<SyncProgress>;
}

export function createConnectorNamespace(transport: Transport): ConnectorNamespace {
  const BASE = '/api/v1/connectors';

  return {
    list(options?: ListOptions): PaginatedIterable<ConnectorInstance> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);
      return new Paginator<ConnectorInstance>(async (cursor, limit) => {
        const result = await transport.request<{
          items: ConnectorInstance[];
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

    async getHealth(id: string): Promise<ConnectorTestResult> {
      return this.test(id);
    },

    async trigger(id: string): Promise<TriggerSyncResult> {
      return transport.request<TriggerSyncResult>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(id)}/trigger`,
      });
    },

    async triggerSync(id: string): Promise<TriggerSyncResult> {
      return this.trigger(id);
    },

    listSyncs(connectorId: string, options?: ListOptions): PaginatedIterable<SyncJob> {
      const pageSize = options?.limit ?? 20;
      const baseQuery = serializeListQuery(options);
      return new Paginator<SyncJob>(async (cursor, limit) => {
        const result = await transport.request<{
          items: SyncJob[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: `${BASE}/${encodeURIComponent(connectorId)}/syncs`,
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      }, pageSize);
    },

    async getSyncProgress(connectorId: string, syncJobId: string): Promise<SyncProgress> {
      return transport.request<SyncProgress>({
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(connectorId)}/syncs/${encodeURIComponent(syncJobId)}/progress`,
      });
    },
  };
}
