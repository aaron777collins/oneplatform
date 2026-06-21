// Row shapes returned from Postgres queries — these mirror the DB columns
// exactly (snake_case) so callers can map to camelCase at the API boundary.

// ---------------------------------------------------------------------------
// Field audit domain types (G-125)
// ---------------------------------------------------------------------------

export interface FieldChangeEntry {
  tenantId: string;
  userId: string;
  entityType: string;
  entityId: string;
  fieldName: string;
  /** undefined means the field is being created (action='create') */
  oldValue?: unknown;
  /** undefined means the field is being deleted (action='delete') */
  newValue?: unknown;
  action: "create" | "update" | "delete";
  /** Where the mutation originated */
  source: "api" | "ui" | "system";
  timestamp: string;
}

export interface FieldAccessEntry {
  tenantId: string;
  userId: string;
  entityType: string;
  entityId: string;
  fieldsAccessed: string[];
  timestamp: string;
  /** Declared purpose — used by GDPR audit queries */
  purpose: "view" | "export" | "api";
}

export interface FieldChangeRow {
  id: string;
  tenant_id: string;
  user_id: string;
  entity_type: string;
  entity_id: string;
  field_name: string;
  old_value: unknown;
  new_value: unknown;
  action: "create" | "update" | "delete";
  source: "api" | "ui" | "system";
  changed_at: Date;
}

export interface FieldAccessRow {
  id: string;
  tenant_id: string;
  user_id: string;
  entity_type: string;
  entity_id: string;
  fields_accessed: string[];
  purpose: "view" | "export" | "api";
  accessed_at: Date;
}

export interface FieldHistoryQueryParams {
  entityType: string;
  entityId: string;
  fieldName?: string;
  userId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

export interface FieldAccessQueryParams {
  entityType: string;
  entityId: string;
  userId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

export interface LogEventRow {
  id: string;
  tenant_id: string;
  trace_id: string;
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface AuditEventRow {
  id: string;
  trace_id: string;
  actor_id: string;
  actor_type: "user" | "service" | "system";
  tenant_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  result: "success" | "failure";
  metadata: Record<string, unknown>;
  created_at: Date;
  archived: boolean;
  job_id: string | null;
}

// ---------------------------------------------------------------------------
// Input types for repository write methods
// ---------------------------------------------------------------------------

export interface CreateLogEventData {
  tenantId: string;
  traceId: string;
  service: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateAuditEventData {
  traceId: string;
  actorId: string;
  actorType: "user" | "service" | "system";
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: "success" | "failure";
  metadata: Record<string, unknown>;
  createdAt: Date;
  /** BullMQ job ID — used for deduplication via unique index */
  jobId: string | null;
}

// ---------------------------------------------------------------------------
// Query parameter types — passed from routes/services to repositories
// ---------------------------------------------------------------------------

export interface LogQueryParams {
  tenantId?: string;
  service?: string;
  level?: "debug" | "info" | "warn" | "error";
  traceId?: string;
  search?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

export interface AuditQueryParams {
  /** Full-text search across the action field and the JSON metadata blob (PA-014). */
  search?: string;
  actorId?: string;
  actorType?: "user" | "service" | "system";
  tenantId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  result?: "success" | "failure";
  /** Inclusive lower bound on created_at. Alias: startDate. */
  from?: string;
  /** Exclusive upper bound on created_at. Alias: endDate. */
  to?: string;
  cursor?: string;
  limit: number;
}
