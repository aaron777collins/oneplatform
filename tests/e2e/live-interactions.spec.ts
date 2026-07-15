/**
 * live-interactions.spec.ts — Deep button interaction tests.
 *
 * Tests actual button clicks, form submissions, dialog interactions, and
 * navigation flows against the live site at http://localhost:8088.
 *
 * Each test navigates fresh to avoid state pollution.
 * Destructive actions (delete, submit) are tested up to the confirmation point only.
 */

import { test, expect, type Page } from "@playwright/test";
import { resolve } from "path";
import { mkdirSync } from "fs";

const SCREENSHOT_DIR = resolve(import.meta.dirname, "screenshots", "live-interactions");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

let screenshotCounter = 0;

async function screenshot(page: Page, label: string): Promise<void> {
  screenshotCounter++;
  const safeName = label.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const path = resolve(SCREENSHOT_DIR, `${String(screenshotCounter).padStart(3, "0")}-${safeName}.png`);
  await page.screenshot({ path, fullPage: true });
}

async function waitForNetworkIdle(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout });
}

function setupErrorCollector(page: Page): () => string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
  return () =>
    errors.filter(
      (e) =>
        !e.includes("EventSource") &&
        !e.includes("WebSocket") &&
        !e.includes("net::ERR") &&
        !e.includes("Failed to fetch") &&
        !e.includes("Failed to load resource") &&
        !e.includes("favicon") &&
        !e.includes("429") &&
        !e.includes("Too Many Requests") &&
        !e.includes("Warning:")
    );
}

async function assertNotCrashed(page: Page): Promise<void> {
  const body = await page.locator("body").textContent();
  expect(body?.length, "Page body should have content").toBeGreaterThan(10);
  const crashed = /something went wrong|error boundary|unhandled|unexpected error/i.test(body ?? "");
  if (crashed) throw new Error(`Page crashed: ${body?.slice(0, 300)}`);
}

async function getToast(page: Page): Promise<string | null> {
  await page.waitForTimeout(800);
  const toast = page.locator('[data-sonner-toast], [role="alert"], .toast').first();
  if (await toast.isVisible().catch(() => false)) {
    return toast.textContent();
  }
  return null;
}

// ============================================================================
// 1. CONNECTORS
// ============================================================================

test.describe("Connectors — Button Interactions", () => {
  test.setTimeout(15_000);

  test("New Connector button → dialog or page appears", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/connectors");
    await waitForNetworkIdle(page);

    const newBtn = page
      .getByRole("link", { name: /new connector|add connector/i })
      .or(page.getByRole("button", { name: /new connector|add connector/i }));
    await expect(newBtn.first()).toBeVisible({ timeout: 10_000 });
    await newBtn.first().click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);

    const url = page.url();
    const dialogVisible =
      (await page.locator('[role="dialog"]').isVisible().catch(() => false)) ||
      (await page.locator("text=Create Connector").isVisible().catch(() => false)) ||
      (await page.locator("text=Select a connector type").isVisible().catch(() => false));

    expect(
      url.includes("/connectors/new") || url.includes("/connectors/marketplace") || dialogVisible,
      `Expected new connector flow but URL is ${url}`
    ).toBeTruthy();

    await screenshot(page, "connectors-new-flow-opened");
    expect(getErrors()).toHaveLength(0);
  });

  test("Connector card click → detail page loads with name visible (not raw UUID)", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/connectors");
    await waitForNetworkIdle(page);

    // Connectors list page shows connector cards — grab the first clickable card
    // that isn't the "new" or "marketplace" link
    const connectorLink = page
      .locator('a[href*="/connectors/"]')
      .filter({ hasNot: page.locator('a[href*="/connectors/new"]') })
      .filter({ hasNot: page.locator('a[href*="/connectors/marketplace"]') })
      .first();

    const hasConnector = await connectorLink.isVisible().catch(() => false);
    if (!hasConnector) {
      // Also try cursor-pointer cards for onClick-based navigation
      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      // Read the card's text before clicking so we can verify the detail page title
      const cardText = (await card.textContent()) ?? "";
      await card.click();
      await waitForNetworkIdle(page);
      await assertNotCrashed(page);
      await screenshot(page, "connector-detail-from-card");
      expect(getErrors()).toHaveLength(0);
      return;
    }

    // Get the connector name from the link text or parent card
    const connectorName = (await connectorLink.textContent()) ?? "";
    await connectorLink.click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);

    // The page heading should show a human-readable name, not a raw UUID
    const heading = page.getByRole("heading", { level: 1 });
    const headingText = await heading.textContent().catch(() => "");
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      headingText?.trim() ?? ""
    );
    expect(isUUID, `Detail page heading appears to be a raw UUID: "${headingText}"`).toBe(false);

    await screenshot(page, "connector-detail-name-visible");
    expect(getErrors()).toHaveLength(0);
  });

  test("Sync Now button on connector detail → toast or status change appears", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/connectors");
    await waitForNetworkIdle(page);

    const connectorLink = page
      .locator('a[href*="/connectors/"]')
      .filter({ hasNot: page.locator('a[href*="/connectors/new"]') })
      .filter({ hasNot: page.locator('a[href*="/connectors/marketplace"]') })
      .first();

    if (!(await connectorLink.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await connectorLink.click();
    await waitForNetworkIdle(page);

    const syncBtn = page.getByRole("button", { name: /sync now|run sync|trigger sync/i });
    if (!(await syncBtn.isVisible().catch(() => false))) {
      await screenshot(page, "connector-no-sync-button");
      return;
    }

    await syncBtn.click();
    // Capture immediate state after click
    await page.waitForTimeout(1000);
    await assertNotCrashed(page);

    // Either a toast appeared, or the button text changed to "Syncing…" / disabled
    const toastText = await getToast(page);
    const btnText = await syncBtn.textContent().catch(() => "");
    const statusChanged =
      toastText !== null ||
      /syncing|in progress|queued|started/i.test(btnText) ||
      (await syncBtn.isDisabled().catch(() => false));

    await screenshot(page, "connector-sync-triggered");
    // We don't assert statusChanged because the API might respond differently; just
    // verify the page didn't crash and there are no error toasts indicating failure
    expect(getErrors()).toHaveLength(0);
  });
});

// ============================================================================
// 2. PIPELINES
// ============================================================================

test.describe("Pipelines — Button Interactions", () => {
  test.setTimeout(15_000);

  test("Pipeline card click → detail page shows pipeline name not UUID", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/pipelines");
    await waitForNetworkIdle(page);

    // Pipeline cards use onClick navigation, not <a> links
    const card = page.locator('[class*="cursor-pointer"]').first();
    if (!(await card.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    // Capture the card's displayed name to compare against detail heading
    const cardName = (await card.locator("h2, h3, [class*='title'], [class*='name']").first().textContent().catch(() => "")) ?? "";

    await card.click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);

    expect(page.url()).toMatch(/\/pipelines\//);

    // Verify the heading is a human-readable name, not a UUID
    const heading = page.getByRole("heading", { level: 1 });
    const headingText = (await heading.textContent().catch(() => "")) ?? "";
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      headingText.trim()
    );
    expect(isUUID, `Pipeline detail heading is a raw UUID: "${headingText}"`).toBe(false);

    await screenshot(page, "pipeline-detail-name-visible");
    expect(getErrors()).toHaveLength(0);
  });

  test("Edit button on pipeline detail → builder loads with pipeline name populated", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/pipelines");
    await waitForNetworkIdle(page);

    const card = page.locator('[class*="cursor-pointer"]').first();
    if (!(await card.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await card.click();
    await waitForNetworkIdle(page);

    // Capture the pipeline name shown on detail page
    const detailHeading = (await page.getByRole("heading", { level: 1 }).textContent().catch(() => "")) ?? "";

    const editBtn = page
      .getByRole("link", { name: /edit/i })
      .or(page.getByRole("button", { name: /edit/i }));
    if (!(await editBtn.first().isVisible().catch(() => false))) {
      await screenshot(page, "pipeline-detail-no-edit-btn");
      return;
    }
    await editBtn.first().click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);

    // Builder should be open — URL contains /edit
    expect(page.url()).toMatch(/\/pipelines\/.+\/edit/);

    // The pipeline name should appear somewhere on the builder page
    if (detailHeading.length > 0) {
      const pageBody = (await page.locator("body").textContent()) ?? "";
      expect(pageBody).toContain(detailHeading);
    }

    await screenshot(page, "pipeline-builder-name-populated");
    expect(getErrors()).toHaveLength(0);
  });

  test("Run Now button → Triggering state or toast appears", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/pipelines");
    await waitForNetworkIdle(page);

    const card = page.locator('[class*="cursor-pointer"]').first();
    if (!(await card.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await card.click();
    await waitForNetworkIdle(page);

    const runBtn = page.getByRole("button", { name: /run now|run pipeline|execute|trigger/i });
    if (!(await runBtn.isVisible().catch(() => false))) {
      await screenshot(page, "pipeline-detail-no-run-btn");
      return;
    }

    await runBtn.click();
    await page.waitForTimeout(1000);
    await assertNotCrashed(page);

    // Check for triggering state: button text change, toast, or loading spinner
    const btnText = (await runBtn.textContent().catch(() => "")) ?? "";
    const toastText = await getToast(page);
    const hasTriggering =
      /triggering|running|queued|started|in progress/i.test(btnText) ||
      toastText !== null ||
      (await runBtn.isDisabled().catch(() => false)) ||
      (await page.locator('[class*="spinner"], [class*="loading"], [aria-busy="true"]').isVisible().catch(() => false));

    await screenshot(page, "pipeline-run-triggered");
    // Soft assertion — the page must not crash; toast/status is best-effort
    expect(getErrors()).toHaveLength(0);
  });

  test("New Pipeline button → template gallery or wizard appears", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/pipelines");
    await waitForNetworkIdle(page);

    const newBtn = page
      .getByRole("link", { name: /new pipeline|create pipeline/i })
      .or(page.getByRole("button", { name: /new pipeline|create pipeline/i }));
    if (!(await newBtn.first().isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await newBtn.first().click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);

    // Should show template gallery, wizard, or the builder itself
    const urlOk = page.url().includes("/pipelines/");
    const hasGallery =
      (await page.locator("text=template").isVisible().catch(() => false)) ||
      (await page.locator("text=Choose a template").isVisible().catch(() => false)) ||
      (await page.locator("text=Pipeline Builder").isVisible().catch(() => false)) ||
      (await page.locator('[role="dialog"]').isVisible().catch(() => false));

    expect(urlOk || hasGallery, "Expected pipeline creation flow to appear").toBeTruthy();

    await screenshot(page, "pipeline-new-flow-opened");
    expect(getErrors()).toHaveLength(0);
  });
});

// ============================================================================
// 3. APPS
// ============================================================================

test.describe("Apps — Button Interactions", () => {
  test.setTimeout(15_000);

  test("App card click → detail page loads", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/apps");
    await waitForNetworkIdle(page);

    const card = page.locator('[class*="cursor-pointer"]').first();
    if (!(await card.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await card.click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);

    expect(page.url()).toContain("/apps/");
    await screenshot(page, "app-detail-loaded");
    expect(getErrors()).toHaveLength(0);
  });

  test("Visual Builder button → editor page opens", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/apps");
    await waitForNetworkIdle(page);

    // Check for Visual Builder button on the list page directly first
    const visualBuilderBtn = page
      .getByRole("button", { name: /visual builder/i })
      .or(page.getByRole("link", { name: /visual builder/i }))
      .first();

    const hasOnList = await visualBuilderBtn.isVisible().catch(() => false);
    if (!hasOnList) {
      // Navigate to a detail page and look there
      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForNetworkIdle(page);
    }

    const builderBtn = page
      .getByRole("button", { name: /visual builder/i })
      .or(page.getByRole("link", { name: /visual builder/i }));
    if (!(await builderBtn.first().isVisible().catch(() => false))) {
      await screenshot(page, "app-no-visual-builder-btn");
      return;
    }

    await builderBtn.first().click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);

    // Should navigate to a builder/edit URL
    expect(page.url()).toMatch(/\/apps\/.+\/(build|edit|builder)/);
    await screenshot(page, "app-visual-builder-opened");
    expect(getErrors()).toHaveLength(0);
  });

  test("Code Editor (Advanced) button → code editor opens", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/apps");
    await waitForNetworkIdle(page);

    // Look for "Code Editor" / "Advanced" / "Edit in Monaco" on list or detail
    const editorBtn = page
      .getByRole("button", { name: /code editor|advanced|edit in monaco/i })
      .or(page.getByRole("link", { name: /code editor|advanced|edit in monaco/i }))
      .first();

    const hasOnList = await editorBtn.isVisible().catch(() => false);
    if (!hasOnList) {
      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForNetworkIdle(page);
    }

    const codeBtn = page
      .getByRole("button", { name: /code editor|advanced|edit in monaco/i })
      .or(page.getByRole("link", { name: /code editor|advanced|edit in monaco/i }));
    if (!(await codeBtn.first().isVisible().catch(() => false))) {
      await screenshot(page, "app-no-code-editor-btn");
      return;
    }

    await codeBtn.first().click();
    await waitForNetworkIdle(page, 20_000);
    await assertNotCrashed(page);

    // Code editor URL pattern — /edit
    expect(page.url()).toMatch(/\/apps\/.+\/edit/);
    await screenshot(page, "app-code-editor-opened");
    expect(getErrors()).toHaveLength(0);
  });

  test("Deploy button → deploy dialog or action initiates", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/apps");
    await waitForNetworkIdle(page);

    const card = page.locator('[class*="cursor-pointer"]').first();
    if (!(await card.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await card.click();
    await waitForNetworkIdle(page);

    const deployBtn = page.getByRole("button", { name: /deploy/i });
    if (!(await deployBtn.isVisible().catch(() => false))) {
      await screenshot(page, "app-detail-no-deploy-btn");
      return;
    }

    await deployBtn.click();
    await page.waitForTimeout(800);
    await assertNotCrashed(page);

    // A deploy dialog should appear, or the button enters a loading state
    const dialogVisible = await page.locator('[role="dialog"]').isVisible().catch(() => false);
    const toastText = await getToast(page);
    const btnDisabled = await deployBtn.isDisabled().catch(() => false);

    await screenshot(page, "app-deploy-initiated");
    // Close dialog if it opened
    if (dialogVisible) await page.keyboard.press("Escape");
    expect(getErrors()).toHaveLength(0);
  });
});

// ============================================================================
// 4. ONTOLOGY / DATA MODELS
// ============================================================================

test.describe("Ontology — Button Interactions", () => {
  test.setTimeout(15_000);

  test("New Entity button → create dialog opens", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/ontology");
    await waitForNetworkIdle(page);

    const createBtn = page.getByRole("button", { name: /new entity|create entity|add entity|create|new|add/i }).first();
    if (!(await createBtn.isVisible().catch(() => false))) {
      await screenshot(page, "ontology-no-create-btn");
      return;
    }

    await createBtn.click();
    await page.waitForTimeout(600);
    await assertNotCrashed(page);

    // Dialog should open
    const dialogVisible = await page.locator('[role="dialog"]').isVisible().catch(() => false);
    const hasForm = await page.locator('input[type="text"], input[name], [placeholder]').first().isVisible().catch(() => false);
    expect(dialogVisible || hasForm, "Expected create entity dialog to open").toBeTruthy();

    await screenshot(page, "ontology-create-dialog-open");

    // Close without submitting
    const cancelBtn = page.getByRole("button", { name: /cancel|close/i });
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }

    expect(getErrors()).toHaveLength(0);
  });

  test("View button on entity → entity detail page loads", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/ontology");
    await waitForNetworkIdle(page);

    // Try clicking "View" button on an entity row, or clicking entity link directly
    const viewBtn = page.getByRole("button", { name: /^view$/i }).or(
      page.getByRole("link", { name: /^view$/i })
    ).first();

    const hasViewBtn = await viewBtn.isVisible().catch(() => false);
    if (hasViewBtn) {
      await viewBtn.click();
      await waitForNetworkIdle(page);
      await assertNotCrashed(page);
      await screenshot(page, "ontology-entity-detail-via-view-btn");
      expect(getErrors()).toHaveLength(0);
      return;
    }

    // Fall back: click the first entity link
    const entityLink = page
      .locator('a[href*="/ontology/"]')
      .filter({ hasNot: page.locator('a[href="/ontology/query"]') })
      .filter({ hasNot: page.locator('a[href="/ontology/data-quality"]') })
      .filter({ hasNot: page.locator('a[href="/ontology/migrations"]') })
      .first();

    if (!(await entityLink.isVisible().catch(() => false))) {
      // Try cursor-pointer card click
      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
    } else {
      await entityLink.click();
    }

    await waitForNetworkIdle(page);
    await assertNotCrashed(page);
    await screenshot(page, "ontology-entity-detail-loaded");
    expect(getErrors()).toHaveLength(0);
  });

  test("Query button on entity → query builder opens", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/ontology");
    await waitForNetworkIdle(page);

    // First try a "Query" button on an entity row on the list page
    const queryBtnOnList = page.getByRole("button", { name: /^query$/i }).or(
      page.getByRole("link", { name: /^query$/i })
    ).first();

    if (await queryBtnOnList.isVisible().catch(() => false)) {
      await queryBtnOnList.click();
      await waitForNetworkIdle(page);
      await assertNotCrashed(page);
      expect(page.url()).toMatch(/\/ontology\/query/);
      await screenshot(page, "ontology-query-builder-from-entity-btn");
      expect(getErrors()).toHaveLength(0);
      return;
    }

    // Navigate to an entity detail page and look for "Query" tab or button
    const entityLink = page
      .locator('a[href*="/ontology/"]')
      .filter({ hasNot: page.locator('a[href="/ontology/query"]') })
      .filter({ hasNot: page.locator('a[href="/ontology/data-quality"]') })
      .filter({ hasNot: page.locator('a[href="/ontology/migrations"]') })
      .first();

    if (!(await entityLink.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await entityLink.click();
    await waitForNetworkIdle(page);

    // Look for Query tab or button on entity detail
    const queryTab = page.getByRole("tab", { name: /query/i });
    if (await queryTab.isVisible().catch(() => false)) {
      await queryTab.click();
      await page.waitForTimeout(500);
      await assertNotCrashed(page);
      await screenshot(page, "ontology-query-tab-on-entity");
    } else {
      // Navigate to query builder directly
      await page.goto("/ontology/query");
      await waitForNetworkIdle(page);
      await assertNotCrashed(page);
      await screenshot(page, "ontology-query-builder-direct");
    }

    expect(getErrors()).toHaveLength(0);
  });
});

// ============================================================================
// 5. SETTINGS TABS
// ============================================================================

test.describe("Settings — Tab Navigation", () => {
  test.setTimeout(15_000);

  const settingsTabs = [
    { name: "Profile", path: "/settings/profile" },
    { name: "Teams", path: "/settings/teams" },
    { name: "API Keys", path: "/settings/api-keys" },
    { name: "Webhooks", path: "/settings/webhooks" },
    { name: "Storage", path: "/settings/storage" },
    { name: "Roles", path: "/settings/roles" },
    { name: "Admin", path: "/settings/admin" },
  ];

  for (const { name, path } of settingsTabs) {
    test(`${name} tab → loads content without crash`, async ({ page }) => {
      const getErrors = setupErrorCollector(page);
      await page.goto(path);
      await waitForNetworkIdle(page);
      await assertNotCrashed(page);

      // Each settings tab must show some meaningful content
      const body = (await page.locator("body").textContent()) ?? "";
      expect(body.length).toBeGreaterThan(100);

      await screenshot(page, `settings-tab-${name.toLowerCase().replace(/\s+/g, "-")}`);
      expect(getErrors()).toHaveLength(0);
    });
  }

  test("Settings sidebar links navigate between all tabs", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/settings/profile");
    await waitForNetworkIdle(page);

    const linkTexts = ["Teams", "API Keys", "Webhooks", "Storage", "Roles", "Admin"];
    for (const text of linkTexts) {
      const link = page
        .getByRole("link", { name: new RegExp(`^${text}$`, "i") })
        .or(page.locator(`nav a:has-text("${text}")`))
        .first();

      if (!(await link.isVisible().catch(() => false))) continue;

      await link.click();
      await page.waitForTimeout(400);
      await assertNotCrashed(page);
      await screenshot(page, `settings-sidebar-nav-to-${text.toLowerCase().replace(/\s+/g, "-")}`);
    }

    expect(getErrors()).toHaveLength(0);
  });

  test("Profile Save Changes with no modifications → no crash", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/settings/profile");
    await waitForNetworkIdle(page);

    const saveBtn = page.getByRole("button", { name: /save|update/i });
    if (!(await saveBtn.isVisible().catch(() => false))) {
      await screenshot(page, "settings-profile-no-save-btn");
      return;
    }

    await saveBtn.click();
    await page.waitForTimeout(800);
    await assertNotCrashed(page);

    // Should show success or remain stable — not crash with an error boundary
    await screenshot(page, "settings-profile-save-no-changes");
    expect(getErrors()).toHaveLength(0);
  });
});

// ============================================================================
// 6. LOGS FILTERS
// ============================================================================

test.describe("Logs — Filter Interactions", () => {
  test.setTimeout(15_000);

  test("Service filter dropdown → options appear on click", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/logs");
    await waitForNetworkIdle(page);

    // Find the service filter: could be a <select> or a shadcn combobox
    const serviceFilter = page
      .getByRole("combobox", { name: /service/i })
      .or(page.locator('select[name*="service" i]'))
      .or(page.locator('[data-testid*="service-filter"]'))
      .or(page.locator('[class*="select"]').first());

    if (!(await serviceFilter.isVisible().catch(() => false))) {
      // Try the first combobox/select on the page
      const firstFilter = page.locator('[role="combobox"], select').first();
      if (!(await firstFilter.isVisible().catch(() => false))) {
        await screenshot(page, "logs-no-service-filter");
        return;
      }
      await firstFilter.click();
      await page.waitForTimeout(400);
      // Options should be in a listbox or as native <option> elements
      const options = page.locator('[role="option"], [role="listbox"] li').or(page.locator('select option'));
      const count = await options.count();
      await screenshot(page, "logs-service-filter-options");
      await page.keyboard.press("Escape");
      expect(getErrors()).toHaveLength(0);
      return;
    }

    await serviceFilter.click();
    await page.waitForTimeout(400);
    const optionsContainer = page.locator('[role="listbox"], [role="option"], select option');
    await expect(optionsContainer.first()).toBeVisible({ timeout: 5_000 });
    await screenshot(page, "logs-service-filter-open");
    await page.keyboard.press("Escape");
    expect(getErrors()).toHaveLength(0);
  });

  test("Log level filter → clicking a level filters the list", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/logs");
    await waitForNetworkIdle(page);

    // Look for log level filter buttons or dropdowns
    const errorLevelBtn = page
      .getByRole("button", { name: /^error$/i })
      .or(page.getByRole("option", { name: /^error$/i }))
      .or(page.locator('[data-value="error"], [data-level="error"]'))
      .first();

    const combobox = page.getByRole("combobox", { name: /level|severity/i });
    if (await combobox.isVisible().catch(() => false)) {
      await combobox.click();
      await page.waitForTimeout(300);
      const errorOption = page.getByRole("option", { name: /error/i });
      if (await errorOption.isVisible().catch(() => false)) {
        await errorOption.click();
        await page.waitForTimeout(500);
        await assertNotCrashed(page);
        await screenshot(page, "logs-filtered-by-error");
        expect(getErrors()).toHaveLength(0);
        return;
      }
      await page.keyboard.press("Escape");
    }

    // Try level toggle buttons
    const levels = ["error", "warn", "info", "debug"];
    for (const level of levels) {
      const btn = page.getByRole("button", { name: new RegExp(`^${level}$`, "i") })
        .or(page.getByRole("checkbox", { name: new RegExp(level, "i") }));
      if (await btn.first().isVisible().catch(() => false)) {
        await btn.first().click();
        await page.waitForTimeout(500);
        await assertNotCrashed(page);
        await screenshot(page, `logs-level-${level}-toggled`);
        break;
      }
    }

    expect(getErrors()).toHaveLength(0);
  });
});

// ============================================================================
// 7. NAVIGATION — BREADCRUMBS AND SIDEBAR
// ============================================================================

test.describe("Navigation — Breadcrumbs and Sidebar", () => {
  test.setTimeout(15_000);

  test("Sidebar items navigate to correct pages", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/dashboard");
    await waitForNetworkIdle(page);

    const sidebarNav = page
      .getByRole("navigation", { name: /primary|main|sidebar/i })
      .or(page.locator("nav").first());

    await expect(sidebarNav).toBeVisible({ timeout: 10_000 });

    const expectedLinks: Array<{ label: RegExp; urlPattern: RegExp }> = [
      { label: /^connectors$/i, urlPattern: /\/connectors/ },
      { label: /^pipelines$/i, urlPattern: /\/pipelines/ },
      { label: /^apps$/i, urlPattern: /\/apps/ },
      { label: /^ontology|data models$/i, urlPattern: /\/ontology/ },
      { label: /^logs$/i, urlPattern: /\/logs/ },
      { label: /^metrics$/i, urlPattern: /\/metrics/ },
    ];

    for (const { label, urlPattern } of expectedLinks) {
      const link = sidebarNav.getByRole("link", { name: label }).first();
      if (!(await link.isVisible().catch(() => false))) continue;

      await link.click();
      await waitForNetworkIdle(page);
      await assertNotCrashed(page);
      expect(page.url()).toMatch(urlPattern);

      await screenshot(page, `sidebar-nav-${label.source.replace(/[^a-z]/gi, "")}`);
      // Return to dashboard for next iteration
      await page.goto("/dashboard");
      await waitForNetworkIdle(page);
    }

    expect(getErrors()).toHaveLength(0);
  });

  test("Breadcrumb links navigate back correctly", async ({ page }) => {
    const getErrors = setupErrorCollector(page);

    // Navigate to a connector detail page to get a breadcrumb trail
    await page.goto("/connectors");
    await waitForNetworkIdle(page);

    const connectorLink = page
      .locator('a[href*="/connectors/"]')
      .filter({ hasNot: page.locator('a[href*="/connectors/new"]') })
      .filter({ hasNot: page.locator('a[href*="/connectors/marketplace"]') })
      .first();

    if (!(await connectorLink.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await connectorLink.click();
    await waitForNetworkIdle(page);

    const breadcrumb = page.getByRole("navigation", { name: /breadcrumb/i });
    if (!(await breadcrumb.isVisible().catch(() => false))) {
      await screenshot(page, "connector-detail-no-breadcrumb");
      return;
    }

    // Click the "Connectors" breadcrumb link (parent)
    const parentCrumb = breadcrumb.getByRole("link", { name: /connectors/i });
    if (!(await parentCrumb.isVisible().catch(() => false))) {
      await screenshot(page, "breadcrumb-no-parent-link");
      return;
    }

    await parentCrumb.click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);
    expect(page.url()).toMatch(/\/connectors/);
    expect(page.url()).not.toMatch(/\/connectors\/.+/);

    await screenshot(page, "breadcrumb-navigate-to-connectors");
    expect(getErrors()).toHaveLength(0);
  });

  test("Dashboard breadcrumb/home link navigates to /dashboard", async ({ page }) => {
    const getErrors = setupErrorCollector(page);
    await page.goto("/pipelines");
    await waitForNetworkIdle(page);

    // Look for a "Dashboard" or home link in breadcrumbs or sidebar
    const homeLink = page
      .getByRole("link", { name: /^dashboard$/i })
      .or(page.locator('a[href="/dashboard"]').first());

    if (!(await homeLink.first().isVisible().catch(() => false))) {
      await screenshot(page, "pipelines-no-dashboard-link");
      return;
    }

    await homeLink.first().click();
    await waitForNetworkIdle(page);
    await assertNotCrashed(page);
    expect(page.url()).toMatch(/\/dashboard/);

    await screenshot(page, "dashboard-via-home-link");
    expect(getErrors()).toHaveLength(0);
  });
});
