import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import type { MarketplaceService } from "../services/marketplace-service.js";
import {
  MarketplaceListQuerySchema,
  PublishPluginSchema,
  RatePluginSchema,
  MarketplaceRatingsQuerySchema,
  PluginManifestSchema,
} from "../schemas/index.js";
import {
  MarketplacePluginNotFoundError,
  MarketplacePluginAlreadyExistsError,
  MarketplaceUnauthorizedError,
  MarketplaceInvalidRatingError,
} from "../services/marketplace-service.js";

export interface MarketplaceRouteDeps {
  marketplaceService: MarketplaceService;
}

// ---------------------------------------------------------------------------
// Rate-limit simple token bucket — in-memory per-instance.
// This is intentionally lightweight: real production rate limiting lives in
// the Caddy/Redis layer. The in-process guard provides defence in depth for
// the two mutating endpoints (publish, rate) that are most sensitive to abuse.
// ---------------------------------------------------------------------------

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

function createRateLimiter(maxTokens: number, refillPerMs: number) {
  const buckets = new Map<string, TokenBucket>();

  return function allow(key: string): boolean {
    const now = Date.now();
    let bucket = buckets.get(key);

    if (bucket === undefined) {
      bucket = { tokens: maxTokens, lastRefill: now };
      buckets.set(key, bucket);
    }

    // Refill tokens proportional to elapsed time.
    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor(elapsed * refillPerMs);
    bucket.tokens = Math.min(maxTokens, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      return false;
    }

    bucket.tokens -= 1;
    return true;
  };
}

// Publish: 5 per minute per user.
const publishRateLimit = createRateLimiter(5, 5 / 60_000);
// Rate: 20 per minute per user (rating multiple plugins in a session is normal).
const rateRateLimit = createRateLimiter(20, 20 / 60_000);

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createMarketplaceRoutes(
  deps: MarketplaceRouteDeps
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { marketplaceService } = deps;

  // --------------------------------------------------------------------------
  // GET /api/v1/marketplace/plugins — browse/search
  // --------------------------------------------------------------------------
  routes.get("/plugins", async (c) => {
    const query = MarketplaceListQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!query.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid query parameters",
            requestId: c.var.requestId,
            details: query.error.flatten(),
          },
        },
        400
      );
    }

    const { search, type, category, sortBy, cursor, limit } = query.data;
    const result = await marketplaceService.listPlugins({
      ...(search !== undefined ? { search } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(sortBy !== undefined ? { sortBy } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });
    return c.json(result);
  });

  // --------------------------------------------------------------------------
  // GET /api/v1/marketplace/plugins/:id — plugin details
  // --------------------------------------------------------------------------
  routes.get("/plugins/:id", async (c) => {
    const id = c.req.param("id");

    const plugin = await marketplaceService.getPluginDetails(id);
    return c.json(plugin);
  });

  // --------------------------------------------------------------------------
  // POST /api/v1/marketplace/plugins — publish plugin
  // --------------------------------------------------------------------------
  routes.post("/plugins", async (c) => {
    const user = c.var.user;
    if (user === undefined || user === null) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required to publish plugins",
            requestId: c.var.requestId,
          },
        },
        401
      );
    }

    if (!publishRateLimit(user.userId)) {
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many publish requests. Try again in a moment.",
            requestId: c.var.requestId,
          },
        },
        429
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request body must be JSON",
            requestId: c.var.requestId,
          },
        },
        400
      );
    }

    const parsed = PublishPluginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            requestId: c.var.requestId,
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    // Re-validate the manifest through the full PluginManifestSchema so the
    // marketplace entry is always backed by a well-formed manifest.
    const manifestParsed = PluginManifestSchema.safeParse(parsed.data.manifest);
    if (!manifestParsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_MANIFEST",
            message: "Manifest failed validation",
            requestId: c.var.requestId,
            details: manifestParsed.error.flatten(),
          },
        },
        422
      );
    }

    const { tags } = parsed.data;
    const plugin = await marketplaceService.publishPlugin(
      {
        manifest: manifestParsed.data,
        category: parsed.data.category,
        // Omit tags key when undefined (exactOptionalPropertyTypes).
        ...(tags !== undefined ? { tags } : {}),
      },
      user.userId
    );

    return c.json(plugin, 201);
  });

  // --------------------------------------------------------------------------
  // DELETE /api/v1/marketplace/plugins/:id — unpublish
  // --------------------------------------------------------------------------
  routes.delete("/plugins/:id", async (c) => {
    const user = c.var.user;
    if (user === undefined || user === null) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
            requestId: c.var.requestId,
          },
        },
        401
      );
    }

    const id = c.req.param("id");
    const isAdmin =
      user.roles?.includes("platform-admin") ||
      user.roles?.includes("admin") ||
      false;

    await marketplaceService.unpublishPlugin(id, user.userId, isAdmin);
    return c.body(null, 204);
  });

  // --------------------------------------------------------------------------
  // POST /api/v1/marketplace/plugins/:id/ratings — rate a plugin
  // --------------------------------------------------------------------------
  routes.post("/plugins/:id/ratings", async (c) => {
    const user = c.var.user;
    if (user === undefined || user === null) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required to rate plugins",
            requestId: c.var.requestId,
          },
        },
        401
      );
    }

    if (!rateRateLimit(user.userId)) {
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many rating requests. Try again in a moment.",
            requestId: c.var.requestId,
          },
        },
        429
      );
    }

    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request body must be JSON",
            requestId: c.var.requestId,
          },
        },
        400
      );
    }

    const parsed = RatePluginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid rating body",
            requestId: c.var.requestId,
            details: parsed.error.flatten(),
          },
        },
        400
      );
    }

    const { rating, review } = parsed.data;
    const ratingResult = await marketplaceService.ratePlugin(id, user.userId, {
      rating,
      // Omit review key when undefined (exactOptionalPropertyTypes).
      ...(review !== undefined ? { review } : {}),
    });

    return c.json(ratingResult, 201);
  });

  // --------------------------------------------------------------------------
  // GET /api/v1/marketplace/plugins/:id/ratings — get ratings
  // --------------------------------------------------------------------------
  routes.get("/plugins/:id/ratings", async (c) => {
    const id = c.req.param("id");

    const query = MarketplaceRatingsQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    if (!query.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid query parameters",
            requestId: c.var.requestId,
            details: query.error.flatten(),
          },
        },
        400
      );
    }

    const result = await marketplaceService.getPluginRatings(
      id,
      query.data.limit,
      query.data.cursor
    );

    return c.json(result);
  });

  // --------------------------------------------------------------------------
  // POST /api/v1/marketplace/plugins/:id/install — install to caller's tenant
  // --------------------------------------------------------------------------
  routes.post("/plugins/:id/install", async (c) => {
    const user = c.var.user;
    if (user === undefined || user === null) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required to install plugins",
            requestId: c.var.requestId,
          },
        },
        401
      );
    }

    const id = c.req.param("id");
    await marketplaceService.installPlugin(id, user.tenantId, user.userId);

    // The marketplace install endpoint records the download and fires the event.
    // Actual plugin bundle installation is handled separately via the existing
    // POST /api/v1/plugins endpoint — this endpoint is the discovery/telemetry step.
    return c.json(
      {
        status: "recorded",
        message:
          "Marketplace install recorded. Use POST /api/v1/plugins to deploy the plugin bundle to your tenant.",
        pluginId: id,
      },
      200
    );
  });

  return routes;
}

// ---------------------------------------------------------------------------
// Shared error handler — converts domain errors to JSON responses.
// Called from the global error handler in index.ts via the route registration.
// We export it so tests can invoke it directly.
// ---------------------------------------------------------------------------

export function handleMarketplaceError(
  err: unknown,
  requestId: string
): { body: Record<string, unknown>; status: number } {
  if (err instanceof MarketplacePluginNotFoundError) {
    return {
      body: { error: { code: err.code, message: err.message, requestId } },
      status: 404,
    };
  }
  if (err instanceof MarketplacePluginAlreadyExistsError) {
    return {
      body: { error: { code: err.code, message: err.message, requestId } },
      status: 409,
    };
  }
  if (err instanceof MarketplaceUnauthorizedError) {
    return {
      body: { error: { code: err.code, message: err.message, requestId } },
      status: 403,
    };
  }
  if (err instanceof MarketplaceInvalidRatingError) {
    return {
      body: { error: { code: err.code, message: err.message, requestId } },
      status: 422,
    };
  }
  return {
    body: {
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId },
    },
    status: 500,
  };
}
