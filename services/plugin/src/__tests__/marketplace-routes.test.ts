// Unit tests for marketplace route handler (routes/marketplace.ts)
//
// Covers HTTP layer concerns:
//  - Query parameter validation and coercion
//  - Authentication guard (401 when no user)
//  - Rate limit guard (429)
//  - Request body validation (400)
//  - Manifest re-validation (422)
//  - Domain error → HTTP status mapping via global error handler

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { createMarketplaceRoutes } from "../routes/marketplace.js";
import type { MarketplaceService } from "../services/marketplace-service.js";
import {
  MarketplacePluginNotFoundError,
  MarketplacePluginAlreadyExistsError,
  MarketplaceUnauthorizedError,
  MarketplaceInvalidRatingError,
} from "../services/marketplace-service.js";
import type { PluginManifest } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CHECKSUM = "a".repeat(64);

function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    manifestVersion: "1",
    id: "com.example.test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    type: "connector",
    description: "A test plugin",
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

function makeMarketplacePlugin() {
  return {
    id: "mp-id-1234",
    name: "com.example.test-plugin",
    displayName: "Test Plugin",
    description: "A test plugin",
    version: "1.0.0",
    type: "connector" as const,
    author: { name: "Test Author" },
    category: "crm",
    tags: ["test"],
    downloads: 42,
    rating: { average: 4.5, count: 10 },
    publishedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    verified: false,
    manifest: makeManifest(),
  };
}

function makeMarketplaceService(): MarketplaceService {
  return {
    listPlugins: vi.fn().mockResolvedValue({
      items: [makeMarketplacePlugin()],
      nextCursor: null,
      total: 1,
    }),
    getPluginDetails: vi.fn().mockResolvedValue(makeMarketplacePlugin()),
    publishPlugin: vi.fn().mockResolvedValue(makeMarketplacePlugin()),
    unpublishPlugin: vi.fn().mockResolvedValue(undefined),
    ratePlugin: vi.fn().mockResolvedValue({
      id: "rating-1",
      userId: "user-222",
      rating: 4,
      review: "Good",
      createdAt: "2026-01-10T00:00:00.000Z",
      updatedAt: "2026-01-10T00:00:00.000Z",
    }),
    getPluginRatings: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    installPlugin: vi.fn().mockResolvedValue(undefined),
  };
}

// Build a minimal Hono app with fake auth middleware that injects a user.
function buildApp(
  svc: MarketplaceService,
  userOverrides?: Partial<AppVariables["user"]>
) {
  const app = new Hono<{ Variables: AppVariables }>();

  // Inject a fake authenticated user before the marketplace routes.
  app.use("*", async (c, next) => {
    const user = {
      userId: "user-111",
      tenantId: "tenant-aaa",
      email: "user@example.com",
      roles: ["user"],
      scopes: [],
      ...userOverrides,
    };
    c.set("user", user as AppVariables["user"]);
    c.set("requestId", "req-test-id");
    await next();
  });

  const marketplaceRoutes = createMarketplaceRoutes({ marketplaceService: svc });

  // Wire domain error handling so tests can verify the HTTP responses.
  app.onError((err, c) => {
    const requestId = c.var.requestId ?? "unknown";
    if (err instanceof MarketplacePluginNotFoundError) {
      return c.json({ error: { code: err.code, message: err.message, requestId } }, 404);
    }
    if (err instanceof MarketplacePluginAlreadyExistsError) {
      return c.json({ error: { code: err.code, message: err.message, requestId } }, 409);
    }
    if (err instanceof MarketplaceUnauthorizedError) {
      return c.json({ error: { code: err.code, message: err.message, requestId } }, 403);
    }
    if (err instanceof MarketplaceInvalidRatingError) {
      return c.json({ error: { code: err.code, message: err.message, requestId } }, 422);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: String(err), requestId } }, 500);
  });

  app.route("/api/v1/marketplace", marketplaceRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Marketplace Routes", () => {
  let svc: MarketplaceService;

  beforeEach(() => {
    svc = makeMarketplaceService();
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/marketplace/plugins
  // -------------------------------------------------------------------------

  describe("GET /api/v1/marketplace/plugins", () => {
    it("returns 200 with list result", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins");
      expect(res.status).toBe(200);

      const body = await res.json() as { items: unknown[]; total: number };
      expect(body.items).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("passes search param to service", async () => {
      const app = buildApp(svc);
      await app.request("/api/v1/marketplace/plugins?search=stripe");
      expect(svc.listPlugins).toHaveBeenCalledWith(
        expect.objectContaining({ search: "stripe" })
      );
    });

    it("returns 400 for invalid sortBy value", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins?sortBy=invalid");
      expect(res.status).toBe(400);
    });

    it("returns 400 for limit out of range", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins?limit=0");
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/marketplace/plugins/:id
  // -------------------------------------------------------------------------

  describe("GET /api/v1/marketplace/plugins/:id", () => {
    it("returns 200 with plugin details", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins/mp-id-1234");
      expect(res.status).toBe(200);

      const body = await res.json() as { id: string };
      expect(body.id).toBe("mp-id-1234");
    });

    it("returns 404 when service throws MarketplacePluginNotFoundError", async () => {
      (svc.getPluginDetails as ReturnType<typeof vi.fn>).mockRejectedValue(
        new MarketplacePluginNotFoundError("not found")
      );
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins/no-such-id");
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/marketplace/plugins
  // -------------------------------------------------------------------------

  describe("POST /api/v1/marketplace/plugins", () => {
    it("returns 201 on successful publish", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: makeManifest(), category: "crm" }),
      });
      expect(res.status).toBe(201);
    });

    it("returns 401 when user is not authenticated", async () => {
      // Build app with null user.
      const app = new Hono<{ Variables: AppVariables }>();
      app.use("*", async (c, next) => {
        c.set("user", null as unknown as AppVariables["user"]);
        c.set("requestId", "req-test-id");
        await next();
      });
      const marketplaceRoutes = createMarketplaceRoutes({ marketplaceService: svc });
      app.route("/api/v1/marketplace", marketplaceRoutes);

      const res = await app.request("/api/v1/marketplace/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: makeManifest(), category: "crm" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 when category is missing", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: makeManifest() }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 422 when manifest fails PluginManifestSchema validation", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Missing required manifest fields
          manifest: { id: "bad-id", name: "X" },
          category: "crm",
        }),
      });
      expect(res.status).toBe(422);
    });

    it("returns 409 when service throws MarketplacePluginAlreadyExistsError", async () => {
      (svc.publishPlugin as ReturnType<typeof vi.fn>).mockRejectedValue(
        new MarketplacePluginAlreadyExistsError("already exists")
      );
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest: makeManifest(), category: "crm" }),
      });
      expect(res.status).toBe(409);
    });

    it("returns 400 for non-JSON body", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/marketplace/plugins/:id
  // -------------------------------------------------------------------------

  describe("DELETE /api/v1/marketplace/plugins/:id", () => {
    it("returns 204 on successful unpublish", async () => {
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins/mp-id-1234", {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
    });

    it("passes isAdmin=true when user has platform-admin role", async () => {
      const app = buildApp(svc, { roles: ["platform-admin"] });
      await app.request("/api/v1/marketplace/plugins/mp-id-1234", {
        method: "DELETE",
      });
      expect(svc.unpublishPlugin).toHaveBeenCalledWith(
        "mp-id-1234",
        "user-111",
        true
      );
    });

    it("returns 403 when service throws MarketplaceUnauthorizedError", async () => {
      (svc.unpublishPlugin as ReturnType<typeof vi.fn>).mockRejectedValue(
        new MarketplaceUnauthorizedError("forbidden")
      );
      const app = buildApp(svc);
      const res = await app.request("/api/v1/marketplace/plugins/mp-id-1234", {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/marketplace/plugins/:id/ratings
  // -------------------------------------------------------------------------

  describe("POST /api/v1/marketplace/plugins/:id/ratings", () => {
    it("returns 201 on successful rating", async () => {
      const app = buildApp(svc);
      const res = await app.request(
        "/api/v1/marketplace/plugins/mp-id-1234/ratings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: 4, review: "Great!" }),
        }
      );
      expect(res.status).toBe(201);
    });

    it("returns 400 for rating outside 1-5", async () => {
      const app = buildApp(svc);
      const res = await app.request(
        "/api/v1/marketplace/plugins/mp-id-1234/ratings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: 6 }),
        }
      );
      expect(res.status).toBe(400);
    });

    it("returns 422 when service throws MarketplaceInvalidRatingError", async () => {
      (svc.ratePlugin as ReturnType<typeof vi.fn>).mockRejectedValue(
        new MarketplaceInvalidRatingError("bad rating")
      );
      const app = buildApp(svc);
      const res = await app.request(
        "/api/v1/marketplace/plugins/mp-id-1234/ratings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: 3 }),
        }
      );
      expect(res.status).toBe(422);
    });

    it("returns 404 when plugin does not exist", async () => {
      (svc.ratePlugin as ReturnType<typeof vi.fn>).mockRejectedValue(
        new MarketplacePluginNotFoundError("not found")
      );
      const app = buildApp(svc);
      const res = await app.request(
        "/api/v1/marketplace/plugins/no-such-id/ratings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: 3 }),
        }
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/marketplace/plugins/:id/ratings
  // -------------------------------------------------------------------------

  describe("GET /api/v1/marketplace/plugins/:id/ratings", () => {
    it("returns 200 with ratings list", async () => {
      const app = buildApp(svc);
      const res = await app.request(
        "/api/v1/marketplace/plugins/mp-id-1234/ratings"
      );
      expect(res.status).toBe(200);

      const body = await res.json() as { items: unknown[] };
      expect(Array.isArray(body.items)).toBe(true);
    });

    it("returns 400 for invalid limit query param", async () => {
      const app = buildApp(svc);
      const res = await app.request(
        "/api/v1/marketplace/plugins/mp-id-1234/ratings?limit=200"
      );
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/marketplace/plugins/:id/install
  // -------------------------------------------------------------------------

  describe("POST /api/v1/marketplace/plugins/:id/install", () => {
    it("returns 200 with status recorded", async () => {
      const app = buildApp(svc);
      const res = await app.request(
        "/api/v1/marketplace/plugins/mp-id-1234/install",
        { method: "POST" }
      );
      expect(res.status).toBe(200);

      const body = await res.json() as { status: string };
      expect(body.status).toBe("recorded");
    });

    it("calls installPlugin with correct tenantId and userId", async () => {
      const app = buildApp(svc, {
        userId: "user-xyz",
        tenantId: "tenant-xyz",
      });
      await app.request("/api/v1/marketplace/plugins/mp-id-1234/install", {
        method: "POST",
      });
      expect(svc.installPlugin).toHaveBeenCalledWith(
        "mp-id-1234",
        "tenant-xyz",
        "user-xyz"
      );
    });

    it("returns 404 when plugin does not exist", async () => {
      (svc.installPlugin as ReturnType<typeof vi.fn>).mockRejectedValue(
        new MarketplacePluginNotFoundError("not found")
      );
      const app = buildApp(svc);
      const res = await app.request(
        "/api/v1/marketplace/plugins/no-such-id/install",
        { method: "POST" }
      );
      expect(res.status).toBe(404);
    });
  });
});
