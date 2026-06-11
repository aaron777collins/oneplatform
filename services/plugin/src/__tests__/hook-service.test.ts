// Unit tests for services/hook-service.ts
//
// Covers: resolveChain delegation, buildHookDataFromManifest field mapping,
// default timeout fallback, priority propagation, and empty hooks array.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHookService } from "../services/hook-service.js";
import type { HookRepository } from "../repositories/hook-repository.js";
import type { ResolvedHook, CreateHookData } from "../repositories/types.js";
import type { PluginManifest } from "../schemas/index.js";
import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

const VALID_CHECKSUM = "a".repeat(64);

function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    manifestVersion: "1",
    id: "com.example.my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    type: "connector",
    description: "Test plugin",
    author: "Test Author",
    minPlatformVersion: "1.0.0",
    entrypoint: "dist/bundle.js",
    configSchema: {},
    hooks: [],
    requiredExternalUrls: [],
    requiredApis: [],
    requiredCredentials: [],
    bundleChecksum: VALID_CHECKSUM,
    license: "MIT",
    ...overrides,
  };
}

function makeResolvedHook(overrides?: Partial<ResolvedHook>): ResolvedHook {
  return {
    hookId: "hook-001",
    instanceId: "inst-001",
    tenantId: "tenant-001",
    stage: "before:ingest",
    criticality: "critical",
    priority: 100,
    timeoutMs: 30000,
    entrypoint: "hooks/before-ingest",
    pluginId: "550e8400-e29b-41d4-a716-446655440000",
    manifestId: "com.example.my-plugin",
    bundleBucket: "plugin-bundles",
    bundleKey: "com.example.my-plugin/1.0.0/bundle.js",
    version: "1.0.0",
    instanceConfig: {},
    ...overrides,
  };
}

function makeHookRepo(): { resolveChain: ReturnType<typeof vi.fn> } {
  return { resolveChain: vi.fn() };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

// ---------------------------------------------------------------------------
// resolveChain
// ---------------------------------------------------------------------------

describe("HookService.resolveChain", () => {
  let hookRepo: ReturnType<typeof makeHookRepo>;
  let service: ReturnType<typeof createHookService>;

  beforeEach(() => {
    hookRepo = makeHookRepo();
    service = createHookService({
      hookRepo: hookRepo as unknown as HookRepository,
      logger: makeLogger(),
    });
  });

  it("returns the resolved hooks from the repository", async () => {
    const expected = [makeResolvedHook()];
    hookRepo.resolveChain.mockResolvedValue(expected);

    const result = await service.resolveChain("before:ingest", "tenant-001");
    expect(result).toBe(expected);
  });

  it("passes stage and tenantId to the repository", async () => {
    hookRepo.resolveChain.mockResolvedValue([]);

    await service.resolveChain("after:transform", "tenant-xyz");
    expect(hookRepo.resolveChain).toHaveBeenCalledWith("after:transform", "tenant-xyz");
  });

  it("returns empty array when no active hooks", async () => {
    hookRepo.resolveChain.mockResolvedValue([]);

    const result = await service.resolveChain("before:ingest", "tenant-001");
    expect(result).toHaveLength(0);
  });

  it("returns multiple resolved hooks in priority order (as returned by repo)", async () => {
    const hooks = [
      makeResolvedHook({ hookId: "hook-001", priority: 10 }),
      makeResolvedHook({ hookId: "hook-002", priority: 50 }),
      makeResolvedHook({ hookId: "hook-003", priority: 100 }),
    ];
    hookRepo.resolveChain.mockResolvedValue(hooks);

    const result = await service.resolveChain("before:ingest", "tenant-001");
    expect(result).toBe(hooks);
    expect(result[0]?.hookId).toBe("hook-001");
    expect(result[1]?.hookId).toBe("hook-002");
    expect(result[2]?.hookId).toBe("hook-003");
  });
});

// ---------------------------------------------------------------------------
// buildHookDataFromManifest — empty hooks
// ---------------------------------------------------------------------------

describe("HookService.buildHookDataFromManifest — empty hooks", () => {
  let service: ReturnType<typeof createHookService>;

  beforeEach(() => {
    service = createHookService({
      hookRepo: makeHookRepo() as unknown as HookRepository,
      logger: makeLogger(),
    });
  });

  it("returns empty array when manifest has no hooks", () => {
    const manifest = makeManifest({ hooks: [] });
    const result = service.buildHookDataFromManifest(
      "plugin-uuid", "inst-001", "tenant-001", manifest
    );
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildHookDataFromManifest — field mapping
// ---------------------------------------------------------------------------

describe("HookService.buildHookDataFromManifest — field mapping", () => {
  let service: ReturnType<typeof createHookService>;

  beforeEach(() => {
    service = createHookService({
      hookRepo: makeHookRepo() as unknown as HookRepository,
      logger: makeLogger(),
    });
  });

  it("maps pluginId to plugin_id", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:ingest", criticality: "critical", priority: 100, entrypoint: "hooks/entry" }],
    });
    const result = service.buildHookDataFromManifest(
      "my-plugin-uuid", "inst-001", "tenant-001", manifest
    );
    expect(result[0]?.plugin_id).toBe("my-plugin-uuid");
  });

  it("maps instanceId to instance_id", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:ingest", criticality: "critical", priority: 100, entrypoint: "hooks/entry" }],
    });
    const result = service.buildHookDataFromManifest(
      "plugin-uuid", "my-instance-id", "tenant-001", manifest
    );
    expect(result[0]?.instance_id).toBe("my-instance-id");
  });

  it("maps tenantId to tenant_id", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:ingest", criticality: "critical", priority: 100, entrypoint: "hooks/entry" }],
    });
    const result = service.buildHookDataFromManifest(
      "plugin-uuid", "inst-001", "my-tenant-id", manifest
    );
    expect(result[0]?.tenant_id).toBe("my-tenant-id");
  });

  it("maps hook stage correctly", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "after:transform", criticality: "advisory", priority: 50, entrypoint: "hooks/after" }],
    });
    const result = service.buildHookDataFromManifest(
      "p", "i", "t", manifest
    );
    expect(result[0]?.stage).toBe("after:transform");
  });

  it("maps hook criticality correctly", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:run", criticality: "advisory", priority: 100, entrypoint: "hooks/run" }],
    });
    const result = service.buildHookDataFromManifest("p", "i", "t", manifest);
    expect(result[0]?.criticality).toBe("advisory");
  });

  it("maps hook priority correctly", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:run", criticality: "critical", priority: 42, entrypoint: "hooks/run" }],
    });
    const result = service.buildHookDataFromManifest("p", "i", "t", manifest);
    expect(result[0]?.priority).toBe(42);
  });

  it("maps hook entrypoint correctly", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:run", criticality: "critical", priority: 100, entrypoint: "hooks/custom-entry" }],
    });
    const result = service.buildHookDataFromManifest("p", "i", "t", manifest);
    expect(result[0]?.entrypoint).toBe("hooks/custom-entry");
  });

  it("sets state to 'inactive' for all built hooks", () => {
    const manifest = makeManifest({
      hooks: [
        { stage: "before:ingest", criticality: "critical", priority: 100, entrypoint: "e1" },
        { stage: "after:transform", criticality: "advisory", priority: 200, entrypoint: "e2" },
      ],
    });
    const result = service.buildHookDataFromManifest("p", "i", "t", manifest);
    for (const hook of result) {
      expect(hook.state).toBe("inactive");
    }
  });

  it("uses timeout from hook declaration when specified", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:run", criticality: "critical", priority: 100, entrypoint: "e", timeout: 120 }],
    });
    const result = service.buildHookDataFromManifest("p", "i", "t", manifest);
    expect(result[0]?.timeout_seconds).toBe(120);
  });

  it("defaults timeout_seconds to 30 when hook has no timeout", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:run", criticality: "critical", priority: 100, entrypoint: "e" }],
    });
    const result = service.buildHookDataFromManifest("p", "i", "t", manifest);
    expect(result[0]?.timeout_seconds).toBe(30);
  });

  it("produces one CreateHookData per hook declaration", () => {
    const manifest = makeManifest({
      hooks: [
        { stage: "before:ingest", criticality: "critical", priority: 10, entrypoint: "e1" },
        { stage: "after:ingest", criticality: "advisory", priority: 20, entrypoint: "e2" },
        { stage: "before:transform", criticality: "critical", priority: 30, entrypoint: "e3" },
      ],
    });
    const result = service.buildHookDataFromManifest("p", "i", "t", manifest);
    expect(result).toHaveLength(3);
  });

  it("preserves hook declaration order in output array", () => {
    const manifest = makeManifest({
      hooks: [
        { stage: "before:ingest", criticality: "critical", priority: 100, entrypoint: "e1" },
        { stage: "after:transform", criticality: "advisory", priority: 50, entrypoint: "e2" },
      ],
    });
    const result = service.buildHookDataFromManifest("p", "i", "t", manifest);
    expect(result[0]?.stage).toBe("before:ingest");
    expect(result[1]?.stage).toBe("after:transform");
  });
});

// ---------------------------------------------------------------------------
// buildHookDataFromManifest — type safety
// ---------------------------------------------------------------------------

describe("HookService.buildHookDataFromManifest — type safety", () => {
  let service: ReturnType<typeof createHookService>;

  beforeEach(() => {
    service = createHookService({
      hookRepo: makeHookRepo() as unknown as HookRepository,
      logger: makeLogger(),
    });
  });

  it("returned CreateHookData objects have all required fields", () => {
    const manifest = makeManifest({
      hooks: [{ stage: "before:run", criticality: "critical", priority: 100, entrypoint: "entry" }],
    });
    const result = service.buildHookDataFromManifest("plugin-id", "inst-id", "tenant-id", manifest);
    const hook = result[0] as CreateHookData;

    expect(hook).toHaveProperty("plugin_id");
    expect(hook).toHaveProperty("instance_id");
    expect(hook).toHaveProperty("tenant_id");
    expect(hook).toHaveProperty("stage");
    expect(hook).toHaveProperty("criticality");
    expect(hook).toHaveProperty("priority");
    expect(hook).toHaveProperty("timeout_seconds");
    expect(hook).toHaveProperty("entrypoint");
    expect(hook).toHaveProperty("state");
  });
});
