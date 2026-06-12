/**
 * Cross-service cleanup helpers for Level 3 E2E tests.
 *
 * Each E2E test creates a unique tenant (via direct DB insert in createE2ETenant)
 * and registers one or more users within it. Because the test PostgreSQL user is
 * a superuser, these deletes bypass RLS regardless of session GUC state.
 *
 * Deletion order honours FK constraints across all service schemas:
 *   plugin, app, ingestion, pipeline, ontology → auth (last, owns tenants table)
 *
 * Services without RLS (ontology, plugin, app) rely purely on tenant_id
 * filtering — no GUC needed for cleanup.
 */

import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Tenant provisioning — creates an isolated tenant in the auth schema so
// each test can register real users via the auth service HTTP API.
// ---------------------------------------------------------------------------

export interface E2ETenant {
  tenantId: string;
  tenantSlug: string;
}

/**
 * Inserts a fresh tenant row directly into auth.tenants.
 *
 * This bypasses the bootstrap flow (which is one-shot per database) and lets
 * each E2E test have its own isolated tenant. The slug is derived from the
 * tenant UUID so it always satisfies the slug format constraint.
 */
export async function createE2ETenant(pool: pg.Pool): Promise<E2ETenant> {
  const tenantId = randomUUID();
  // slug must match ^[a-z0-9][a-z0-9\-]{1,62}[a-z0-9]$ — use a short prefix + uuid hex
  const tenantSlug = `e2e-${tenantId.replace(/-/g, "").slice(0, 20)}`;

  await pool.query(
    `INSERT INTO auth.tenants (id, name, slug)
     VALUES ($1, $2, $3)`,
    [tenantId, `E2E Tenant ${tenantId.slice(0, 8)}`, tenantSlug]
  );

  return { tenantId, tenantSlug };
}

// ---------------------------------------------------------------------------
// Cleanup — deletes ALL rows for a tenant across all service schemas.
// Call in afterAll with the tenantId created by createE2ETenant.
// ---------------------------------------------------------------------------

/**
 * Deletes all rows created by an E2E test across all service schemas.
 *
 * Deletion order is carefully chosen to satisfy FK constraints:
 *  1. Plugin hooks and instances (reference plugin rows + tenants)
 *  2. App data (files, builds, env_vars, etc. cascade from app.apps)
 *  3. Ingestion data (credentials cascade from connectors)
 *  4. Pipeline data (run_steps, run_logs cascade from runs)
 *  5. Ontology data (fields, relationships etc. cascade from entities)
 *  6. Auth data (api_keys, oauth_providers, sessions etc. cascade from users)
 *  7. Auth tenants (last — everything else FK-references it)
 */
export async function cleanupE2ETenant(pool: pg.Pool, tenantId: string): Promise<void> {
  // ── Plugin schema ──────────────────────────────────────────────────────────
  // hooks reference instances and plugins — delete hooks before instances
  await pool.query(
    "DELETE FROM plugin.hooks WHERE tenant_id = $1",
    [tenantId]
  );
  await pool.query(
    "DELETE FROM plugin.instances WHERE tenant_id = $1",
    [tenantId]
  );

  // ── App schema ─────────────────────────────────────────────────────────────
  // files, builds, env_vars, roles, tenant_shares, oauth_registrations, user_storage
  // all CASCADE from app.apps — delete the parent and they follow.
  await pool.query(
    "DELETE FROM app.apps WHERE tenant_id = $1",
    [tenantId]
  );

  // ── Ingestion schema ───────────────────────────────────────────────────────
  // ingestion.credentials CASCADE from connectors; webhook_receivers and
  // upload_jobs also reference tenant_id but have no FK to connectors.
  await pool.query(
    "DELETE FROM ingestion.webhook_receivers WHERE tenant_id = $1",
    [tenantId]
  );
  await pool.query(
    "DELETE FROM ingestion.upload_jobs WHERE tenant_id = $1",
    [tenantId]
  );
  // connectors delete cascades to credentials
  await pool.query(
    "DELETE FROM ingestion.connectors WHERE tenant_id = $1",
    [tenantId]
  );

  // ── Pipeline schema ────────────────────────────────────────────────────────
  // run_steps and run_logs CASCADE from runs; runs CASCADE from pipelines.
  await pool.query(
    "DELETE FROM pipeline.schedules WHERE tenant_id = $1",
    [tenantId]
  );
  await pool.query(
    "DELETE FROM pipeline.triggers WHERE tenant_id = $1",
    [tenantId]
  );
  // runs and their child rows cascade from pipelines
  await pool.query(
    "DELETE FROM pipeline.pipelines WHERE tenant_id = $1",
    [tenantId]
  );

  // ── Ontology schema ────────────────────────────────────────────────────────
  // fields, relationships, mapping_rules, migrations cascade from entities.
  await pool.query(
    "DELETE FROM ontology.mapping_errors WHERE tenant_id = $1",
    [tenantId]
  );
  await pool.query(
    "DELETE FROM ontology.draft_ontologies WHERE tenant_id = $1",
    [tenantId]
  );
  // mapping_rules reference entities — delete before entities
  await pool.query(
    "DELETE FROM ontology.mapping_rules WHERE tenant_id = $1",
    [tenantId]
  );
  // migrations reference entities; shadow_table_registry cascades from migrations
  await pool.query(
    "DELETE FROM ontology.migrations WHERE tenant_id = $1",
    [tenantId]
  );
  // relationships reference entities — delete before entities
  await pool.query(
    "DELETE FROM ontology.relationships WHERE tenant_id = $1",
    [tenantId]
  );
  // fields cascade from entities; entities cascade to fields ON DELETE CASCADE
  await pool.query(
    "DELETE FROM ontology.entities WHERE tenant_id = $1",
    [tenantId]
  );

  // ── Auth schema ────────────────────────────────────────────────────────────
  // entity_permissions, api_keys, oauth_clients, oauth_providers, sessions,
  // password_reset_tokens all CASCADE from users or tenants.
  await pool.query(
    "DELETE FROM auth.entity_permissions WHERE tenant_id = $1",
    [tenantId]
  );
  await pool.query(
    "DELETE FROM auth.oauth_clients WHERE tenant_id = $1",
    [tenantId]
  );
  // api_keys, oauth_providers, sessions, password_reset_tokens cascade from users
  await pool.query(
    "DELETE FROM auth.users WHERE tenant_id = $1",
    [tenantId]
  );
  await pool.query(
    "DELETE FROM auth.roles WHERE tenant_id = $1",
    [tenantId]
  );
  // tenants last — everything else referenced it
  await pool.query(
    "DELETE FROM auth.tenants WHERE id = $1",
    [tenantId]
  );
}

// ---------------------------------------------------------------------------
// Shared cleanup pool factory
// ---------------------------------------------------------------------------

/**
 * Creates a direct PostgreSQL pool for cleanup operations.
 *
 * Uses the test superuser connection (OP_DATABASE_URL from .env.test) which
 * bypasses RLS at the PostgreSQL level, so no GUC manipulation is needed.
 */
export function createCleanupPool(): pg.Pool {
  const connectionString = process.env["OP_DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "OP_DATABASE_URL must be set in the test environment. " +
      "Ensure .env.test is loaded before running E2E tests."
    );
  }
  return new Pool({
    connectionString,
    max: 2,
    // Short timeout — cleanup should be fast on small test datasets
    statement_timeout: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}
