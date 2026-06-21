/**
 * dashboard.spec.ts — E2E tests for the /dashboard page and sidebar navigation.
 *
 * Authentication strategy: the AuthenticatedLayout calls GET /api/v1/auth/me on
 * mount. Because setupMockApi intercepts that request and returns a valid Session
 * object, navigating directly to /dashboard enters an authenticated session without
 * any cookie or localStorage setup.
 *
 * Missing mock routes: the default MOCK_USER in mock-api.ts does not match the
 * Session interface (uses `id` + `name` instead of `userId` + `roles[]`). We
 * shadow /auth/me in beforeEach with a correctly-shaped Session.
 *
 * Additional mocks added in beforeEach:
 *   /api/healthz  — ServiceHealthGrid calls this; absent from the default route table
 *   /api/v1/connectors?limit=1 — Quick Start count query (query string breaks $ anchor)
 *   /api/v1/ontology?limit=1   — same
 *   /api/v1/pipelines?limit=1  — same
 *
 * Quick Start visibility: the panel appears when any resource count is zero AND
 * the user has not dismissed it. The overrides above all return total=0, so the
 * panel stays visible in every test where Quick Start isn't explicitly tested.
 */

import { test, expect } from "./fixtures/base.js";
import {
  setupMockApi,
  overrideMock,
  MOCK_PIPELINES,
} from "./helpers/mock-api.js";
import { DashboardPage } from "./pages/dashboard.page.js";

// ---------------------------------------------------------------------------
// Correct Session-shaped response for /auth/me (matches auth.store.ts Session)
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
// Helper — register all mocks missing from the default route table
// ---------------------------------------------------------------------------

async function applyAuthAndExtraMocks(
  page: import("@playwright/test").Page,
): Promise<void> {
  // Auth/me with correct Session shape (LIFO — registered after setupMockApi)
  await overrideMock(page, /\/api\/v1\/auth\/me/, 200, { data: MOCK_SESSION });

  // ServiceHealthGrid calls /api/healthz, not /api/v1/health. Without this
  // the component logs a console error and shows "Unknown" for every service.
  await overrideMock(page, /\/api\/healthz/, 200, {
    status: "healthy",
    services: {
      gateway: { status: "healthy", latencyMs: 2 },
      auth: { status: "healthy", latencyMs: 4 },
    },
  });

  // Quick Start count queries use limit=1 query params which the default mock
  // patterns don't match (they anchor with $). Return total=0 so Quick Start
  // stays visible by default (tests that need it hidden set their own override).
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
// Helper — navigate to the dashboard and wait for it to finish loading
// ---------------------------------------------------------------------------

async function loadDashboard(page: import("@playwright/test").Page): Promise<DashboardPage> {
  const dashboard = new DashboardPage(page);
  // goto() calls waitForPageReady() (networkidle + spinner check).
  // We do not call waitForLoad() because the .or() union locator in that method
  // triggers Playwright strict-mode violations when all three panel headings
  // are present simultaneously.
  await dashboard.goto();
  return dashboard;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    // Clear persisted state so each test starts clean
    await page.addInitScript(() => {
      localStorage.removeItem("oneplatform.quickstart.dismissed");
      localStorage.removeItem("oneplatform.dashboard.widget-order");
    });

    await setupMockApi(page);
    await applyAuthAndExtraMocks(page);
  });

  // -------------------------------------------------------------------------
  // Load + layout
  // -------------------------------------------------------------------------

  test("dashboard loads after login and renders the Overview heading", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await loadDashboard(page);

    // The dashboard h1 is "Overview" — DashboardPage.tsx uses that text, not "Dashboard"
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();

    await screenshotHelper.capture("overview");
    consoleErrors.assertNone();
  });

  test("current URL is /dashboard after loading", async ({ page }) => {
    await loadDashboard(page);

    expect(new URL(page.url()).pathname).toBe("/dashboard");
  });

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  test("Active Pipelines panel renders with pipeline names from mock data", async ({
    page,
  }) => {
    await loadDashboard(page);

    // The panel heading — use first() to avoid strict-mode issues if there are
    // multiple "Active Pipelines" strings on the page (the heading is a CardTitle)
    await expect(
      page.getByRole("heading", { name: "Active Pipelines" }).first(),
    ).toBeVisible();

    // Each mock pipeline's name should appear as a link in the panel
    for (const pipeline of MOCK_PIPELINES) {
      await expect(page.getByRole("link", { name: pipeline.name })).toBeVisible();
    }
  });

  test("Service Health panel renders with service status indicators", async ({
    page,
    screenshotHelper,
  }) => {
    await loadDashboard(page);

    await expect(
      page.getByRole("heading", { name: "Service Health" }).first(),
    ).toBeVisible();

    // The ServiceHealthGrid renders service names as paragraphs.
    // We added a /healthz mock so the grid resolves to the mock services.
    await expect(page.getByText("Gateway")).toBeVisible();

    await screenshotHelper.capture("service-health");
  });

  test("Recent Activity panel renders", async ({ page }) => {
    await loadDashboard(page);

    await expect(
      page.getByRole("heading", { name: "Recent Activity" }).first(),
    ).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Quick Start panel
  // -------------------------------------------------------------------------

  test("Quick Start panel is visible when onboarding is incomplete", async ({
    page,
    screenshotHelper,
  }) => {
    // The extra mocks return total=0 for all resources, so allStepsComplete=false
    // and the Quick Start panel stays visible.
    await loadDashboard(page);

    // QuickStartPanel.CardTitle = "Get started with OnePlatform"
    await expect(
      page.getByText(/get started with oneplatform/i),
    ).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("quick-start");
  });

  test("Quick Start dismiss button hides the panel", async ({ page }) => {
    await loadDashboard(page);

    await expect(page.getByText(/get started with oneplatform/i)).toBeVisible({
      timeout: 10_000,
    });

    // The dismiss button uses aria-label="Dismiss quick start"
    await page.getByRole("button", { name: /dismiss quick start/i }).click();

    await expect(page.getByText(/get started with oneplatform/i)).toBeHidden({
      timeout: 5_000,
    });
  });

  // -------------------------------------------------------------------------
  // Empty states — override mocks to return empty lists
  // -------------------------------------------------------------------------

  test("Active Pipelines panel shows empty state when no pipelines exist", async ({
    page,
    screenshotHelper,
  }) => {
    // Override the list endpoint (no query string) to return empty.
    // The LIFO registration means this shadows the setupMockApi handler.
    await overrideMock(page, /\/api\/v1\/pipelines$/, 200, {
      data: [],
      pagination: { total: 0, page: 1, pageSize: 20 },
    });

    await loadDashboard(page);

    // DashboardPage renders "No pipelines yet." with a "Create one" link
    await expect(page.getByText(/no pipelines yet/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /create one/i })).toBeVisible();

    await screenshotHelper.capture("pipelines-empty-state");
  });

  test("Recent Activity shows empty state when no log events exist", async ({
    page,
    screenshotHelper,
  }) => {
    // The default logs mock already returns empty — verify the empty-state message.
    await loadDashboard(page);

    await expect(page.getByText(/no recent activity/i)).toBeVisible();

    await screenshotHelper.capture("activity-empty-state");
  });

  // -------------------------------------------------------------------------
  // Authenticated user info
  // -------------------------------------------------------------------------

  test("authenticated tenant name appears in the app shell topbar", async ({ page }) => {
    await loadDashboard(page);

    // The Topbar renders "Tenant: <tenantName>" as always-visible text when tenantName
    // is populated. The user's displayName ("E2E Tester") lives inside a DropdownMenu
    // that is only visible when opened. Testing the tenant label is a better proxy
    // for confirming the auth store was populated from /auth/me.
    await expect(
      page.getByText(/E2E Tenant/, { exact: false }),
    ).toBeVisible();
  });

  test("authenticated user display name is visible in the user menu dropdown", async ({
    page,
  }) => {
    await loadDashboard(page);

    // Open the user menu dropdown to reveal the display name
    await page.getByRole("button", { name: /user menu/i }).click();

    // The dropdown shows "E2E Tester" as the user label
    await expect(
      page.getByText(MOCK_SESSION.displayName, { exact: false }),
    ).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // Sidebar navigation links
  // -------------------------------------------------------------------------

  test("all primary sidebar sections are visible", async ({ page }) => {
    await loadDashboard(page);

    // Labels defined in Sidebar.tsx NAV_GROUPS. Scope to the primary nav to
    // avoid collisions with the mobile nav (which has a subset of links).
    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });

    const expectedLabels = [
      "Overview",
      "Connectors",
      "Marketplace",
      "Ontology",
      "Pipelines",
      "Apps",
      "Logs",
      "Audit",
      "Plugins",
      "Settings",
    ];

    for (const label of expectedLabels) {
      await expect(
        primaryNav.getByRole("link", { name: label }),
        `Primary nav link "${label}" should be visible`,
      ).toBeVisible();
    }
  });

  test("DLQ and Metrics are hidden for tenant-admin users (require data-engineer role)", async ({
    page,
  }) => {
    // Sidebar.tsx gates DLQ and Metrics on `data-engineer` role.
    // MOCK_SESSION.roles = ["tenant-admin"] — neither "data-engineer" nor "platform-admin" —
    // so both links should be hidden.
    await loadDashboard(page);

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(primaryNav.getByRole("link", { name: "Logs" })).toBeVisible();
    await expect(primaryNav.getByRole("link", { name: "DLQ" })).toBeHidden();
    await expect(primaryNav.getByRole("link", { name: "Metrics" })).toBeHidden();
  });

  test("Overview sidebar link is marked aria-current=page on the dashboard", async ({
    page,
  }) => {
    await loadDashboard(page);

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await expect(
      primaryNav.getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("clicking a sidebar link navigates to the correct route", async ({
    page,
  }) => {
    await loadDashboard(page);

    const primaryNav = page.getByRole("navigation", { name: /primary navigation/i });
    await primaryNav.getByRole("link", { name: "Connectors" }).click();
    await page.waitForLoadState("networkidle");

    expect(new URL(page.url()).pathname).toBe("/connectors");
  });

  // -------------------------------------------------------------------------
  // Widget reorder controls
  // -------------------------------------------------------------------------

  test("widget reorder buttons are present in the DOM", async ({ page }) => {
    await loadDashboard(page);

    // Reorder controls are in the DOM but at opacity-0 until hover. Use count()
    // rather than toBeVisible() to avoid flakiness with the CSS transition.
    const moveUpButtons = page.getByRole("button", { name: /move .+ up/i });
    const moveDownButtons = page.getByRole("button", { name: /move .+ down/i });

    // Three widgets → 2 move-up buttons (first is disabled) + 2 move-down buttons
    expect(await moveUpButtons.count()).toBeGreaterThanOrEqual(2);
    expect(await moveDownButtons.count()).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Visual snapshot
  // -------------------------------------------------------------------------

  test("full-page screenshot for visual verification", async ({
    page,
    screenshotHelper,
  }) => {
    await loadDashboard(page);
    await screenshotHelper.capture("full-page");
  });
});
