// AUTO-GENERATED — do not edit by hand.
// Source: ingestion.proto
// Package: oneplatform.v1
// Re-run tools/proto-gen/src/generate.ts to regenerate.

export interface TriggerSyncRequest {
  connectorId: string;
  tenantId: string;
  syncMode: string;
  force: boolean;
}

export interface TriggerSyncResponse {
  syncJobId: string;
  status: string;
  estimatedStartMs: number;
}

export interface GetSyncStatusRequest {
  syncJobId: string;
}

export interface SyncStatus {
  syncJobId: string;
  connectorId: string;
  tenantId: string;
  status: string;
  syncMode: string;
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  totalRecords: number;
  processedRecords: number;
  startedAt: string;
  completedAt: string;
  lastBatchAt: string;
  errors: SyncError[];
}

export interface SyncError {
  batchId: string;
  message: string;
  code: string;
  recordCount: number;
}

export interface StreamSyncEventsRequest {
  syncJobId: string;
  heartbeatIntervalMs: number;
}

export interface SyncEvent {
  eventType: string;
  status: SyncStatus;
  emittedAt: string;
}
