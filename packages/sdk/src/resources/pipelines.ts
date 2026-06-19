/**
 * client.pipelines namespace — pipeline CRUD and run management.
 *
 * Accessible as `client.pipelines`. Pipelines orchestrate multi-step data
 * workflows composed of connectors, transformers, and destinations.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type {
  Pipeline,
  PipelineRun,
  CreatePipelineRequest,
  UpdatePipelineRequest,
  LogEntry,
} from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';
import { serializeListQuery } from './list-query.js';

/**
 * Namespace for pipeline management operations.
 *
 * Accessible as `client.pipelines`.
 */
export interface PipelineNamespace {
  /** Lists all pipelines, newest first. */
  list(options?: ListOptions): PaginatedIterable<Pipeline>;
  /** Fetches a single pipeline by ID or slug. */
  get(id: string): Promise<Pipeline>;
  /** Creates a new pipeline definition. */
  create(data: CreatePipelineRequest): Promise<Pipeline>;
  /** Applies a partial update to an existing pipeline. */
  update(id: string, data: UpdatePipelineRequest): Promise<Pipeline>;
  /** Permanently deletes a pipeline and all its run history. */
  delete(id: string): Promise<void>;

  /**
   * Enqueues an immediate run of the pipeline.
   *
   * @param id - Pipeline ID or slug.
   * @param input - Optional key-value pairs passed to the first step.
   */
  trigger(id: string, input?: Record<string, unknown>): Promise<PipelineRun>;

  /** Fetches a single run record. */
  getRun(pipelineId: string, runId: string): Promise<PipelineRun>;
  /** Lists all runs for a pipeline in reverse-chronological order. */
  listRuns(pipelineId: string, options?: ListOptions): PaginatedIterable<PipelineRun>;

  /**
   * Requests cancellation of an in-progress run.
   *
   * Returns the updated run record; status transitions asynchronously to
   * `cancelled` once the currently executing step finishes.
   */
  cancelRun(pipelineId: string, runId: string): Promise<PipelineRun>;

  /**
   * Streams log lines for a run in cursor-paginated pages.
   *
   * @param pipelineId - Pipeline ID or slug.
   * @param runId      - Run ID.
   * @param options    - Optional list options (limit, filter, sort).
   */
  streamRunLogs(pipelineId: string, runId: string, options?: ListOptions): PaginatedIterable<LogEntry>;
}

export function createPipelineNamespace(transport: Transport): PipelineNamespace {
  const BASE = '/api/v1/pipelines';

  return {
    list(options?: ListOptions): PaginatedIterable<Pipeline> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);
      return new Paginator<Pipeline>(async (cursor, limit) => {
        const result = await transport.request<{
          items: Pipeline[];
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

    async get(id: string): Promise<Pipeline> {
      return transport.request<Pipeline>({ method: 'GET', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async create(data: CreatePipelineRequest): Promise<Pipeline> {
      return transport.request<Pipeline>({ method: 'POST', path: BASE, body: data });
    },

    async update(id: string, data: UpdatePipelineRequest): Promise<Pipeline> {
      return transport.request<Pipeline>({
        method: 'PATCH',
        path: `${BASE}/${encodeURIComponent(id)}`,
        body: data,
      });
    },

    async delete(id: string): Promise<void> {
      await transport.request<void>({ method: 'DELETE', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async trigger(id: string, input?: Record<string, unknown>): Promise<PipelineRun> {
      return transport.request<PipelineRun>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(id)}/trigger`,
        body: input ?? {},
      });
    },

    async getRun(pipelineId: string, runId: string): Promise<PipelineRun> {
      return transport.request<PipelineRun>({
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}`,
      });
    },

    listRuns(pipelineId: string, options?: ListOptions): PaginatedIterable<PipelineRun> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);
      return new Paginator<PipelineRun>(async (cursor, limit) => {
        const result = await transport.request<{
          items: PipelineRun[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: `${BASE}/${encodeURIComponent(pipelineId)}/runs`,
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      }, pageSize);
    },

    async cancelRun(pipelineId: string, runId: string): Promise<PipelineRun> {
      return transport.request<PipelineRun>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}/cancel`,
      });
    },

    streamRunLogs(pipelineId: string, runId: string, options?: ListOptions): PaginatedIterable<LogEntry> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);
      return new Paginator<LogEntry>(async (cursor, limit) => {
        const result = await transport.request<{
          items: LogEntry[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: `${BASE}/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}/logs`,
          query: { ...baseQuery, limit, ...(cursor !== null ? { cursor } : {}) },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      }, pageSize);
    },
  };
}
