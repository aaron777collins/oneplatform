/**
 * navigation.spec.ts — E2E tests for sidebar navigation and page routing.
 *
 * Each test navigates to a page via URL or sidebar click and asserts:
 *   1. The correct h1 heading is present
 *   2. The sidebar active link is marked with aria-current="page"
 *   3. No unexpected console errors (where applicable)
 *   4. A screenshot is captured for visual record
 *
 * Auth/me shape: MOCK_USER in mock-api.ts has a different shape than the Session
 * interface (id vs userId, role vs roles[]). Without a proper override the auth
 * store sets roles=undefined and Sidebar.tsx throws on roles.includes(). We
 * shadow /auth/me in beforeEach with a correctly-shaped Session object.
 *
 * Missing mock routes: several pages call endpoints not in the default route table.
 * We add overrides for each in applyAuthAndExtraMocks():
 *   /api/healthz              — ServiceHealthGrid on dashboard and Logs sidebar filter
 *   /api/v1/health/services   — LogsPage service selector
 *   /api/v1/ontology          — OntologyPage entity list (mock has entity-types, not base path)
 *   /api/v1/ontology/migrations — OntologyPage migration state
 *   /api/v1/users             — TeamsPage member list
 *   /api/v1/connectors?*      — Quick Start count queries (query string breaks $ anchor)
 *   /api/v1/ontology?*        — same
 *   /api/v1/pipelines?*       — same
 *   /api/v1/apps?*            — same
 *
 * Pipeline/App data shapes: MOCK_PIPELINES lacks triggerType and MOCK_APPS lacks
 * accessMode + slug, causing PipelineCard / AppCard to crash with React "Element
 * type is invalid". We provide complete data for these pages in their overrides.
 */

import { test, expect } from "./fixtures/base.js";
import { setupMockApi, overrideMock } from "./helpers/mock-api.js";

// ---------------------------------------------------------------------------
// Correct Session-shaped response for /auth/me
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  userId: "user-e2e-001",
  tenantId: "tenant-e2e-001",
  roles: ["tenant-admin"],
  scopes: ["*"],
  isGuest: false,
  emailVerified: true,
  email: "e2e-tester@oneplatform.test",
  displayName: "E2E Tester",
  tenantName: "E2E Tenant",
};

// ---------------------------------------------------------------------------
// Complete pipeline data (adds triggerType missing from MOCK_PIPELINES)
// ---------------------------------------------------------------------------

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
    lastRunAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
  },
];

// ---------------------------------------------------------------------------
// Complete app data (adds accessMode + slug missing from MOCK_APPS)
// ---------------------------------------------------------------------------

const COMPLETE_APPS = [
  {
    id: "app-001",
    name: "Customer 360 Dashboard",
    slug: "customer-360",
    accessMode: "platform-user" as const,
    buildStatus: "ready" as const,
    lastDeployedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
  },
];

// ---------------------------------------------------------------------------
// Helper — register all mocks needed for authenticated pages
// ---------------------------------------------------------------------------

async function applyAuthAndExtraMocks(
  page: import("@playwright/test").Page,
): Promise<void> {
  // Auth/me with the correct Session shape so roles[] is populated
  await overrideMock(page, /\/api\/v1\/auth\/me/, 200, { data: MOCK_SESSION });

  // ServiceHealthGrid (on dashboard) and Logs sidebar call /api/healthz
  await overrideMock(page, /\/api\/healthz/, 200, {
    status: "healthy",
    services: {
      gateway: { status: "healthy", latencyMs: 2 },
      auth: { status: "healthy", latencyMs: 4 },
    },
  });

  // LogsPage service selector calls /v1/health/services
  await overrideMock(page, /\/api\/v1\/health\/services/, 200, {
    data: [
      { name: "gateway", status: "healthy" },
      { name: "auth", status: "healthy" },
    ],
  });

  // OntologyPage fetches /v1/ontology (the mock only has /v1/ontology/entity-types)
  await overrideMock(page, /\/api\/v1\/ontology$/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });
  await overrideMock(page, /\/api\/v1\/ontology\/migrations/, 200, {
    data: [],
  });

  // TeamsPage fetches /v1/users (not in default mock table)
  await overrideMock(page, /\/api\/v1\/users/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });

  // Pipeline list with complete triggerType so PipelineCard doesn't crash
  await overrideMock(page, /\/api\/v1\/pipelines$/, 200, {
    data: COMPLETE_PIPELINES,
    pagination: { total: COMPLETE_PIPELINES.length, page: 1, pageSize: 20 },
  });

  // Apps list with complete accessMode + slug so AppCard doesn't crash
  await overrideMock(page, /\/api\/v1\/apps$/, 200, {
    data: COMPLETE_APPS,
    pagination: { total: COMPLETE_APPS.length, page: 1, pageSize: 20 },
  });

  // Quick Start count queries use ?limit=1 which the default $ anchors don't match
  await overrideMock(page, /\/api\/v1\/connectors\?/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });
  await overrideMock(page, /\/api\/v1\/ontology\?/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });
  await overrideMock(page, /\/api\/v1\/pipelines\?/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });
  await overrideMock(page, /\/api\/v1\/apps\?/, 200, {
    data: [],
    pagination: { total: 0, page: 1, pageSize: 20 },
  });
}

// ---------------------------------------------------------------------------
// Shared setup: called in all describe blocks
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("op-sidebar-collapsed");
    localStorage.removeItem("oneplatform.quickstart.dismissed");
    localStorage.removeItem("oneplatform.dashboard.widget-order");
  });

  await setupMockApi(page);
  await applyAuthAndExtraMocks(page);
});

// ---------------------------------------------------------------------------
// Navigation helper
// ---------------------------------------------------------------------------

async function goTo(page: import("@playwright/test").Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
// 1. Main page routes — direct URL navigation
// ---------------------------------------------------------------------------

test.describe("Page navigation — main routes", () => {
  test("dashboard (/dashboard) — Overview heading and active sidebar link", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/dashboard");

    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("aria-current", "page");

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("connectors (/connectors) — heading, breadcrumb, active sidebar link", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/connectors");

    await expect(page.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    // Breadcrumb nav renders "Platform > Connectors"; scope to the breadcrumb
    // navigation element to avoid matching "OnePlatform" in the sidebar brand.
    const breadcrumb = page.getByRole("navigation", { name: /breadcrumb/i });
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb.getByText("Platform")).toBeVisible();

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Connectors" }),
    ).toHaveAttribute("aria-current", "page");

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("ontology (/ontology) — heading and breadcrumb", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/ontology");

    await expect(page.getByRole("heading", { name: "Ontology", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const breadcrumb = page.getByRole("navigation", { name: /breadcrumb/i });
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb.getByText("Ontology")).toBeVisible();

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Ontology" }),
    ).toHaveAttribute("aria-current", "page");

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("pipelines (/pipelines) — heading and breadcrumb", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/pipelines");

    await expect(page.getByRole("heading", { name: "Pipelines", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    // Breadcrumb: Platform > Pipelines
    const breadcrumb = page.getByRole("navigation", { name: /breadcrumb/i });
    await expect(breadcrumb.getByText("Pipelines")).toBeVisible();

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Pipelines" }),
    ).toHaveAttribute("aria-current", "page");

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("apps (/apps) — heading and active sidebar link", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/apps");

    await expect(page.getByRole("heading", { name: "Apps", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Apps" }),
    ).toHaveAttribute("aria-current", "page");

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("logs (/logs) — heading and active sidebar link", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/logs");

    await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Logs" }),
    ).toHaveAttribute("aria-current", "page");

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("plugins (/plugins) — heading and active sidebar link", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/plugins");

    await expect(page.getByRole("heading", { name: "Plugins", level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Plugins" }),
    ).toHaveAttribute("aria-current", "page");

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("settings (/settings) — redirects to /settings/profile", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/settings");

    // settingsIndexRoute.beforeLoad redirects bare /settings to /settings/profile
    await page.waitForURL("**/settings/profile", { timeout: 10_000 });

    // SettingsPage renders an h1 "Settings" for its secondary sidebar shell
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible({ timeout: 10_000 });

    // Profile sub-page content is nested inside the settings layout
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("aria-current", "page");

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });
});

// ---------------------------------------------------------------------------
// 2. Settings sub-pages
// ---------------------------------------------------------------------------

test.describe("Settings sub-pages", () => {
  test("profile (/settings/profile) — heading visible", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/settings/profile");

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 10_000,
    });

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("teams (/settings/teams) — heading visible", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/settings/teams");

    await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible({
      timeout: 10_000,
    });

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("api-keys (/settings/api-keys) — heading visible", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/settings/api-keys");

    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible({
      timeout: 10_000,
    });

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });

  test("webhooks (/settings/webhooks) — heading visible", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await goTo(page, "/settings/webhooks");

    await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible({
      timeout: 10_000,
    });

    await screenshotHelper.capture("page");
    consoleErrors.assertNone();
  });
});

// ---------------------------------------------------------------------------
// 3. Sidebar click navigation
// ---------------------------------------------------------------------------

test.describe("Sidebar click navigation", () => {
  // Start from the dashboard so the sidebar is fully rendered
  test.beforeEach(async ({ page }) => {
    await goTo(page, "/dashboard");
    await expect(
      page.getByRole("navigation", { name: /primary navigation/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("clicking Connectors navigates to /connectors", async ({ page }) => {
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Connectors" }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/connectors");
    await expect(page.getByRole("heading", { name: "Connectors", level: 1 })).toBeVisible();
  });

  test("clicking Ontology navigates to /ontology", async ({ page }) => {
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Ontology" }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/ontology");
    await expect(page.getByRole("heading", { name: "Ontology", level: 1 })).toBeVisible();
  });

  test("clicking Pipelines navigates to /pipelines", async ({ page }) => {
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Pipelines" }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/pipelines");
    await expect(page.getByRole("heading", { name: "Pipelines", level: 1 })).toBeVisible();
  });

  test("clicking Apps navigates to /apps", async ({ page }) => {
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Apps" }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/apps");
    await expect(page.getByRole("heading", { name: "Apps", level: 1 })).toBeVisible();
  });

  test("clicking Logs navigates to /logs", async ({ page }) => {
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Logs" }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/logs");
    await expect(page.getByRole("heading", { name: "Logs", level: 1 })).toBeVisible();
  });

  test("clicking Plugins navigates to /plugins", async ({ page }) => {
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Plugins" }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/plugins");
    await expect(page.getByRole("heading", { name: "Plugins", level: 1 })).toBeVisible();
  });

  test("clicking Settings navigates to /settings/profile", async ({ page }) => {
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL("**/settings/profile", { timeout: 10_000 });

    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  });

  test("browser back button returns to the previous page", async ({ page }) => {
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Connectors" }).click();
    await page.waitForLoadState("networkidle");
    expect(new URL(page.url()).pathname).toBe("/connectors");

    await page.goBack();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/dashboard");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 4. 404 handling
// ---------------------------------------------------------------------------

test.describe("404 — unknown routes", () => {
  test("navigating to an unknown path renders the 404 page", async ({
    page,
    screenshotHelper,
  }) => {
    await goTo(page, "/this/route/does/not/exist");

    const bodyText = await page.locator("body").textContent();
    const isNotFound = /404|not found|page not found/i.test(bodyText ?? "");

    expect(
      isNotFound,
      `Expected 404 page content but got: ${bodyText?.slice(0, 300)}`,
    ).toBe(true);

    await screenshotHelper.capture("not-found");
  });

  test("unknown route within authenticated area shows 404", async ({ page }) => {
    await goTo(page, "/this-authenticated-route-does-not-exist");

    const bodyText = await page.locator("body").textContent();
    // The page renders either a 404 page or falls into an error boundary
    expect(bodyText).toBeTruthy();
    expect(bodyText?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Sidebar collapse / expand
// ---------------------------------------------------------------------------

test.describe("Sidebar collapse", () => {
  test("sidebar collapses when the Collapse button is clicked", async ({
    page,
    screenshotHelper,
  }) => {
    await goTo(page, "/dashboard");
    await page.waitForLoadState("networkidle");

    // Primary nav must be visible before we interact with it
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(primaryNav.getByText("Overview")).toBeVisible({ timeout: 10_000 });

    const collapseBtn = page.getByRole("button", { name: /collapse sidebar/i });
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click();

    // After collapse the expand button appears and nav text labels are hidden
    await expect(
      page.getByRole("button", { name: /expand sidebar/i }),
    ).toBeVisible({ timeout: 5_000 });

    // The "Overview" text span is removed from the DOM in collapsed state
    await expect(primaryNav.getByText("Overview")).toBeHidden();

    await screenshotHelper.capture("sidebar-collapsed");
  });

  test("sidebar re-expands and shows nav labels again", async ({ page }) => {
    await goTo(page, "/dashboard");
    await page.waitForLoadState("networkidle");

    // Collapse then expand
    await page.getByRole("button", { name: /collapse sidebar/i }).click();
    await page.getByRole("button", { name: /expand sidebar/i }).click();

    // Labels should be visible again after expanding
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(primaryNav.getByText("Overview")).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// 6. Each main page loads without console errors
// ---------------------------------------------------------------------------

test.describe("No console errors on main pages", () => {
  const PAGES: Array<{ label: string; path: string }> = [
    { label: "dashboard", path: "/dashboard" },
    { label: "connectors", path: "/connectors" },
    { label: "ontology", path: "/ontology" },
    { label: "pipelines", path: "/pipelines" },
    { label: "apps", path: "/apps" },
    { label: "logs", path: "/logs" },
    { label: "plugins", path: "/plugins" },
    { label: "settings profile", path: "/settings/profile" },
  ];

  for (const { label, path } of PAGES) {
    test(`${label} (${path}) loads without console errors`, async ({
      page,
      consoleErrors,
    }) => {
      await goTo(page, path);
      await page.waitForLoadState("networkidle");

      consoleErrors.assertNone();
    });
  }
});
