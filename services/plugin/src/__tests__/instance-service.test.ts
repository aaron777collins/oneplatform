// Unit tests for services/instance-service.ts
//
// Covers: createInstance (not found, not active, success), patchInstance
// (not found, enable/disable routing), listInstances (UUID vs manifest_id,
// platform admin flag), getInstance (found / not found).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInstanceService } from "../services/instance-service.js";
import type { InstanceServiceDeps } from "../services/instance-service.js";
import type { PluginRepository } from "../repositories/plugin-repository.js";
import type { InstanceRepository } from "../repositories/instance-repository.js";
import type { HookRepository } from "../repositories/hook-repository.js";
import type { ConnectorRegistrationService } from "../services/connector-registration-service.js";
import type { HookService } from "../services/hook-service.js";
import type { PluginRow, InstanceRow } from "../repositories/types.js";
import {
  PluginNotFoundError,
  InstanceNotFoundError,
  PluginNotActiveError,
  ConfigValidationFailedError,
} from "../services/errors.js";
import type { Logger, EventPublisher } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

const VALID_CHECKSUM = "a".repeat(64);

function makePluginRow(overrides?: Partial<PluginRow>): PluginRow {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    manifest_id: "com.example.my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    type: "connector",
    status: "active",
    bundle_bucket: "plugin-bundles",
    bundle_key: "com.example.my-plugin/1.0.0/bundle.js",
    manifest: {
      manifestVersion: "1",
      id: "com.example.my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      type: "connector",
      description: "Test",
      author: "Author",
      minPlatformVersion: "1.0.0",
      entrypoint: "dist/bundle.js",
      configSchema: {},
      hooks: [],
      requiredExternalUrls: [],
      requiredApis: [],
      requiredCredentials: [],
      bundleChecksum: VALID_CHECKSUM,
      license: "MIT",
    },
    is_platform_wide: false,
    gpg_fingerprint: null,
    installed_at: new Date("2026-01-01T00:00:00Z"),
    installed_by: "user-001",
    uninstalled_at: null,
    bundle_delete_after: null,
    ...overrides,
  };
}

function makeInstanceRow(overrides?: Partial<InstanceRow>): InstanceRow {
  return {
    id: "inst-001",
    plugin_manifest_id: "com.example.my-plugin",
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    tenant_id: "tenant-001",
    display_name: "My Instance",
    config: {},
    enabled: "enabled",
    created_at: new Date("2026-01-01T00:00:00Z"),
    created_by: "user-001",
    updated_at: new Date("2026-01-01T00:00:00Z"),
    updated_by: null,
    deleted_at: null,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeEventPublisher(): EventPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventPublisher;
}

function makePluginRepo() {
  return {
    findById: vi.fn(),
    findActiveByManifestId: vi.fn(),
    findByManifestIdAndVersion: vi.fn(),
    findStagedByManifestId: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    findExpiredBundles: vi.fn(),
    createApprovedUrl: vi.fn(),
    findApprovedUrlsByPlugin: vi.fn(),
  };
}

function makeInstanceRepo() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByIdAndTenant: vi.fn(),
    findByPluginManifestId: vi.fn(),
    countActiveByManifestId: vi.fn(),
    update: vi.fn(),
    updatePluginIdForManifest: vi.fn(),
    softDeleteAllByManifestId: vi.fn(),
    findEnabledConnectorsByTenant: vi.fn(),
  };
}

function makeHookRepo() {
  return {
    createMany: vi.fn().mockResolvedValue([]),
    resolveChain: vi.fn(),
    updateStateByInstance: vi.fn().mockResolvedValue(0),
    updateStateByPluginAndCurrentState: vi.fn(),
    disableAllByManifestId: vi.fn(),
    findByInstanceId: vi.fn(),
  };
}

function makeConnectorService() {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    deregisterPlugin: vi.fn().mockResolvedValue(undefined),
    deregisterInstance: vi.fn().mockResolvedValue(undefined),
  };
}

function makeHookService() {
  return {
    resolveChain: vi.fn().mockResolvedValue([]),
    buildHookDataFromManifest: vi.fn().mockReturnValue([]),
  };
}

type MockPluginRepo = ReturnType<typeof makePluginRepo>;
type MockInstanceRepo = ReturnType<typeof makeInstanceRepo>;
type MockHookRepo = ReturnType<typeof makeHookRepo>;

function makePool() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [makeInstanceRow()] }),
    release: vi.fn(),
  };
  return {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
    _mockClient: client,
  };
}

function makeDeps(overrides?: {
  pluginRepo?: MockPluginRepo;
  instanceRepo?: MockInstanceRepo;
  hookRepo?: MockHookRepo;
  connectorService?: ReturnType<typeof makeConnectorService>;
  hookService?: ReturnType<typeof makeHookService>;
  logger?: Logger;
  eventPublisher?: EventPublisher;
  pool?: ReturnType<typeof makePool>;
}): InstanceServiceDeps {
  return {
    pool: (overrides?.pool ?? makePool()) as unknown as import("pg").Pool,
    pluginRepo: (overrides?.pluginRepo ?? makePluginRepo()) as unknown as PluginRepository,
    instanceRepo: (overrides?.instanceRepo ?? makeInstanceRepo()) as unknown as InstanceRepository,
    hookRepo: (overrides?.hookRepo ?? makeHookRepo()) as unknown as HookRepository,
    connectorService: (overrides?.connectorService ?? makeConnectorService()) as unknown as ConnectorRegistrationService,
    hookService: (overrides?.hookService ?? makeHookService()) as unknown as HookService,
    executionServiceUrl: "http://execution:3000",
    serviceToken: "token-123",
    drainGraceSeconds: 60,
    logger: overrides?.logger ?? makeLogger(),
    eventPublisher: overrides?.eventPublisher ?? makeEventPublisher(),
  };
}

// ---------------------------------------------------------------------------
// createInstance — plugin resolution failures
// ---------------------------------------------------------------------------

describe("InstanceService.createInstance — plugin resolution", () => {
  let pluginRepo: MockPluginRepo;
  let service: ReturnType<typeof createInstanceService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    service = createInstanceService(makeDeps({ pluginRepo }));
  });

  it("throws PluginNotFoundError when neither lookup finds the plugin", async () => {
    pluginRepo.findById.mockRejectedValue(new Error("bad uuid"));
    pluginRepo.findActiveByManifestId.mockResolvedValue(null);

    await expect(
      service.createInstance({
        pluginIdOrManifestId: "not-found",
        tenantId: "t",
        displayName: "D",
        config: {},
        createdBy: "u",
      }),
    ).rejects.toThrow(PluginNotFoundError);
  });

  it("throws PluginNotActiveError when plugin is not in active status", async () => {
    pluginRepo.findById.mockRejectedValue(new Error("bad uuid"));
    pluginRepo.findActiveByManifestId.mockResolvedValue(
      makePluginRow({ status: "installed" })
    );

    await expect(
      service.createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: {},
        createdBy: "u",
      }),
    ).rejects.toThrow(PluginNotActiveError);
  });
});

// ---------------------------------------------------------------------------
// getInstance
// ---------------------------------------------------------------------------

describe("InstanceService.getInstance", () => {
  let instanceRepo: MockInstanceRepo;
  let service: ReturnType<typeof createInstanceService>;

  beforeEach(() => {
    instanceRepo = makeInstanceRepo();
    service = createInstanceService(makeDeps({ instanceRepo }));
  });

  it("returns the instance when found", async () => {
    const expected = makeInstanceRow();
    instanceRepo.findByIdAndTenant.mockResolvedValue(expected);

    const result = await service.getInstance("inst-001", "tenant-001");
    expect(result).toBe(expected);
  });

  it("throws InstanceNotFoundError when not found", async () => {
    instanceRepo.findByIdAndTenant.mockResolvedValue(null);

    await expect(service.getInstance("inst-999", "tenant-001")).rejects.toThrow(
      InstanceNotFoundError,
    );
  });

  it("passes instanceId and tenantId to findByIdAndTenant", async () => {
    instanceRepo.findByIdAndTenant.mockResolvedValue(null);

    await expect(service.getInstance("inst-abc", "tenant-xyz")).rejects.toThrow();
    expect(instanceRepo.findByIdAndTenant).toHaveBeenCalledWith("inst-abc", "tenant-xyz");
  });
});

// ---------------------------------------------------------------------------
// patchInstance — not found
// ---------------------------------------------------------------------------

describe("InstanceService.patchInstance — not found", () => {
  let instanceRepo: MockInstanceRepo;
  let service: ReturnType<typeof createInstanceService>;

  beforeEach(() => {
    instanceRepo = makeInstanceRepo();
    service = createInstanceService(makeDeps({ instanceRepo }));
  });

  it("throws InstanceNotFoundError when instance does not exist", async () => {
    instanceRepo.findByIdAndTenant.mockResolvedValue(null);

    await expect(
      service.patchInstance({
        instanceId: "inst-999",
        tenantId: "tenant-001",
        updatedBy: "user-001",
        displayName: "New Name",
      }),
    ).rejects.toThrow(InstanceNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// patchInstance — config and displayName updates
// ---------------------------------------------------------------------------

describe("InstanceService.patchInstance — config/displayName update", () => {
  let instanceRepo: MockInstanceRepo;
  let pluginRepo: MockPluginRepo;
  let service: ReturnType<typeof createInstanceService>;

  beforeEach(() => {
    instanceRepo = makeInstanceRepo();
    pluginRepo = makePluginRepo();
    service = createInstanceService(makeDeps({ instanceRepo, pluginRepo }));
  });

  it("updates config via instanceRepo when config is provided", async () => {
    const inst = makeInstanceRow();
    const updated = makeInstanceRow({ config: { retries: 5 } });
    instanceRepo.findByIdAndTenant
      .mockResolvedValueOnce(inst)   // initial fetch
      .mockResolvedValueOnce(updated); // final refresh
    instanceRepo.update.mockResolvedValue(updated);
    // patchInstance calls pluginRepo.findById to validate config against configSchema
    pluginRepo.findById.mockResolvedValue(makePluginRow());

    await service.patchInstance({
      instanceId: "inst-001",
      tenantId: "tenant-001",
      updatedBy: "user-001",
      config: { retries: 5 },
    });

    expect(instanceRepo.update).toHaveBeenCalledWith(
      "inst-001",
      expect.objectContaining({ config: { retries: 5 } }),
    );
  });

  it("updates displayName via instanceRepo when displayName is provided", async () => {
    const inst = makeInstanceRow();
    const updated = makeInstanceRow({ display_name: "New Name" });
    instanceRepo.findByIdAndTenant
      .mockResolvedValueOnce(inst)
      .mockResolvedValueOnce(updated);
    instanceRepo.update.mockResolvedValue(updated);

    await service.patchInstance({
      instanceId: "inst-001",
      tenantId: "tenant-001",
      updatedBy: "user-001",
      displayName: "New Name",
    });

    expect(instanceRepo.update).toHaveBeenCalledWith(
      "inst-001",
      expect.objectContaining({ display_name: "New Name" }),
    );
  });

  it("throws InstanceNotFoundError when refreshed instance is null after update", async () => {
    const inst = makeInstanceRow();
    instanceRepo.findByIdAndTenant
      .mockResolvedValueOnce(inst)
      .mockResolvedValueOnce(null); // disappears mid-flight
    instanceRepo.update.mockResolvedValue(inst);

    await expect(
      service.patchInstance({
        instanceId: "inst-001",
        tenantId: "tenant-001",
        updatedBy: "user-001",
        displayName: "New Name",
      }),
    ).rejects.toThrow(InstanceNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// listInstances
// ---------------------------------------------------------------------------

describe("InstanceService.listInstances", () => {
  let pluginRepo: MockPluginRepo;
  let instanceRepo: MockInstanceRepo;
  let service: ReturnType<typeof createInstanceService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    instanceRepo = makeInstanceRepo();
    service = createInstanceService(makeDeps({ pluginRepo, instanceRepo }));
  });

  it("resolves manifestId from UUID when pluginIdOrManifestId is a UUID", async () => {
    const plugin = makePluginRow();
    pluginRepo.findById.mockResolvedValue(plugin);
    instanceRepo.findByPluginManifestId.mockResolvedValue([]);

    await service.listInstances({
      pluginIdOrManifestId: "550e8400-e29b-41d4-a716-446655440000",
      tenantId: "tenant-001",
      isPlatformAdmin: false,
    });

    expect(instanceRepo.findByPluginManifestId).toHaveBeenCalledWith(
      "com.example.my-plugin",
      expect.anything(),
    );
  });

  it("uses pluginIdOrManifestId directly when it is not a UUID", async () => {
    instanceRepo.findByPluginManifestId.mockResolvedValue([]);

    await service.listInstances({
      pluginIdOrManifestId: "com.example.my-plugin",
      tenantId: "tenant-001",
      isPlatformAdmin: false,
    });

    expect(pluginRepo.findById).not.toHaveBeenCalled();
    expect(instanceRepo.findByPluginManifestId).toHaveBeenCalledWith(
      "com.example.my-plugin",
      expect.anything(),
    );
  });

  it("throws PluginNotFoundError when UUID lookup fails during list", async () => {
    pluginRepo.findById.mockResolvedValue(null);

    await expect(
      service.listInstances({
        pluginIdOrManifestId: "550e8400-e29b-41d4-a716-446655440000",
        tenantId: "tenant-001",
        isPlatformAdmin: false,
      }),
    ).rejects.toThrow(PluginNotFoundError);
  });

  it("returns all instances for platform admin without tenant filter", async () => {
    instanceRepo.findByPluginManifestId.mockResolvedValue([makeInstanceRow()]);

    await service.listInstances({
      pluginIdOrManifestId: "com.example.my-plugin",
      isPlatformAdmin: true,
    });

    // Platform admin: called with empty options (no tenantId filter)
    expect(instanceRepo.findByPluginManifestId).toHaveBeenCalledWith(
      "com.example.my-plugin",
      {},
    );
  });

  it("filters by tenantId for non-platform-admin users", async () => {
    instanceRepo.findByPluginManifestId.mockResolvedValue([makeInstanceRow()]);

    await service.listInstances({
      pluginIdOrManifestId: "com.example.my-plugin",
      tenantId: "tenant-001",
      isPlatformAdmin: false,
    });

    expect(instanceRepo.findByPluginManifestId).toHaveBeenCalledWith(
      "com.example.my-plugin",
      { tenantId: "tenant-001" },
    );
  });
});

// ---------------------------------------------------------------------------
// createInstance — Ajv JSON Schema config validation (M-23)
//
// These tests exercise constraints the old hand-rolled validator did not cover:
// enum, minimum/maximum, minLength/maxLength, pattern, additionalProperties.
// ---------------------------------------------------------------------------

describe("InstanceService.createInstance — Ajv config validation", () => {
  function makeService(configSchema: Record<string, unknown>) {
    const pluginRepo = makePluginRepo();
    const instanceRepo = makeInstanceRepo();
    const pool = makePool();
    const plugin = makePluginRow({ manifest: { ...makePluginRow().manifest, configSchema } });

    // First call: UUID lookup fails (input is a manifest_id string, not a UUID).
    // Second call: enableInstance resolves the plugin by its actual UUID.
    pluginRepo.findById
      .mockRejectedValueOnce(new Error("bad uuid"))
      .mockResolvedValue(plugin);
    pluginRepo.findActiveByManifestId.mockResolvedValue(plugin);
    instanceRepo.create.mockResolvedValue(makeInstanceRow());

    const service = createInstanceService(
      makeDeps({ pluginRepo, instanceRepo, pool })
    );
    return { service, instanceRepo };
  }

  it("accepts config that satisfies an empty schema", async () => {
    const { service } = makeService({});

    // Should not throw — empty schema allows any object
    await expect(
      service.createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: { anything: true },
        createdBy: "u",
      })
    ).resolves.toBeDefined();
  });

  it("rejects config missing a required field", async () => {
    const { service } = makeService({
      type: "object",
      required: ["apiKey"],
      properties: { apiKey: { type: "string" } },
    });

    await expect(
      service.createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: {},
        createdBy: "u",
      })
    ).rejects.toThrow(ConfigValidationFailedError);
  });

  it("error message names the missing required field", async () => {
    const { service } = makeService({
      type: "object",
      required: ["apiKey"],
      properties: { apiKey: { type: "string" } },
    });

    const err = await service
      .createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: {},
        createdBy: "u",
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigValidationFailedError);
    expect((err as ConfigValidationFailedError).message).toMatch(/apiKey/);
  });

  it("rejects a field that fails an enum constraint", async () => {
    const { service } = makeService({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["read", "write"] },
      },
    });

    await expect(
      service.createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: { mode: "delete" },
        createdBy: "u",
      })
    ).rejects.toThrow(ConfigValidationFailedError);
  });

  it("rejects a number below the minimum constraint", async () => {
    const { service } = makeService({
      type: "object",
      required: ["retries"],
      properties: { retries: { type: "number", minimum: 1 } },
    });

    await expect(
      service.createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: { retries: 0 },
        createdBy: "u",
      })
    ).rejects.toThrow(ConfigValidationFailedError);
  });

  it("rejects a string shorter than minLength", async () => {
    const { service } = makeService({
      type: "object",
      required: ["token"],
      properties: { token: { type: "string", minLength: 8 } },
    });

    await expect(
      service.createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: { token: "short" },
        createdBy: "u",
      })
    ).rejects.toThrow(ConfigValidationFailedError);
  });

  it("rejects a string that does not match a pattern constraint", async () => {
    const { service } = makeService({
      type: "object",
      required: ["webhookUrl"],
      properties: { webhookUrl: { type: "string", pattern: "^https://" } },
    });

    await expect(
      service.createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: { webhookUrl: "http://insecure.example.com" },
        createdBy: "u",
      })
    ).rejects.toThrow(ConfigValidationFailedError);
  });

  it("rejects additional properties when additionalProperties is false", async () => {
    const { service } = makeService({
      type: "object",
      properties: { apiKey: { type: "string" } },
      additionalProperties: false,
    });

    await expect(
      service.createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        config: { apiKey: "valid", unknownField: "oops" },
        createdBy: "u",
      })
    ).rejects.toThrow(ConfigValidationFailedError);
  });

  it("collects multiple violations in one error (allErrors mode)", async () => {
    const { service } = makeService({
      type: "object",
      required: ["apiKey", "retries"],
      properties: {
        apiKey: { type: "string" },
        retries: { type: "number", minimum: 1 },
      },
    });

    const err = await service
      .createInstance({
        pluginIdOrManifestId: "com.example.my-plugin",
        tenantId: "t",
        displayName: "D",
        // Both required fields missing
        config: {},
        createdBy: "u",
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConfigValidationFailedError);
    // fieldErrors.config must contain one entry per violation
    const details = (err as ConfigValidationFailedError).details as
      | { fieldErrors?: Record<string, string[]> }
      | undefined;
    expect(details?.fieldErrors?.["config"]?.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// patchInstance — Ajv config validation on update (M-23)
// ---------------------------------------------------------------------------

describe("InstanceService.patchInstance — Ajv config validation", () => {
  it("rejects a patched config that violates the plugin's configSchema", async () => {
    const configSchema = {
      type: "object",
      required: ["apiKey"],
      properties: { apiKey: { type: "string", minLength: 10 } },
    };

    const pluginRepo = makePluginRepo();
    const instanceRepo = makeInstanceRepo();

    instanceRepo.findByIdAndTenant.mockResolvedValue(makeInstanceRow());
    // patchInstance loads the plugin to get configSchema
    pluginRepo.findById.mockResolvedValue(
      makePluginRow({ manifest: { ...makePluginRow().manifest, configSchema } })
    );

    const service = createInstanceService(makeDeps({ pluginRepo, instanceRepo }));

    await expect(
      service.patchInstance({
        instanceId: "inst-001",
        tenantId: "tenant-001",
        updatedBy: "user-001",
        config: { apiKey: "short" }, // fails minLength: 10
      })
    ).rejects.toThrow(ConfigValidationFailedError);
  });
});
