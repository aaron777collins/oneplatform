// Database row shapes for the marketplace tables.
// Column names mirror the SQL schema (snake_case) exactly.

import type { PluginManifest } from "../schemas/index.js";

// ---------------------------------------------------------------------------
// plugin.marketplace_plugins
// ---------------------------------------------------------------------------

export interface MarketplacePluginRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  version: string;
  type: MarketplacePluginType;
  author_name: string;
  author_email: string | null;
  category: string;
  tags: string[];
  manifest: PluginManifest;
  downloads: string; // BIGINT arrives as string from pg driver
  rating_average: string; // NUMERIC arrives as string
  rating_count: number;
  verified: boolean;
  published_by: string;
  published_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// plugin.plugin_ratings
// ---------------------------------------------------------------------------

export interface PluginRatingRow {
  id: string;
  marketplace_plugin_id: string;
  user_id: string;
  rating: number;
  review: string | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type MarketplacePluginType =
  | "connector"
  | "transformer"
  | "destination"
  | "auth-provider"
  | "custom";

export interface CreateMarketplacePluginData {
  name: string;
  display_name: string;
  description: string;
  version: string;
  type: MarketplacePluginType;
  author_name: string;
  author_email?: string;
  category: string;
  tags: string[];
  manifest: PluginManifest;
  published_by: string;
}

export interface UpsertRatingData {
  marketplace_plugin_id: string;
  user_id: string;
  rating: number;
  review?: string;
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

export interface MarketplaceListQuery {
  search?: string;
  type?: string;
  category?: string;
  sortBy?: "popular" | "recent" | "rating" | "name";
  cursor?: string;
  limit: number;
}
