// Unit tests for repositories/plugin-repository.ts
//
// All database interactions use vi.fn() mocks — no real DB connection.
// Tests verify: SQL parameter passing, null coalescing, empty-row guards,
// conflict resolution for approved URLs, update with no fields.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginRepository } from "../repositories/plugin-repository.js";
import type { PluginRow, CreatePluginData, ApprovedUrlRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
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

function makeApprovedUrlRow(overrides?: Partial<ApprovedUrlRow>): ApprovedUrlRow {
  return {
    id: "url-001",
    plugin_id: "550e8400-e29b-41d4-a716-446655440000",
    url_pattern: "https://api.example.com/*",
    approved_by: "user-001",
    approved_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makePool() {
  return {
    query: vi.fn(),
  } as unknown as import("pg").Pool;
}

function makeCreateData(overrides?: Partial<CreatePluginData>): CreatePluginData {
  return {
    manifest_id: "com.example.my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    type: "connector",
    status: "installed",
    bundle_bucket: "plugin-bundles",
    bundle_key: "com.example.my-plugin/1.0.0/bundle.js",
    manifest: makePluginRow().manifest,
    is_platform_wide: false,
    installed_by: "user-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("PluginRepository.create", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns the inserted plugin row", async () => {
    const expected = makePluginRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.create(makeCreateData());
    expect(result).toBe(expected);
  });

  it("passes manifest_id as first parameter", async () => {
    const expected = makePluginRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    await repo.create(makeCreateData({ manifest_id: "com.example.test" }));
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("com.example.test");
  });

  it("throws an Error when INSERT returns no rows", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await expect(repo.create(makeCreateData())).rejects.toThrow(
      "INSERT INTO plugin.plugins returned no rows",
    );
  });

  it("serialises manifest as JSON string parameter", async () => {
    const expected = makePluginRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    await repo.create(makeCreateData());
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    // manifest is index 7 — passed as JSON.stringify(data.manifest)
    expect(typeof values[7]).toBe("string");
    const parsed = JSON.parse(values[7] as string) as { id: string };
    expect(parsed.id).toBe("com.example.my-plugin");
  });
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe("PluginRepository.findById", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns the row when found", async () => {
    const expected = makePluginRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.findById("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toBe(expected);
  });

  it("returns null when not found", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findById("non-existent-id");
    expect(result).toBeNull();
  });

  it("passes the id as the query parameter", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findById("my-plugin-id");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("my-plugin-id");
  });
});

// ---------------------------------------------------------------------------
// findActiveByManifestId
// ---------------------------------------------------------------------------

describe("PluginRepository.findActiveByManifestId", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns the active row when found", async () => {
    const expected = makePluginRow({ status: "active" });
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.findActiveByManifestId("com.example.my-plugin");
    expect(result).toBe(expected);
  });

  it("returns null when no active version", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findActiveByManifestId("com.example.my-plugin");
    expect(result).toBeNull();
  });

  it("passes manifestId as the query parameter", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findActiveByManifestId("com.example.my-plugin");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("com.example.my-plugin");
  });
});

// ---------------------------------------------------------------------------
// findByManifestIdAndVersion
// ---------------------------------------------------------------------------

describe("PluginRepository.findByManifestIdAndVersion", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns the row when found", async () => {
    const expected = makePluginRow({ version: "2.0.0", status: "staged" });
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.findByManifestIdAndVersion("com.example.my-plugin", "2.0.0");
    expect(result).toBe(expected);
  });

  it("returns null when not found", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findByManifestIdAndVersion("com.example.my-plugin", "99.0.0");
    expect(result).toBeNull();
  });

  it("passes manifestId and version as parameters", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findByManifestIdAndVersion("com.example.test", "3.1.0");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("com.example.test");
    expect(values[1]).toBe("3.1.0");
  });
});

// ---------------------------------------------------------------------------
// findStagedByManifestId
// ---------------------------------------------------------------------------

describe("PluginRepository.findStagedByManifestId", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns the staged row when found", async () => {
    const expected = makePluginRow({ status: "staged" });
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.findStagedByManifestId("com.example.my-plugin");
    expect(result).toBe(expected);
  });

  it("returns null when no staged version", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findStagedByManifestId("com.example.my-plugin");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("PluginRepository.list", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns rows and total from count query", async () => {
    const rows = [makePluginRow()];
    // First call: COUNT query; second call: paginated SELECT
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({ rows });

    const result = await repo.list({ limit: 50 });
    expect(result.total).toBe(1);
    expect(result.rows).toBe(rows);
  });

  it("returns total 0 when count row is missing", async () => {
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await repo.list({ limit: 50 });
    expect(result.total).toBe(0);
  });

  it("passes type filter in WHERE clause values", async () => {
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await repo.list({ type: "connector", limit: 50 });
    const countValues = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(countValues).toContain("connector");
  });

  it("passes status filter in WHERE clause values", async () => {
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await repo.list({ status: "active", limit: 50 });
    const countValues = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(countValues).toContain("active");
  });

  it("passes search term for full-text query when q is provided", async () => {
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await repo.list({ q: "my plugin", limit: 50 });
    const countValues = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(countValues).toContain("my plugin");
  });

  it("passes cursor value in paginated query but not count query", async () => {
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ count: "5" }] })
      .mockResolvedValueOnce({ rows: [] });

    await repo.list({ cursor: "cursor-abc", limit: 20 });
    const countValues = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    const pageValues = (pool.query as ReturnType<typeof vi.fn>).mock.calls[1]![1] as unknown[];
    expect(countValues).not.toContain("cursor-abc");
    expect(pageValues).toContain("cursor-abc");
  });

  it("does not add q filter when q is empty string", async () => {
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [] });

    await repo.list({ q: "", limit: 50 });
    const countSql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(countSql).not.toContain("tsvector");
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("PluginRepository.update", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns the updated row on success", async () => {
    const updated = makePluginRow({ status: "uninstalled" });
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [updated] });

    const result = await repo.update("plugin-id", { status: "uninstalled" });
    expect(result).toBe(updated);
  });

  it("returns null when the row does not exist", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.update("non-existent", { status: "disabled" });
    expect(result).toBeNull();
  });

  it("throws when called with no update fields", async () => {
    await expect(repo.update("plugin-id", {})).rejects.toThrow(
      "update() called with no fields for plugin plugin-id",
    );
  });

  it("passes status value correctly", async () => {
    const updated = makePluginRow({ status: "draining" });
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [updated] });

    await repo.update("plugin-id", { status: "draining" });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values).toContain("draining");
  });

  it("passes null for bundle_key when clearing the key", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [makePluginRow()] });

    await repo.update("plugin-id", { bundle_key: null });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values).toContain(null);
  });

  it("handles uninstalled_at Date correctly", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [makePluginRow()] });
    const dt = new Date("2026-06-10T00:00:00Z");

    await repo.update("plugin-id", { uninstalled_at: dt });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values).toContain(dt);
  });
});

// ---------------------------------------------------------------------------
// findExpiredBundles
// ---------------------------------------------------------------------------

describe("PluginRepository.findExpiredBundles", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns expired plugin rows", async () => {
    const rows = [makePluginRow({ status: "uninstalled" })];
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });

    const result = await repo.findExpiredBundles();
    expect(result).toBe(rows);
  });

  it("returns empty array when no expired bundles", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findExpiredBundles();
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createApprovedUrl
// ---------------------------------------------------------------------------

describe("PluginRepository.createApprovedUrl", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns the created approved URL row on successful INSERT", async () => {
    const expected = makeApprovedUrlRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    const result = await repo.createApprovedUrl({
      plugin_id: "plugin-id",
      url_pattern: "https://api.example.com/*",
      approved_by: "user-001",
    });
    expect(result).toBe(expected);
  });

  it("fetches the existing row on ON CONFLICT DO NOTHING (empty INSERT result)", async () => {
    const existing = makeApprovedUrlRow({ url_pattern: "https://existing.example.com/*" });
    // First call: INSERT returns empty (conflict); second call: SELECT returns existing
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [existing] });

    const result = await repo.createApprovedUrl({
      plugin_id: "plugin-id",
      url_pattern: "https://existing.example.com/*",
      approved_by: "user-001",
    });
    expect(result).toBe(existing);
  });

  it("throws when conflict fetch also returns empty (data integrity error)", async () => {
    (pool.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      repo.createApprovedUrl({
        plugin_id: "plugin-id",
        url_pattern: "https://api.example.com/*",
        approved_by: "user-001",
      }),
    ).rejects.toThrow("Failed to fetch approved_url after upsert");
  });

  it("passes plugin_id, url_pattern, and approved_by as parameters", async () => {
    const expected = makeApprovedUrlRow();
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [expected] });

    await repo.createApprovedUrl({
      plugin_id: "my-plugin-id",
      url_pattern: "https://api.example.com/v1/*",
      approved_by: "admin-001",
    });
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("my-plugin-id");
    expect(values[1]).toBe("https://api.example.com/v1/*");
    expect(values[2]).toBe("admin-001");
  });
});

// ---------------------------------------------------------------------------
// findApprovedUrlsByPlugin
// ---------------------------------------------------------------------------

describe("PluginRepository.findApprovedUrlsByPlugin", () => {
  let pool: ReturnType<typeof makePool>;
  let repo: PluginRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new PluginRepository(pool);
  });

  it("returns all approved URL rows for the plugin", async () => {
    const rows = [
      makeApprovedUrlRow({ url_pattern: "https://api1.example.com/*" }),
      makeApprovedUrlRow({ url_pattern: "https://api2.example.com/*" }),
    ];
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });

    const result = await repo.findApprovedUrlsByPlugin("plugin-id");
    expect(result).toBe(rows);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no approved URLs", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await repo.findApprovedUrlsByPlugin("plugin-id");
    expect(result).toHaveLength(0);
  });

  it("passes pluginId as the query parameter", async () => {
    (pool.query as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    await repo.findApprovedUrlsByPlugin("my-plugin-id");
    const values = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("my-plugin-id");
  });
});
