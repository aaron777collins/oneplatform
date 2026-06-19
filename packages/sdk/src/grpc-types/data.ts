// AUTO-GENERATED — do not edit by hand.
// Source: data.proto
// Package: oneplatform.v1
// Re-run tools/proto-gen/src/generate.ts to regenerate.

export interface Entity {
  id: string;
  entityType: string;
  tenantId: string;
  dataJson: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Returns the parsed `dataJson` field of an {@link Entity} as a typed object.
 *
 * Caches the parsed result on the entity instance so subsequent calls avoid
 * redundant JSON.parse() overhead.
 *
 * @param entity - A gRPC Entity whose `dataJson` field contains serialised JSON.
 * @returns The parsed data object, typed as `T`.
 *
 * @example
 * ```ts
 * const entity = await grpc.data.GetEntity({ entityType: 'Product', id: '1', tenantId: 't1' });
 * const product = parseEntityData<Product>(entity);
 * ```
 */
export function parseEntityData<T = Record<string, unknown>>(entity: Entity): T {
  // Cache parsed result on the entity to avoid repeated parsing
  const cacheKey = '__parsedData';
  const entityAny = entity as unknown as Record<string, unknown>;
  const cached = entityAny[cacheKey];
  if (cached !== undefined) return cached as T;

  const parsed = JSON.parse(entity.dataJson) as T;
  entityAny[cacheKey] = parsed;
  return parsed;
}

export interface GetEntityRequest {
  entityType: string;
  id: string;
  tenantId: string;
}

export interface ListEntitiesRequest {
  entityType: string;
  tenantId: string;
  pageSize: number;
  pageCursor: string;
  filterJson: string;
}

export interface ListEntitiesResponse {
  items: Entity[];
  nextCursor: string;
  total: number;
}

export interface CreateEntityRequest {
  entityType: string;
  tenantId: string;
  dataJson: string;
}

export interface UpdateEntityRequest {
  entityType: string;
  id: string;
  tenantId: string;
  dataJson: string;
}

export interface DeleteEntityRequest {
  entityType: string;
  id: string;
  tenantId: string;
}

export interface DeleteEntityResponse {
  success: boolean;
  id: string;
}

export interface StreamEntitiesRequest {
  entityType: string;
  tenantId: string;
  filterJson: string;
  limit: number;
}

export interface IngestRecord {
  connectorId: string;
  tenantId: string;
  dataJson: string;
  externalId: string;
}

export interface BulkIngestResponse {
  accepted: number;
  rejected: number;
  errors: IngestError[];
}

export interface IngestError {
  recordIndex: number;
  code: string;
  message: string;
}
