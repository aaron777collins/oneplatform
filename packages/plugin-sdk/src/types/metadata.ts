/**
 * Metadata types for all plugin kinds.
 *
 * Each plugin's metadata() method returns one of these types.
 * The Plugin Service stores these values and the marketplace UI reads them.
 */

import type { JSONSchema } from "./primitives.js";
import type { WidgetSlotDeclaration } from "./widget.js";

export interface BaseMetadata {
  /** Must match manifest.id exactly. */
  id: string;

  /** Human-readable display name. 2-100 characters. */
  name: string;

  /** Brief description shown in the marketplace. 10-500 characters. */
  description: string;

  /** Must match manifest.version exactly. */
  version: string;

  /** Plugin author name or organization. */
  author: string;

  /** URL or data URI for the plugin icon. PNG or SVG, max 64KB. */
  icon?: string;

  /** JSON Schema for the tenant-admin configuration form. */
  configSchema: JSONSchema;

  /** Discoverability tags shown in the marketplace filter UI. */
  tags?: string[];
}

export interface ConnectorMetadata extends BaseMetadata {
  readonly type: "connector";

  /**
   * Marketplace category. Standard values: "crm", "ecommerce", "database",
   * "file", "analytics", "marketing", "finance", "devtools", "iot", "other".
   */
  category: string;

  /** JSON Schema describing the shape of records this connector produces. */
  outputSchema: JSONSchema;

  /** True if the connector supports cursor-based incremental fetching. */
  supportsIncremental: boolean;

  /** True if the connector implements subscribeToEvents(). */
  supportsRealtime: boolean;

  /**
   * Advisory rate limit hint for the Ingestion Service's scheduling algorithm.
   * Does not enforce anything — the connector is responsible for enforcing its own
   * rate limits by throwing PluginRateLimitError.
   */
  rateLimit?: {
    requestsPerMinute: number;
    rowsPerSecond?: number;
  };
}

export interface TransformerMetadata extends BaseMetadata {
  readonly type: "transformer";

  /** JSON Schema for accepted record shape. null means any shape is accepted. */
  inputSchema?: JSONSchema;

  /** JSON Schema for output record shape. null means shape mirrors input. */
  outputSchema?: JSONSchema;

  /**
   * True if transform(transform(x)) === transform(x) for all x.
   * Idempotent transformers can be safely retried without data duplication.
   */
  idempotent: boolean;
}

export interface DestinationMetadata extends BaseMetadata {
  readonly type: "destination";

  /** JSON Schema for the record shape this destination accepts. null = any shape. */
  acceptedSchema?: JSONSchema;

  /**
   * Delivery guarantee provided by this destination's write() implementation.
   * "at-most-once":  records may be lost on failure; no retry
   * "at-least-once": records are retried on failure; destination must handle duplicates
   * "exactly-once":  records are deduplicated by sourceId; strongest guarantee
   */
  deliveryGuarantee: "at-most-once" | "at-least-once" | "exactly-once";

  /** True if the destination supports write() with batches > 1. */
  supportsBulk: boolean;

  /** True if the destination implements writeStream(). */
  supportsStreaming: boolean;
}

export interface AuthProviderMetadata extends BaseMetadata {
  readonly type: "auth-provider";

  /** The identity protocol this provider implements. */
  protocol: "oauth2" | "saml" | "oidc" | "ldap" | "custom";

  /** True if the provider implements validateToken(). */
  supportsTokenValidation: boolean;

  /** True if the provider implements refreshToken(). */
  supportsTokenRefresh: boolean;

  /**
   * OAuth scopes this provider supports. Shown in the admin configuration UI.
   * Omit for non-OAuth providers.
   */
  scopes?: string[];
}

export interface WidgetMetadata extends BaseMetadata {
  readonly type: "widget";

  /** Minimum grid width. Integer 1-12. */
  minWidth: number;

  /** Minimum grid height. Integer 1-12. */
  minHeight: number;

  /** Maximum grid width. Omit for no constraint. */
  maxWidth?: number;

  /** Maximum grid height. Omit for no constraint. */
  maxHeight?: number;

  /** Slots this widget can render in. */
  slots: WidgetSlotDeclaration[];
}

/** Union of all metadata types for use in generic plugin-handling code. */
export type AnyPluginMetadata =
  | ConnectorMetadata
  | TransformerMetadata
  | DestinationMetadata
  | AuthProviderMetadata
  | WidgetMetadata;
