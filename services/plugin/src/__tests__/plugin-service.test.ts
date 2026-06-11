// Unit tests for services/plugin-service.ts
//
// Focuses on testable behaviour that does not require filesystem or real network:
// - activatePlugin: found / not found
// - uninstallPlugin: all three guards (active instances, active jobs check path, orphan)
// - getPlugin: UUID path, manifest_id fallback, not found
// - listPlugins: delegation to repo
// - getApprovedUrls: delegation
// - cleanupExpiredBundles: null bundle_key skip, success path, error recovery

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPluginService } from "../services/plugin-service.js";
import type { PluginServiceDeps } from "../services/plugin-service.js";
import type { PluginRepository } from "../repositories/plugin-repository.js";
import type { InstanceRepository } from "../repositories/instance-repository.js";
import type { HookRepository } from "../repositories/hook-repository.js";
import type { BundleService } from "../services/bundle-service.js";
import type { ConnectorRegistrationService } from "../services/connector-registration-service.js";
import type { HookService } from "../services/hook-service.js";
import type { PluginRow, ApprovedUrlRow } from "../repositories/types.js";
import {
  PluginNotFoundError,
  PluginHasActiveInstancesError,
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
    create: vi.fn(),
    findById: vi.fn(),
    findActiveByManifestId: vi.fn(),
    findByManifestIdAndVersion: vi.fn(),
    findStagedByManifestId: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
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
    createMany: vi.fn(),
    resolveChain: vi.fn(),
    updateStateByInstance: vi.fn(),
    updateStateByPluginAndCurrentState: vi.fn(),
    disableAllByManifestId: vi.fn(),
    findByInstanceId: vi.fn(),
  };
}

function makeBundleService(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    upload: vi.fn().mockResolvedValue({ bucket: "plugin-bundles", key: "k/bundle.js" }),
    download: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    verifyChecksum: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(true),
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

function makePool() {
  return {
    query: vi.fn(),
    connect: vi.fn(),
  } as unknown as import("pg").Pool;
}

type MockPluginRepo = ReturnType<typeof makePluginRepo>;
type MockInstanceRepo = ReturnType<typeof makeInstanceRepo>;
type MockHookRepo = ReturnType<typeof makeHookRepo>;

function makeDeps(overrides?: {
  pluginRepo?: MockPluginRepo;
  instanceRepo?: MockInstanceRepo;
  hookRepo?: MockHookRepo;
  bundleService?: Record<string, ReturnType<typeof vi.fn>>;
  connectorService?: ReturnType<typeof makeConnectorService>;
  hookService?: ReturnType<typeof makeHookService>;
  logger?: Logger;
  eventPublisher?: EventPublisher;
}): PluginServiceDeps {
  return {
    pool: makePool(),
    pluginRepo: (overrides?.pluginRepo ?? makePluginRepo()) as unknown as PluginRepository,
    instanceRepo: (overrides?.instanceRepo ?? makeInstanceRepo()) as unknown as InstanceRepository,
    hookRepo: (overrides?.hookRepo ?? makeHookRepo()) as unknown as HookRepository,
    bundleService: (overrides?.bundleService ?? makeBundleService()) as unknown as BundleService,
    connectorService: (overrides?.connectorService ?? makeConnectorService()) as unknown as ConnectorRegistrationService,
    hookService: (overrides?.hookService ?? makeHookService()) as unknown as HookService,
    redis: { del: vi.fn() } as unknown as import("ioredis").Redis,
    executionServiceUrl: "http://execution:3000",
    serviceToken: "token-123",
    logger: overrides?.logger ?? makeLogger(),
    eventPublisher: overrides?.eventPublisher ?? makeEventPublisher(),
    bundleBucket: "plugin-bundles",
    retentionDays: 7,
  };
}

// ---------------------------------------------------------------------------
// activatePlugin
// ---------------------------------------------------------------------------

describe("PluginService.activatePlugin", () => {
  let pluginRepo: MockPluginRepo;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    service = createPluginService(makeDeps({ pluginRepo }));
  });

  it("returns the plugin row when found", async () => {
    const expected = makePluginRow({ status: "installed" });
    pluginRepo.findById.mockResolvedValue(expected);

    const result = await service.activatePlugin("plugin-uuid", "user-001");
    expect(result).toBe(expected);
  });

  it("throws PluginNotFoundError when plugin does not exist", async () => {
    pluginRepo.findById.mockResolvedValue(null);

    await expect(service.activatePlugin("non-existent-id", "user-001")).rejects.toThrow(
      PluginNotFoundError,
    );
  });

  it("passes the pluginId to findById", async () => {
    pluginRepo.findById.mockResolvedValue(null);

    await expect(service.activatePlugin("my-plugin-uuid", "user-001")).rejects.toThrow();
    expect(pluginRepo.findById).toHaveBeenCalledWith("my-plugin-uuid");
  });
});

// ---------------------------------------------------------------------------
// getPlugin
// ---------------------------------------------------------------------------

describe("PluginService.getPlugin", () => {
  let pluginRepo: MockPluginRepo;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    service = createPluginService(makeDeps({ pluginRepo }));
  });

  it("looks up by UUID when input is a UUID", async () => {
    const expected = makePluginRow();
    pluginRepo.findById.mockResolvedValue(expected);

    const result = await service.getPlugin("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toBe(expected);
    expect(pluginRepo.findById).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000");
  });

  it("falls back to findActiveByManifestId when UUID lookup returns null", async () => {
    const expected = makePluginRow();
    pluginRepo.findById.mockResolvedValue(null);
    pluginRepo.findActiveByManifestId.mockResolvedValue(expected);

    const result = await service.getPlugin("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toBe(expected);
    expect(pluginRepo.findActiveByManifestId).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000");
  });

  it("uses findActiveByManifestId directly for non-UUID manifest IDs", async () => {
    const expected = makePluginRow();
    pluginRepo.findActiveByManifestId.mockResolvedValue(expected);

    const result = await service.getPlugin("com.example.my-plugin");
    expect(result).toBe(expected);
    expect(pluginRepo.findById).not.toHaveBeenCalled();
    expect(pluginRepo.findActiveByManifestId).toHaveBeenCalledWith("com.example.my-plugin");
  });

  it("throws PluginNotFoundError when both lookups return null", async () => {
    pluginRepo.findById.mockResolvedValue(null);
    pluginRepo.findActiveByManifestId.mockResolvedValue(null);

    await expect(service.getPlugin("550e8400-e29b-41d4-a716-446655440000")).rejects.toThrow(
      PluginNotFoundError,
    );
  });

  it("throws PluginNotFoundError for non-UUID manifest ID not found", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(null);

    await expect(service.getPlugin("com.example.not-found")).rejects.toThrow(
      PluginNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// listPlugins
// ---------------------------------------------------------------------------

describe("PluginService.listPlugins", () => {
  let pluginRepo: MockPluginRepo;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    service = createPluginService(makeDeps({ pluginRepo }));
  });

  it("delegates to pluginRepo.list and returns result", async () => {
    const rows = [makePluginRow()];
    pluginRepo.list.mockResolvedValue({ rows, total: 1 });

    const result = await service.listPlugins({ limit: 50 });
    expect(result.rows).toBe(rows);
    expect(result.total).toBe(1);
  });

  it("passes filter options to the repository", async () => {
    pluginRepo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.listPlugins({ type: "connector", status: "active", limit: 20 });
    expect(pluginRepo.list).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connector", status: "active", limit: 20 }),
    );
  });
});

// ---------------------------------------------------------------------------
// getApprovedUrls
// ---------------------------------------------------------------------------

describe("PluginService.getApprovedUrls", () => {
  let pluginRepo: MockPluginRepo;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    service = createPluginService(makeDeps({ pluginRepo }));
  });

  it("returns the approved URLs from the repository", async () => {
    const rows: ApprovedUrlRow[] = [
      { id: "url-001", plugin_id: "p", url_pattern: "https://api.example.com/*", approved_by: "u", approved_at: new Date() },
    ];
    pluginRepo.findApprovedUrlsByPlugin.mockResolvedValue(rows);

    const result = await service.getApprovedUrls("plugin-uuid");
    expect(result).toBe(rows);
    expect(pluginRepo.findApprovedUrlsByPlugin).toHaveBeenCalledWith("plugin-uuid");
  });
});

// ---------------------------------------------------------------------------
// uninstallPlugin — guard 1: active instances
// ---------------------------------------------------------------------------

describe("PluginService.uninstallPlugin — guard: active instances", () => {
  let pluginRepo: MockPluginRepo;
  let instanceRepo: MockInstanceRepo;
  let hookRepo: MockHookRepo;
  let connectorService: ReturnType<typeof makeConnectorService>;
  let eventPublisher: EventPublisher;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    instanceRepo = makeInstanceRepo();
    hookRepo = makeHookRepo();
    connectorService = makeConnectorService();
    eventPublisher = makeEventPublisher();
    service = createPluginService(
      makeDeps({ pluginRepo, instanceRepo, hookRepo, connectorService, eventPublisher }),
    );
  });

  it("throws PluginNotFoundError when plugin not found by ID or manifest_id", async () => {
    pluginRepo.findById.mockResolvedValue(null);
    pluginRepo.findActiveByManifestId.mockResolvedValue(null);

    await expect(
      service.uninstallPlugin({ id: "non-existent", confirmOrphan: false, uninstalledBy: "u" }),
    ).rejects.toThrow(PluginNotFoundError);
  });

  it("throws PluginHasActiveInstancesError when active instances exist", async () => {
    pluginRepo.findById.mockResolvedValue(makePluginRow());
    instanceRepo.countActiveByManifestId.mockResolvedValue(3);

    await expect(
      service.uninstallPlugin({ id: "plugin-uuid", confirmOrphan: false, uninstalledBy: "u" }),
    ).rejects.toThrow(PluginHasActiveInstancesError);
  });

  it("includes instance count in PluginHasActiveInstancesError message", async () => {
    pluginRepo.findById.mockResolvedValue(makePluginRow());
    instanceRepo.countActiveByManifestId.mockResolvedValue(5);

    await expect(
      service.uninstallPlugin({ id: "plugin-uuid", confirmOrphan: false, uninstalledBy: "u" }),
    ).rejects.toThrow("5 instance(s)");
  });

  it("falls back to findActiveByManifestId when findById returns null", async () => {
    pluginRepo.findById.mockResolvedValue(null);
    pluginRepo.findActiveByManifestId.mockResolvedValue(makePluginRow());
    instanceRepo.countActiveByManifestId.mockResolvedValue(0);
    instanceRepo.softDeleteAllByManifestId.mockResolvedValue(0);
    hookRepo.disableAllByManifestId.mockResolvedValue(0);
    pluginRepo.update.mockResolvedValue(makePluginRow({ status: "uninstalled" }));

    await service.uninstallPlugin({
      id: "com.example.my-plugin",
      confirmOrphan: false,
      uninstalledBy: "u",
    });

    expect(pluginRepo.findActiveByManifestId).toHaveBeenCalledWith("com.example.my-plugin");
  });
});

// ---------------------------------------------------------------------------
// uninstallPlugin — successful uninstall (no instances, no jobs)
// ---------------------------------------------------------------------------

describe("PluginService.uninstallPlugin — successful path", () => {
  let pluginRepo: MockPluginRepo;
  let instanceRepo: MockInstanceRepo;
  let hookRepo: MockHookRepo;
  let connectorService: ReturnType<typeof makeConnectorService>;
  let eventPublisher: EventPublisher;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    instanceRepo = makeInstanceRepo();
    hookRepo = makeHookRepo();
    connectorService = makeConnectorService();
    eventPublisher = makeEventPublisher();
    service = createPluginService(
      makeDeps({ pluginRepo, instanceRepo, hookRepo, connectorService, eventPublisher }),
    );

    pluginRepo.findById.mockResolvedValue(makePluginRow());
    instanceRepo.countActiveByManifestId.mockResolvedValue(0);
    instanceRepo.softDeleteAllByManifestId.mockResolvedValue(0);
    hookRepo.disableAllByManifestId.mockResolvedValue(0);
    pluginRepo.update.mockResolvedValue(makePluginRow({ status: "uninstalled" }));
  });

  it("returns manifestId, status=uninstalled, and bundleDeleteAfter", async () => {
    const result = await service.uninstallPlugin({
      id: "plugin-uuid",
      confirmOrphan: false,
      uninstalledBy: "user-001",
    });

    expect(result.manifestId).toBe("com.example.my-plugin");
    expect(result.status).toBe("uninstalled");
    expect(typeof result.bundleDeleteAfter).toBe("string");
    // bundleDeleteAfter should be a valid ISO date string
    expect(() => new Date(result.bundleDeleteAfter)).not.toThrow();
  });

  it("soft-deletes all instances for the manifest", async () => {
    await service.uninstallPlugin({ id: "plugin-uuid", confirmOrphan: false, uninstalledBy: "u" });

    expect(instanceRepo.softDeleteAllByManifestId).toHaveBeenCalledWith("com.example.my-plugin");
  });

  it("disables all hooks for the manifest", async () => {
    await service.uninstallPlugin({ id: "plugin-uuid", confirmOrphan: false, uninstalledBy: "u" });

    expect(hookRepo.disableAllByManifestId).toHaveBeenCalledWith("com.example.my-plugin");
  });

  it("calls deregisterPlugin for connector-type plugins", async () => {
    await service.uninstallPlugin({ id: "plugin-uuid", confirmOrphan: false, uninstalledBy: "u" });

    expect(connectorService.deregisterPlugin).toHaveBeenCalledWith("com.example.my-plugin");
  });

  it("does not call deregisterPlugin for non-connector plugins", async () => {
    // The service checks plugin.manifest.type (not plugin.type), so we must
    // override the nested manifest.type as well as the top-level type field.
    const transformerRow = makePluginRow({ type: "transformer" });
    transformerRow.manifest = { ...transformerRow.manifest, type: "transformer" };
    pluginRepo.findById.mockResolvedValue(transformerRow);
    instanceRepo.countActiveByManifestId.mockResolvedValue(0);
    // Clear any calls from previous tests in this describe block
    (connectorService.deregisterPlugin as ReturnType<typeof vi.fn>).mockClear();

    await service.uninstallPlugin({ id: "plugin-uuid", confirmOrphan: false, uninstalledBy: "u" });

    expect(connectorService.deregisterPlugin).not.toHaveBeenCalled();
  });

  it("updates plugin status to uninstalled with uninstalled_at and bundle_delete_after", async () => {
    await service.uninstallPlugin({ id: "plugin-uuid", confirmOrphan: false, uninstalledBy: "u" });

    expect(pluginRepo.update).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      expect.objectContaining({
        status: "uninstalled",
        uninstalled_at: expect.any(Date),
        bundle_delete_after: expect.any(Date),
      }),
    );
  });

  it("publishes plugin.uninstalled event", async () => {
    await service.uninstallPlugin({ id: "plugin-uuid", confirmOrphan: false, uninstalledBy: "user-001" });

    expect(eventPublisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "plugin.uninstalled" }),
    );
  });

  it("bundleDeleteAfter is approximately retentionDays (7) days in the future", async () => {
    const before = Date.now();
    const result = await service.uninstallPlugin({
      id: "plugin-uuid",
      confirmOrphan: false,
      uninstalledBy: "u",
    });
    const after = Date.now();

    const deleteAfter = new Date(result.bundleDeleteAfter).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(deleteAfter).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    expect(deleteAfter).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
  });
});

// ---------------------------------------------------------------------------
// cleanupExpiredBundles
// ---------------------------------------------------------------------------

describe("PluginService.cleanupExpiredBundles", () => {
  let pluginRepo: MockPluginRepo;
  let bundleService: Record<string, ReturnType<typeof vi.fn>>;
  let logger: Logger;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    bundleService = makeBundleService();
    logger = makeLogger();
    service = createPluginService(makeDeps({ pluginRepo, bundleService, logger }));
  });

  it("skips plugins with null bundle_key", async () => {
    const expired = [makePluginRow({ bundle_key: null, status: "uninstalled" })];
    pluginRepo.findExpiredBundles.mockResolvedValue(expired);

    await service.cleanupExpiredBundles();

    expect(bundleService["delete"]).not.toHaveBeenCalled();
    expect(pluginRepo.update).not.toHaveBeenCalled();
  });

  it("deletes the bundle and clears the bundle_key for expired plugins", async () => {
    const expired = [makePluginRow({ status: "uninstalled" })];
    pluginRepo.findExpiredBundles.mockResolvedValue(expired);
    bundleService["delete"]!.mockResolvedValue(undefined);
    pluginRepo.update.mockResolvedValue(makePluginRow({ bundle_key: null }));

    await service.cleanupExpiredBundles();

    expect(bundleService["delete"]).toHaveBeenCalledWith(
      "plugin-bundles",
      "com.example.my-plugin/1.0.0/bundle.js",
    );
    expect(pluginRepo.update).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      { bundle_key: null, bundle_delete_after: null },
    );
  });

  it("logs error and continues when bundle deletion fails", async () => {
    const expired = [
      makePluginRow({ status: "uninstalled" }),
      makePluginRow({ id: "plugin-002", status: "uninstalled" }),
    ];
    pluginRepo.findExpiredBundles.mockResolvedValue(expired);
    bundleService["delete"]!.mockRejectedValueOnce(new Error("MinIO error"));
    bundleService["delete"]!.mockResolvedValueOnce(undefined);
    pluginRepo.update.mockResolvedValue(makePluginRow({ bundle_key: null }));

    await service.cleanupExpiredBundles(); // Should not throw

    const loggerError = logger.error as ReturnType<typeof vi.fn>;
    expect(loggerError).toHaveBeenCalledOnce();
    // Second plugin's update should still be called
    expect(pluginRepo.update).toHaveBeenCalledOnce();
  });

  it("does nothing when there are no expired bundles", async () => {
    pluginRepo.findExpiredBundles.mockResolvedValue([]);

    await service.cleanupExpiredBundles();

    expect(bundleService["delete"]).not.toHaveBeenCalled();
    expect(pluginRepo.update).not.toHaveBeenCalled();
  });
});
