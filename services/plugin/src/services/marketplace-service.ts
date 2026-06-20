import type pg from "pg";
import type { Logger, EventPublisher } from "@oneplatform/core";
import type { MarketplaceRepository } from "../repositories/marketplace-repository.js";
import type { PluginManifest } from "../schemas/index.js";
import type {
  MarketplacePluginRow,
  PluginRatingRow,
  MarketplacePluginType,
} from "../repositories/marketplace-types.js";
import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Domain errors — specific codes so API handlers can map to HTTP status
// ---------------------------------------------------------------------------

export class MarketplacePluginNotFoundError extends AppError {
  readonly code = "MARKETPLACE_PLUGIN_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class MarketplacePluginAlreadyExistsError extends AppError {
  readonly code = "MARKETPLACE_PLUGIN_ALREADY_EXISTS" as const;
  readonly statusCode = 409;
}

export class MarketplaceUnauthorizedError extends AppError {
  readonly code = "MARKETPLACE_UNAUTHORIZED" as const;
  readonly statusCode = 403;
}

export class MarketplaceInvalidRatingError extends AppError {
  readonly code = "MARKETPLACE_INVALID_RATING" as const;
  readonly statusCode = 422;
}

// ---------------------------------------------------------------------------
// Public interface types
// ---------------------------------------------------------------------------

export interface MarketplacePlugin {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  type: MarketplacePluginType;
  author: { name: string; email?: string };
  category: string;
  tags: string[];
  downloads: number;
  rating: { average: number; count: number };
  publishedAt: string;
  updatedAt: string;
  verified: boolean;
  manifest: PluginManifest;
}

export interface MarketplacePluginRating {
  id: string;
  userId: string;
  rating: number;
  review: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceListOptions {
  search?: string;
  type?: string;
  category?: string;
  sortBy?: "popular" | "recent" | "rating" | "name";
  cursor?: string;
  limit?: number;
}

export interface MarketplaceListResult {
  items: MarketplacePlugin[];
  nextCursor: string | null;
  total: number;
}

export interface PublishPluginInput {
  manifest: PluginManifest;
  category: string;
  tags?: string[];
}

export interface RatePluginInput {
  rating: number;
  review?: string;
}

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface MarketplaceServiceDeps {
  pool: pg.Pool;
  marketplaceRepo: MarketplaceRepository;
  logger: Logger;
  eventPublisher: EventPublisher;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface MarketplaceService {
  listPlugins(options: MarketplaceListOptions): Promise<MarketplaceListResult>;
  getPluginDetails(pluginId: string): Promise<MarketplacePlugin>;
  publishPlugin(input: PublishPluginInput, userId: string): Promise<MarketplacePlugin>;
  unpublishPlugin(pluginId: string, userId: string, isAdmin: boolean): Promise<void>;
  ratePlugin(
    pluginId: string,
    userId: string,
    input: RatePluginInput
  ): Promise<MarketplacePluginRating>;
  getPluginRatings(
    pluginId: string,
    limit: number,
    cursor?: string
  ): Promise<{ items: MarketplacePluginRating[]; nextCursor: string | null }>;
  installPlugin(pluginId: string, tenantId: string, userId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Row → domain model projection
// ---------------------------------------------------------------------------

function toMarketplacePlugin(row: MarketplacePluginRow): MarketplacePlugin {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    version: row.version,
    type: row.type,
    author: {
      name: row.author_name,
      ...(row.author_email !== null ? { email: row.author_email } : {}),
    },
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    downloads: typeof row.downloads === "string"
      ? parseInt(row.downloads, 10)
      : Number(row.downloads),
    rating: {
      average: typeof row.rating_average === "string"
        ? parseFloat(row.rating_average)
        : Number(row.rating_average),
      count: row.rating_count,
    },
    publishedAt: row.published_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    verified: row.verified,
    manifest: row.manifest,
  };
}

function toMarketplaceRating(row: PluginRatingRow): MarketplacePluginRating {
  return {
    id: row.id,
    userId: row.user_id,
    rating: row.rating,
    review: row.review,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Encode the opaque pagination cursor from the last row's sort column value.
// Base64-encoding ensures the cursor is URL-safe and opaque to callers.
function encodeCursor(row: MarketplacePluginRow, sortBy: string): string {
  const sortVal =
    sortBy === "popular"
      ? String(row.downloads)
      : sortBy === "rating"
      ? String(row.rating_average)
      : sortBy === "recent"
      ? row.published_at.toISOString()
      : row.name;

  return Buffer.from(JSON.stringify({ id: row.id, sortVal })).toString("base64");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMarketplaceService(
  deps: MarketplaceServiceDeps
): MarketplaceService {
  const { pool, marketplaceRepo, logger, eventPublisher } = deps;

  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 100;

  function sanitizeSearchInput(raw: string): string {
    return raw.replace(/[^\p{L}\p{N}\s\-_.@]/gu, "").trim().slice(0, 200);
  }

  return {
    async listPlugins(options) {
      const limit = Math.min(
        Math.max(1, options.limit ?? DEFAULT_LIMIT),
        MAX_LIMIT
      );

      const sanitizedSearch =
        options.search !== undefined ? sanitizeSearchInput(options.search) : undefined;

      const { rows, total } = await marketplaceRepo.list({
        ...(sanitizedSearch !== undefined && sanitizedSearch.length > 0 ? { search: sanitizedSearch } : {}),
        ...(options.type !== undefined ? { type: options.type } : {}),
        ...(options.category !== undefined ? { category: options.category } : {}),
        ...(options.sortBy !== undefined ? { sortBy: options.sortBy } : {}),
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        limit,
      });

      const items = rows.map(toMarketplacePlugin);
      const lastRow = rows[rows.length - 1];
      const nextCursor =
        rows.length === limit && lastRow !== undefined
          ? encodeCursor(lastRow, options.sortBy ?? "popular")
          : null;

      return { items, nextCursor, total };
    },

    async getPluginDetails(pluginId) {
      const row = await marketplaceRepo.findById(pluginId);
      if (row === null) {
        throw new MarketplacePluginNotFoundError(
          `Marketplace plugin '${pluginId}' not found`
        );
      }
      return toMarketplacePlugin(row);
    },

    async publishPlugin(input, userId) {
      const { manifest, category, tags } = input;

      // Guard duplicate — name is a UNIQUE column so the DB would also
      // reject it, but we surface a cleaner error message here.
      const existing = await marketplaceRepo.findByName(manifest.id);
      if (existing !== null) {
        throw new MarketplacePluginAlreadyExistsError(
          `A marketplace entry for '${manifest.id}' already exists. ` +
          `Use the update endpoint to release a new version.`
        );
      }

      // The manifest type enum includes 'widget'; the marketplace type enum
      // maps widget → 'custom' because widget is a UI-only concern not useful
      // as a search filter in the community registry.
      const marketplaceType: MarketplacePluginType =
        manifest.type === "widget" ? "custom" : manifest.type;

      // Author information is sourced directly from the manifest.
      // The manifest.author field is a free-form string (validated by Zod);
      // we store it as-is and do not attempt to split name/email here.
      const row = await marketplaceRepo.create({
        name: manifest.id,
        display_name: manifest.name,
        description: manifest.description ?? "",
        version: manifest.version,
        type: marketplaceType,
        author_name: manifest.author,
        category: category.trim().toLowerCase() || "other",
        tags: (tags ?? manifest.tags ?? []).map((t) => t.toLowerCase()),
        manifest,
        published_by: userId,
      });

      logger.info("Marketplace plugin published", {
        pluginName: manifest.id,
        version: manifest.version,
        publishedBy: userId,
      });

      await eventPublisher.publish({
        eventType: "marketplace.plugin.published",
        eventVersion: "1.0.0",
        tenantId: "00000000-0000-0000-0000-000000000000",
        actor: { type: "user", id: userId },
        data: {
          pluginId: row.id,
          pluginName: manifest.id,
          version: manifest.version,
          publishedBy: userId,
        },
      });

      return toMarketplacePlugin(row);
    },

    async unpublishPlugin(pluginId, userId, isAdmin) {
      const row = await marketplaceRepo.findById(pluginId);
      if (row === null) {
        throw new MarketplacePluginNotFoundError(
          `Marketplace plugin '${pluginId}' not found`
        );
      }

      // Only the original publisher or a platform admin may unpublish.
      if (!isAdmin && row.published_by !== userId) {
        throw new MarketplaceUnauthorizedError(
          `Only the plugin author or a platform admin can unpublish '${row.name}'`
        );
      }

      await marketplaceRepo.delete(pluginId);

      logger.info("Marketplace plugin unpublished", {
        pluginId,
        pluginName: row.name,
        unpublishedBy: userId,
        isAdmin,
      });

      await eventPublisher.publish({
        eventType: "marketplace.plugin.unpublished",
        eventVersion: "1.0.0",
        tenantId: "00000000-0000-0000-0000-000000000000",
        actor: { type: "user", id: userId },
        data: {
          pluginId,
          pluginName: row.name,
          unpublishedBy: userId,
        },
      });
    },

    async ratePlugin(pluginId, userId, input) {
      const { rating, review } = input;

      // Validate star value here so the error message is specific.
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new MarketplaceInvalidRatingError(
          `Rating must be an integer between 1 and 5, got: ${String(rating)}`
        );
      }

      // Confirm the target plugin exists before touching ratings.
      const plugin = await marketplaceRepo.findById(pluginId);
      if (plugin === null) {
        throw new MarketplacePluginNotFoundError(
          `Marketplace plugin '${pluginId}' not found`
        );
      }

      // Upsert the rating and refresh the denormalised stats within one
      // transaction so the average never diverges from the raw data.
      const client = await pool.connect();
      let ratingRow: PluginRatingRow;
      try {
        await client.query("BEGIN");

        const { row, inserted } = await marketplaceRepo.upsertRating(
          {
            marketplace_plugin_id: pluginId,
            user_id: userId,
            rating,
            // Omit review key entirely when undefined (exactOptionalPropertyTypes).
            ...(review !== undefined ? { review } : {}),
          },
          client
        );
        ratingRow = row;

        // Refresh denormalised average and count on the parent row.
        await marketplaceRepo.refreshRatingStats(pluginId, client);

        await client.query("COMMIT");

        logger.info("Marketplace plugin rated", {
          pluginId,
          userId,
          rating,
          inserted,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return toMarketplaceRating(ratingRow);
    },

    async getPluginRatings(pluginId, limit, cursor) {
      // Confirm plugin exists so callers get 404 rather than an empty list.
      const plugin = await marketplaceRepo.findById(pluginId);
      if (plugin === null) {
        throw new MarketplacePluginNotFoundError(
          `Marketplace plugin '${pluginId}' not found`
        );
      }

      const clampedLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
      const rows = await marketplaceRepo.findRatingsByPlugin(
        pluginId,
        clampedLimit,
        cursor
      );

      const items = rows.map(toMarketplaceRating);
      const lastRow = rows[rows.length - 1];
      const nextCursor =
        rows.length === clampedLimit && lastRow !== undefined
          ? lastRow.id
          : null;

      return { items, nextCursor };
    },

    async installPlugin(pluginId, tenantId, userId) {
      const plugin = await marketplaceRepo.findById(pluginId);
      if (plugin === null) {
        throw new MarketplacePluginNotFoundError(
          `Marketplace plugin '${pluginId}' not found`
        );
      }

      // Increment the download counter. This is a best-effort counter —
      // if it fails we log but do not fail the install.
      try {
        await marketplaceRepo.incrementDownloads(pluginId);
      } catch (err) {
        logger.warn("Failed to increment download counter", {
          pluginId,
          error: String(err),
        });
      }

      logger.info("Marketplace plugin install recorded", {
        pluginId,
        pluginName: plugin.name,
        tenantId,
        userId,
      });

      await eventPublisher.publish({
        eventType: "marketplace.plugin.installed",
        eventVersion: "1.0.0",
        tenantId,
        actor: { type: "user", id: userId },
        data: {
          pluginId,
          pluginName: plugin.name,
          version: plugin.version,
          installedBy: userId,
          tenantId,
        },
      });
    },
  };
}
