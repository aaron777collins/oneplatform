import type { Logger } from "@oneplatform/core";
import { NotFoundError, ForbiddenError } from "@oneplatform/core";
import type { CredentialService } from "./credential-service.js";
import {
  ConnectorNotFoundError,
  ConnectorDisabledError,
} from "./errors.js";

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
  create(data: CreateConnectorData): Promise<ConnectorRow>;
  findById(id: string): Promise<ConnectorRow | null>;
  findByTenantId(tenantId: string, options?: { cursor?: string; limit?: number }): Promise<ConnectorRow[]>;
  findByPluginId(pluginId: string): Promise<ConnectorRow[]>;
  countByTenantId(tenantId: string): Promise<number>;
  update(id: string, data: UpdateConnectorData): Promise<ConnectorRow | null>;
  softDelete(id: string): Promise<boolean>;
  disableByPluginId(pluginId: string): Promise<number>;
  disableByInstanceId(instanceId: string): Promise<number>;
  // list() supports cross-tenant iteration when tenantId is "*" — used by
  // the retention scheduler and internal plugin-management routes only.
  list(tenantId: string, options: ListConnectorsOptions): Promise<ConnectorListResult>;
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
  }): Promise<SyncStateRow>;
  findByConnectorId(connectorId: string): Promise<SyncStateRow | null>;
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
  } = deps;

  // -------------------------------------------------------------------------
  // Internal helper: look up a connector and verify tenant ownership.
  // Separating the DB lookup from the ownership check keeps the logic clear.
  // -------------------------------------------------------------------------

  async function requireConnectorForTenant(
    tenantId: string,
    id: string,
  ): Promise<ConnectorRow> {
    const connector = await connectorRepo.findById(id);
    if (connector === null) {
      throw new ConnectorNotFoundError(
        `Connector ${id} not found.`,
        { connectorId: id },
      );
    }
    // Tenant isolation: enforce ownership in the service layer in addition to
    // the DB-level RLS policy so we always fail loudly on cross-tenant access.
    if (tenantId !== "*" && connector.tenant_id !== tenantId) {
      throw new ForbiddenError(
        `You do not have access to connector ${id}.`,
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
    });

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
    });

    logger.info("Connector created", {
      connectorId: connector.id,
      tenantId,
      pluginId: input.pluginId,
    });

    return { connector, syncState };
  }

  // -------------------------------------------------------------------------
  // getConnector — tenant isolation enforced in requireConnectorForTenant.
  // -------------------------------------------------------------------------

  async function getConnector(
    tenantId: string,
    id: string,
  ): Promise<ConnectorWithSyncState> {
    const connector = await requireConnectorForTenant(tenantId, id);
    const syncState = await requireSyncState(connector.id, connector.sync_mode);
    return { connector, syncState };
  }

  // -------------------------------------------------------------------------
  // listConnectors — paginated list with sync state joined per-item.
  // -------------------------------------------------------------------------

  async function listConnectors(
    tenantId: string,
    query: ListConnectorsOptions,
  ): Promise<ConnectorListResult> {
    // Apply plugin filter at the DB level when specified.
    let connectorRows: ConnectorRow[];

    if (query.filterPluginId !== undefined) {
      // The repo has findByPluginId — filter to this tenant's connectors.
      const byPlugin = await connectorRepo.findByPluginId(query.filterPluginId);
      connectorRows = tenantId === "*"
        ? byPlugin
        : byPlugin.filter((c) => c.tenant_id === tenantId);
    } else {
      connectorRows = await connectorRepo.findByTenantId(tenantId, {
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        limit: query.limit,
      });
    }

    // Apply status filter in-process (the repo doesn't have a filterStatus param).
    if (query.filterStatus !== undefined) {
      const wantEnabled = query.filterStatus === "enabled";
      connectorRows = connectorRows.filter((c) => c.is_enabled === wantEnabled);
    }

    // Join sync state for each connector in parallel.
    const items = await Promise.all(
      connectorRows.map(async (connector): Promise<ConnectorWithSyncState> => {
        const syncState = await requireSyncState(connector.id, connector.sync_mode);
        return { connector, syncState };
      }),
    );

    const total = await connectorRepo.countByTenantId(tenantId);
    const nextCursor =
      connectorRows.length === query.limit
        ? (connectorRows[connectorRows.length - 1]?.id ?? null)
        : null;

    return { items, data: items, nextCursor, total };
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
    // Verify ownership before mutating.
    await requireConnectorForTenant(tenantId, id);

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
    // Ownership check raises ConnectorNotFoundError for unknown/cross-tenant IDs.
    await requireConnectorForTenant(tenantId, id);

    await connectorRepo.softDelete(id);

    // Credential deletion is synchronous on connector delete — credentials
    // must not outlive the logical connector record for compliance reasons.
    await credentialService.deleteByConnectorId(id);

    logger.info("Connector deleted", { connectorId: id, tenantId });
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
