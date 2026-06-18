/**
 * Custom Connector: Shopify Products (Example)
 *
 * Implements the Connector interface from @oneplatform/plugin-sdk to ingest
 * product catalog data from a Shopify store.
 *
 * The Ingestion Service drives this lifecycle:
 *   1. connect()    — validate config and credentials, return a ConnectorHandle
 *   2. fetchBatch() — called in a loop; return records + nextCursor until done
 *   3. disconnect() — release resources (do NOT revoke the access token here)
 *
 * The `connector` export name must match `entrypoint` in manifest.json.
 */

import type {
  Connector,
  ConnectorHandle,
  ConnectorMetadata,
  BatchResult,
  DataRecord,
  PluginContext,
} from "@oneplatform/plugin-sdk";

import {
  PluginAuthError,
  PluginConfigError,
  PluginRateLimitError,
  PluginTimeoutError,
} from "@oneplatform/plugin-sdk";

// ---------------------------------------------------------------------------
// Shape of the config delivered at connect() time.
// Validated against manifest.json configSchema by the platform before this
// method is called — these casts are safe.
// ---------------------------------------------------------------------------

interface ShopifyConfig {
  shopDomain: string;
  apiVersion: string;
  pageSize: number;
}

// Shopify product shape (subset of fields we care about)
interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  product_type: string;
  price_min: string;
  updated_at: string;
  published_at: string | null;
}

interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseConfig(raw: Record<string, unknown>): ShopifyConfig {
  const shopDomain = raw["shopDomain"];
  const apiVersion = raw["apiVersion"];
  const pageSize = raw["pageSize"];

  if (typeof shopDomain !== "string" || shopDomain.trim() === "") {
    throw new PluginConfigError("shopDomain is required and must be a non-empty string");
  }
  if (typeof apiVersion !== "string" || apiVersion.trim() === "") {
    throw new PluginConfigError("apiVersion is required and must be a non-empty string");
  }

  return {
    shopDomain: shopDomain.trim().replace(/\/$/, ""),
    apiVersion: apiVersion.trim(),
    // Fall back to 100 if omitted; clamp to the Shopify max of 250.
    pageSize: Math.min(typeof pageSize === "number" ? pageSize : 100, 250),
  };
}

// Build a Shopify Admin API URL. Using a helper isolates the URL construction
// so it is easy to unit-test without needing a live Shopify connection.
function buildProductsUrl(
  shopDomain: string,
  apiVersion: string,
  pageSize: number,
  pageInfo: string | null,
): string {
  const base =
    `https://${shopDomain}/admin/api/${apiVersion}/products.json` +
    `?limit=${pageSize}&fields=id,title,handle,status,vendor,product_type,price_min,updated_at,published_at`;

  // Shopify cursor pagination uses the `page_info` parameter. The initial
  // request omits it; subsequent requests use the opaque token from the
  // Link header.
  return pageInfo !== null ? `${base}&page_info=${pageInfo}` : base;
}

// Parse the Shopify Link header to extract the next page cursor.
// Shopify uses RFC 5988 link relations — we look for rel="next".
// Returns null when there are no more pages.
function parseNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    const match = /page_info=([^>&"]+)[^>]*>;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

// Map a Shopify product to the platform's DataRecord format.
// DataRecord.sourceId is the stable external identifier used for upsert
// deduplication — Shopify product IDs are stable across renames/moves.
function toDataRecord(product: ShopifyProduct): DataRecord {
  return {
    sourceId: String(product.id),
    data: {
      id: String(product.id),
      title: product.title,
      handle: product.handle,
      status: product.status,
      vendor: product.vendor,
      productType: product.product_type,
      price: parseFloat(product.price_min) || 0,
      publishedAt: product.published_at,
    },
    metadata: {
      updatedAt: product.updated_at,
    },
  };
}

// ---------------------------------------------------------------------------
// Connector implementation
// ---------------------------------------------------------------------------

export const connector: Connector = {
  // ── metadata ──────────────────────────────────────────────────────────────
  //
  // Called at install time by the Plugin Service and by the Ingestion Service
  // to populate the data source catalog. Must return synchronously.

  metadata(): ConnectorMetadata {
    return {
      type: "connector",
      id: "com.example.connectors.shopify-products",
      name: "Shopify Products (Example)",
      description:
        "Ingests product catalog data from a Shopify store into OnePlatform via the Shopify Admin REST API.",
      version: "1.0.0",
      author: "Example Author",
      category: "ecommerce",
      tags: ["ecommerce", "shopify", "products"],
      configSchema: {
        type: "object",
        required: ["shopDomain", "apiVersion"],
        properties: {
          shopDomain: { type: "string" },
          apiVersion: { type: "string" },
          pageSize: { type: "integer", default: 100 },
        },
      },
      // Describes the shape of the DataRecord.data payload this connector emits.
      // The Ingestion Service uses this schema to validate records before mapping.
      outputSchema: {
        type: "object",
        required: ["id", "title", "handle", "status"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          handle: { type: "string" },
          status: { type: "string" },
          vendor: { type: "string" },
          productType: { type: "string" },
          price: { type: "number" },
          publishedAt: { type: ["string", "null"] },
        },
      },
      // Shopify's cursor pagination makes incremental syncs straightforward:
      // on each run we store the cursor of the last page fetched and resume
      // from there on the next run.
      supportsIncremental: true,
      // This connector does not implement subscribeToEvents() — webhook support
      // would require a registered Shopify webhook endpoint.
      supportsRealtime: false,
      rateLimit: {
        // Shopify Basic plan: 2 requests/second with a bucket of 40.
        // Advisory only — actual enforcement is via PluginRateLimitError below.
        requestsPerMinute: 120,
      },
    };
  },

  // ── connect ───────────────────────────────────────────────────────────────
  //
  // Validates the config and credentials before the first fetchBatch call.
  // We make one lightweight API call (shop endpoint) to confirm the access
  // token is valid without pulling any product data yet.

  async connect(
    config: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ConnectorHandle> {
    const parsed = parseConfig(config);

    // Retrieve the access token from the platform's encrypted credential store.
    // Never log this value — the platform will rotate it automatically.
    const accessToken = await context.credentials.get("shopify_access_token");

    const verifyUrl = `https://${parsed.shopDomain}/admin/api/${parsed.apiVersion}/shop.json`;

    context.logger.info("Verifying Shopify connection", {
      shopDomain: parsed.shopDomain,
      apiVersion: parsed.apiVersion,
    });

    const headers = context.tracing.injectHeaders({
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    });

    const response = await context.fetch.fetch(verifyUrl, { headers });

    if (response.status === 401) {
      throw new PluginAuthError(
        `Shopify access token is invalid or expired for shop ${parsed.shopDomain}. ` +
          "Regenerate the token and update the connector credentials.",
      );
    }

    if (!response.ok) {
      throw new PluginAuthError(
        `Shopify connection check failed with HTTP ${response.status} for shop ${parsed.shopDomain}.`,
      );
    }

    context.logger.info("Shopify connection verified", {
      shopDomain: parsed.shopDomain,
    });

    // The ConnectorHandle carries state between connect(), fetchBatch(), and
    // disconnect(). We store the parsed config here so fetchBatch() does not
    // need to re-parse it on every call.
    return {
      // connectionId is surfaced in platform logs and used to correlate runs.
      connectionId: `shopify-${parsed.shopDomain}-${Date.now()}`,
      metadata: {
        shopDomain: parsed.shopDomain,
        apiVersion: parsed.apiVersion,
        pageSize: parsed.pageSize,
      },
    };
  },

  // ── fetchBatch ────────────────────────────────────────────────────────────
  //
  // Called repeatedly by the Ingestion Service until hasMore is false.
  //
  // cursor=null on the first call (fetch from the beginning).
  // cursor=<page_info token> on subsequent calls (resume from last position).
  //
  // The platform persists the last successful cursor between runs so that a
  // failed sync can resume mid-dataset without re-ingesting everything.

  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    const { shopDomain, apiVersion, pageSize } = handle.metadata as ShopifyConfig;

    const accessToken = await context.credentials.get("shopify_access_token");

    const url = buildProductsUrl(
      shopDomain,
      String(apiVersion),
      Number(pageSize),
      cursor,
    );

    context.logger.debug("Fetching product batch", {
      shopDomain,
      cursor: cursor ?? "(initial)",
      pageSize,
    });

    const span = context.tracing.startSpan("shopify.fetchProducts");

    let response: Response;
    try {
      const headers = context.tracing.injectHeaders({
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      });
      response = await context.fetch.fetch(url, { headers });
    } finally {
      span.end();
    }

    if (response.status === 429) {
      // The platform's Ingestion Service recognises PluginRateLimitError and
      // backs off before retrying. Do not sleep here — let the platform manage
      // the retry schedule.
      throw new PluginRateLimitError(
        "Shopify rate limit exceeded. The platform will retry after the backoff window.",
      );
    }

    if (response.status === 401) {
      throw new PluginAuthError("Shopify access token expired mid-sync. Re-authenticate and retry.");
    }

    if (response.status === 408 || response.status === 504) {
      throw new PluginTimeoutError(
        `Shopify request timed out (HTTP ${response.status}). The platform will retry.`,
      );
    }

    if (!response.ok) {
      throw new Error(`Unexpected Shopify API error: HTTP ${response.status}`);
    }

    const body = (await response.json()) as ShopifyProductsResponse;
    const products = body.products ?? [];

    const records: DataRecord[] = products.map(toDataRecord);

    // Shopify signals the end of the dataset by omitting the Link: rel="next" header.
    const linkHeader = response.headers.get("Link");
    const nextCursor = parseNextPageInfo(linkHeader);

    context.logger.info("Fetched product batch", {
      count: records.length,
      hasMore: nextCursor !== null,
    });

    span.setAttribute("records.count", records.length);

    return {
      records,
      nextCursor,
      hasMore: nextCursor !== null,
      fetchedAt: new Date().toISOString(),
    };
  },

  // ── disconnect ────────────────────────────────────────────────────────────
  //
  // Called after the ingestion job completes (success or error). Must not throw.
  // We have no persistent TCP connections to close, so this is a no-op — but
  // we log the completion so it appears in the platform execution log.

  async disconnect(handle: ConnectorHandle, context: PluginContext): Promise<void> {
    context.logger.info("Disconnecting Shopify connector", {
      connectionId: handle.connectionId,
    });
    // No TCP/WebSocket connections to release. Do NOT revoke the access token —
    // it will be reused by the next scheduled sync.
  },
};
