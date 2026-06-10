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
