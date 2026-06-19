/**
 * client.ontologies namespace — ontology schema management.
 *
 * Accessible as `client.ontologies`. Ontologies define the entity types,
 * fields, and relationships that structure data in the platform.
 *
 * Canonical API base path: /api/v1/ontology (singular, matching the service routes).
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
import { ConfigurationError } from '../errors/client-errors.js';
import { serializeListQuery } from './list-query.js';

/**
 * Namespace for ontology schema management.
 *
 * Accessible as `client.ontologies`.
 */
export interface OntologyNamespace {
  /** Lists all ontology schemas for the tenant. */
  list(options?: ListOptions): PaginatedIterable<OntologySchema>;
  /** Fetches a single schema by ID. */
  get(id: string): Promise<OntologySchema>;
  /** Creates a new ontology schema. */
  create(data: CreateOntologyRequest): Promise<OntologySchema>;
  /** Updates an existing schema (adding or modifying fields). */
  update(id: string, data: UpdateOntologyRequest): Promise<OntologySchema>;
  /** Deletes a schema. Fails if any connector or pipeline references it. */
  delete(id: string): Promise<void>;

  /**
   * Validates a proposed schema change without persisting it.
   *
   * @returns A {@link ValidationResult} listing any constraint violations.
   */
  validate(data: ValidateOntologyRequest): Promise<ValidationResult>;
  /**
   * @deprecated Use `diff(entityTypeId, proposedSchema)` instead.
   * Will be removed in SDK v1.0.
   *
   * @param fromVersion - The base version identifier.
   * @param toVersion   - The target version identifier.
   */
  diff(fromVersion: string, toVersion: string): Promise<OntologyDiff>;

  /**
   * Computes a non-destructive field-level diff of `proposedSchema` against the
   * live entity schema.
   *
   * @param entityTypeId   - The entity type to diff against.
   * @param proposedSchema - The proposed schema changes.
   */
  diff(entityTypeId: string, proposedSchema: UpdateOntologyRequest): Promise<OntologyDiff>;

  /**
   * Returns the status of the background migration job triggered by a schema update.
   *
   * Poll until `status === 'complete'` or `status === 'failed'`.
   */
  getMigrationStatus(id: string): Promise<MigrationStatus>;
}

export function createOntologyNamespace(transport: Transport): OntologyNamespace {
  // Canonical path matches the service route definitions (singular, no /entities suffix).
  const BASE = '/api/v1/ontology';

  return {
    list(options?: ListOptions): PaginatedIterable<OntologySchema> {
      const pageSize = options?.limit ?? 50;
      const baseQuery = serializeListQuery(options);
      return new Paginator<OntologySchema>(async (cursor, limit) => {
        // The transport unwraps the top-level { data: T } envelope automatically.
        // The service returns { data: { items, nextCursor, total, hasMore } } so
        // the transport unwraps the outer data key and the callback receives the
        // inner object directly — matching the PageFetcher<T> contract exactly.
        const result = await transport.request<{
          items: OntologySchema[];
          nextCursor: string | null;
          total: number | null;
          hasMore: boolean;
        }>({
          method: 'GET',
          path: BASE,
          query: {
            ...baseQuery,
            limit,
            ...(cursor !== null ? { cursor } : {}),
          },
        });
        return result;
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

    async diff(entityTypeIdOrFromVersion: string, proposedSchemaOrToVersion: UpdateOntologyRequest | string): Promise<OntologyDiff> {
      // The old GET-based signature diff(fromVersion, toVersion) had no service
      // endpoint and never worked. It is preserved here only for compile-time
      // compatibility during the deprecation window — callers that pass two
      // strings receive a descriptive error so they can migrate.
      if (typeof proposedSchemaOrToVersion === 'string') {
        // Two-string signature was never wired to a service endpoint and was
        // removed in the API redesign. Throw ConfigurationError (not
        // ValidationError) because this is a programmer error — the wrong
        // method overload — not bad user input that the caller can retry with
        // corrected field values.
        throw new ConfigurationError(
          '[SDK] diff(fromVersion, toVersion) is deprecated and has no service endpoint. ' +
          'Use diff(entityTypeId, proposedSchema) instead — see SDK CHANGELOG for migration guidance.',
        );
      }
      return transport.request<OntologyDiff>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(entityTypeIdOrFromVersion)}/diff`,
        body: proposedSchemaOrToVersion,
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
