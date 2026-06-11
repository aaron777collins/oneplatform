/**
 * client.pipelines namespace — pipeline CRUD and run management.
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

export interface PipelineNamespace {
  list(options?: ListOptions): PaginatedIterable<Pipeline>;
  get(id: string): Promise<Pipeline>;
  create(data: CreatePipelineRequest): Promise<Pipeline>;
  update(id: string, data: UpdatePipelineRequest): Promise<Pipeline>;
  delete(id: string): Promise<void>;
  trigger(id: string, input?: Record<string, unknown>): Promise<PipelineRun>;
  getRun(pipelineId: string, runId: string): Promise<PipelineRun>;
  listRuns(pipelineId: string, options?: ListOptions): PaginatedIterable<PipelineRun>;
  cancelRun(pipelineId: string, runId: string): Promise<PipelineRun>;
  streamRunLogs(pipelineId: string, runId: string): PaginatedIterable<LogEntry>;
}

export function createPipelineNamespace(transport: Transport): PipelineNamespace {
  const BASE = '/api/v1/pipelines';

  return {
    list(options?: ListOptions): PaginatedIterable<Pipeline> {
      const pageSize = options?.limit ?? 50;
      return new Paginator<Pipeline>(async (cursor, limit) => {
        const result = await transport.request<{
          items: Pipeline[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: BASE,
          query: {
            limit,
            ...(cursor !== null ? { cursor } : {}),
            ...(options?.sort !== undefined
              ? { sort: Array.isArray(options.sort) ? options.sort.join(',') : options.sort }
              : {}),
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
      return new Paginator<PipelineRun>(async (cursor, limit) => {
        const result = await transport.request<{
          items: PipelineRun[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: `${BASE}/${encodeURIComponent(pipelineId)}/runs`,
          query: { limit, ...(cursor !== null ? { cursor } : {}) },
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

    streamRunLogs(pipelineId: string, runId: string): PaginatedIterable<LogEntry> {
      return new Paginator<LogEntry>(async (cursor, limit) => {
        const result = await transport.request<{
          items: LogEntry[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: `${BASE}/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}/logs`,
          query: { limit, ...(cursor !== null ? { cursor } : {}) },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      });
    },
  };
}
