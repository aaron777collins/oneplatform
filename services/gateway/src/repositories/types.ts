// Database row shapes for the gateway schema.
// Column names mirror the SQL schema in the L2 design §4 exactly — no
// transformation, so repository methods can return them directly.

// ---------------------------------------------------------------------------
// gateway.webhooks
// ---------------------------------------------------------------------------

export interface WebhookRow {
  id: string;
  tenant_id: string;
  url: string;
  events: string[];
  secret_hash: string;
  secret_encrypted: string;
  description: string | null;
  enabled: boolean;
  custom_headers: Record<string, string> | null;
  consecutive_failures: number;
  throttled_until: Date | null;
  total_deliveries: bigint;
  successful_deliveries: bigint;
  failed_deliveries: bigint;
  last_delivery_at: Date | null;
  last_delivery_status: "success" | "failed" | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// gateway.webhook_deliveries
// ---------------------------------------------------------------------------

export interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  tenant_id: string;
  event_id: string;
  event_type: string;
  delivery_id: string;
  attempt: number;
  requested_at: Date;
  responded_at: Date | null;
  status_code: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  // Generated column — always present on read; omitted on INSERT
  success: boolean;
}

// ---------------------------------------------------------------------------
// gateway.rate_limit_config
// ---------------------------------------------------------------------------

export interface RateLimitConfigRow {
  id: string;
  tenant_id: string;
  tier_name: "standard" | "pro" | "enterprise" | "custom";
  req_per_min_tenant: number | null;
  req_per_min_api_key: number | null;
  burst_multiplier: number | null;
  burst_duration_sec: number | null;
  api_key_overrides: Record<string, { req_per_min: number }> | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// gateway.usage_events
// ---------------------------------------------------------------------------

export type UsageEventType =
  | "api_call"
  | "rows_ingested"
  | "rows_transformed"
  | "storage_delta"
  | "pipeline_execution";

export type UsagePeriodType = "hourly" | "daily" | "monthly";

export interface UsageEventRow {
  id: string;
  tenant_id: string;
  type: UsageEventType;
  value: bigint;
  metadata: Record<string, string> | null;
  timestamp: Date;
}

export interface CreateUsageEventData {
  tenant_id: string;
  type: UsageEventType;
  value: number;
  metadata?: Record<string, string>;
  timestamp?: Date;
}

// ---------------------------------------------------------------------------
// gateway.usage_summaries
// ---------------------------------------------------------------------------

export interface UsageSummaryRow {
  id: string;
  tenant_id: string;
  period_type: UsagePeriodType;
  period_start: Date;
  event_type: UsageEventType;
  total_value: bigint;
  event_count: bigint;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// gateway.billing_webhook_configs
// ---------------------------------------------------------------------------

export type BillingWebhookProvider = "stripe" | "custom";

export interface BillingWebhookConfigRow {
  id: string;
  tenant_id: string;
  url: string;
  provider: BillingWebhookProvider;
  api_call_threshold: bigint | null;
  rows_ingested_threshold: bigint | null;
  storage_bytes_threshold: bigint | null;
  secret_encrypted: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertBillingWebhookConfigData {
  tenant_id: string;
  url: string;
  provider?: BillingWebhookProvider;
  api_call_threshold?: number | null;
  rows_ingested_threshold?: number | null;
  storage_bytes_threshold?: number | null;
  secret_encrypted?: string | null;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// gateway.gdpr_requests
// ---------------------------------------------------------------------------

export type GdprRequestType = "access" | "deletion" | "export";
export type GdprRequestStatus = "pending" | "processing" | "completed" | "failed";

export interface GdprRequestRow {
  id: string;
  tenant_id: string;
  user_id: string;
  type: GdprRequestType;
  status: GdprRequestStatus;
  requester_id: string;
  requested_at: Date;
  completed_at: Date | null;
  result_url: string | null;
  error_detail: string | null;
}

export interface CreateGdprRequestData {
  tenant_id: string;
  user_id: string;
  type: GdprRequestType;
  requester_id: string;
}

export interface UpdateGdprRequestData {
  status: GdprRequestStatus;
  completed_at?: Date;
  result_url?: string;
  error_detail?: string;
}

// ---------------------------------------------------------------------------
// Input shapes for create / update operations
// ---------------------------------------------------------------------------

export interface CreateWebhookData {
  tenant_id: string;
  url: string;
  events: string[];
  secret_hash: string;
  secret_encrypted: string;
  description?: string;
  enabled?: boolean;
  custom_headers?: Record<string, string>;
}

export interface UpdateWebhookData {
  url?: string;
  events?: string[];
  // Rotating the secret re-derives both fields together.
  secret_hash?: string;
  secret_encrypted?: string;
  // null explicitly clears the column; undefined means do not touch it
  description?: string | null;
  enabled?: boolean;
  custom_headers?: Record<string, string> | null;
}

// ---------------------------------------------------------------------------
// gateway.data_residency_policies
// ---------------------------------------------------------------------------

export type DataRegion =
  | "US_EAST"
  | "US_WEST"
  | "EU_WEST"
  | "EU_CENTRAL"
  | "AP_SOUTHEAST"
  | "AP_NORTHEAST";

export type StorageClass = "standard" | "reduced_redundancy" | "archive";

export type ReplicationPolicy = "single_region" | "multi_az" | "cross_region_backup";

export interface DataResidencyPolicyRow {
  id: string;
  tenant_id: string;
  region: DataRegion;
  storage_class: StorageClass;
  replication_policy: ReplicationPolicy;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertDataResidencyPolicyData {
  tenant_id: string;
  region: DataRegion;
  storage_class?: StorageClass;
  replication_policy?: ReplicationPolicy;
}

// ---------------------------------------------------------------------------
// gateway.data_transfer_rules
// ---------------------------------------------------------------------------

export type TransferPolicy = "allow" | "deny" | "audit";

export interface DataTransferRuleRow {
  id: string;
  source_region: DataRegion;
  target_region: DataRegion;
  policy: TransferPolicy;
  justification_required: boolean;
  created_at: Date;
}

export interface CreateDataTransferRuleData {
  source_region: DataRegion;
  target_region: DataRegion;
  policy: TransferPolicy;
  justification_required?: boolean;
}

// ---------------------------------------------------------------------------
// gateway.data_location_log
// ---------------------------------------------------------------------------

export interface DataLocationLogRow {
  id: string;
  record_id: string;
  tenant_id: string;
  region: DataRegion;
  service: string;
  operation: string;
  actor_id: string | null;
  metadata: Record<string, unknown> | null;
  timestamp: Date;
}

export interface CreateDataLocationLogData {
  record_id: string;
  tenant_id: string;
  region: DataRegion;
  service: string;
  operation?: string;
  actor_id?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Input shapes for create / update operations
// ---------------------------------------------------------------------------

export interface CreateWebhookDeliveryData {
  webhook_id: string;
  tenant_id: string;
  event_id: string;
  event_type: string;
  delivery_id: string;
  attempt: number;
  responded_at?: Date;
  status_code?: number;
  response_body?: string;
  error?: string;
  duration_ms?: number;
}
