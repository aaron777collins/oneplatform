import type pg from "pg";
import type { Logger } from "@oneplatform/core";
import type { CredentialService } from "./credential-service.js";
import {
  ConnectorNotFoundError,
  ConnectorDisabledError,
} from "./errors.js";
import { withTenant } from "../db/tenant-context.js";

// ---------------------------------------------------------------------------
// Repository row shapes — mirror the concrete repository types.ts exactly.
// Re-exported for route handlers that need the raw row shape.
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

export interface SyncStateRow {
  connector_id: string;
  last_cursor: string | null;
  last_sync_at: Date | null;
  last_sync_job_id: string | null;
  sync_mode: "full" | "incremental";
  status: "never_run" | "running" | "success" | "failed" | "cancelled";
  last_error: string | null;
  last_error_code: string | null;
  rows_last_sync: string; // bigint returned as string by pg driver
  rows_total: string;     // bigint returned as string by pg driver
  updated_at: Date;
}

export interface CreateConnectorData {
  tenant_id: string;
  plugin_id: string;
  instance_id: string;
  name: string;
  config: Record<string, unknown>;
  sync_mode?: "full" | "incremental";
  created_by: string;
  description?: string;
  schedule_cron?: string;
  is_enabled?: boolean;
}

export interface UpdateConnectorData {
  name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
  sync_mode?: "full" | "incremental";
  schedule_cron?: string | null;
  is_enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Repository interfaces — match the concrete classes exactly.
// ---------------------------------------------------------------------------

export interface ConnectorRepository {
  create(data: CreateConnectorData, client?: pg.PoolClient): Promise<ConnectorRow>;
  findById(id: string, client?: pg.PoolClient): Promise<ConnectorRow | null>;
  findByTenantId(tenantId: string, options?: { cursor?: string; limit?: number }): Promise<ConnectorRow[]>;
  findByPluginId(pluginId: string): Promise<ConnectorRow[]>;
  countByTenantId(tenantId: string): Promise<number>;
  update(id: string, data: UpdateConnectorData): Promise<ConnectorRow | null>;
  softDelete(id: string): Promise<boolean>;
  // findDeletedBefore returns connectors soft-deleted before cutoffDate so the
  // retention job can drop their raw tables and hard-delete the rows.
  findDeletedBefore(cutoffDate: Date): Promise<ConnectorRow[]>;
  // hardDelete permanently removes a connector row. Only called after the raw
  // table has been dropped and the grace period has elapsed.
  hardDelete(id: string): Promise<void>;
  disableByPluginId(pluginId: string): Promise<number>;
  disableByInstanceId(instanceId: string): Promise<number>;
  // list() supports cross-tenant iteration when tenantId is "*" — used by
  // the retention scheduler and internal plugin-management routes only.
  list(tenantId: string, options: ListConnectorsOptions, client?: pg.PoolClient): Promise<ConnectorListResult>;
}

export interface SyncStateRepository {
  upsert(data: {
    connector_id: string;
    sync_mode: "full" | "incremental";
    status?: "never_run" | "running" | "success" | "failed" | "cancelled";
    last_cursor?: string;
    last_sync_at?: Date;
    last_sync_job_id?: string;
    last_error?: string;
    last_error_code?: string;
    rows_last_sync?: number;
    rows_total?: number;
  }, client?: pg.PoolClient): Promise<SyncStateRow>;
  findByConnectorId(connectorId: string): Promise<SyncStateRow | null>;
  findByConnectorIds(connectorIds: string[]): Promise<Map<string, SyncStateRow>>;
  updateStatus(
    connectorId: string,
    status: "never_run" | "running" | "success" | "failed" | "cancelled",
    extra?: {
      last_error?: string | null;
      last_error_code?: string | null;
      last_sync_at?: Date;
      last_sync_job_id?: string;
      rows_last_sync?: number;
      rows_total?: number;
    },
  ): Promise<SyncStateRow | null>;
  updateCursor(connectorId: string, lastCursor: string | null): Promise<void>;
  // resetStaleSyncs resets sync_state rows stuck in 'running' for longer than
  // staleThresholdMs. Returns the number of rows reset so the caller can log
  // the count. The watchdog is the only caller.
  resetStaleSyncs(staleThresholdMs: number): Promise<number>;
  // findStaleSyncs returns rows currently in 'running' status whose updated_at
  // is older than olderThanMs milliseconds ago. Used by the watchdog to log
  // each affected connector before bulk-resetting them.
  findStaleSyncs(olderThanMs: number): Promise<SyncStateRow[]>;
}

// ---------------------------------------------------------------------------
// Service-level list options and results
// ---------------------------------------------------------------------------

export interface ListConnectorsOptions {
  cursor?: string;
  limit: number;
  filterStatus?: "enabled" | "disabled";
  filterPluginId?: string;
  sort: string;
}

export interface ConnectorWithSyncState {
  connector: ConnectorRow;
  syncState: SyncStateRow;
}

export interface ConnectorListResult {
  // items and data are the same array — routes access data, service-internal
  // code may use items. Both properties reference the same underlying array.
  items: ConnectorWithSyncState[];
  data: ConnectorWithSyncState[];
  nextCursor: string | null;
  total: number;
}

// ---------------------------------------------------------------------------
// Input types for ConnectorService operations
// ---------------------------------------------------------------------------

export interface CreateConnectorInput {
  pluginId: string;
  name: string;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  syncMode: "full" | "incremental";
  isEnabled: boolean;
  description?: string;
  scheduleCron?: string;
}

export interface UpdateConnectorInput {
  name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
  syncMode?: "full" | "incremental";
  scheduleCron?: string | null;
  isEnabled?: boolean;
}

export interface TestConnectorOverrides {
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
}

export interface TestConnectorResult {
  success: boolean;
  latencyMs: number;
  message: string;
  sampleRecords?: unknown[];
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// ConnectorService — public interface
// masterKey is optional on per-call signatures for backward-compat with routes
// that pass it explicitly; the service uses the deps-injected key internally.
// ---------------------------------------------------------------------------

export interface ConnectorService {
  createConnector(
    tenantId: string,
    userId: string,
    input: CreateConnectorInput,
    masterKey?: Buffer,
  ): Promise<ConnectorWithSyncState>;
  getConnector(tenantId: string, id: string): Promise<ConnectorWithSyncState>;
  listConnectors(
    tenantId: string,
    query: ListConnectorsOptions,
  ): Promise<ConnectorListResult>;
  updateConnector(
    tenantId: string,
    id: string,
    input: UpdateConnectorInput,
    masterKey?: Buffer,
  ): Promise<ConnectorWithSyncState>;
  deleteConnector(tenantId: string, id: string, masterKey?: Buffer): Promise<void>;
  testConnector(
    tenantId: string,
    id: string,
    masterKey?: Buffer,
    overrides?: TestConnectorOverrides,
  ): Promise<TestConnectorResult>;
}

export interface ConnectorServiceDeps {
  connectorRepo: ConnectorRepository;
  syncStateRepo: SyncStateRepository;
  credentialService: CredentialService;
  // masterKey is held in the service closure so routes never handle raw key
  // material — only the bootstrap code that has the key constructs this service.
  masterKey: Buffer;
  executionServiceUrl: string;
  logger: Logger;
  pool: pg.Pool;
}

export function createConnectorService(
  deps: ConnectorServiceDeps,
): ConnectorService {
  const {
    connectorRepo,
    syncStateRepo,
    credentialService,
    masterKey,
    executionServiceUrl,
    logger,
    pool,
  } = deps;

  // -------------------------------------------------------------------------
  // Internal helper: look up a connector and verify tenant ownership.
  // Separating the DB lookup from the ownership check keeps the logic clear.
  // -------------------------------------------------------------------------

  async function requireConnectorForTenant(
    tenantId: string,
    id: string,
    client?: pg.PoolClient,
  ): Promise<ConnectorRow> {
    const connector = await connectorRepo.findById(id, client);
    if (connector === null) {
      throw new ConnectorNotFoundError(
        `Connector ${id} not found.`,
        { connectorId: id },
      );
    }
    // Tenant isolation: enforce ownership in the service layer in addition to
    // the DB-level RLS policy so we always fail loudly on cross-tenant access.
    // Throw a NotFoundError (404) rather than ForbiddenError (403) when the
    // connector belongs to a different tenant — leaking the 403 vs 404
    // distinction would allow callers to enumerate connector IDs across tenants.
    if (tenantId !== "*" && connector.tenant_id !== tenantId) {
      throw new ConnectorNotFoundError(
        `Connector ${id} not found.`,
        { connectorId: id },
      );
    }
    return connector;
  }

  async function requireSyncState(connectorId: string, syncMode: "full" | "incremental"): Promise<SyncStateRow> {
    const existing = await syncStateRepo.findByConnectorId(connectorId);
    if (existing !== null) return existing;

    // Synthesise a sync_state row if missing — should never happen in normal
    // operation but guards against races during connector creation.
    logger.warn("sync_state missing for connector — synthesising default", {
      connectorId,
    });
    return syncStateRepo.upsert({ connector_id: connectorId, sync_mode: syncMode });
  }

  // -------------------------------------------------------------------------
  // createConnector — creates the connector row, encrypts credentials, and
  // initialises the sync_state entry. Credentials are encrypted after creating
  // the connector row so the connector ID is available as the vault namespace.
  // -------------------------------------------------------------------------

  async function createConnector(
    tenantId: string,
    userId: string,
    input: CreateConnectorInput,
    // _callerMasterKey accepted for API compatibility; internal deps key used.
    _callerMasterKey?: Buffer,
  ): Promise<ConnectorWithSyncState> {
    return withTenant(pool, tenantId, async (client) => {
      const connector = await connectorRepo.create({
        tenant_id: tenantId,
        plugin_id: input.pluginId,
        // instance_id starts as a new UUID; the Plugin Service overwrites it when
        // it sends a POST /internal/ingestion/connectors registration.
        instance_id: crypto.randomUUID(),
        name: input.name,
        config: input.config,
        sync_mode: input.syncMode,
        created_by: userId,
        is_enabled: input.isEnabled,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.scheduleCron !== undefined ? { schedule_cron: input.scheduleCron } : {}),
      }, client);

      if (Object.keys(input.credentials).length > 0) {
        await credentialService.storeCredentials(
          connector.id,
          input.credentials,
          masterKey,
        );
      }

      // Initialise sync state — one row per connector, created eagerly so the
      // list endpoint can always join without a LEFT JOIN.
      const syncState = await syncStateRepo.upsert({
        connector_id: connector.id,
        sync_mode: input.syncMode,
      }, client);

      logger.info("Connector created", {
        connectorId: connector.id,
        tenantId,
        pluginId: input.pluginId,
      });

      return { connector, syncState };
    });
  }

  // -------------------------------------------------------------------------
  // getConnector — tenant isolation enforced in requireConnectorForTenant.
  // -------------------------------------------------------------------------

  async function getConnector(
    tenantId: string,
    id: string,
  ): Promise<ConnectorWithSyncState> {
    return withTenant(pool, tenantId, async (client) => {
      const connector = await requireConnectorForTenant(tenantId, id, client);
      const syncState = await requireSyncState(connector.id, connector.sync_mode);
      return { connector, syncState };
    });
  }

  // -------------------------------------------------------------------------
  // listConnectors — paginated list with sync state joined per-item.
  // -------------------------------------------------------------------------

  async function listConnectors(
    tenantId: string,
    query: ListConnectorsOptions,
  ): Promise<ConnectorListResult> {
    // Use the repo's list() method for all code paths so that pluginId
    // filtering, status filtering, and pagination all happen at the SQL level.
    // The repo JOIN already includes sync_state, so no separate fetch is needed.
    return withTenant(pool, tenantId, async (client) => {
      return connectorRepo.list(tenantId, query, client);
    });
  }

  // -------------------------------------------------------------------------
  // updateConnector — re-encrypts only the credential fields present in the
  // input. Omitted credential fields retain their existing encrypted values.
  // -------------------------------------------------------------------------

  async function updateConnector(
    tenantId: string,
    id: string,
    input: UpdateConnectorInput,
    // _callerMasterKey accepted for API compatibility; internal deps key used.
    _callerMasterKey?: Buffer,
  ): Promise<ConnectorWithSyncState> {
    return withTenant(pool, tenantId, async (client) => {
      // Verify ownership before mutating.
      await requireConnectorForTenant(tenantId, id, client);

      const updated = await connectorRepo.update(id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.syncMode !== undefined ? { sync_mode: input.syncMode } : {}),
        ...(input.scheduleCron !== undefined ? { schedule_cron: input.scheduleCron } : {}),
        ...(input.isEnabled !== undefined ? { is_enabled: input.isEnabled } : {}),
      });

      if (updated === null) {
        throw new ConnectorNotFoundError(
          `Connector ${id} not found after update.`,
          { connectorId: id },
        );
      }

      // Re-encrypt only the explicitly provided credential fields.
      if (input.credentials !== undefined && Object.keys(input.credentials).length > 0) {
        await credentialService.storeCredentials(id, input.credentials, masterKey);
      }

      const syncState = await requireSyncState(updated.id, updated.sync_mode);

      logger.info("Connector updated", { connectorId: id, tenantId });
      return { connector: updated, syncState };
    });
  }

  // -------------------------------------------------------------------------
  // deleteConnector — soft delete + immediate credential deletion.
  // Raw table cleanup (DROP TABLE after 7 days) is delegated to RetentionService.
  // -------------------------------------------------------------------------

  async function deleteConnector(
    tenantId: string,
    id: string,
    // _callerMasterKey accepted for API compatibility; unused in delete path.
    _callerMasterKey?: Buffer,
  ): Promise<void> {
    return withTenant(pool, tenantId, async (client) => {
      // Ownership check raises ConnectorNotFoundError for unknown/cross-tenant IDs.
      await requireConnectorForTenant(tenantId, id, client);

      await connectorRepo.softDelete(id);

      // Credential deletion is synchronous on connector delete — credentials
      // must not outlive the logical connector record for compliance reasons.
      await credentialService.deleteByConnectorId(id);

      logger.info("Connector deleted", { connectorId: id, tenantId });
    });
  }

  // -------------------------------------------------------------------------
  // testConnector — delegates execution to the Execution Service sandbox.
  // Never persists data. Overrides allow testing before saving a connector.
  // -------------------------------------------------------------------------

  async function testConnector(
    tenantId: string,
    id: string,
    // _callerMasterKey accepted for API compatibility; internal deps key used.
    _callerMasterKey?: Buffer,
    overrides?: TestConnectorOverrides,
  ): Promise<TestConnectorResult> {
    const { connector } = await getConnector(tenantId, id);

    if (!connector.is_enabled) {
      throw new ConnectorDisabledError(
        `Connector ${id} is disabled and cannot be tested.`,
        { connectorId: id },
      );
    }

    const startMs = Date.now();

    const effectiveConfig: Record<string, unknown> = {
      ...connector.config,
      ...(overrides?.config ?? {}),
    };

    const credentialFields = await credentialService.listFieldNames(id);
    const credentialOverrides = overrides?.credentials ?? {};

    const payload = {
      pluginId: connector.plugin_id,
      instanceId: connector.instance_id,
      tenantId,
      method: "connect" as const,
      config: effectiveConfig,
      credentialBundleId: connector.id,
      credentialOverrides,
      credentialFields,
      timeoutMs: 30_000,
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35_000);

      let response: Response;
      try {
        response = await fetch(`${executionServiceUrl}/internal/execution/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = Date.now() - startMs;

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const errorMsg =
          typeof body["message"] === "string"
            ? body["message"]
            : `Execution service returned HTTP ${response.status}`;
        const errorCode =
          typeof body["code"] === "string" ? body["code"] : "EXECUTION_ERROR";

        return {
          success: false,
          latencyMs,
          message: "Connector test failed.",
          error: { code: errorCode, message: errorMsg },
        };
      }

      const result = (await response.json()) as Record<string, unknown>;
      const sampleRecords = Array.isArray(result["sampleRecords"])
        ? (result["sampleRecords"] as unknown[]).slice(0, 3)
        : undefined;

      return {
        success: true,
        latencyMs,
        message: "Connector test succeeded.",
        ...(sampleRecords !== undefined ? { sampleRecords } : {}),
      };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        latencyMs,
        message: "Connector test failed.",
        error: { code: "EXECUTION_UNREACHABLE", message },
      };
    }
  }

  return {
    createConnector,
    getConnector,
    listConnectors,
    updateConnector,
    deleteConnector,
    testConnector,
  };
}
