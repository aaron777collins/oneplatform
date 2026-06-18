-- ============================================================
-- Migration: 004_data_residency
-- Gateway Service — Data residency controls
--
-- Implements geographic data residency enforcement for tenants.
-- Each tenant can be assigned a primary storage region with
-- replication policies. Cross-region data transfers are governed
-- by explicit rules (allow/deny/audit) to satisfy data sovereignty
-- regulations (GDPR, CCPA, PIPL, etc.).
--
-- Design rationale:
--   data_residency_policies stores the per-tenant region assignment.
--   The gateway enforces residency at the middleware layer before
--   any data operation reaches downstream services.
--
--   data_transfer_rules encodes a directed graph of permitted
--   cross-region transfers. If no rule exists for a (source, target)
--   pair, the default is "deny" — fail-closed.
--
--   data_location_log is an append-only audit trail that records
--   every data access with its resolved region, enabling post-hoc
--   compliance auditing.
--
-- Idempotent: uses IF NOT EXISTS throughout.
-- ============================================================

-- ============================================================
-- gateway.data_residency_policies
--
-- One row per tenant. Stores the tenant's assigned storage region,
-- storage class preference, and replication policy.
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.data_residency_policies (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  -- region uses a structured enum-like CHECK so that only valid
  -- deployment regions can be assigned. New regions require a
  -- migration to extend the CHECK constraint.
  region             TEXT        NOT NULL
                     CHECK (region IN (
                       'US_EAST',
                       'US_WEST',
                       'EU_WEST',
                       'EU_CENTRAL',
                       'AP_SOUTHEAST',
                       'AP_NORTHEAST'
                     )),
  -- storage_class controls the durability/cost trade-off within a region
  storage_class      TEXT        NOT NULL DEFAULT 'standard'
                     CHECK (storage_class IN ('standard', 'reduced_redundancy', 'archive')),
  -- replication_policy controls whether data is replicated across
  -- availability zones within the assigned region
  replication_policy TEXT        NOT NULL DEFAULT 'single_region'
                     CHECK (replication_policy IN (
                       'single_region',
                       'multi_az',
                       'cross_region_backup'
                     )),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One policy per tenant — prevents conflicting region assignments
  CONSTRAINT data_residency_policies_tenant_unique UNIQUE (tenant_id)
);

-- Lookup by region: useful for compliance reports ("list all tenants in EU_WEST")
CREATE INDEX IF NOT EXISTS idx_data_residency_policies_region
  ON gateway.data_residency_policies(region);

-- updated_at auto-maintenance
CREATE OR REPLACE TRIGGER set_data_residency_policies_updated_at
  BEFORE UPDATE ON gateway.data_residency_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- gateway.data_transfer_rules
--
-- Directed graph of cross-region transfer permissions.
-- Each row represents a rule from source_region to target_region.
-- The policy field controls whether the transfer is permitted:
--   allow  — transfer proceeds without restrictions
--   deny   — transfer is blocked; the middleware returns 403
--   audit  — transfer proceeds but a mandatory audit log entry is
--            created and an alert may be raised
--
-- If no rule exists for a (source, target) pair, the system
-- defaults to "deny" (fail-closed).
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.data_transfer_rules (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_region          TEXT        NOT NULL
                         CHECK (source_region IN (
                           'US_EAST', 'US_WEST', 'EU_WEST', 'EU_CENTRAL',
                           'AP_SOUTHEAST', 'AP_NORTHEAST'
                         )),
  target_region          TEXT        NOT NULL
                         CHECK (target_region IN (
                           'US_EAST', 'US_WEST', 'EU_WEST', 'EU_CENTRAL',
                           'AP_SOUTHEAST', 'AP_NORTHEAST'
                         )),
  policy                 TEXT        NOT NULL
                         CHECK (policy IN ('allow', 'deny', 'audit')),
  -- justification_required forces callers to provide a reason string
  -- when this transfer rule is exercised (useful for audit policies)
  justification_required BOOLEAN     NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One rule per (source, target) pair
  CONSTRAINT data_transfer_rules_pair_unique
    UNIQUE (source_region, target_region),
  -- A region cannot have a transfer rule to itself
  CONSTRAINT data_transfer_rules_no_self_transfer
    CHECK (source_region <> target_region)
);

-- Lookup: all rules from a given source region
CREATE INDEX IF NOT EXISTS idx_data_transfer_rules_source
  ON gateway.data_transfer_rules(source_region);

-- ============================================================
-- gateway.data_location_log
--
-- Append-only audit trail recording every data operation and
-- its resolved storage region. Used for compliance reporting
-- and post-hoc residency verification.
--
-- Rows are never updated or deleted — retention policies should
-- be enforced via a background job that deletes entries older
-- than the regulatory retention period (typically 7 years for
-- GDPR, varies by jurisdiction).
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway.data_location_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id   TEXT        NOT NULL,
  tenant_id   UUID        NOT NULL REFERENCES auth.tenants(id) ON DELETE CASCADE,
  region      TEXT        NOT NULL
              CHECK (region IN (
                'US_EAST', 'US_WEST', 'EU_WEST', 'EU_CENTRAL',
                'AP_SOUTHEAST', 'AP_NORTHEAST'
              )),
  service     TEXT        NOT NULL,
  operation   TEXT        NOT NULL DEFAULT 'access',
  actor_id    TEXT,
  metadata    JSONB,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query: all log entries for a tenant in a time window
CREATE INDEX IF NOT EXISTS idx_data_location_log_tenant_ts
  ON gateway.data_location_log(tenant_id, timestamp DESC);

-- Compliance query: all accesses in a specific region
CREATE INDEX IF NOT EXISTS idx_data_location_log_region_ts
  ON gateway.data_location_log(region, timestamp DESC);

-- Record-level lineage: all regions a specific record has been accessed from
CREATE INDEX IF NOT EXISTS idx_data_location_log_record
  ON gateway.data_location_log(record_id);
