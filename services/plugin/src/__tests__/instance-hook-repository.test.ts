// Unit tests for repositories/instance-repository.ts and hook-repository.ts
//
// Both are database-backed repositories; all I/O uses vi.fn() mocks.
// Tests verify: SQL parameter passing, empty-row guards, bulk insert placeholder
// generation, hook chain resolution mapping, state transition helpers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InstanceRepository } from "../repositories/instance-repository.js";
import { HookRepository } from "../repositories/hook-repository.js";
import type { InstanceRow, HookRow, CreateHookData, ResolvedHook } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

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

function makeHookRow(overrides?: Partial<HookRow>): HookRow {
  return {
    id: "hook-001",
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    instance_id: "inst-001",
    tenant_id: "tenant-001",
    stage: "before:ingest",
    criticality: "critical",
    priority: 100,
    timeout_seconds: 30,
    entrypoint: "hooks/before-ingest",
    state: "active",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeCreateHookData(overrides?: Partial<CreateHookData>): CreateHookData {
  return {
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    instance_id: "inst-001",
    tenant_id: "tenant-001",
    stage: "before:ingest",
    criticality: "critical",
    priority: 100,
    timeout_seconds: 30,
    entrypoint: "hooks/before-ingest",
    state: "inactive",
    ...overrides,
  };
}

function makePool() {
  return { query: vi.fn() } as unknown as import("pg").Pool;
}

function makeClient() {
  return { query: vi.fn() } as unknown as import("pg").PoolClient;
}

// ---------------------------------------------------------------------------
// InstanceRepository.create
// ---------------------------------------------------------------------------

describe("InstanceRepository.create", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: InstanceRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new InstanceRepository(pool);
  });

  it("returns the created instance row", async () => {
    const expected = makeInstanceRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.create({
      plugin_manifest_id: "com.example.my-plugin",
      plugin_id: "plugin-uuid",
      tenant_id: "tenant-001",
      display_name: "My Instance",
      config: {},
      enabled: "disabled",
      created_by: "user-001",
    });
    expect(result).toBe(expected);
  });

  it("throws when INSERT returns no rows", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await expect(
      repo.create({
        plugin_manifest_id: "m",
        plugin_id: "p",
        tenant_id: "t",
        display_name: "D",
        config: {},
        enabled: "disabled",
        created_by: "u",
      }),
    ).rejects.toThrow("INSERT INTO plugin.instances returned no rows");
  });

  it("serialises config as JSON string", async () => {
    const expected = makeInstanceRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    await repo.create({
      plugin_manifest_id: "m",
      plugin_id: "p",
      tenant_id: "t",
      display_name: "D",
      config: { apiKey: "secret" },
      enabled: "disabled",
      created_by: "u",
    });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    // config is index 4
    expect(typeof values[4]).toBe("string");
    expect(JSON.parse(values[4] as string)).toEqual({ apiKey: "secret" });
  });
});

// ---------------------------------------------------------------------------
// InstanceRepository.findById
// ---------------------------------------------------------------------------

describe("InstanceRepository.findById", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: InstanceRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new InstanceRepository(pool);
  });

  it("returns the row when found", async () => {
    const expected = makeInstanceRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.findById("inst-001");
    expect(result).toBe(expected);
  });

  it("returns null when not found", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findById("inst-999");
    expect(result).toBeNull();
  });

  it("passes id as query parameter", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findById("my-instance-id");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("my-instance-id");
  });
});

// ---------------------------------------------------------------------------
// InstanceRepository.findByIdAndTenant
// ---------------------------------------------------------------------------

describe("InstanceRepository.findByIdAndTenant", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: InstanceRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new InstanceRepository(pool);
  });

  it("returns the row when found for the correct tenant", async () => {
    const expected = makeInstanceRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.findByIdAndTenant("inst-001", "tenant-001");
    expect(result).toBe(expected);
  });

  it("returns null for wrong tenant or non-existent id", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findByIdAndTenant("inst-001", "tenant-999");
    expect(result).toBeNull();
  });

  it("passes id and tenantId as parameters", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findByIdAndTenant("inst-abc", "tenant-xyz");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("inst-abc");
    expect(values[1]).toBe("tenant-xyz");
  });
});

// ---------------------------------------------------------------------------
// InstanceRepository.findByPluginManifestId
// ---------------------------------------------------------------------------

describe("InstanceRepository.findByPluginManifestId", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: InstanceRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new InstanceRepository(pool);
  });

  it("returns all rows for the manifest", async () => {
    const rows = [makeInstanceRow(), makeInstanceRow({ id: "inst-002" })];
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });

    const result = await repo.findByPluginManifestId("com.example.my-plugin");
    expect(result).toBe(rows);
  });

  it("passes tenantId filter when provided in options", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findByPluginManifestId("com.example.my-plugin", { tenantId: "tenant-001" });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values).toContain("tenant-001");
  });

  it("does not pass tenantId filter when not provided", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findByPluginManifestId("com.example.my-plugin");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    // Only manifestId should be in the values
    expect(values).toHaveLength(1);
    expect(values[0]).toBe("com.example.my-plugin");
  });
});

// ---------------------------------------------------------------------------
// InstanceRepository.countActiveByManifestId
// ---------------------------------------------------------------------------

describe("InstanceRepository.countActiveByManifestId", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: InstanceRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new InstanceRepository(pool);
  });

  it("returns the count as a number", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ count: "3" }] });

    const result = await repo.countActiveByManifestId("com.example.my-plugin");
    expect(result).toBe(3);
  });

  it("returns 0 when count row has no count property", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{}] });

    const result = await repo.countActiveByManifestId("com.example.my-plugin");
    expect(result).toBe(0);
  });

  it("returns 0 when rows array is empty", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.countActiveByManifestId("com.example.my-plugin");
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// InstanceRepository.update
// ---------------------------------------------------------------------------

describe("InstanceRepository.update", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: InstanceRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new InstanceRepository(pool);
  });

  it("returns the updated row", async () => {
    const updated = makeInstanceRow({ enabled: "disabled" });
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [updated] });

    const result = await repo.update("inst-001", { enabled: "disabled" });
    expect(result).toBe(updated);
  });

  it("returns null when row not found", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.update("inst-999", { enabled: "disabled" });
    expect(result).toBeNull();
  });

  it("always includes updated_at=now() even with no explicit fields", async () => {
    const updated = makeInstanceRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [updated] });

    await repo.update("inst-001", {});
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain("updated_at = now()");
  });

  it("serialises config update as JSON string", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [makeInstanceRow()] });

    await repo.update("inst-001", { config: { retries: 5 } });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    const configValue = values.find((v) => typeof v === "string" && v.includes("retries"));
    expect(configValue).toBeDefined();
    expect(JSON.parse(configValue as string)).toEqual({ retries: 5 });
  });

  it("passes deleted_at null for soft-delete restore", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [makeInstanceRow()] });

    await repo.update("inst-001", { deleted_at: null });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values).toContain(null);
  });

  it("passes deleted_at Date for soft-delete", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [makeInstanceRow()] });
    const dt = new Date("2026-06-10T00:00:00Z");

    await repo.update("inst-001", { deleted_at: dt });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values).toContain(dt);
  });
});

// ---------------------------------------------------------------------------
// InstanceRepository.updatePluginIdForManifest
// ---------------------------------------------------------------------------

describe("InstanceRepository.updatePluginIdForManifest", () => {
  it("returns rowCount from client query", async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 5 });

    const pool = makePool();
    const repo = new InstanceRepository(pool);
    const result = await repo.updatePluginIdForManifest(client, "com.example.my-plugin", "new-plugin-id");
    expect(result).toBe(5);
  });

  it("returns 0 when rowCount is null", async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: null });

    const pool = makePool();
    const repo = new InstanceRepository(pool);
    const result = await repo.updatePluginIdForManifest(client, "m", "p");
    expect(result).toBe(0);
  });

  it("passes newPluginId and manifestId to client query", async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 3 });

    const pool = makePool();
    const repo = new InstanceRepository(pool);
    await repo.updatePluginIdForManifest(client, "com.example.my-plugin", "new-plugin-uuid");
    const values = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("new-plugin-uuid");
    expect(values[1]).toBe("com.example.my-plugin");
  });
});

// ---------------------------------------------------------------------------
// InstanceRepository.softDeleteAllByManifestId
// ---------------------------------------------------------------------------

describe("InstanceRepository.softDeleteAllByManifestId", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: InstanceRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new InstanceRepository(pool);
  });

  it("returns the number of soft-deleted instances", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 3 });

    const result = await repo.softDeleteAllByManifestId("com.example.my-plugin");
    expect(result).toBe(3);
  });

  it("returns 0 when rowCount is null", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: null });

    const result = await repo.softDeleteAllByManifestId("com.example.my-plugin");
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HookRepository.createMany — empty array guard
// ---------------------------------------------------------------------------

describe("HookRepository.createMany — empty array", () => {
  it("returns empty array immediately without querying the DB", async () => {
    const pool = makePool();
    const repo = new HookRepository(pool);

    const result = await repo.createMany([]);
    expect(result).toHaveLength(0);
    expect((pool.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HookRepository.createMany — bulk insert
// ---------------------------------------------------------------------------

describe("HookRepository.createMany — bulk insert", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: HookRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new HookRepository(pool);
  });

  it("returns all inserted hook rows", async () => {
    const rows = [makeHookRow(), makeHookRow({ id: "hook-002" })];
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });

    const result = await repo.createMany([makeCreateHookData(), makeCreateHookData()]);
    expect(result).toBe(rows);
  });

  it("generates correct placeholder count for 1 hook (9 params)", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [makeHookRow()] });

    await repo.createMany([makeCreateHookData()]);
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain("($1,$2,$3,$4,$5,$6,$7,$8,$9)");
  });

  it("generates correct placeholder count for 2 hooks (18 params)", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [makeHookRow(), makeHookRow()] });

    await repo.createMany([makeCreateHookData(), makeCreateHookData()]);
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain("($1,$2,$3,$4,$5,$6,$7,$8,$9)");
    expect(sql).toContain("($10,$11,$12,$13,$14,$15,$16,$17,$18)");
  });

  it("flattens hook fields into the values array in correct order", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [makeHookRow()] });

    const hookData = makeCreateHookData({
      plugin_id: "plugin-uuid",
      instance_id: "inst-uuid",
      tenant_id: "tenant-uuid",
      stage: "after:transform",
      criticality: "advisory",
      priority: 50,
      timeout_seconds: 60,
      entrypoint: "hooks/after-transform",
      state: "inactive",
    });
    await repo.createMany([hookData]);
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("plugin-uuid");
    expect(values[1]).toBe("inst-uuid");
    expect(values[2]).toBe("tenant-uuid");
    expect(values[3]).toBe("after:transform");
    expect(values[4]).toBe("advisory");
    expect(values[5]).toBe(50);
    expect(values[6]).toBe(60);
    expect(values[7]).toBe("hooks/after-transform");
    expect(values[8]).toBe("inactive");
  });
});

// ---------------------------------------------------------------------------
// HookRepository.resolveChain — result mapping
// ---------------------------------------------------------------------------

describe("HookRepository.resolveChain", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: HookRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new HookRepository(pool);
  });

  it("returns empty array when no active hooks", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.resolveChain("before:ingest", "tenant-001");
    expect(result).toHaveLength(0);
  });

  it("maps raw DB rows to ResolvedHook shape", async () => {
    const raw = {
      id: "hook-001",
      instance_id: "inst-001",
      plugin_id: "plugin-uuid",
      tenant_id: "tenant-001",
      stage: "before:ingest",
      criticality: "critical",
      priority: 100,
      timeout_ms: "30000",
      entrypoint: "hooks/before-ingest",
      manifest_id: "com.example.my-plugin",
      bundle_key: "com.example.my-plugin/1.0.0/bundle.js",
      bundle_bucket: "plugin-bundles",
      version: "1.0.0",
      config: { apiKey: "secret" },
    };
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [raw] });

    const result = await repo.resolveChain("before:ingest", "tenant-001");
    expect(result).toHaveLength(1);
    const hook = result[0] as ResolvedHook;
    expect(hook.hookId).toBe("hook-001");
    expect(hook.instanceId).toBe("inst-001");
    expect(hook.tenantId).toBe("tenant-001");
    expect(hook.stage).toBe("before:ingest");
    expect(hook.criticality).toBe("critical");
    expect(hook.priority).toBe(100);
    expect(hook.timeoutMs).toBe(30000);
    expect(hook.entrypoint).toBe("hooks/before-ingest");
    expect(hook.pluginId).toBe("plugin-uuid");
    expect(hook.manifestId).toBe("com.example.my-plugin");
    expect(hook.bundleBucket).toBe("plugin-bundles");
    expect(hook.bundleKey).toBe("com.example.my-plugin/1.0.0/bundle.js");
    expect(hook.version).toBe("1.0.0");
    expect(hook.instanceConfig).toEqual({ apiKey: "secret" });
  });

  it("parses timeout_ms string to integer", async () => {
    const raw = {
      id: "h", instance_id: "i", plugin_id: "p", tenant_id: "t",
      stage: "before:run", criticality: "advisory", priority: 0,
      timeout_ms: "15000", entrypoint: "e",
      manifest_id: "m", bundle_key: "k", bundle_bucket: "b",
      version: "1.0.0", config: {},
    };
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [raw] });

    const result = await repo.resolveChain("before:run", "t");
    expect((result[0] as ResolvedHook).timeoutMs).toBe(15000);
    expect(typeof (result[0] as ResolvedHook).timeoutMs).toBe("number");
  });

  it("passes stage and tenantId as query parameters", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.resolveChain("after:transform", "tenant-xyz");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("after:transform");
    expect(values[1]).toBe("tenant-xyz");
  });
});

// ---------------------------------------------------------------------------
// HookRepository.updateStateByInstance
// ---------------------------------------------------------------------------

describe("HookRepository.updateStateByInstance", () => {
  it("returns rowCount from client query", async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 4 });

    const pool = makePool();
    const repo = new HookRepository(pool);
    const result = await repo.updateStateByInstance(client, "inst-001", "active");
    expect(result).toBe(4);
  });

  it("returns 0 when rowCount is null", async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: null });

    const pool = makePool();
    const repo = new HookRepository(pool);
    const result = await repo.updateStateByInstance(client, "inst-001", "disabled");
    expect(result).toBe(0);
  });

  it("passes newState and instanceId to client query", async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 2 });

    const pool = makePool();
    const repo = new HookRepository(pool);
    await repo.updateStateByInstance(client, "inst-abc", "staged");
    const values = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("staged");
    expect(values[1]).toBe("inst-abc");
  });
});

// ---------------------------------------------------------------------------
// HookRepository.updateStateByPluginAndCurrentState
// ---------------------------------------------------------------------------

describe("HookRepository.updateStateByPluginAndCurrentState", () => {
  it("returns rowCount on successful transition", async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 7 });

    const pool = makePool();
    const repo = new HookRepository(pool);
    const result = await repo.updateStateByPluginAndCurrentState(
      client, "plugin-id", "staged", "active"
    );
    expect(result).toBe(7);
  });

  it("passes toState, pluginId, and fromState to client query", async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 3 });

    const pool = makePool();
    const repo = new HookRepository(pool);
    await repo.updateStateByPluginAndCurrentState(client, "plugin-uuid", "active", "disabled");
    const values = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("disabled"); // toState
    expect(values[1]).toBe("plugin-uuid"); // pluginId
    expect(values[2]).toBe("active"); // fromState
  });
});

// ---------------------------------------------------------------------------
// HookRepository.disableAllByManifestId
// ---------------------------------------------------------------------------

describe("HookRepository.disableAllByManifestId", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: HookRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new HookRepository(pool);
  });

  it("returns count of disabled hooks", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 12 });

    const result = await repo.disableAllByManifestId("com.example.my-plugin");
    expect(result).toBe(12);
  });

  it("returns 0 when rowCount is null", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: null });

    const result = await repo.disableAllByManifestId("com.example.my-plugin");
    expect(result).toBe(0);
  });

  it("passes manifestId as query parameter", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rowCount: 0 });

    await repo.disableAllByManifestId("com.example.target-plugin");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("com.example.target-plugin");
  });
});

// ---------------------------------------------------------------------------
// HookRepository.findByInstanceId
// ---------------------------------------------------------------------------

describe("HookRepository.findByInstanceId", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: HookRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new HookRepository(pool);
  });

  it("returns all hook rows for the instance", async () => {
    const rows = [makeHookRow(), makeHookRow({ id: "hook-002", stage: "after:transform" })];
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });

    const result = await repo.findByInstanceId("inst-001");
    expect(result).toBe(rows);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no hooks found", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findByInstanceId("inst-999");
    expect(result).toHaveLength(0);
  });

  it("passes instanceId as query parameter", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findByInstanceId("inst-abc");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("inst-abc");
  });
});
