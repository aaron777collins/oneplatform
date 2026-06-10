// Database row shapes for the ingestion schema.
// Column names mirror the SQL schema in the L2 design §2 exactly — no
// transformation, so repository methods can return them directly.
// Row types use `Date` for timestamptz and `string` for uuid (pg driver behaviour).

// ---------------------------------------------------------------------------
// ingestion.connectors
// ---------------------------------------------------------------------------

export interface ConnectorRow {
  id: string;
  tenant_id: string;
  plugin_id: string;
  instance_id: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  sync_mode: "full" | "incremental";
  schedule_cron: string | null;
  is_enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

// ---------------------------------------------------------------------------
// ingestion.credentials
// ---------------------------------------------------------------------------

export interface CredentialRow {
  id: string;
  connector_id: string;
  field_name: string;
  encrypted_blob: string;
  key_version: number;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// ingestion.sync_state
// ---------------------------------------------------------------------------

export interface SyncStateRow {
  connector_id: string;
  last_cursor: string | null;
  last_sync_at: Date | null;
  last_sync_job_id: string | null;
  sync_mode: "full" | "incremental";
  status: "never_run" | "running" | "success" | "failed" | "cancelled";
  last_error: string | null;
  last_error_code: string | null;
  rows_last_sync: string; // bigint comes back as string from pg driver
  rows_total: string;     // bigint comes back as string from pg driver
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// ingestion.webhook_receivers
// ---------------------------------------------------------------------------

export interface WebhookReceiverRow {
  id: string;
  tenant_id: string;
  connector_id: string | null;
  name: string;
  description: string | null;
  path_suffix: string;
  secret_hash: string;
  hmac_algorithm: "sha256" | "sha512";
  header_name: string;
  is_enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  last_received_at: Date | null;
  events_received: string; // bigint comes back as string from pg driver
}

// ---------------------------------------------------------------------------
// ingestion.upload_jobs
// ---------------------------------------------------------------------------

export interface UploadJobRow {
  id: string;
  tenant_id: string;
  connector_id: string | null;
  filename: string;
  content_type: string;
  file_size_bytes: string | null; // bigint comes back as string from pg driver
  minio_key: string | null;
  status: "pending" | "uploading" | "parsing" | "staging" | "complete" | "failed";
  rows_parsed: string;  // bigint comes back as string from pg driver
  rows_staged: string;  // bigint comes back as string from pg driver
  rows_failed: string;  // bigint comes back as string from pg driver
  error: string | null;
  inferred_schema: Record<string, unknown> | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

// ---------------------------------------------------------------------------
// Input types — create operations
// ---------------------------------------------------------------------------

export interface CreateConnectorData {
  tenant_id: string;
  plugin_id: string;
  instance_id: string;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  sync_mode?: "full" | "incremental";
  schedule_cron?: string;
  is_enabled?: boolean;
  created_by: string;
}

export interface UpdateConnectorData {
  name?: string;
  // null explicitly clears description; undefined means do not touch it
  description?: string | null;
  config?: Record<string, unknown>;
  sync_mode?: "full" | "incremental";
  // null explicitly clears schedule_cron; undefined means do not touch it
  schedule_cron?: string | null;
  is_enabled?: boolean;
}

export interface CreateCredentialData {
  connector_id: string;
  field_name: string;
  encrypted_blob: string;
  key_version: number;
}

export interface CreateWebhookReceiverData {
  tenant_id: string;
  connector_id?: string;
  name: string;
  description?: string;
  path_suffix: string;
  secret_hash: string;
  hmac_algorithm?: "sha256" | "sha512";
  header_name?: string;
  is_enabled?: boolean;
  created_by: string;
}

export interface UpdateWebhookReceiverData {
  name?: string;
  // null explicitly clears description; undefined means do not touch it
  description?: string | null;
  // null explicitly clears connector_id (unlink); undefined means do not touch it
  connector_id?: string | null;
  hmac_algorithm?: "sha256" | "sha512";
  header_name?: string;
  is_enabled?: boolean;
  // For secret rotation: both fields must be updated together
  secret_hash?: string;
}

export interface CreateUploadJobData {
  tenant_id: string;
  connector_id?: string;
  filename: string;
  content_type: string;
  file_size_bytes?: number;
  minio_key?: string;
  status?: "pending" | "uploading" | "parsing" | "staging" | "complete" | "failed";
  created_by: string;
}

export interface UpdateUploadJobData {
  status?: "pending" | "uploading" | "parsing" | "staging" | "complete" | "failed";
  file_size_bytes?: number;
  minio_key?: string;
  rows_parsed?: number;
  rows_staged?: number;
  rows_failed?: number;
  error?: string | null;
  inferred_schema?: Record<string, unknown>;
  completed_at?: Date;
}
