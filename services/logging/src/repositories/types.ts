// Row shapes returned from Postgres queries — these mirror the DB columns
// exactly (snake_case) so callers can map to camelCase at the API boundary.

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
  actorId?: string;
  actorType?: "user" | "service" | "system";
  tenantId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  result?: "success" | "failure";
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}
