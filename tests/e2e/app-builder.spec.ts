/**
 * app-builder.spec.ts — E2E tests for the visual app builder.
 *
 * Route: /apps/$id/build
 *
 * The AppBuilderPage loads the app meta from the API, then renders:
 *   - A name strip across the top with "Back to app" and "Visual Builder" labels
 *   - AppBuilderCanvas which contains:
 *     - ComponentPalette (left): categorised draggable component cards
 *     - AppBuilderCanvas centre: the drop zone
 *     - ComponentConfigPanel (right): appears when a component is selected
 *
 * Auth is satisfied by setupMockApi intercepting GET /api/v1/auth/me.
 */

import { test, expect } from "./fixtures/base.js";
import { setupMockApi, overrideMock, MOCK_APPS } from "./helpers/mock-api.js";
import { TEST_APPS } from "./helpers/test-data.js";

// ---------------------------------------------------------------------------
// Helper: navigate to the app builder for app-001.
// ---------------------------------------------------------------------------

// The Session shape AuthenticatedLayout expects (roles as array, userId not id).
// The default MOCK_USER in setupMockApi uses the wrong shape and causes
// `roles.includes(...)` in Sidebar to throw "Cannot read properties of undefined".
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

async function gotoBuilder(page: import("@playwright/test").Page) {
  await setupMockApi(page);
  // Override auth/me with a properly-shaped Session object
  await overrideMock(page, /\/api\/v1\/auth\/me/, 200, { data: MOCK_SESSION });
  await page.goto(`/apps/${TEST_APPS.published.id}/build`);
  await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("App builder", () => {
  test("builder page loads with the app name and Visual Builder label", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoBuilder(page);

    // The name strip shows the app name and "Visual Builder" label
    await expect(
      page.getByText("Visual Builder", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // The back-link shows the app name
    await expect(
      page.getByLabel("Back to app detail"),
    ).toBeVisible({ timeout: 8_000 });

    await screenshotHelper.capture("builder-loaded");
  });

  test("component palette is visible with the Components header", async ({
    page,
  }) => {
    await gotoBuilder(page);

    // ComponentPalette renders a div with "Components" as its header text
    await expect(
      page.getByText("Components", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // The search input for filtering components is present
    await expect(
      page.getByLabel("Search components"),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("palette shows all required category groups", async ({ page }) => {
    await gotoBuilder(page);

    // PALETTE_CATEGORIES from palette-registry.ts:
    // "Data Display", "Charts", "Form Inputs", "Interactive", "Progress", "Input", "Layout", "Custom"
    const expectedCategories = [
      "Data Display",
      "Charts",
      "Form Inputs",
      "Interactive",
      "Progress",
      "Input",
      "Layout",
      "Custom",
    ];

    for (const category of expectedCategories) {
      // Each category renders as a button with aria-expanded and visible text.
      // Use exact: true so "Input" does not accidentally match "Form Inputs".
      await expect(
        page.getByRole("button", { name: category, exact: true }),
      ).toBeVisible({ timeout: 8_000 });
    }
  });

  test("palette shows component cards within expanded categories", async ({
    page,
  }) => {
    await gotoBuilder(page);

    // Data Display category should be expanded by default and show "Data Table"
    await expect(
      page.getByLabel("Data Table — Sortable, paginated, searchable table."),
    ).toBeVisible({ timeout: 10_000 });

    // Charts category should show "Bar Chart"
    await expect(
      page.getByLabel(/Bar Chart — .*bar chart/i),
    ).toBeVisible({ timeout: 5_000 });

    // Form Inputs category should show "Text Input"
    await expect(
      page.getByLabel(/Text Input — /i),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("palette search filters components by label", async ({ page }) => {
    await gotoBuilder(page);

    const searchInput = page.getByLabel("Search components");
    await expect(searchInput).toBeVisible({ timeout: 10_000 });

    // Filter for "chart" — should show chart items only
    await searchInput.fill("chart");

    await expect(
      page.getByLabel(/Bar Chart — /i),
    ).toBeVisible({ timeout: 5_000 });

    // Data Table should not be visible when searching for "chart"
    await expect(
      page.getByLabel("Data Table — Sortable, paginated, searchable table."),
    ).not.toBeVisible({ timeout: 3_000 });

    // Clear filter — Data Table should reappear
    await searchInput.clear();
    await expect(
      page.getByLabel("Data Table — Sortable, paginated, searchable table."),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("collapsing and expanding a category group works", async ({ page }) => {
    await gotoBuilder(page);

    // "Data Display" starts expanded. Click its header to collapse.
    const dataDisplayToggle = page.getByRole("button", { name: /Data Display/i });
    await expect(dataDisplayToggle).toBeVisible({ timeout: 10_000 });

    // Stat Card is in Data Display — visible when expanded
    await expect(
      page.getByLabel(/Stat Card — /i),
    ).toBeVisible({ timeout: 5_000 });

    await dataDisplayToggle.click();

    // After collapsing, Stat Card should no longer be visible
    await expect(
      page.getByLabel(/Stat Card — /i),
    ).not.toBeVisible({ timeout: 3_000 });

    // Re-expand
    await dataDisplayToggle.click();
    await expect(
      page.getByLabel(/Stat Card — /i),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("the canvas drop zone is present", async ({ page, screenshotHelper }) => {
    await gotoBuilder(page);

    // AppBuilderCanvas renders the drop zone region. The canvas contains
    // DropZone components and the ComponentWrapper grid. In an empty state
    // the canvas is present but empty of placed components.
    //
    // Verify the palette and the canvas area are both visible, meaning the
    // three-column layout loaded successfully.
    await expect(page.getByText("Components", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // "Open in Monaco editor" button (aria-label) rendered by AppBuilderCanvas
    // toolbar is a reliable indicator the canvas loaded fully.
    await expect(
      page.getByRole("button", { name: "Open in Monaco editor" }),
    ).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("canvas-loaded");
  });

  test("the edit and preview mode buttons are visible in the builder toolbar", async ({
    page,
  }) => {
    await gotoBuilder(page);

    // AppBuilderCanvas toolbar renders Edit mode and Preview mode toggle buttons.
    // There is no Save button — layout changes are committed to the store immediately.
    await expect(
      page.getByRole("button", { name: "Edit mode" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: "Preview mode" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("screenshot of builder with palette open", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoBuilder(page);

    // Ensure the full layout is visible
    await expect(page.getByText("Visual Builder", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Components", { exact: true })).toBeVisible();

    await screenshotHelper.capture("builder-with-palette");
  });

  test("usage hint 'Drag components onto the canvas' is visible", async ({
    page,
  }) => {
    await gotoBuilder(page);

    await expect(
      page.getByText("Drag components onto the canvas"),
    ).toBeVisible({ timeout: 10_000 });
  });
});
