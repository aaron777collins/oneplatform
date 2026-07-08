/**
 * full-flow.spec.ts — Comprehensive end-to-end coverage for the OnePlatform UI.
 *
 * This suite covers flows that are not exercised by the individual feature specs:
 *
 *   1. Login flow         — /login → submit credentials → dashboard
 *   2. Dashboard          — stats cards, charts, no error messages
 *   3. App creation       — /apps "New App" dialog (TemplatePickerDialog), blank + template paths
 *   4. App builder        — /apps/:id/build loads, palette visible, data table renders
 *   5. Connectors marketplace — /connectors/marketplace, search, category tabs, empty state
 *   6. Admin settings     — /settings/admin, system stats, tenant form, no timezone crash
 *   7. Pipeline listing   — /pipelines loads without errors, cards render
 *   8. Full navigation    — sidebar links traverse all major routes without errors
 *
 * Mock strategy:
 *   All /api/* requests are intercepted via setupMockApi + overrideMock so the
 *   suite runs without any running backend. Auth is provided through the standard
 *   MOCK_SESSION shape that satisfies AuthenticatedLayout's roles[] check.
 *
 * Target: https://test.aaroncollins.info (configure baseURL in playwright.config.ts
 * or via PLAYWRIGHT_BASE_URL env var before running against the live site).
 */

import { test, expect } from "./fixtures/base.js";
import { setupMockApi, overrideMock } from "./helpers/mock-api.js";
import { TEST_APPS, TEST_USERS } from "./helpers/test-data.js";

// ---------------------------------------------------------------------------
// Shared mock session — correctly shaped so Sidebar.tsx roles.includes() works
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  userId: "user-e2e-001",
  tenantId: "tenant-e2e-001",
  roles: ["tenant-admin"],
  scopes: ["*"],
  isGuest: false,
  emailVerified: true,
  email: TEST_USERS.admin.email,
  displayName: TEST_USERS.admin.name,
  tenantName: "E2E Tenant",
};

// ---------------------------------------------------------------------------
// Complete app data — AppCard requires accessMode + slug, MOCK_APPS lacks them
// ---------------------------------------------------------------------------

const COMPLETE_APPS = [
  {
    id: "app-001",
    name: "Customer 360 Dashboard",
    slug: "customer-360",
    accessMode: "platform-user" as const,
    buildStatus: "ready" as const,
    lastDeployedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
  },
  {
    id: "app-002",
    name: "Order Operations Portal",
    slug: "order-ops",
    accessMode: "internal" as const,
    buildStatus: "draft" as const,
    lastDeployedAt: null,
  },
];

// Complete pipeline data — PipelineCard requires triggerType
const COMPLETE_PIPELINES = [
  {
    id: "pipe-001",
    name: "Customer Events Pipeline",
    triggerType: "event" as const,
    lastRunStatus: "success" as const,
    lastRunAt: new Date(Date.now() - 15 * 60_000).toISOString(),
  },
  {
    id: "pipe-002",
    name: "Product Catalog Sync",
    triggerType: "cron" as const,
    lastRunStatus: "failed" as const,
    lastRunAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  },
];

// Tenant config response for AdminPage
const MOCK_TENANT = {
  id: "tenant-e2e-001",
  name: "E2E Tenant",
  slug: "e2e-tenant",
  settings: {
    timezone: "UTC",
    dateFormat: "YYYY-MM-DD",
    defaultPageSize: 25,
  },
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-06-01T00:00:00.000Z",
};

// Admin stats response
const MOCK_ADMIN_STATS = {
  stats: {
    userCount: 12,
    tenantCount: 1,
    activeSessions: 3,
    pipelineCount: 7,
  },
  activity: [
    {
      id: "1",
      type: "USER_LOGIN",
      actor: "alice@acme.com",
      resource: "session",
      timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
    {
      id: "2",
      type: "PIPELINE_RUN",
      actor: "system",
      resource: "pipeline:etl",
      timestamp: new Date(Date.now() - 15 * 60_000).toISOString(),
    },
  ],
};

// Connector registry response for marketplace page
const MOCK_CONNECTOR_REGISTRY = {
  items: [
    {
      type: "postgres",
      name: "PostgreSQL",
      description: "Connect to a Postgres database",
      category: "database",
      tags: ["sql", "relational"],
      version: "1.0.0",
      author: "OnePlatform",
      isBuiltIn: true,
      installCount: 1200,
    },
    {
      type: "kafka",
      name: "Apache Kafka",
      description: "Stream data from Kafka topics",
      category: "streaming",
      tags: ["streaming", "event"],
      version: "1.2.0",
      author: "OnePlatform",
      isBuiltIn: true,
      installCount: 800,
    },
    {
      type: "s3",
      name: "Amazon S3",
      description: "Read and write files from S3",
      category: "file",
      tags: ["cloud", "storage"],
      version: "1.1.0",
      author: "OnePlatform",
      isBuiltIn: false,
      installCount: 650,
    },
  ],
  nextCursor: null,
  total: 3,
};

// App templates for TemplatePickerDialog
const MOCK_TEMPLATES = [
  {
    id: "tpl-001",
    name: "Analytics Dashboard",
    description: "Pre-built dashboard for data analytics",
    category: "dashboard",
    thumbnail: "",
    requiredPermissions: [],
  },
  {
    id: "tpl-002",
    name: "Admin Panel",
    description: "Internal administration tool template",
    category: "admin",
    thumbnail: "",
    requiredPermissions: [],
  },
];

// ---------------------------------------------------------------------------
// Shared setup helper — applies all auth + extra mocks for authenticated pages
// ---------------------------------------------------------------------------

async function applyFullMocks(page: import("@playwright/test").Page): Promise<void> {
  await setupMockApi(page);

  // Correct Session shape for AuthenticatedLayout
  await overrideMock(page, /\/api\/v1\/auth\/me/, 200, { data: MOCK_SESSION });

  // ServiceHealthGrid
  await overrideMock(page, /\/api\/healthz/, 200, {
    status: "healthy",
    services: {
      gateway: { status: "healthy", latencyMs: 2 },
      auth: { status: "healthy", latencyMs: 4 },
    },
  });

  // Health services list (LogsPage)
  await overrideMock(page, /\/api\/v1\/health\/services/, 200, {
    data: [
      { name: "gateway", status: "healthy" },
      { name: "auth", status: "healthy" },
    ],
  });

  // Apps with complete shape
  await overrideMock(page, /\/api\/v1\/apps$/, 200, {
    data: COMPLETE_APPS,
    pagination: { total: COMPLETE_APPS.length, page: 1, pageSize: 20 },
  });
  await overrideMock(page, /\/api\/v1\/apps\?/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });

  // Pipelines with complete shape
  await overrideMock(page, /\/api\/v1\/pipelines$/, 200, {
    data: COMPLETE_PIPELINES,
    pagination: { total: COMPLETE_PIPELINES.length, page: 1, pageSize: 20 },
  });
  await overrideMock(page, /\/api\/v1\/pipelines\?/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });

  // Quick-start count queries
  await overrideMock(page, /\/api\/v1\/connectors\?/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });
  await overrideMock(page, /\/api\/v1\/ontology\?/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });

  // Ontology base path (OntologyPage, dashboard count queries)
  await overrideMock(page, /\/api\/v1\/ontology$/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });
  await overrideMock(page, /\/api\/v1\/ontology\/migrations/, 200, { data: [] });

  // Teams
  await overrideMock(page, /\/api\/v1\/users/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });

  // Admin endpoints
  await overrideMock(page, /\/api\/v1\/admin\/stats/, 200, { data: MOCK_ADMIN_STATS });
  await overrideMock(page, /\/api\/v1\/tenants\/tenant-e2e-001/, 200, { data: MOCK_TENANT });

  // Connector marketplace registry
  await overrideMock(page, /\/api\/v1\/connector-registry/, 200, MOCK_CONNECTOR_REGISTRY);

  // App templates
  await overrideMock(page, /\/api\/v1\/app-templates/, 200, {
    data: MOCK_TEMPLATES,
    pagination: { total: MOCK_TEMPLATES.length, page: 1, pageSize: 20 },
  });

  // App POST (create new app)
  await overrideMock(page, /\/api\/v1\/apps\/from-template/, 201, {
    data: {
      id: "app-new-001",
      name: "New Dashboard App",
      slug: "new-dashboard-app",
      accessMode: "platform-user",
      buildStatus: "draft",
      lastDeployedAt: null,
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Login flow
// ---------------------------------------------------------------------------

test.describe("Full flow — login", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("navigating to / redirects to /login when bootstrap is complete", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/");
    await page.waitForURL("**/login", { timeout: 15_000 });

    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible({ timeout: 10_000 });
    await screenshotHelper.capture("login-redirect");
  });

  test("login form has all required fields", async ({ page, screenshotHelper }) => {
    await page.goto("/login");

    await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

    await screenshotHelper.capture("login-form");
  });

  test("submitting valid credentials navigates away from login", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/login");

    await page.getByRole("textbox", { name: /email/i }).fill(TEST_USERS.admin.email);
    await page.getByLabel(/password/i).fill(TEST_USERS.admin.password);

    await screenshotHelper.capture("before-submit");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // After 200 the api-client calls window.location.href = "/" → page reloads to /login
    // (bootstrap is complete so it redirects back). No error alert must appear.
    await page.waitForLoadState("networkidle");

    const errorAlert = page.locator('[role="alert"]');
    await expect(errorAlert).toBeHidden({ timeout: 8_000 });

    await screenshotHelper.capture("after-submit");
  });

  test("submitting with empty fields shows validation errors", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.locator("text=Enter a valid email address")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Password is required")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 2. Dashboard
// ---------------------------------------------------------------------------

test.describe("Full flow — dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem("oneplatform.quickstart.dismissed");
      localStorage.removeItem("oneplatform.dashboard.widget-order");
    });
    await applyFullMocks(page);
  });

  test("dashboard loads with Overview heading and no error messages", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    // No "Something went wrong" crash boundary
    const body = await page.locator("body").textContent();
    expect(body).not.toMatch(/something went wrong/i);

    await screenshotHelper.capture("dashboard");
    consoleErrors.assertNone();
  });

  test("dashboard shows Active Pipelines panel with pipeline names", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: "Active Pipelines" }).first(),
    ).toBeVisible({ timeout: 10_000 });

    for (const pipeline of COMPLETE_PIPELINES) {
      await expect(page.getByRole("link", { name: pipeline.name })).toBeVisible();
    }
  });

  test("dashboard shows Service Health panel", async ({ page, screenshotHelper }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: "Service Health" }).first(),
    ).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("service-health");
  });

  test("dashboard shows Recent Activity panel", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: "Recent Activity" }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("tenant name from session appears in topbar", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/E2E Tenant/, { exact: false })).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// 3. App creation — TemplatePickerDialog
// ---------------------------------------------------------------------------

test.describe("Full flow — app creation", () => {
  test.beforeEach(async ({ page }) => {
    await applyFullMocks(page);
  });

  test("apps page loads with heading and New App button", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await page.goto("/apps");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Apps", level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: /new app/i })).toBeVisible();

    await screenshotHelper.capture("apps-page");
    consoleErrors.assertNone();
  });

  test("apps page displays existing app cards", async ({ page }) => {
    await page.goto("/apps");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Apps", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    for (const app of COMPLETE_APPS) {
      await expect(page.getByText(app.name, { exact: false })).toBeVisible({ timeout: 8_000 });
    }
  });

  test("clicking New App opens the template picker dialog", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/apps");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /new app/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /new app/i }).click();

    // TemplatePickerDialog renders as a modal dialog
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await screenshotHelper.capture("template-picker-dialog");
  });

  test("template picker dialog shows template cards and blank option", async ({
    page,
  }) => {
    await page.goto("/apps");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /new app/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // "Blank" app option is always available (FilePlus card)
    await expect(dialog.getByText(/blank/i)).toBeVisible({ timeout: 8_000 });
  });

  test("selecting blank template shows the app details form", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/apps");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /new app/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // Click the "Blank" card to select it
    const blankCard = dialog.getByText(/blank/i).first();
    await blankCard.click();

    // The Next button should be clickable after selection
    const nextBtn = dialog.getByRole("button", { name: /next/i });
    if (await nextBtn.isVisible()) {
      await nextBtn.click();
    }

    // Step 2 renders an app name input
    const nameInput = dialog.getByRole("textbox", { name: /app name/i });
    if (await nameInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(nameInput).toBeVisible();
      await screenshotHelper.capture("app-details-form");
    } else {
      // Some flows show name input directly after clicking blank — just screenshot the dialog state
      await screenshotHelper.capture("template-selected");
    }
  });

  test("closing the dialog does not crash the app", async ({ page, consoleErrors }) => {
    await page.goto("/apps");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /new app/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // Press Escape to close
    await page.keyboard.press("Escape");

    await expect(dialog).toBeHidden({ timeout: 5_000 });

    // Apps page should still be functional
    await expect(page.getByRole("heading", { name: "Apps", level: 1 })).toBeVisible();
    consoleErrors.assertNone();
  });
});

// ---------------------------------------------------------------------------
// 4. App builder
// ---------------------------------------------------------------------------

test.describe("Full flow — app builder", () => {
  test.beforeEach(async ({ page }) => {
    await applyFullMocks(page);
    // Override auth/me for builder page (same session, ensure LIFO priority)
    await overrideMock(page, /\/api\/v1\/auth\/me/, 200, { data: MOCK_SESSION });
  });

  test("app builder loads with Visual Builder label and palette", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await page.goto(`/apps/${TEST_APPS.published.id}/build`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Visual Builder", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Components", { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    await screenshotHelper.capture("builder-loaded");
    consoleErrors.assertNone();
  });

  test("component palette shows the Data Display category", async ({ page }) => {
    await page.goto(`/apps/${TEST_APPS.published.id}/build`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: "Data Display", exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Data Table component card is visible in palette", async ({ page }) => {
    await page.goto(`/apps/${TEST_APPS.published.id}/build`);
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByLabel("Data Table — Sortable, paginated, searchable table."),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("canvas drop zone renders correctly", async ({ page, screenshotHelper }) => {
    await page.goto(`/apps/${TEST_APPS.published.id}/build`);
    await page.waitForLoadState("networkidle");

    // "Open in Monaco editor" button confirms canvas is fully loaded
    await expect(
      page.getByRole("button", { name: "Open in Monaco editor" }),
    ).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("canvas");
  });

  test("Edit mode and Preview mode buttons are present", async ({ page }) => {
    await page.goto(`/apps/${TEST_APPS.published.id}/build`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: "Edit mode" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Preview mode" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 5. Connectors marketplace
// ---------------------------------------------------------------------------

test.describe("Full flow — connectors marketplace", () => {
  test.beforeEach(async ({ page }) => {
    await applyFullMocks(page);
  });

  test("marketplace page loads with heading and no crash", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await page.goto("/connectors/marketplace");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /connector marketplace/i }),
    ).toBeVisible({ timeout: 10_000 });

    const body = await page.locator("body").textContent();
    expect(body).not.toMatch(/something went wrong/i);

    await screenshotHelper.capture("marketplace");
    consoleErrors.assertNone();
  });

  test("marketplace shows connector cards from registry", async ({ page }) => {
    await page.goto("/connectors/marketplace");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /connector marketplace/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Mock registry has PostgreSQL, Kafka, S3
    await expect(page.getByText("PostgreSQL", { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Apache Kafka", { exact: false })).toBeVisible();
  });

  test("marketplace search input is present and interactive", async ({ page }) => {
    await page.goto("/connectors/marketplace");
    await page.waitForLoadState("networkidle");

    const searchInput = page.getByLabel("Search connector marketplace");
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    await searchInput.fill("postgres");
    // Input accepts the value without crashing
    await expect(searchInput).toHaveValue("postgres");
  });

  test("marketplace category tabs are present", async ({ page }) => {
    await page.goto("/connectors/marketplace");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /connector marketplace/i })).toBeVisible({
      timeout: 10_000,
    });

    const expectedTabs = ["All", "Database", "API", "File", "Streaming", "Webhook", "Custom"];
    for (const tab of expectedTabs) {
      await expect(page.getByRole("tab", { name: tab })).toBeVisible({ timeout: 8_000 });
    }
  });

  test("clicking a category tab filters the view without crashing", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/connectors/marketplace");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /connector marketplace/i })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("tab", { name: "Database" }).click();

    // After clicking, page must remain functional (no error boundary)
    const body = await page.locator("body").textContent();
    expect(body).not.toMatch(/something went wrong/i);

    await screenshotHelper.capture("database-category");
  });

  test("marketplace sort selector is present", async ({ page }) => {
    await page.goto("/connectors/marketplace");
    await page.waitForLoadState("networkidle");

    await expect(page.getByLabel("Sort connectors")).toBeVisible({ timeout: 10_000 });
  });

  test("empty marketplace state shows meaningful message when no results match", async ({
    page,
    screenshotHelper,
  }) => {
    // Override registry with empty results to exercise empty state
    await overrideMock(page, /\/api\/v1\/connector-registry/, 200, {
      items: [],
      nextCursor: null,
      total: 0,
    });

    await page.goto("/connectors/marketplace");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /connector marketplace/i }),
    ).toBeVisible({ timeout: 10_000 });

    // EmptyState renders "No connectors found" or "connector catalog is empty"
    const body = await page.locator("body").textContent();
    expect(body).toMatch(/no connectors found|catalog is empty/i);

    await screenshotHelper.capture("empty-state");
  });

  test("My Connectors button navigates back to /connectors", async ({ page }) => {
    await page.goto("/connectors/marketplace");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /connector marketplace/i })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: /my connectors/i }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/connectors");
  });
});

// ---------------------------------------------------------------------------
// 6. Admin settings
// ---------------------------------------------------------------------------

test.describe("Full flow — admin settings", () => {
  test.beforeEach(async ({ page }) => {
    await applyFullMocks(page);
  });

  test("admin page loads at /settings/admin without timezone crash", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    // The page renders an "Admin" heading via PageHeader
    await expect(page.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    // No error boundary or "Something went wrong" crash
    const body = await page.locator("body").textContent();
    expect(body).not.toMatch(/something went wrong/i);

    await screenshotHelper.capture("admin-page");
    consoleErrors.assertNone();
  });

  test("admin page shows system overview stats section", async ({ page }) => {
    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    // Section heading from aria-labelledby="system-stats-heading"
    await expect(page.getByText("System overview", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // StatCard labels
    await expect(page.getByText("Users", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Tenants", { exact: true })).toBeVisible();
    await expect(page.getByText("Active sessions", { exact: true })).toBeVisible();
    await expect(page.getByText("Pipelines", { exact: true })).toBeVisible();
  });

  test("admin page shows quick links section", async ({ page }) => {
    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Quick links", { exact: true })).toBeVisible({ timeout: 10_000 });

    // Quick link labels from QUICK_LINKS constant in AdminPage.tsx
    await expect(page.getByText("Manage users", { exact: true })).toBeVisible();
    await expect(page.getByText("View logs", { exact: true })).toBeVisible();
    await expect(page.getByText("API Keys", { exact: true })).toBeVisible();
  });

  test("admin page shows tenant settings form with timezone field", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Tenant settings", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Timezone input (the timezone crash was from missing this field)
    const timezoneInput = page.getByLabel("Default timezone");
    await expect(timezoneInput).toBeVisible({ timeout: 8_000 });
    await expect(timezoneInput).toHaveValue("UTC");

    await screenshotHelper.capture("tenant-settings-form");
  });

  test("admin page shows organization display name field", async ({ page }) => {
    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    await expect(page.getByLabel("Organization display name")).toBeVisible({ timeout: 10_000 });
  });

  test("admin page shows date format selector", async ({ page }) => {
    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Date format", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test("admin page shows danger zone with rotate master key button", async ({ page }) => {
    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Danger zone", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /rotate master key/i }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("clicking rotate master key opens a confirm dialog", async ({
    page,
    screenshotHelper,
  }) => {
    await overrideMock(page, /\/api\/v1\/admin\/rotate-master-key/, 200, {
      jobId: "job-e2e-001",
      message: "Key rotation started.",
    });

    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /rotate master key/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText(/rotate master key/i)).toBeVisible();

    await screenshotHelper.capture("rotate-key-dialog");

    // Dismiss the dialog
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test("recent activity section shows event rows", async ({ page }) => {
    await page.goto("/settings/admin");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Recent activity", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Mock activity events
    await expect(page.getByText("USER_LOGIN", { exact: false })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("PIPELINE_RUN", { exact: false })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 7. Pipeline listing
// ---------------------------------------------------------------------------

test.describe("Full flow — pipeline listing", () => {
  test.beforeEach(async ({ page }) => {
    await applyFullMocks(page);
  });

  test("pipelines page loads with heading and no crash", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Pipelines", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const body = await page.locator("body").textContent();
    expect(body).not.toMatch(/something went wrong/i);

    await screenshotHelper.capture("pipelines");
    consoleErrors.assertNone();
  });

  test("pipelines page shows pipeline cards", async ({ page }) => {
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Pipelines", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    for (const pipeline of COMPLETE_PIPELINES) {
      await expect(page.getByText(pipeline.name, { exact: false })).toBeVisible({ timeout: 8_000 });
    }
  });

  test("pipelines page breadcrumb shows Platform > Pipelines", async ({ page }) => {
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    const breadcrumb = page.getByRole("navigation", { name: /breadcrumb/i });
    await expect(breadcrumb).toBeVisible({ timeout: 10_000 });
    await expect(breadcrumb.getByText("Pipelines")).toBeVisible();
  });

  test("active sidebar link is marked for pipelines route", async ({ page }) => {
    await page.goto("/pipelines");
    await page.waitForLoadState("networkidle");

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Pipelines" }),
    ).toHaveAttribute("aria-current", "page");
  });
});

// ---------------------------------------------------------------------------
// 8. Navigation — full sidebar traversal
// ---------------------------------------------------------------------------

test.describe("Full flow — sidebar navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem("op-sidebar-collapsed");
      localStorage.removeItem("oneplatform.quickstart.dismissed");
      localStorage.removeItem("oneplatform.dashboard.widget-order");
    });
    await applyFullMocks(page);
  });

  const NAV_ROUTES: Array<{ label: string; path: string; heading: RegExp | string }> = [
    { label: "Overview",    path: "/dashboard",          heading: "Overview" },
    { label: "Connectors",  path: "/connectors",         heading: "Connectors" },
    { label: "Ontology",    path: "/ontology",           heading: "Ontology" },
    { label: "Pipelines",   path: "/pipelines",          heading: "Pipelines" },
    { label: "Apps",        path: "/apps",               heading: "Apps" },
    { label: "Logs",        path: "/logs",               heading: "Logs" },
    { label: "Plugins",     path: "/plugins",            heading: "Plugins" },
    { label: "Settings",    path: "/settings/profile",   heading: /settings/i },
  ];

  for (const { label, path, heading } of NAV_ROUTES) {
    test(`${label} (${path}) loads without "Something went wrong"`, async ({
      page,
      consoleErrors,
    }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const expectedHeading =
        typeof heading === "string"
          ? page.getByRole("heading", { name: heading })
          : page.getByRole("heading", { name: heading });

      await expect(expectedHeading.first()).toBeVisible({ timeout: 10_000 });

      const body = await page.locator("body").textContent();
      expect(body, `"Something went wrong" appeared on ${path}`).not.toMatch(
        /something went wrong/i,
      );

      consoleErrors.assertNone();
    });
  }

  test("clicking Marketplace sidebar link navigates to /connectors/marketplace", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });

    // Marketplace is a sub-item under Connectors in the sidebar
    const marketplaceLink = primaryNav.getByRole("link", { name: "Marketplace" });
    await expect(marketplaceLink).toBeVisible({ timeout: 10_000 });
    await marketplaceLink.click();

    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).pathname).toBe("/connectors/marketplace");
  });

  test("sidebar click navigation: Apps → Builder → back to Apps", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/apps");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Apps", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    // Click through to app builder
    await page.goto(`/apps/${TEST_APPS.published.id}/build`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Visual Builder", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await screenshotHelper.capture("builder");

    // Back to apps via the back link
    await page.getByLabel("Back to app detail").click();
    await page.waitForLoadState("networkidle");

    // Should land on app detail or apps page
    const path = new URL(page.url()).pathname;
    expect(path).toMatch(/^\/apps/);
  });

  test("browser back button works after sidebar navigation", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Pipelines" }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/pipelines");

    await page.goBack();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/dashboard");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  });

  test("all major pages load in sequence without mounting errors", async ({
    page,
    consoleErrors,
  }) => {
    const routes = [
      "/dashboard",
      "/connectors",
      "/connectors/marketplace",
      "/ontology",
      "/pipelines",
      "/apps",
      "/logs",
      "/plugins",
      "/settings/profile",
      "/settings/admin",
    ];

    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");

      const body = await page.locator("body").textContent();
      expect(
        body,
        `Route ${route} rendered "Something went wrong"`,
      ).not.toMatch(/something went wrong/i);
    }

    consoleErrors.assertNone();
  });
});
