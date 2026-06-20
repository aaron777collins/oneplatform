import type pg from "pg";
import type { RateLimitConfigRow } from "./types.js";

export class RateLimitConfigRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByTenantId(tenantId: string): Promise<RateLimitConfigRow | null> {
    const result = await this.pool.query<RateLimitConfigRow>(
      `SELECT
         id, tenant_id, tier_name,
         req_per_min_tenant, req_per_min_api_key,
         burst_multiplier, burst_duration_sec,
         api_key_overrides,
         created_at, updated_at
         FROM gateway.rate_limit_config
        WHERE tenant_id = $1`,
      [tenantId]
    );
    return result.rows[0] ?? null;
  }

  // Upserts rate limit config for a tenant. Only the explicitly-provided
  // fields are written; absent keys retain their current database value
  // (via the DO UPDATE SET ... = EXCLUDED.* pattern).
  async upsert(
    tenantId: string,
    data: Partial<
      Omit<RateLimitConfigRow, "id" | "tenant_id" | "created_at" | "updated_at">
    >
  ): Promise<RateLimitConfigRow> {
    const tierName = data.tier_name ?? "standard";
    const reqPerMinTenant = data.req_per_min_tenant ?? null;
    const reqPerMinApiKey = data.req_per_min_api_key ?? null;
    const burstMultiplier = data.burst_multiplier ?? null;
    const burstDurationSec = data.burst_duration_sec ?? null;
    const apiKeyOverrides =
      data.api_key_overrides !== undefined
        ? JSON.stringify(data.api_key_overrides)
        : null;

    const setReqPerMinTenant = "req_per_min_tenant" in data
      ? "EXCLUDED.req_per_min_tenant"
      : "COALESCE(EXCLUDED.req_per_min_tenant, gateway.rate_limit_config.req_per_min_tenant)";
    const setReqPerMinApiKey = "req_per_min_api_key" in data
      ? "EXCLUDED.req_per_min_api_key"
      : "COALESCE(EXCLUDED.req_per_min_api_key, gateway.rate_limit_config.req_per_min_api_key)";
    const setBurstMultiplier = "burst_multiplier" in data
      ? "EXCLUDED.burst_multiplier"
      : "COALESCE(EXCLUDED.burst_multiplier, gateway.rate_limit_config.burst_multiplier)";
    const setBurstDurationSec = "burst_duration_sec" in data
      ? "EXCLUDED.burst_duration_sec"
      : "COALESCE(EXCLUDED.burst_duration_sec, gateway.rate_limit_config.burst_duration_sec)";
    const setApiKeyOverrides = "api_key_overrides" in data
      ? "EXCLUDED.api_key_overrides"
      : "COALESCE(EXCLUDED.api_key_overrides, gateway.rate_limit_config.api_key_overrides)";

    const result = await this.pool.query<RateLimitConfigRow>(
      `INSERT INTO gateway.rate_limit_config
         (tenant_id, tier_name, req_per_min_tenant, req_per_min_api_key,
          burst_multiplier, burst_duration_sec, api_key_overrides)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id) DO UPDATE
           SET tier_name         = EXCLUDED.tier_name,
               req_per_min_tenant  = ${setReqPerMinTenant},
               req_per_min_api_key = ${setReqPerMinApiKey},
               burst_multiplier    = ${setBurstMultiplier},
               burst_duration_sec  = ${setBurstDurationSec},
               api_key_overrides   = ${setApiKeyOverrides},
               updated_at          = now()
     RETURNING
         id, tenant_id, tier_name,
         req_per_min_tenant, req_per_min_api_key,
         burst_multiplier, burst_duration_sec,
         api_key_overrides,
         created_at, updated_at`,
      [
        tenantId,
        tierName,
        reqPerMinTenant,
        reqPerMinApiKey,
        burstMultiplier,
        burstDurationSec,
        apiKeyOverrides,
      ]
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `UPSERT INTO gateway.rate_limit_config returned no rows for tenant ${tenantId}`
      );
    }
    return row;
  }
}
