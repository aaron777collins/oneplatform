/**
 * mock-api.ts — Playwright route interception for isolated frontend testing.
 *
 * Because the backend microservices require Docker (Postgres, Redis, BullMQ,
 * etc.), the E2E suite intercepts every /api/* request and returns realistic
 * data. This lets us test every frontend flow without any external processes.
 *
 * Usage — call setupMockApi(page) early in any test or beforeEach that needs
 * backend data:
 *
 *   import { setupMockApi } from "../helpers/mock-api.js";
 *   test.beforeEach(async ({ page }) => { await setupMockApi(page); });
 *
 * The mock state is intentionally minimal: enough to exercise UI rendering
 * and navigation, not a faithful replica of every server response shape.
 */

import type { Page, Route } from "@playwright/test";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

// MOCK_USER mirrors the Session type from auth.store.ts so that setSession()
// receives a valid object and the auth store is properly populated.
// The previous shape used `id` and `role` (singular) which are the server's raw
// user-record fields — the auth/me endpoint returns the Session envelope instead.
const MOCK_USER = {
  // Session fields (auth.store.ts Session interface)
  userId: "user-e2e-001",
  tenantId: "tenant-e2e-001",
  roles: ["tenant-admin"],
  scopes: ["read:all", "write:all"],
  isGuest: false,
  emailVerified: true,
  email: "e2e-tester@oneplatform.test",
  displayName: "E2E Tester",
  tenantName: "E2E Tenant",
};

const MOCK_PIPELINES = [
  {
    id: "pipe-001",
    name: "Customer Events Pipeline",
    description: "Ingests and enriches customer event data",
    status: "active",
    lastRunAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    lastRunStatus: "success",
    createdAt: "2025-01-15T10:00:00.000Z",
  },
  {
    id: "pipe-002",
    name: "Product Catalog Sync",
    description: "Syncs product catalog from external source",
    status: "paused",
    lastRunAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    lastRunStatus: "failed",
    createdAt: "2025-02-01T08:30:00.000Z",
  },
  {
    id: "pipe-003",
    name: "Order Processing",
    description: "Transforms raw order events into structured data",
    status: "active",
    lastRunAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    lastRunStatus: "running",
    createdAt: "2025-02-15T14:00:00.000Z",
  },
];

const MOCK_CONNECTORS = [
  {
    id: "conn-001",
    name: "Postgres Production",
    type: "postgres",
    status: "connected",
    createdAt: "2025-01-10T09:00:00.000Z",
  },
  {
    id: "conn-002",
    name: "Kafka Cluster",
    type: "kafka",
    status: "connected",
    createdAt: "2025-01-12T11:00:00.000Z",
  },
  {
    id: "conn-003",
    name: "S3 Data Lake",
    type: "s3",
    status: "error",
    createdAt: "2025-01-20T15:00:00.000Z",
  },
];

const MOCK_ENTITY_TYPES = [
  {
    id: "et-001",
    name: "Customer",
    description: "A customer entity",
    fieldCount: 12,
    recordCount: 45_320,
    createdAt: "2025-01-05T00:00:00.000Z",
  },
  {
    id: "et-002",
    name: "Order",
    description: "An order placed by a customer",
    fieldCount: 18,
    recordCount: 128_450,
    createdAt: "2025-01-06T00:00:00.000Z",
  },
  {
    id: "et-003",
    name: "Product",
    description: "A product in the catalog",
    fieldCount: 9,
    recordCount: 3_201,
    createdAt: "2025-01-07T00:00:00.000Z",
  },
];

const MOCK_APPS = [
  {
    id: "app-001",
    name: "Customer 360 Dashboard",
    description: "Unified view of customer data and activity",
    status: "published",
    createdAt: "2025-02-01T00:00:00.000Z",
  },
  {
    id: "app-002",
    name: "Order Operations Portal",
    description: "Internal tool for managing order lifecycle",
    status: "draft",
    createdAt: "2025-03-01T00:00:00.000Z",
  },
];

const MOCK_HEALTH = {
  status: "healthy",
  services: {
    gateway: { status: "healthy", latencyMs: 2 },
    auth: { status: "healthy", latencyMs: 4 },
    ingestion: { status: "healthy", latencyMs: 8 },
    ontology: { status: "healthy", latencyMs: 3 },
    pipeline: { status: "healthy", latencyMs: 6 },
    execution: { status: "healthy", latencyMs: 12 },
    app: { status: "healthy", latencyMs: 5 },
    logging: { status: "healthy", latencyMs: 9 },
    plugin: { status: "healthy", latencyMs: 7 },
  },
};

const MOCK_BOOTSTRAP_COMPLETE = {
  data: { completed: true },
};

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

interface RouteEntry {
  /** URL pattern — supports glob matching via Playwright's built-in matcher. */
  pattern: string | RegExp;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: (url: URL) => { status: number; body: unknown };
}

const ROUTE_TABLE: RouteEntry[] = [
  // Bootstrap status — always complete so the router redirects to /login
  {
    pattern: /\/api\/v1\/bootstrap\/status/,
    method: "GET",
    response: () => ({ status: 200, body: MOCK_BOOTSTRAP_COMPLETE }),
  },

  // Auth
  {
    pattern: /\/api\/v1\/auth\/me/,
    method: "GET",
    response: () => ({ status: 200, body: { data: MOCK_USER } }),
  },
  {
    pattern: /\/api\/v1\/auth\/login/,
    method: "POST",
    // LoginForm calls client.post<ApiResponse<Session>>("/v1/auth/login") then
    // setSession(result.data). The data field must be a Session object so
    // setSession() can populate the auth store correctly.
    response: () => ({
      status: 200,
      body: {
        data: MOCK_USER,
      },
    }),
  },
  {
    pattern: /\/api\/v1\/auth\/logout/,
    method: "POST",
    response: () => ({ status: 200, body: { data: { success: true } } }),
  },
  {
    // The api-client attempts a token refresh on the first 401 before giving up.
    // Return 200 so the retry can proceed rather than immediately redirecting to /login.
    pattern: /\/api\/v1\/auth\/refresh/,
    method: "POST",
    response: () => ({ status: 200, body: { data: MOCK_USER } }),
  },

  // Health
  {
    pattern: /\/api\/v1\/health/,
    method: "GET",
    response: () => ({ status: 200, body: { data: MOCK_HEALTH } }),
  },

  // Pipelines
  {
    pattern: /\/api\/v1\/pipelines$/,
    method: "GET",
    response: () => ({
      status: 200,
      body: {
        data: MOCK_PIPELINES,
        pagination: { total: MOCK_PIPELINES.length, page: 1, pageSize: 20 },
      },
    }),
  },
  {
    pattern: /\/api\/v1\/pipelines\/[^/]+$/,
    method: "GET",
    response: (url) => {
      const id = url.pathname.split("/").pop();
      const found = MOCK_PIPELINES.find((p) => p.id === id) ?? MOCK_PIPELINES[0];
      return { status: 200, body: { data: found } };
    },
  },

  // Connectors
  {
    pattern: /\/api\/v1\/connectors$/,
    method: "GET",
    response: () => ({
      status: 200,
      body: {
        data: MOCK_CONNECTORS,
        pagination: { total: MOCK_CONNECTORS.length, page: 1, pageSize: 20 },
      },
    }),
  },
  {
    pattern: /\/api\/v1\/connectors\/[^/]+$/,
    method: "GET",
    response: (url) => {
      const id = url.pathname.split("/").pop();
      const found = MOCK_CONNECTORS.find((c) => c.id === id) ?? MOCK_CONNECTORS[0];
      return { status: 200, body: { data: found } };
    },
  },

  // Ontology
  {
    pattern: /\/api\/v1\/ontology\/entity-types/,
    method: "GET",
    response: () => ({
      status: 200,
      body: {
        data: MOCK_ENTITY_TYPES,
        pagination: { total: MOCK_ENTITY_TYPES.length, page: 1, pageSize: 20 },
      },
    }),
  },

  // Apps
  {
    pattern: /\/api\/v1\/apps$/,
    method: "GET",
    response: () => ({
      status: 200,
      body: {
        data: MOCK_APPS,
        pagination: { total: MOCK_APPS.length, page: 1, pageSize: 20 },
      },
    }),
  },
  {
    pattern: /\/api\/v1\/apps\/[^/]+$/,
    method: "GET",
    response: (url) => {
      const id = url.pathname.split("/").pop();
      const found = MOCK_APPS.find((a) => a.id === id) ?? MOCK_APPS[0];
      return { status: 200, body: { data: found } };
    },
  },

  // Pipeline runs
  {
    pattern: /\/api\/v1\/pipeline-runs/,
    method: "GET",
    response: () => ({
      status: 200,
      body: {
        data: [],
        pagination: { total: 0, page: 1, pageSize: 20 },
      },
    }),
  },

  // Logs / Activity
  {
    pattern: /\/api\/v1\/logs/,
    method: "GET",
    response: () => ({
      status: 200,
      body: { data: [], pagination: { total: 0, page: 1, pageSize: 50 } },
    }),
  },

  // Plugins
  {
    pattern: /\/api\/v1\/plugins/,
    method: "GET",
    response: () => ({
      status: 200,
      body: { data: [], pagination: { total: 0, page: 1, pageSize: 20 } },
    }),
  },

  // Settings / Teams
  {
    pattern: /\/api\/v1\/teams/,
    method: "GET",
    response: () => ({
      status: 200,
      body: { data: [], pagination: { total: 0, page: 1, pageSize: 20 } },
    }),
  },

  // API keys
  {
    pattern: /\/api\/v1\/api-keys/,
    method: "GET",
    response: () => ({
      status: 200,
      body: { data: [], pagination: { total: 0, page: 1, pageSize: 20 } },
    }),
  },

  // Webhooks
  {
    pattern: /\/api\/v1\/webhooks/,
    method: "GET",
    response: () => ({
      status: 200,
      body: { data: [], pagination: { total: 0, page: 1, pageSize: 20 } },
    }),
  },

  // DLQ
  {
    pattern: /\/api\/v1\/dlq/,
    method: "GET",
    response: () => ({
      status: 200,
      body: { data: [], pagination: { total: 0, page: 1, pageSize: 20 } },
    }),
  },

  // Metrics
  {
    pattern: /\/api\/v1\/metrics/,
    method: "GET",
    response: () => ({
      status: 200,
      body: { data: {} },
    }),
  },

  // SSE endpoint — return an empty stream so the browser doesn't hang
  {
    pattern: /\/api\/v1\/events/,
    method: "GET",
    response: () => ({ status: 200, body: "" }),
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all mock route handlers on the given page.
 *
 * Call this before navigation so every request the page issues is
 * intercepted. Unmatched /api/* requests fall through to a 404 mock so
 * tests surface missing routes rather than hanging.
 */
export async function setupMockApi(page: Page): Promise<void> {
  // Playwright matches routes LIFO (last-registered handler wins).
  // Register broad catch-alls FIRST so specific handlers registered
  // afterward take priority over them.

  // /bff proxy (app builder backend-for-frontend)
  await page.route(/\/bff\//, (route: Route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: {} }),
    });
  });

  // Catch-all: any /api/* request not matched by a specific handler below
  // returns 404 so tests fail fast with a meaningful error rather than timing out.
  await page.route(/\/api\//, (route: Route) => {
    const method = route.request().method();
    const url = route.request().url();
    console.warn(`[mock-api] Unhandled ${method} ${url} → 404`);
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: `Mock: no handler for ${method} ${url}` }),
    });
  });

  // Specific handlers — registered AFTER the catch-all so they win (LIFO).
  for (const entry of ROUTE_TABLE) {
    await page.route(entry.pattern, (route: Route) => {
      if (entry.method && route.request().method() !== entry.method) {
        // HTTP method does not match this entry — fall back so the next
        // matching handler (or the catch-all) can respond.
        return route.fallback();
      }

      const url = new URL(route.request().url());
      const { status, body } = entry.response(url);

      // SSE streams need a different content-type and body shape.
      if (entry.pattern instanceof RegExp && entry.pattern.source.includes("events")) {
        return route.fulfill({
          status,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
          body: typeof body === "string" ? body : "",
        });
      }

      return route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
  }
}

/**
 * Override a specific mock response for a single test.
 *
 * Playwright uses the most-recently-registered handler for a given route,
 * so calling this after setupMockApi() will shadow the default mock.
 *
 * Example:
 *   await overrideMock(page, /\/api\/v1\/pipelines$/, 200, { data: [] });
 */
export async function overrideMock(
  page: Page,
  pattern: string | RegExp,
  status: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: unknown,
): Promise<void> {
  await page.route(pattern, (route: Route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}

// Re-export mock data so tests can make assertions against known values.
export { MOCK_USER, MOCK_PIPELINES, MOCK_CONNECTORS, MOCK_ENTITY_TYPES, MOCK_APPS };
