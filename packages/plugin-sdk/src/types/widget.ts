/**
 * Widget interface and supporting types.
 *
 * A Widget renders a UI component inside the platform dashboard. The App Service
 * executes the widget's render() method server-side and serves the returned HTML
 * in a sandboxed <iframe>. The Widget interface does not receive PluginContext
 * because it does not run in the Execution Service sandbox — the App Service renders
 * it in a restricted Node.js context.
 *
 * Widget code must not access credentials or make outbound HTTP calls.
 */

import type { WidgetMetadata } from "./metadata.js";

export type WidgetSlot = "main" | "sidebar" | "header" | "footer" | "fullscreen";

export interface WidgetSlotDeclaration {
  slot: WidgetSlot;
  defaultWidth: number; // Grid units (1-12)
  defaultHeight: number; // Grid units (1-12)
}

export interface DataQuery {
  entityType: string;
  filter?: Record<string, unknown>;
  sort?: string;
  fields?: string[];
  limit?: number;
}

export interface WidgetData {
  /**
   * Pre-fetched query results, keyed by entityType.
   * Populated by the platform before render() is called.
   * The platform fetches data using the tenant's access rights — widgets
   * never make data API calls directly.
   */
  queryResults: Record<string, unknown[]>;

  /** The widget instance's configuration values. */
  config: Record<string, unknown>;

  /** The requesting user's identity and roles. Use for conditional rendering only. */
  user: { id: string; roles: string[] };
}

export interface Widget {
  metadata(): WidgetMetadata;

  /**
   * Return a complete HTML document string to be served inside the widget iframe.
   *
   * Security constraints:
   * - Do not include <script> tags in the output. DOMPurify (server-side) strips
   *   all <script> elements. The platform injects a bootstrap script via nonce.
   * - Do not attempt to access window.parent or window.top — the iframe uses
   *   sandbox="allow-scripts" (no allow-same-origin), creating an opaque origin.
   * - Use inline styles freely (style-src 'unsafe-inline' is permitted).
   * - Do not embed external images — use data URIs or serve from the widget bundle.
   *
   * The returned HTML must be a complete document (<html><head><body>...</body></html>).
   */
  render(data: WidgetData): string;

  /**
   * Declare what platform data this widget needs.
   * The platform pre-fetches this data before calling render(), so render() receives
   * fully populated WidgetData.queryResults without making any async calls.
   *
   * Keep queries minimal — each declared query adds latency to the dashboard load.
   */
  declareDataRequirements(): DataQuery[];

  /** Declare which slot(s) this widget can render in. */
  declareSlot(): WidgetSlotDeclaration;
}
