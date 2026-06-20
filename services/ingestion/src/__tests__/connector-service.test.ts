// Unit tests for services/ingestion/src/services/connector-service.ts
//
// Tests createConnector, updateConnector, deleteConnector, testConnector,
// tenant isolation, masterKey handling, and sync state initialization.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@oneplatform/core";
import {
  createConnectorService,
  type ConnectorRepository,
  type SyncStateRepository,
  type ConnectorRow,
  type SyncStateRow,
  type CreateConnectorInput,
  type UpdateConnectorInput,
} from "../services/connector-service.js";
import type { CredentialService } from "../services/credential-service.js";
import {
  ConnectorNotFoundError,
  ConnectorDisabledError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASTER_KEY = Buffer.from("01234567890123456789012345678901");
const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONNECTOR_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function makeConnectorRow(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: CONNECTOR_ID,
    tenant_id: TENANT_A,
    plugin_id: "my-plugin",
    instance_id: "iiiiiiii-iiii-iiii-iiii-iiiiiiiiiiii",
    name: "Test Connector",
    description: null,
    config: {},
    sync_mode: "incremental",
    schedule_cron: null,
    is_enabled: true,
    created_by: "user-1",
    created_at: new Date("2024-01-01"),
    updated_at: new Date("2024-01-01"),
    deleted_at: null,
    ...overrides,
  };
}

function makeSyncStateRow(overrides: Partial<SyncStateRow> = {}): SyncStateRow {
  return {
    connector_id: CONNECTOR_ID,
    last_cursor: null,
    last_sync_at: null,
    last_sync_job_id: null,
    sync_mode: "incremental",
    status: "never_run",
    last_error: null,
    last_error_code: null,
    rows_last_sync: "0",
    rows_total: "0",
    updated_at: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

// Mock factories — each returns a plain object with explicit named vi.fn() fields.
// TypeScript knows the exact properties; no index signature needed.

type MockFn = ReturnType<typeof vi.fn>;

interface MockConnectorRepo {
  create: MockFn; findById: MockFn; findByTenantId: MockFn;
  findByPluginId: MockFn; countByTenantId: MockFn; update: MockFn;
  softDelete: MockFn; disableByPluginId: MockFn; list: MockFn;
}

interface MockSyncStateRepo {
  upsert: MockFn; findByConnectorId: MockFn;
  updateStatus: MockFn; updateCursor: MockFn;
}

interface MockCredSvc {
  storeCredentials: MockFn; deleteByConnectorId: MockFn;
  listFieldNames: MockFn; getDecryptedCredential: MockFn;
  createCredentialAccessor: MockFn;
}

function makeConnectorRepo(): MockConnectorRepo {
  return {
    create: vi.fn(), findById: vi.fn(), findByTenantId: vi.fn(),
    findByPluginId: vi.fn(), countByTenantId: vi.fn(), update: vi.fn(),
    softDelete: vi.fn(), disableByPluginId: vi.fn(), list: vi.fn(),
  };
}

function makeSyncStateRepo(): MockSyncStateRepo {
  return {
    upsert: vi.fn(), findByConnectorId: vi.fn(),
    updateStatus: vi.fn(), updateCursor: vi.fn(),
  };
}

function makeCredentialService(): MockCredSvc {
  return {
    storeCredentials: vi.fn(), deleteByConnectorId: vi.fn(),
    listFieldNames: vi.fn(), getDecryptedCredential: vi.fn(),
    createCredentialAccessor: vi.fn(),
  };
}

interface ServiceBundle {
  connectorRepo: MockConnectorRepo;
  syncStateRepo: MockSyncStateRepo;
  credentialService: MockCredSvc;
  logger: Logger;
  service: ReturnType<typeof createConnectorService>;
}

function makeService(executionServiceUrl = "http://exec:3000"): ServiceBundle {
  const connectorRepo = makeConnectorRepo();
  const syncStateRepo = makeSyncStateRepo();
  const credentialService = makeCredentialService();
  const logger = makeLogger();

  const service = createConnectorService({
    connectorRepo: connectorRepo as unknown as ConnectorRepository,
    syncStateRepo: syncStateRepo as unknown as SyncStateRepository,
    credentialService: credentialService as unknown as CredentialService,
    masterKey: MASTER_KEY,
    executionServiceUrl,
    logger,
  });

  return { connectorRepo, syncStateRepo, credentialService, logger, service };
}

const DEFAULT_CREATE_INPUT: CreateConnectorInput = {
  pluginId: "stripe",
  name: "Stripe Connector",
  config: { apiVersion: "2023-10-16" },
  credentials: { apiKey: "sk_test_123" },
  syncMode: "incremental",
  isEnabled: true,
};

// ---------------------------------------------------------------------------
// createConnector
// ---------------------------------------------------------------------------

describe("createConnector", () => {
  let bundle: ServiceBundle;

  beforeEach(() => {
    bundle = makeService();
    bundle.connectorRepo.create.mockResolvedValue(makeConnectorRow());
    bundle.syncStateRepo.upsert.mockResolvedValue(makeSyncStateRow());
    bundle.credentialService.storeCredentials.mockResolvedValue(undefined);
  });

  it("returns connector and syncState on success", async () => {
    const result = await bundle.service.createConnector(TENANT_A, "user-1", DEFAULT_CREATE_INPUT);
    expect(result.connector).toBeDefined();
    expect(result.syncState).toBeDefined();
  });

  it("calls connectorRepo.create with correct tenant_id", async () => {
    await bundle.service.createConnector(TENANT_A, "user-1", DEFAULT_CREATE_INPUT);
    const calls = bundle.connectorRepo.create.mock.calls;
    expect((calls[0]?.[0] as { tenant_id: string }).tenant_id).toBe(TENANT_A);
  });

  it("calls connectorRepo.create with correct plugin_id", async () => {
    await bundle.service.createConnector(TENANT_A, "user-1", DEFAULT_CREATE_INPUT);
    const calls = bundle.connectorRepo.create.mock.calls;
    expect((calls[0]?.[0] as { plugin_id: string }).plugin_id).toBe("stripe");
  });

  it("calls credentialService.storeCredentials when credentials are provided", async () => {
    await bundle.service.createConnector(TENANT_A, "user-1", DEFAULT_CREATE_INPUT);
    expect(bundle.credentialService.storeCredentials.mock.calls).toHaveLength(1);
  });

  it("does not call storeCredentials when credentials object is empty", async () => {
    const input: CreateConnectorInput = { ...DEFAULT_CREATE_INPUT, credentials: {} };
    await bundle.service.createConnector(TENANT_A, "user-1", input);
    expect(bundle.credentialService.storeCredentials.mock.calls).toHaveLength(0);
  });

  it("calls syncStateRepo.upsert to initialise sync state", async () => {
    await bundle.service.createConnector(TENANT_A, "user-1", DEFAULT_CREATE_INPUT);
    expect(bundle.syncStateRepo.upsert.mock.calls).toHaveLength(1);
  });

  it("uses the injected masterKey (not caller-provided key) for storeCredentials", async () => {
    const callerKey = Buffer.alloc(32, 0xff); // different from MASTER_KEY
    await bundle.service.createConnector(TENANT_A, "user-1", DEFAULT_CREATE_INPUT, callerKey);
    const storeCalls = bundle.credentialService.storeCredentials.mock.calls;
    // The third argument is the master key — should be the injected one
    expect(storeCalls[0]?.[2]).toBe(MASTER_KEY);
  });

  it("logs a connector created info event", async () => {
    await bundle.service.createConnector(TENANT_A, "user-1", DEFAULT_CREATE_INPUT);
    const calls = (bundle.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
  });

  it("passes optional description when provided", async () => {
    const input: CreateConnectorInput = { ...DEFAULT_CREATE_INPUT, description: "My connector" };
    await bundle.service.createConnector(TENANT_A, "user-1", input);
    const createArg = bundle.connectorRepo.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createArg["description"]).toBe("My connector");
  });
});

// ---------------------------------------------------------------------------
// getConnector
// ---------------------------------------------------------------------------

describe("getConnector", () => {
  let bundle: ServiceBundle;

  beforeEach(() => {
    bundle = makeService();
    bundle.connectorRepo.findById.mockResolvedValue(makeConnectorRow());
    bundle.syncStateRepo.findByConnectorId.mockResolvedValue(makeSyncStateRow());
  });

  it("returns connector and syncState for correct tenant", async () => {
    const result = await bundle.service.getConnector(TENANT_A, CONNECTOR_ID);
    expect(result.connector.id).toBe(CONNECTOR_ID);
    expect(result.syncState.connector_id).toBe(CONNECTOR_ID);
  });

  it("throws ConnectorNotFoundError when connector does not exist", async () => {
    bundle.connectorRepo.findById.mockResolvedValue(null);
    await expect(bundle.service.getConnector(TENANT_A, CONNECTOR_ID)).rejects.toBeInstanceOf(
      ConnectorNotFoundError,
    );
  });

  it("throws ConnectorNotFoundError when connector belongs to a different tenant", async () => {
    // We return NotFound rather than Forbidden to avoid leaking that the
    // connector exists to callers from a different tenant.
    await expect(bundle.service.getConnector(TENANT_B, CONNECTOR_ID)).rejects.toBeInstanceOf(
      ConnectorNotFoundError,
    );
  });

  it("wildcard tenant '*' bypasses ownership check", async () => {
    const result = await bundle.service.getConnector("*", CONNECTOR_ID);
    expect(result.connector.id).toBe(CONNECTOR_ID);
  });

  it("synthesises a missing sync_state row and logs a warn", async () => {
    bundle.syncStateRepo.findByConnectorId.mockResolvedValue(null);
    bundle.syncStateRepo.upsert.mockResolvedValue(makeSyncStateRow());
    await bundle.service.getConnector(TENANT_A, CONNECTOR_ID);
    const warnCalls = (bundle.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// updateConnector
// ---------------------------------------------------------------------------

describe("updateConnector", () => {
  let bundle: ServiceBundle;

  beforeEach(() => {
    bundle = makeService();
    bundle.connectorRepo.findById.mockResolvedValue(makeConnectorRow());
    bundle.connectorRepo.update.mockResolvedValue(makeConnectorRow({ name: "Updated Name" }));
    bundle.syncStateRepo.findByConnectorId.mockResolvedValue(makeSyncStateRow());
    bundle.credentialService.storeCredentials.mockResolvedValue(undefined);
  });

  it("returns updated connector and syncState", async () => {
    const result = await bundle.service.updateConnector(TENANT_A, CONNECTOR_ID, { name: "Updated Name" });
    expect(result.connector.name).toBe("Updated Name");
  });

  it("re-encrypts credentials when credentials are provided in the update", async () => {
    const input: UpdateConnectorInput = { credentials: { newKey: "new-value" } };
    await bundle.service.updateConnector(TENANT_A, CONNECTOR_ID, input);
    expect(bundle.credentialService.storeCredentials.mock.calls).toHaveLength(1);
  });

  it("does not re-encrypt when credentials are undefined in the update", async () => {
    const input: UpdateConnectorInput = { name: "New Name" };
    await bundle.service.updateConnector(TENANT_A, CONNECTOR_ID, input);
    expect(bundle.credentialService.storeCredentials.mock.calls).toHaveLength(0);
  });

  it("does not re-encrypt when credentials is an empty object", async () => {
    const input: UpdateConnectorInput = { credentials: {} };
    await bundle.service.updateConnector(TENANT_A, CONNECTOR_ID, input);
    expect(bundle.credentialService.storeCredentials.mock.calls).toHaveLength(0);
  });

  it("throws ConnectorNotFoundError when tenantId does not own the connector", async () => {
    await expect(
      bundle.service.updateConnector(TENANT_B, CONNECTOR_ID, { name: "Hack" }),
    ).rejects.toBeInstanceOf(ConnectorNotFoundError);
  });

  it("throws ConnectorNotFoundError when connector does not exist", async () => {
    bundle.connectorRepo.findById.mockResolvedValue(null);
    await expect(
      bundle.service.updateConnector(TENANT_A, CONNECTOR_ID, { name: "x" }),
    ).rejects.toBeInstanceOf(ConnectorNotFoundError);
  });

  it("throws ConnectorNotFoundError when repo.update returns null", async () => {
    bundle.connectorRepo.update.mockResolvedValue(null);
    await expect(
      bundle.service.updateConnector(TENANT_A, CONNECTOR_ID, { name: "x" }),
    ).rejects.toBeInstanceOf(ConnectorNotFoundError);
  });

  it("logs a connector updated event", async () => {
    await bundle.service.updateConnector(TENANT_A, CONNECTOR_ID, { name: "x" });
    const infoCalls = (bundle.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(infoCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// deleteConnector
// ---------------------------------------------------------------------------

describe("deleteConnector", () => {
  let bundle: ServiceBundle;

  beforeEach(() => {
    bundle = makeService();
    bundle.connectorRepo.findById.mockResolvedValue(makeConnectorRow());
    bundle.connectorRepo.softDelete.mockResolvedValue(true);
    bundle.credentialService.deleteByConnectorId.mockResolvedValue(undefined);
  });

  it("resolves successfully for the correct tenant", async () => {
    await expect(bundle.service.deleteConnector(TENANT_A, CONNECTOR_ID)).resolves.toBeUndefined();
  });

  it("calls softDelete on the connector repo", async () => {
    await bundle.service.deleteConnector(TENANT_A, CONNECTOR_ID);
    expect(bundle.connectorRepo.softDelete.mock.calls[0]?.[0]).toBe(CONNECTOR_ID);
  });

  it("calls deleteByConnectorId on the credential service", async () => {
    await bundle.service.deleteConnector(TENANT_A, CONNECTOR_ID);
    expect(bundle.credentialService.deleteByConnectorId.mock.calls[0]?.[0]).toBe(CONNECTOR_ID);
  });

  it("throws ConnectorNotFoundError when connector belongs to different tenant", async () => {
    await expect(bundle.service.deleteConnector(TENANT_B, CONNECTOR_ID)).rejects.toBeInstanceOf(
      ConnectorNotFoundError,
    );
  });

  it("throws ConnectorNotFoundError when connector does not exist", async () => {
    bundle.connectorRepo.findById.mockResolvedValue(null);
    await expect(bundle.service.deleteConnector(TENANT_A, CONNECTOR_ID)).rejects.toBeInstanceOf(
      ConnectorNotFoundError,
    );
  });

  it("logs a connector deleted event", async () => {
    await bundle.service.deleteConnector(TENANT_A, CONNECTOR_ID);
    const infoCalls = (bundle.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(infoCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// testConnector
// ---------------------------------------------------------------------------

describe("testConnector", () => {
  let bundle: ServiceBundle;

  beforeEach(() => {
    bundle = makeService("http://exec:3000");
    bundle.connectorRepo.findById.mockResolvedValue(makeConnectorRow());
    bundle.syncStateRepo.findByConnectorId.mockResolvedValue(makeSyncStateRow());
    bundle.credentialService.listFieldNames.mockResolvedValue(["apiKey"]);

    vi.stubGlobal("fetch", vi.fn());
  });

  it("throws ConnectorDisabledError when connector is disabled", async () => {
    bundle.connectorRepo.findById.mockResolvedValue(makeConnectorRow({ is_enabled: false }));
    await expect(
      bundle.service.testConnector(TENANT_A, CONNECTOR_ID),
    ).rejects.toBeInstanceOf(ConnectorDisabledError);
  });

  it("throws ConnectorNotFoundError when connector belongs to different tenant", async () => {
    await expect(
      bundle.service.testConnector(TENANT_B, CONNECTOR_ID),
    ).rejects.toBeInstanceOf(ConnectorNotFoundError);
  });

  it("returns success result when execution service responds 200", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ sampleRecords: [{ id: 1 }] }),
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await bundle.service.testConnector(TENANT_A, CONNECTOR_ID);
    expect(result.success).toBe(true);
    expect(result.message).toBe("Connector test succeeded.");
  });

  it("includes sampleRecords (capped at 3) on success", async () => {
    const samples = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ sampleRecords: samples }),
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await bundle.service.testConnector(TENANT_A, CONNECTOR_ID);
    expect(result.sampleRecords).toHaveLength(3);
  });

  it("returns failure result when execution service responds non-200", async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ message: "Bad plugin config", code: "PLUGIN_CONFIG_ERROR" }),
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await bundle.service.testConnector(TENANT_A, CONNECTOR_ID);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PLUGIN_CONFIG_ERROR");
  });

  it("returns failure result when fetch rejects (execution service unreachable)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await bundle.service.testConnector(TENANT_A, CONNECTOR_ID);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("EXECUTION_UNREACHABLE");
  });

  it("merges config overrides into the effective config", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    await bundle.service.testConnector(TENANT_A, CONNECTOR_ID, undefined, {
      config: { extraParam: "override" },
    });

    const fetchBody = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { body: string }).body,
    ) as { config: Record<string, unknown> };
    expect(fetchBody.config["extraParam"]).toBe("override");
  });

  it("latencyMs is a non-negative number", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const result = await bundle.service.testConnector(TENANT_A, CONNECTOR_ID);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
