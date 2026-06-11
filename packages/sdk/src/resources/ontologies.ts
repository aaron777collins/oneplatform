/**
 * client.ontologies namespace — ontology schema management.
 */

import type { Transport } from '../transport.js';
import type { PaginatedIterable } from '../pagination/paginator.js';
import type { ListOptions } from '../types/resources.js';
import type {
  OntologySchema,
  CreateOntologyRequest,
  UpdateOntologyRequest,
  ValidateOntologyRequest,
  ValidationResult,
  OntologyDiff,
  MigrationStatus,
} from './platform-types.js';
import { Paginator } from '../pagination/paginator.js';

export interface OntologyNamespace {
  list(options?: ListOptions): PaginatedIterable<OntologySchema>;
  get(id: string): Promise<OntologySchema>;
  create(data: CreateOntologyRequest): Promise<OntologySchema>;
  update(id: string, data: UpdateOntologyRequest): Promise<OntologySchema>;
  delete(id: string): Promise<void>;
  validate(data: ValidateOntologyRequest): Promise<ValidationResult>;
  diff(fromVersion: string, toVersion: string): Promise<OntologyDiff>;
  getMigrationStatus(id: string): Promise<MigrationStatus>;
}

export function createOntologyNamespace(transport: Transport): OntologyNamespace {
  const BASE = '/api/v1/ontologies';

  return {
    list(options?: ListOptions): PaginatedIterable<OntologySchema> {
      const pageSize = options?.limit ?? 50;
      return new Paginator<OntologySchema>(async (cursor, limit) => {
        const result = await transport.request<{
          items: OntologySchema[];
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

    async get(id: string): Promise<OntologySchema> {
      return transport.request<OntologySchema>({ method: 'GET', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async create(data: CreateOntologyRequest): Promise<OntologySchema> {
      return transport.request<OntologySchema>({ method: 'POST', path: BASE, body: data });
    },

    async update(id: string, data: UpdateOntologyRequest): Promise<OntologySchema> {
      return transport.request<OntologySchema>({
        method: 'PATCH',
        path: `${BASE}/${encodeURIComponent(id)}`,
        body: data,
      });
    },

    async delete(id: string): Promise<void> {
      await transport.request<void>({ method: 'DELETE', path: `${BASE}/${encodeURIComponent(id)}` });
    },

    async validate(data: ValidateOntologyRequest): Promise<ValidationResult> {
      return transport.request<ValidationResult>({ method: 'POST', path: `${BASE}/validate`, body: data });
    },

    async diff(fromVersion: string, toVersion: string): Promise<OntologyDiff> {
      return transport.request<OntologyDiff>({
        method: 'GET',
        path: `${BASE}/diff`,
        query: { from: fromVersion, to: toVersion },
      });
    },

    async getMigrationStatus(id: string): Promise<MigrationStatus> {
      return transport.request<MigrationStatus>({
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(id)}/migration-status`,
      });
    },
  };
}
