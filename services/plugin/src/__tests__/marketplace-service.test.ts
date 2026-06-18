// Unit tests for marketplace-service.ts
//
// Covers:
//  - listPlugins: pagination, search, filter, sort
//  - publishPlugin: success path, duplicate guard, manifest type mapping
//  - unpublishPlugin: success (owner), success (admin), unauthorized, not-found
//  - ratePlugin: insert, update (upsert), invalid rating value, not-found
//  - getPluginRatings: success, not-found, pagination
//  - installPlugin: success, download counter increment, not-found

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMarketplaceService } from "../services/marketplace-service.js";
import type { MarketplaceServiceDeps } from "../services/marketplace-service.js";
import {
  MarketplacePluginNotFoundError,
  MarketplacePluginAlreadyExistsError,
  MarketplaceUnauthorizedError,
  MarketplaceInvalidRatingError,
} from "../services/marketplace-service.js";
import type { MarketplaceRepository } from "../repositories/marketplace-repository.js";
import type { MarketplacePluginRow, PluginRatingRow } from "../repositories/marketplace-types.js";
import type { PluginManifest } from "../schemas/index.js";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type pg from "pg";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

const VALID_CHECKSUM = "a".repeat(64);

function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    manifestVersion: "1",
    id: "com.example.test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    type: "connector",
    description: "A test plugin for marketplace tests",
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
    tags: ["test", "example"],
    ...overrides,
  };
}

function makeMarketplaceRow(
  overrides?: Partial<MarketplacePluginRow>
): MarketplacePluginRow {
  return {
    id: "mp-id-1234",
    name: "com.example.test-plugin",
    display_name: "Test Plugin",
    description: "A test plugin for marketplace tests",
    version: "1.0.0",
    type: "connector",
    author_name: "Test Author",
    author_email: null,
    category: "crm",
    tags: ["test"],
    manifest: makeManifest(),
    downloads: "42",
    rating_average: "4.50",
    rating_count: 10,
    verified: false,
    published_by: "user-111",
    published_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

function makeRatingRow(overrides?: Partial<PluginRatingRow>): PluginRatingRow {
  return {
    id: "rating-id-1",
    marketplace_plugin_id: "mp-id-1234",
    user_id: "user-222",
    rating: 4,
    review: "Great plugin!",
    created_at: new Date("2026-01-10T00:00:00Z"),
    updated_at: new Date("2026-01-10T00:00:00Z"),
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

// Returns a plain object of vi.fn() stubs. TypeScript infers the type as the
// object literal (not as MarketplaceRepository), so mock methods like
// .mockResolvedValue() remain accessible to callers. The cast to
// MarketplaceRepository only happens when wiring into MarketplaceServiceDeps.
function makeMarketplaceRepo() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    incrementDownloads: vi.fn().mockResolvedValue(undefined),
    refreshRatingStats: vi.fn().mockResolvedValue(undefined),
    setVerified: vi.fn(),
    upsertRating: vi.fn(),
    findRatingsByPlugin: vi.fn(),
    findRatingByUser: vi.fn(),
  };
}

// Fake pg.Pool that provides a client stub with BEGIN/COMMIT/ROLLBACK.
function makePool() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
  return {
    connect: vi.fn().mockResolvedValue(client),
    _client: client,
  } as unknown as pg.Pool & { _client: typeof client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MarketplaceService", () => {
  let marketplaceRepo: ReturnType<typeof makeMarketplaceRepo>;
  let logger: Logger;
  let eventPublisher: EventPublisher;
  let pool: ReturnType<typeof makePool>;
  let deps: MarketplaceServiceDeps;

  beforeEach(() => {
    marketplaceRepo = makeMarketplaceRepo();
    logger = makeLogger();
    eventPublisher = makeEventPublisher();
    pool = makePool();
    deps = {
      pool: pool as unknown as pg.Pool,
      marketplaceRepo: marketplaceRepo as unknown as MarketplaceRepository,
      logger,
      eventPublisher,
    };
  });

  // -------------------------------------------------------------------------
  // listPlugins
  // -------------------------------------------------------------------------

  describe("listPlugins", () => {
    it("returns items, total, and null nextCursor when fewer results than limit", async () => {
      const row = makeMarketplaceRow();
      marketplaceRepo.list.mockResolvedValue({ rows: [row], total: 1 });

      const svc = createMarketplaceService(deps);
      const result = await svc.listPlugins({ limit: 20 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    });

    it("returns a nextCursor when result count equals limit", async () => {
      const rows = Array.from({ length: 5 }, (_, i) =>
        makeMarketplaceRow({ id: `id-${i}`, name: `com.example.plugin-${i}` })
      );
      marketplaceRepo.list.mockResolvedValue({ rows, total: 50 });

      const svc = createMarketplaceService(deps);
      const result = await svc.listPlugins({ limit: 5 });

      expect(result.nextCursor).not.toBeNull();
      // Cursor must be a non-empty string.
      expect(typeof result.nextCursor).toBe("string");
      expect((result.nextCursor ?? "").length).toBeGreaterThan(0);
    });

    it("passes search, type, category, and sortBy to the repository", async () => {
      marketplaceRepo.list.mockResolvedValue({ rows: [], total: 0 });

      const svc = createMarketplaceService(deps);
      await svc.listPlugins({
        search: "shopify",
        type: "connector",
        category: "ecommerce",
        sortBy: "rating",
        limit: 10,
      });

      expect(marketplaceRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({
          search: "shopify",
          type: "connector",
          category: "ecommerce",
          sortBy: "rating",
          limit: 10,
        })
      );
    });

    it("clamps limit to MAX_LIMIT (100)", async () => {
      marketplaceRepo.list.mockResolvedValue({ rows: [], total: 0 });

      const svc = createMarketplaceService(deps);
      await svc.listPlugins({ limit: 9999 });

      expect(marketplaceRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 })
      );
    });

    it("projects row fields into camelCase domain model", async () => {
      const row = makeMarketplaceRow({
        downloads: "77",
        rating_average: "3.25",
        rating_count: 4,
        author_email: "author@example.com",
      });
      marketplaceRepo.list.mockResolvedValue({ rows: [row], total: 1 });

      const svc = createMarketplaceService(deps);
      const result = await svc.listPlugins({ limit: 20 });

      const item = result.items[0]!;
      expect(item.downloads).toBe(77);
      expect(item.rating.average).toBe(3.25);
      expect(item.rating.count).toBe(4);
      expect(item.author.email).toBe("author@example.com");
    });
  });

  // -------------------------------------------------------------------------
  // getPluginDetails
  // -------------------------------------------------------------------------

  describe("getPluginDetails", () => {
    it("returns the projected plugin when found", async () => {
      const row = makeMarketplaceRow();
      marketplaceRepo.findById.mockResolvedValue(row);

      const svc = createMarketplaceService(deps);
      const result = await svc.getPluginDetails("mp-id-1234");

      expect(result.id).toBe("mp-id-1234");
      expect(result.displayName).toBe("Test Plugin");
    });

    it("throws MarketplacePluginNotFoundError when missing", async () => {
      marketplaceRepo.findById.mockResolvedValue(null);

      const svc = createMarketplaceService(deps);
      await expect(svc.getPluginDetails("no-such-id")).rejects.toThrow(
        MarketplacePluginNotFoundError
      );
    });
  });

  // -------------------------------------------------------------------------
  // publishPlugin
  // -------------------------------------------------------------------------

  describe("publishPlugin", () => {
    it("creates and returns the marketplace plugin", async () => {
      marketplaceRepo.findByName.mockResolvedValue(null);
      const row = makeMarketplaceRow();
      marketplaceRepo.create.mockResolvedValue(row);

      const svc = createMarketplaceService(deps);
      const result = await svc.publishPlugin(
        { manifest: makeManifest(), category: "crm" },
        "user-111"
      );

      expect(result.name).toBe("com.example.test-plugin");
      expect(marketplaceRepo.create).toHaveBeenCalledOnce();
    });

    it("throws MarketplacePluginAlreadyExistsError when name is taken", async () => {
      marketplaceRepo.findByName.mockResolvedValue(makeMarketplaceRow());

      const svc = createMarketplaceService(deps);
      await expect(
        svc.publishPlugin({ manifest: makeManifest(), category: "crm" }, "user-111")
      ).rejects.toThrow(MarketplacePluginAlreadyExistsError);
    });

    it("maps widget manifest type to 'custom' marketplace type", async () => {
      marketplaceRepo.findByName.mockResolvedValue(null);
      const row = makeMarketplaceRow({ type: "custom" });
      marketplaceRepo.create.mockResolvedValue(row);

      const svc = createMarketplaceService(deps);
      await svc.publishPlugin(
        { manifest: makeManifest({ type: "widget" }), category: "crm" },
        "user-111"
      );

      expect(marketplaceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: "custom" })
      );
    });

    it("normalises category and tags to lowercase", async () => {
      marketplaceRepo.findByName.mockResolvedValue(null);
      const row = makeMarketplaceRow();
      marketplaceRepo.create.mockResolvedValue(row);

      const svc = createMarketplaceService(deps);
      await svc.publishPlugin(
        { manifest: makeManifest(), category: "CRM", tags: ["Shopify", "ECommerce"] },
        "user-111"
      );

      expect(marketplaceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "crm",
          tags: ["shopify", "ecommerce"],
        })
      );
    });

    it("emits marketplace.plugin.published event", async () => {
      marketplaceRepo.findByName.mockResolvedValue(null);
      marketplaceRepo.create.mockResolvedValue(makeMarketplaceRow());

      const svc = createMarketplaceService(deps);
      await svc.publishPlugin(
        { manifest: makeManifest(), category: "crm" },
        "user-111"
      );

      expect(eventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "marketplace.plugin.published" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // unpublishPlugin
  // -------------------------------------------------------------------------

  describe("unpublishPlugin", () => {
    it("allows the original author to unpublish", async () => {
      const row = makeMarketplaceRow({ published_by: "user-111" });
      marketplaceRepo.findById.mockResolvedValue(row);
      marketplaceRepo.delete.mockResolvedValue(true);

      const svc = createMarketplaceService(deps);
      await expect(
        svc.unpublishPlugin("mp-id-1234", "user-111", false)
      ).resolves.toBeUndefined();

      expect(marketplaceRepo.delete).toHaveBeenCalledWith("mp-id-1234");
    });

    it("allows a platform admin to unpublish someone else's plugin", async () => {
      const row = makeMarketplaceRow({ published_by: "user-111" });
      marketplaceRepo.findById.mockResolvedValue(row);
      marketplaceRepo.delete.mockResolvedValue(true);

      const svc = createMarketplaceService(deps);
      await expect(
        svc.unpublishPlugin("mp-id-1234", "admin-user", true)
      ).resolves.toBeUndefined();
    });

    it("throws MarketplaceUnauthorizedError when non-author non-admin tries to unpublish", async () => {
      const row = makeMarketplaceRow({ published_by: "user-111" });
      marketplaceRepo.findById.mockResolvedValue(row);

      const svc = createMarketplaceService(deps);
      await expect(
        svc.unpublishPlugin("mp-id-1234", "other-user", false)
      ).rejects.toThrow(MarketplaceUnauthorizedError);

      expect(marketplaceRepo.delete).not.toHaveBeenCalled();
    });

    it("throws MarketplacePluginNotFoundError when plugin does not exist", async () => {
      marketplaceRepo.findById.mockResolvedValue(null);

      const svc = createMarketplaceService(deps);
      await expect(
        svc.unpublishPlugin("no-such-id", "user-111", false)
      ).rejects.toThrow(MarketplacePluginNotFoundError);
    });

    it("emits marketplace.plugin.unpublished event", async () => {
      const row = makeMarketplaceRow({ published_by: "user-111" });
      marketplaceRepo.findById.mockResolvedValue(row);
      marketplaceRepo.delete.mockResolvedValue(true);

      const svc = createMarketplaceService(deps);
      await svc.unpublishPlugin("mp-id-1234", "user-111", false);

      expect(eventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "marketplace.plugin.unpublished" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // ratePlugin
  // -------------------------------------------------------------------------

  describe("ratePlugin", () => {
    it("inserts a new rating and returns it", async () => {
      marketplaceRepo.findById.mockResolvedValue(makeMarketplaceRow());
      const ratingRow = makeRatingRow();
      marketplaceRepo.upsertRating.mockResolvedValue({ row: ratingRow, inserted: true });

      const svc = createMarketplaceService(deps);
      const result = await svc.ratePlugin("mp-id-1234", "user-222", {
        rating: 4,
        review: "Great plugin!",
      });

      expect(result.rating).toBe(4);
      expect(result.review).toBe("Great plugin!");
    });

    it("updates an existing rating (upsert)", async () => {
      marketplaceRepo.findById.mockResolvedValue(makeMarketplaceRow());
      const ratingRow = makeRatingRow({ rating: 5, review: "Updated review" });
      marketplaceRepo.upsertRating.mockResolvedValue({ row: ratingRow, inserted: false });

      const svc = createMarketplaceService(deps);
      const result = await svc.ratePlugin("mp-id-1234", "user-222", {
        rating: 5,
        review: "Updated review",
      });

      expect(result.rating).toBe(5);
    });

    it("refreshes denormalised stats after rating", async () => {
      marketplaceRepo.findById.mockResolvedValue(makeMarketplaceRow());
      marketplaceRepo.upsertRating.mockResolvedValue({
        row: makeRatingRow(),
        inserted: true,
      });

      const svc = createMarketplaceService(deps);
      await svc.ratePlugin("mp-id-1234", "user-222", { rating: 3 });

      expect(marketplaceRepo.refreshRatingStats).toHaveBeenCalledWith(
        "mp-id-1234",
        expect.anything() // pg.PoolClient
      );
    });

    it("throws MarketplaceInvalidRatingError for rating < 1", async () => {
      const svc = createMarketplaceService(deps);
      await expect(
        svc.ratePlugin("mp-id-1234", "user-222", { rating: 0 })
      ).rejects.toThrow(MarketplaceInvalidRatingError);
    });

    it("throws MarketplaceInvalidRatingError for rating > 5", async () => {
      const svc = createMarketplaceService(deps);
      await expect(
        svc.ratePlugin("mp-id-1234", "user-222", { rating: 6 })
      ).rejects.toThrow(MarketplaceInvalidRatingError);
    });

    it("throws MarketplaceInvalidRatingError for non-integer rating", async () => {
      const svc = createMarketplaceService(deps);
      await expect(
        svc.ratePlugin("mp-id-1234", "user-222", { rating: 3.5 })
      ).rejects.toThrow(MarketplaceInvalidRatingError);
    });

    it("throws MarketplacePluginNotFoundError when plugin does not exist", async () => {
      marketplaceRepo.findById.mockResolvedValue(null);

      const svc = createMarketplaceService(deps);
      await expect(
        svc.ratePlugin("no-such-id", "user-222", { rating: 4 })
      ).rejects.toThrow(MarketplacePluginNotFoundError);
    });

    it("rolls back the transaction on repo failure", async () => {
      marketplaceRepo.findById.mockResolvedValue(makeMarketplaceRow());
      marketplaceRepo.upsertRating.mockRejectedValue(new Error("DB error"));

      const svc = createMarketplaceService(deps);
      await expect(
        svc.ratePlugin("mp-id-1234", "user-222", { rating: 4 })
      ).rejects.toThrow("DB error");

      const client = pool._client;
      // BEGIN called, then ROLLBACK called
      expect(client.query).toHaveBeenCalledWith("BEGIN");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      // COMMIT must NOT have been called
      const commitCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls.filter(
        (args: unknown[]) => args[0] === "COMMIT"
      );
      expect(commitCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getPluginRatings
  // -------------------------------------------------------------------------

  describe("getPluginRatings", () => {
    it("returns ratings for a plugin", async () => {
      marketplaceRepo.findById.mockResolvedValue(makeMarketplaceRow());
      marketplaceRepo.findRatingsByPlugin.mockResolvedValue([makeRatingRow()]);

      const svc = createMarketplaceService(deps);
      const result = await svc.getPluginRatings("mp-id-1234", 20);

      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    });

    it("returns nextCursor when result count equals limit", async () => {
      marketplaceRepo.findById.mockResolvedValue(makeMarketplaceRow());
      const rows = Array.from({ length: 5 }, (_, i) =>
        makeRatingRow({ id: `r-${i}` })
      );
      marketplaceRepo.findRatingsByPlugin.mockResolvedValue(rows);

      const svc = createMarketplaceService(deps);
      const result = await svc.getPluginRatings("mp-id-1234", 5);

      expect(result.nextCursor).toBe("r-4");
    });

    it("throws MarketplacePluginNotFoundError when plugin does not exist", async () => {
      marketplaceRepo.findById.mockResolvedValue(null);

      const svc = createMarketplaceService(deps);
      await expect(
        svc.getPluginRatings("no-such-id", 20)
      ).rejects.toThrow(MarketplacePluginNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // installPlugin
  // -------------------------------------------------------------------------

  describe("installPlugin", () => {
    it("increments download counter and emits event on success", async () => {
      marketplaceRepo.findById.mockResolvedValue(makeMarketplaceRow());

      const svc = createMarketplaceService(deps);
      await svc.installPlugin("mp-id-1234", "tenant-abc", "user-333");

      expect(marketplaceRepo.incrementDownloads).toHaveBeenCalledWith("mp-id-1234");
      expect(eventPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "marketplace.plugin.installed" })
      );
    });

    it("throws MarketplacePluginNotFoundError when plugin does not exist", async () => {
      marketplaceRepo.findById.mockResolvedValue(null);

      const svc = createMarketplaceService(deps);
      await expect(
        svc.installPlugin("no-such-id", "tenant-abc", "user-333")
      ).rejects.toThrow(MarketplacePluginNotFoundError);
    });

    it("logs a warning but does not fail if incrementDownloads throws", async () => {
      marketplaceRepo.findById.mockResolvedValue(makeMarketplaceRow());
      marketplaceRepo.incrementDownloads.mockRejectedValue(new Error("Redis timeout"));

      const svc = createMarketplaceService(deps);
      // Must not throw — download counter is best-effort.
      await expect(
        svc.installPlugin("mp-id-1234", "tenant-abc", "user-333")
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        "Failed to increment download counter",
        expect.objectContaining({ pluginId: "mp-id-1234" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Full-text search delegation
  // -------------------------------------------------------------------------

  describe("full-text search", () => {
    it("passes the search term to the repository unchanged", async () => {
      marketplaceRepo.list.mockResolvedValue({ rows: [], total: 0 });

      const svc = createMarketplaceService(deps);
      await svc.listPlugins({ search: "stripe payments", limit: 10 });

      expect(marketplaceRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ search: "stripe payments" })
      );
    });
  });
});
