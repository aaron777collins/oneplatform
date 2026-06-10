import { v5 as uuidv5 } from "uuid";

export interface DataEnvelope {
  _id: string;
  _source: string;
  _ingested_at: string;
  _connector_id: string;
  _batch_id: string;
  _tenant_id: string;
  _sync_mode: "full" | "incremental";
  _cursor: string | null;
  _source_id: string;
  data: Record<string, unknown>;
}

export interface DataRecord {
  sourceId: string;
  data: Record<string, unknown>;
  metadata?: {
    deletedAt?: string;
  };
}

export function deriveEnvelopeId(connectorId: string, sourceId: string): string {
  return uuidv5(sourceId, connectorId);
}

export function normalizeToEnvelope(
  record: DataRecord,
  context: {
    connectorId: string;
    connectorName: string;
    batchId: string;
    tenantId: string;
    syncMode: "full" | "incremental";
    cursor: string | null;
  },
): DataEnvelope {
  return {
    _id: deriveEnvelopeId(context.connectorId, record.sourceId),
    _source: context.connectorName,
    _ingested_at: new Date().toISOString(),
    _connector_id: context.connectorId,
    _batch_id: context.batchId,
    _tenant_id: context.tenantId,
    _sync_mode: context.syncMode,
    _cursor: context.cursor,
    _source_id: record.sourceId,
    data: record.data,
  };
}

export function connectorIdToTableName(connectorId: string): string {
  return `raw_${connectorId.replace(/-/g, "_")}`;
}

const CONNECTOR_ID_PATTERN = /^[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/;

export function validateRawTableName(tableName: string): boolean {
  if (!tableName.startsWith("raw_")) return false;
  const suffix = tableName.slice(4);
  return CONNECTOR_ID_PATTERN.test(suffix);
}
