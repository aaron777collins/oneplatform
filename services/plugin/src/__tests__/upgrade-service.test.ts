// Unit tests for services/upgrade-service.ts
//
// Tests the deterministic, non-time-blocked paths:
// - upgrade: not found active, not found staged, not-staged status guard
// - rollback: not found active, no disabled version within rollback window
// The setTimeout(62_000) grace period is NOT awaited in tests — we verify
// the observable side-effects (queries, event publishing) via mock resolution.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUpgradeService } from "../services/upgrade-service.js";
import type { UpgradeServiceDeps } from "../services/upgrade-service.js";
import type { PluginRepository } from "../repositories/plugin-repository.js";
import type { InstanceRepository } from "../repositories/instance-repository.js";
import type { HookRepository } from "../repositories/hook-repository.js";
import type { HookService } from "../services/hook-service.js";
import type { PluginRow } from "../repositories/types.js";
import { PluginNotFoundError } from "../services/errors.js";
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
    findByPluginManifestId: vi.fn().mockResolvedValue([]),
    countActiveByManifestId: vi.fn(),
    update: vi.fn(),
    updatePluginIdForManifest: vi.fn().mockResolvedValue(0),
    softDeleteAllByManifestId: vi.fn(),
    findEnabledConnectorsByTenant: vi.fn(),
  };
}

function makeHookRepo() {
  return {
    createMany: vi.fn().mockResolvedValue([]),
    resolveChain: vi.fn(),
    updateStateByInstance: vi.fn().mockResolvedValue(0),
    updateStateByPluginAndCurrentState: vi.fn().mockResolvedValue(0),
    disableAllByManifestId: vi.fn(),
    findByInstanceId: vi.fn(),
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

function makeClient() {
  return {
    query: vi.fn().mockResolvedValue({ rowCount: 0 }),
    release: vi.fn(),
  };
}

function makePool(client?: ReturnType<typeof makeClient>) {
  const c = client ?? makeClient();
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(c),
    _mockClient: c,
  };
}

function makeDeps(overrides?: {
  pluginRepo?: MockPluginRepo;
  instanceRepo?: MockInstanceRepo;
  hookRepo?: MockHookRepo;
  hookService?: ReturnType<typeof makeHookService>;
  logger?: Logger;
  eventPublisher?: EventPublisher;
  pool?: ReturnType<typeof makePool>;
}): UpgradeServiceDeps {
  return {
    pool: (overrides?.pool ?? makePool()) as unknown as import("pg").Pool,
    pluginRepo: (overrides?.pluginRepo ?? makePluginRepo()) as unknown as PluginRepository,
    instanceRepo: (overrides?.instanceRepo ?? makeInstanceRepo()) as unknown as InstanceRepository,
    hookRepo: (overrides?.hookRepo ?? makeHookRepo()) as unknown as HookRepository,
    hookService: (overrides?.hookService ?? makeHookService()) as unknown as HookService,
    executionServiceUrl: "http://execution:3000",
    serviceToken: "token-123",
    logger: overrides?.logger ?? makeLogger(),
    eventPublisher: overrides?.eventPublisher ?? makeEventPublisher(),
  };
}

// ---------------------------------------------------------------------------
// upgrade — early error paths (no setTimeout needed)
// ---------------------------------------------------------------------------

describe("UpgradeService.upgrade — error paths", () => {
  let pluginRepo: MockPluginRepo;
  let service: ReturnType<typeof createUpgradeService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    service = createUpgradeService(makeDeps({ pluginRepo }));
  });

  it("throws PluginNotFoundError when no active version exists", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(null);

    await expect(
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "u" }),
    ).rejects.toThrow(PluginNotFoundError);
  });

  it("throws PluginNotFoundError when staged version is not found", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(makePluginRow());
    pluginRepo.findByManifestIdAndVersion.mockResolvedValue(null);

    await expect(
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "u" }),
    ).rejects.toThrow(PluginNotFoundError);
  });

  it("throws PluginNotFoundError when found version is not in 'staged' status", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(makePluginRow());
    pluginRepo.findByManifestIdAndVersion.mockResolvedValue(
      makePluginRow({ status: "installed" }) // not 'staged'
    );

    await expect(
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "u" }),
    ).rejects.toThrow(PluginNotFoundError);
  });

  it("includes manifestId in PluginNotFoundError when no active version", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(null);

    await expect(
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "u" }),
    ).rejects.toThrow("com.example.my-plugin");
  });

  it("includes toVersion in PluginNotFoundError when staged version missing", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(makePluginRow());
    pluginRepo.findByManifestIdAndVersion.mockResolvedValue(null);

    await expect(
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "u" }),
    ).rejects.toThrow("2.0.0");
  });
});

// ---------------------------------------------------------------------------
// rollback — early error paths
// ---------------------------------------------------------------------------

describe("UpgradeService.rollback — error paths", () => {
  let pluginRepo: MockPluginRepo;
  let pool: ReturnType<typeof makePool>;
  let service: ReturnType<typeof createUpgradeService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    pool = makePool();
    service = createUpgradeService(makeDeps({ pluginRepo, pool }));
  });

  it("throws PluginNotFoundError when no active version exists", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(null);

    await expect(
      service.rollback({ manifestId: "com.example.my-plugin", rolledBackBy: "u" }),
    ).rejects.toThrow(PluginNotFoundError);
  });

  it("throws PluginNotFoundError when no disabled version within rollback window", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(makePluginRow());
    // pool.query for the raw disabled-version lookup returns empty
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await expect(
      service.rollback({ manifestId: "com.example.my-plugin", rolledBackBy: "u" }),
    ).rejects.toThrow(PluginNotFoundError);
  });

  it("error message for no disabled version mentions 24h rollback window", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(makePluginRow());
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await expect(
      service.rollback({ manifestId: "com.example.my-plugin", rolledBackBy: "u" }),
    ).rejects.toThrow("24h rollback window");
  });

  it("passes manifestId to findActiveByManifestId", async () => {
    pluginRepo.findActiveByManifestId.mockResolvedValue(null);

    await expect(service.rollback({ manifestId: "com.example.test", rolledBackBy: "u" })).rejects.toThrow();
    expect(pluginRepo.findActiveByManifestId).toHaveBeenCalledWith("com.example.test");
  });
});

// ---------------------------------------------------------------------------
// upgrade — pre-staging hooks setup (no timeout wait)
// ---------------------------------------------------------------------------

describe("UpgradeService.upgrade — pre-hook staging", () => {
  let pluginRepo: MockPluginRepo;
  let instanceRepo: MockInstanceRepo;
  let hookRepo: MockHookRepo;
  let service: ReturnType<typeof createUpgradeService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    instanceRepo = makeInstanceRepo();
    hookRepo = makeHookRepo();

    // Set up: active 1.0.0, staged 2.0.0, no instances
    pluginRepo.findActiveByManifestId.mockResolvedValue(makePluginRow({ version: "1.0.0" }));
    pluginRepo.findByManifestIdAndVersion.mockResolvedValue(
      makePluginRow({ id: "plugin-v2-id", version: "2.0.0", status: "staged" })
    );
    pluginRepo.update.mockResolvedValue(makePluginRow({ status: "draining" }));
    instanceRepo.findByPluginManifestId.mockResolvedValue([]);

    // Mock global fetch so AbortSignal.timeout-gated fetch calls resolve instantly
    // (the service wraps all fetch calls in try/catch and just logs warnings on failure)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    // Fake timers to skip the 62s setTimeout grace period
    vi.useFakeTimers();

    service = createUpgradeService(makeDeps({ pluginRepo, instanceRepo, hookRepo }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runUpgradeWithTimers(upgradeFn: () => Promise<{ fromVersion: string; toVersion: string }>) {
    // Pattern: start the async function, let pending microtasks flush (so the
    // setTimeout gets registered), then advance fake time past the 62s grace
    // period, then await the settled promise.
    const promise = upgradeFn();
    await vi.advanceTimersByTimeAsync(70_000);
    // Await the promise AFTER advancing timers so remaining async steps (swap,
    // event publish etc.) run to completion via microtask queue.
    return await promise;
  }

  it("does not create staged hooks when there are no instances", async () => {
    instanceRepo.findByPluginManifestId.mockResolvedValue([]);
    await runUpgradeWithTimers(() =>
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "user-001" })
    );
    expect(hookRepo.createMany).not.toHaveBeenCalled();
  });

  it("marks active version as draining before swap", async () => {
    await runUpgradeWithTimers(() =>
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "user-001" })
    );
    expect(pluginRepo.update).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      { status: "draining" },
    );
  });

  it("returns fromVersion and toVersion on successful upgrade", async () => {
    const result = await runUpgradeWithTimers(() =>
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "user-001" })
    );
    expect(result.fromVersion).toBe("1.0.0");
    expect(result.toVersion).toBe("2.0.0");
  });

  it("publishes plugin.upgraded event", async () => {
    const eventPublisher = makeEventPublisher();
    const svc = createUpgradeService(
      makeDeps({ pluginRepo, instanceRepo, hookRepo, eventPublisher }),
    );
    await runUpgradeWithTimers(() =>
      svc.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "user-001" })
    );
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "plugin.upgraded" }),
    );
  });

  it("schedules old bundle for cleanup with 24h retention after swap", async () => {
    await runUpgradeWithTimers(() =>
      service.upgrade({ manifestId: "com.example.my-plugin", toVersion: "2.0.0", upgradedBy: "user-001" })
    );
    // pluginRepo.update should be called at least twice:
    // 1. status=draining before swap
    // 2. bundle_delete_after after swap
    const calls = (pluginRepo.update as ReturnType<typeof vi.fn>).mock.calls;
    const bundleDeleteCall = calls.find(
      (c) => (c[1] as Record<string, unknown>)["bundle_delete_after"] instanceof Date
    );
    expect(bundleDeleteCall).toBeDefined();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// rollback — with disabled version available (fake timers)
// ---------------------------------------------------------------------------

describe("UpgradeService.rollback — successful path", () => {
  let pluginRepo: MockPluginRepo;
  let instanceRepo: MockInstanceRepo;
  let hookRepo: MockHookRepo;
  let eventPublisher: EventPublisher;
  let pool: ReturnType<typeof makePool>;
  let service: ReturnType<typeof createUpgradeService>;

  beforeEach(() => {
    pluginRepo = makePluginRepo();
    instanceRepo = makeInstanceRepo();
    hookRepo = makeHookRepo();
    eventPublisher = makeEventPublisher();
    pool = makePool();

    pluginRepo.findActiveByManifestId.mockResolvedValue(
      makePluginRow({ version: "2.0.0", status: "active" })
    );
    pluginRepo.update.mockResolvedValue(makePluginRow({ status: "draining" }));

    const previousPlugin = makePluginRow({
      id: "plugin-v1-id",
      version: "1.0.0",
      status: "disabled",
      bundle_delete_after: new Date(Date.now() + 3600 * 1000),
    });
    // Pool.query for finding the disabled version
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [previousPlugin] });

    // Mock global fetch so AbortSignal.timeout-gated fetch calls resolve instantly
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    // Fake timers to skip the 62s setTimeout grace period
    vi.useFakeTimers();

    service = createUpgradeService(
      makeDeps({ pluginRepo, instanceRepo, hookRepo, eventPublisher, pool }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runRollbackWithTimers(rollbackFn: () => Promise<{ fromVersion: string; toVersion: string }>) {
    const promise = rollbackFn();
    await vi.advanceTimersByTimeAsync(70_000);
    return await promise;
  }

  it("returns fromVersion and toVersion on successful rollback", async () => {
    const result = await runRollbackWithTimers(() =>
      service.rollback({ manifestId: "com.example.my-plugin", rolledBackBy: "user-001" })
    );
    expect(result.fromVersion).toBe("2.0.0");
    expect(result.toVersion).toBe("1.0.0");
  });

  it("publishes plugin.rolled_back event", async () => {
    await runRollbackWithTimers(() =>
      service.rollback({ manifestId: "com.example.my-plugin", rolledBackBy: "user-001" })
    );
    expect(eventPublisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "plugin.rolled_back" }),
    );
  });

  it("marks current active version as draining before rollback swap", async () => {
    await runRollbackWithTimers(() =>
      service.rollback({ manifestId: "com.example.my-plugin", rolledBackBy: "u" })
    );
    expect(pluginRepo.update).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      { status: "draining" },
    );
  });

  it("sets bundle_delete_after on the rolled-back version for 24h retention", async () => {
    await runRollbackWithTimers(() =>
      service.rollback({ manifestId: "com.example.my-plugin", rolledBackBy: "u" })
    );
    const calls = (pluginRepo.update as ReturnType<typeof vi.fn>).mock.calls;
    const retentionCall = calls.find(
      (c) => (c[1] as Record<string, unknown>)["bundle_delete_after"] instanceof Date
    );
    expect(retentionCall).toBeDefined();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
