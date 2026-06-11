/**
 * client.logs namespace — log queries and audit trail.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { LogQueryOptions, TailOptions, AuditQueryOptions } from '../types/resources.js';
import type { LogEntry, AuditEntry } from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';

export interface LogNamespace {
  query(options: LogQueryOptions): PaginatedIterable<LogEntry>;
  tail(options?: TailOptions): PaginatedIterable<LogEntry>;
  queryAudit(options: AuditQueryOptions): PaginatedIterable<AuditEntry>;
}

function buildLogQuery(
  options: LogQueryOptions | TailOptions,
): Record<string, string | number | boolean | undefined> {
  const q: Record<string, string | number | boolean | undefined> = {};
  if ('from' in options && options.from !== undefined) q['from'] = options.from;
  if ('to' in options && options.to !== undefined) q['to'] = options.to;
  if (options.service !== undefined) q['service'] = options.service;
  if (options.level !== undefined) q['level'] = options.level;
  if ('limit' in options && options.limit !== undefined) q['limit'] = options.limit;
  return q;
}

export function createLogNamespace(transport: Transport): LogNamespace {
  return {
    query(options: LogQueryOptions): PaginatedIterable<LogEntry> {
      const pageSize = options.limit ?? 50;
      const baseQuery = buildLogQuery(options);
      return new Paginator<LogEntry>(async (cursor, limit) => {
        const result = await transport.request<{
          items: LogEntry[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: '/api/v1/logs',
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      }, pageSize);
    },

    tail(options?: TailOptions): PaginatedIterable<LogEntry> {
      const baseQuery = options !== undefined ? buildLogQuery(options) : {};
      return new Paginator<LogEntry>(async (cursor, limit) => {
        const result = await transport.request<{
          items: LogEntry[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: '/api/v1/logs/tail',
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      });
    },

    queryAudit(options: AuditQueryOptions): PaginatedIterable<AuditEntry> {
      const pageSize = options.limit ?? 50;
      const baseQuery: Record<string, string | number | boolean | undefined> = {};
      if (options.from !== undefined) baseQuery['from'] = options.from;
      if (options.to !== undefined) baseQuery['to'] = options.to;
      if (options.actorId !== undefined) baseQuery['actorId'] = options.actorId;
      if (options.resourceType !== undefined) baseQuery['resourceType'] = options.resourceType;
      if (options.limit !== undefined) baseQuery['limit'] = options.limit;

      return new Paginator<AuditEntry>(async (cursor, limit) => {
        const result = await transport.request<{
          items: AuditEntry[];
          nextCursor: string | null;
          total: number | null;
        }>({
          method: 'GET',
          path: '/api/v1/logs/audit',
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return { ...result, hasMore: result.nextCursor !== null };
      }, pageSize);
    },
  };
}
