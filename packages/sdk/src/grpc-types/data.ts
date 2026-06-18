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
