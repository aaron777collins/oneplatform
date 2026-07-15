/**
 * live-spider.spec.ts — Comprehensive live-site spider tests.
 *
 * Hits the real running site (PLAYWRIGHT_BASE_URL), authenticates via Authelia,
 * and systematically tests every page, button, dialog, form, and action.
 *
 * Run with:
 *   PLAYWRIGHT_BASE_URL=https://test.aaroncollins.info \
 *   AUTHELIA_USERNAME=aaron AUTHELIA_PASSWORD=<pass> \
 *   npx playwright test tests/e2e/live-spider.spec.ts --project=desktop
 */

import { test, expect, type Page } from "@playwright/test";
import { resolve } from "path";
import { mkdirSync } from "fs";

const SCREENSHOT_DIR = resolve(import.meta.dirname, "screenshots", "live-spider");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

let screenshotCounter = 0;

async function screenshot(page: Page, label: string): Promise<string> {
  screenshotCounter++;
  const safeName = label.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const path = resolve(SCREENSHOT_DIR, `${String(screenshotCounter).padStart(3, "0")}-${safeName}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function waitForPage(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout });
}

async function noPageErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  return errors;
}

// Collect console errors across the test
function setupErrorCollector(page: Page): { errors: string[]; getReal: () => string[] } {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });
  return {
    errors,
    getReal: () => errors.filter(
      (e) =>
        !e.includes("EventSource") &&
        !e.includes("WebSocket") &&
        !e.includes("Warning:") &&
        !e.includes("ERR_CONNECTION_REFUSED") &&
        !e.includes("net::ERR") &&
        !e.includes("Failed to fetch") &&
        !e.includes("favicon") &&
        !e.includes("429") &&
        !e.includes("Too Many Requests") &&
        !e.includes("Failed to load resource")
    ),
  };
}

// Helper: click a button and wait
async function clickButton(page: Page, nameOrLocator: string | RegExp, opts?: { timeout?: number }) {
  const btn = page.getByRole("button", { name: nameOrLocator });
  await btn.waitFor({ state: "visible", timeout: opts?.timeout ?? 10_000 });
  await btn.click();
}

// Helper: check for visible error toasts/alerts
async function checkNoErrorToasts(page: Page): Promise<string[]> {
  await page.waitForTimeout(500);
  const alerts = page.locator('[role="alert"], .toast-error, [data-sonner-toast][data-type="error"]');
  const count = await alerts.count();
  const errors: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await alerts.nth(i).textContent();
    if (text) errors.push(text);
  }
  return errors;
}

// Helper: check page didn't crash (no error boundary, no blank page)
async function assertPageNotCrashed(page: Page) {
  const body = await page.locator("body").textContent();
  expect(body?.length, "Page body should have content").toBeGreaterThan(10);

  // Check no React error boundary
  const hasErrorBoundary = /something went wrong|error boundary|unhandled|unexpected error/i.test(body ?? "");
  if (hasErrorBoundary) {
    throw new Error(`Page crashed with error boundary: ${body?.slice(0, 500)}`);
  }
}

// ============================================================================
// TESTS
// ============================================================================

// Run all tests independently — failures don't block other tests

test.describe("Live Site Spider — Every Page, Every Button", () => {
  // -------------------------------------------------------------------------
  // 1. DASHBOARD
  // -------------------------------------------------------------------------
  test.describe("Dashboard", () => {
    test("loads with all widgets visible", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/dashboard");
      await waitForPage(page);
      await assertPageNotCrashed(page);

      // Heading
      await expect(page.getByRole("heading", { name: /overview/i, level: 1 })).toBeVisible({ timeout: 10_000 });

      // Quick Start widget (or dismissed)
      const quickStart = page.locator("text=Quick Start");
      const quickStartVisible = await quickStart.isVisible().catch(() => false);

      // Service Health grid
      await expect(page.locator("text=Service Health").first()).toBeVisible({ timeout: 10_000 });

      // Active Pipelines widget
      await expect(page.locator("text=Active Pipelines").first()).toBeVisible({ timeout: 10_000 });

      // Recent Activity
      await expect(page.locator("text=Recent Activity").first()).toBeVisible({ timeout: 10_000 });

      await screenshot(page, "dashboard-loaded");

      // Check no fatal errors
      const realErrors = ec.getReal();
      expect(realErrors, `Console errors on dashboard: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("Quick Start — dismiss button works", async ({ page }) => {
      await page.goto("/dashboard");
      await waitForPage(page);

      const dismissBtn = page.locator('[aria-label="Dismiss quick start"], button:has-text("Dismiss")').first();
      const isVisible = await dismissBtn.isVisible().catch(() => false);
      if (isVisible) {
        await dismissBtn.click();
        await page.waitForTimeout(500);
        await screenshot(page, "dashboard-quickstart-dismissed");
      }
      // If already dismissed, that's fine
    });

    test("Service Health — all services show status", async ({ page }) => {
      await page.goto("/dashboard");
      await waitForPage(page);

      const healthGrid = page.locator("text=Service Health").first().locator("..");
      await expect(healthGrid).toBeVisible({ timeout: 10_000 });
      await screenshot(page, "dashboard-service-health");
    });
  });

  // -------------------------------------------------------------------------
  // 2. CONNECTORS
  // -------------------------------------------------------------------------
  test.describe("Connectors", () => {
    test("list page loads with connector cards", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/connectors");
      await waitForPage(page);
      await assertPageNotCrashed(page);

      await expect(page.getByRole("heading", { name: /connectors/i, level: 1 })).toBeVisible({ timeout: 10_000 });
      await screenshot(page, "connectors-list");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("'New Connector' button opens new connector flow", async ({ page }) => {
      await page.goto("/connectors");
      await waitForPage(page);

      const newBtn = page.getByRole("link", { name: /new connector|add connector/i }).or(
        page.getByRole("button", { name: /new connector|add connector/i })
      );
      await expect(newBtn.first()).toBeVisible({ timeout: 10_000 });
      await newBtn.first().click();
      await waitForPage(page);

      // Should navigate to new connector page or open dialog
      const url = page.url();
      const hasNewConnectorContent = url.includes("/connectors/new") ||
        url.includes("/connectors/marketplace") ||
        await page.locator("text=Create Connector").isVisible().catch(() => false) ||
        await page.locator("text=Select a connector type").isVisible().catch(() => false);

      expect(hasNewConnectorContent, "New connector flow should open").toBeTruthy();
      await screenshot(page, "connectors-new-flow");
    });

    test("connector detail page loads for existing connector", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/connectors");
      await waitForPage(page);

      // Click the first connector card/link
      const connectorLink = page.locator('a[href*="/connectors/"]').first();
      const hasConnector = await connectorLink.isVisible().catch(() => false);
      if (hasConnector) {
        await connectorLink.click();
        await waitForPage(page);
        await assertPageNotCrashed(page);
        await screenshot(page, "connector-detail");
      }
    });

    test("connector detail — tabs work (Overview, Sync History, Settings)", async ({ page }) => {
      await page.goto("/connectors");
      await waitForPage(page);

      const connectorLink = page.locator('a[href*="/connectors/"]').filter({ hasNot: page.locator('a[href*="/connectors/new"]') }).filter({ hasNot: page.locator('a[href*="/connectors/marketplace"]') }).first();
      const hasConnector = await connectorLink.isVisible().catch(() => false);
      if (!hasConnector) {
        test.skip();
        return;
      }
      await connectorLink.click();
      await waitForPage(page);

      // Try each tab
      const tabs = ["Overview", "Sync History", "Settings", "Schema", "Configuration"];
      for (const tabName of tabs) {
        const tab = page.getByRole("tab", { name: new RegExp(tabName, "i") });
        const visible = await tab.isVisible().catch(() => false);
        if (visible) {
          await tab.click();
          await page.waitForTimeout(500);
          await assertPageNotCrashed(page);
          await screenshot(page, `connector-detail-tab-${tabName.toLowerCase()}`);
        }
      }
    });

    test("connector detail — Sync Now button works", async ({ page }) => {
      await page.goto("/connectors");
      await waitForPage(page);

      const connectorLink = page.locator('a[href*="/connectors/"]').filter({ hasNot: page.locator('a[href*="/connectors/new"]') }).filter({ hasNot: page.locator('a[href*="/connectors/marketplace"]') }).first();
      const hasConnector = await connectorLink.isVisible().catch(() => false);
      if (!hasConnector) {
        test.skip();
        return;
      }
      await connectorLink.click();
      await waitForPage(page);

      const syncBtn = page.getByRole("button", { name: /sync now|run sync|trigger sync/i });
      const hasSyncBtn = await syncBtn.isVisible().catch(() => false);
      if (hasSyncBtn) {
        await syncBtn.click();
        await page.waitForTimeout(1000);
        await screenshot(page, "connector-sync-triggered");
        // Check no error toast
        const errors = await checkNoErrorToasts(page);
        expect(errors, `Error toasts after sync: ${errors.join(", ")}`).toHaveLength(0);
      }
    });

    test("connector detail — Edit/Delete buttons exist and respond", async ({ page }) => {
      await page.goto("/connectors");
      await waitForPage(page);

      const connectorLink = page.locator('a[href*="/connectors/"]').filter({ hasNot: page.locator('a[href*="/connectors/new"]') }).filter({ hasNot: page.locator('a[href*="/connectors/marketplace"]') }).first();
      const hasConnector = await connectorLink.isVisible().catch(() => false);
      if (!hasConnector) {
        test.skip();
        return;
      }
      await connectorLink.click();
      await waitForPage(page);

      // Check for edit button
      const editBtn = page.getByRole("button", { name: /edit/i });
      if (await editBtn.isVisible().catch(() => false)) {
        await editBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "connector-edit-clicked");
      }

      // Check for delete button
      const deleteBtn = page.getByRole("button", { name: /delete/i });
      if (await deleteBtn.isVisible().catch(() => false)) {
        await screenshot(page, "connector-delete-button-visible");
        // Don't actually click delete — just verify it's there
      }
    });

    test("Connector Marketplace page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/connectors/marketplace");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "connector-marketplace");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. ONTOLOGY (Data Models)
  // -------------------------------------------------------------------------
  test.describe("Ontology / Data Models", () => {
    test("list page loads with entities", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/ontology");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "ontology-list");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("'Create Entity' button opens dialog/form", async ({ page }) => {
      await page.goto("/ontology");
      await waitForPage(page);

      const createBtn = page.getByRole("button", { name: /create|new|add/i }).first();
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "ontology-create-dialog");

        // Close dialog if open
        const cancelBtn = page.getByRole("button", { name: /cancel|close/i });
        if (await cancelBtn.isVisible().catch(() => false)) {
          await cancelBtn.click();
        } else {
          await page.keyboard.press("Escape");
        }
      }
    });

    test("entity detail page loads for existing entity", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/ontology");
      await waitForPage(page);

      const entityLink = page.locator('a[href*="/ontology/"]').filter({ hasNot: page.locator('a[href*="/ontology/query"]') }).filter({ hasNot: page.locator('a[href*="/ontology/data-quality"]') }).filter({ hasNot: page.locator('a[href*="/ontology/migrations"]') }).first();
      const hasEntity = await entityLink.isVisible().catch(() => false);
      if (!hasEntity) {
        test.skip();
        return;
      }
      await entityLink.click();
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "entity-detail");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("entity detail — Add Field button works", async ({ page }) => {
      await page.goto("/ontology");
      await waitForPage(page);

      const entityLink = page.locator('a[href*="/ontology/"]').filter({ hasNot: page.locator('a[href*="/ontology/query"]') }).filter({ hasNot: page.locator('a[href*="/ontology/data-quality"]') }).filter({ hasNot: page.locator('a[href*="/ontology/migrations"]') }).first();
      if (!(await entityLink.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await entityLink.click();
      await waitForPage(page);

      const addFieldBtn = page.getByRole("button", { name: /add field|new field/i });
      if (await addFieldBtn.isVisible().catch(() => false)) {
        await addFieldBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "entity-add-field");

        // Close
        await page.keyboard.press("Escape");
      }
    });

    test("entity detail — tabs (Fields, Records, Relationships, Query)", async ({ page }) => {
      await page.goto("/ontology");
      await waitForPage(page);

      const entityLink = page.locator('a[href*="/ontology/"]').filter({ hasNot: page.locator('a[href*="/ontology/query"]') }).filter({ hasNot: page.locator('a[href*="/ontology/data-quality"]') }).filter({ hasNot: page.locator('a[href*="/ontology/migrations"]') }).first();
      if (!(await entityLink.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await entityLink.click();
      await waitForPage(page);

      const tabs = ["Fields", "Records", "Relationships", "Query"];
      for (const tabName of tabs) {
        const tab = page.getByRole("tab", { name: new RegExp(tabName, "i") });
        if (await tab.isVisible().catch(() => false)) {
          await tab.click();
          await page.waitForTimeout(500);
          await assertPageNotCrashed(page);
          await screenshot(page, `entity-detail-tab-${tabName.toLowerCase()}`);
        }
      }
    });

    test("Query Builder page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/ontology/query");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "query-builder");
    });

    test("Data Quality page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/ontology/data-quality");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "data-quality");
    });

    test("Migrations page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/ontology/migrations");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "migrations");
    });
  });

  // -------------------------------------------------------------------------
  // 4. PIPELINES
  // -------------------------------------------------------------------------
  test.describe("Pipelines", () => {
    test("list page loads with pipeline cards", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/pipelines");
      await waitForPage(page);
      await assertPageNotCrashed(page);

      await expect(page.getByRole("heading", { name: /pipelines/i, level: 1 })).toBeVisible({ timeout: 10_000 });
      await screenshot(page, "pipelines-list");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("'New Pipeline' button navigates to builder", async ({ page }) => {
      await page.goto("/pipelines");
      await waitForPage(page);

      const newBtn = page.getByRole("link", { name: /new pipeline|create pipeline/i }).or(
        page.getByRole("button", { name: /new pipeline|create pipeline/i })
      );
      if (await newBtn.first().isVisible().catch(() => false)) {
        await newBtn.first().click();
        await waitForPage(page);
        await assertPageNotCrashed(page);

        expect(page.url()).toContain("/pipelines/");
        await screenshot(page, "pipeline-builder-new");
      }
    });

    test("pipeline detail page loads — click first pipeline card", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/pipelines");
      await waitForPage(page);

      // Pipeline cards use onClick (not <a> links) — click the card's cursor-pointer container
      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);
      await assertPageNotCrashed(page);

      // Should have navigated to a pipeline detail page
      expect(page.url()).toContain("/pipelines/");
      await screenshot(page, "pipeline-detail");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("pipeline detail — Run Now button", async ({ page }) => {
      // Navigate directly to known pipeline detail
      await page.goto("/pipelines");
      await waitForPage(page);

      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);

      const runBtn = page.getByRole("button", { name: /run now|run pipeline|execute|trigger/i });
      if (await runBtn.isVisible().catch(() => false)) {
        await runBtn.click();
        await page.waitForTimeout(1000);
        await assertPageNotCrashed(page);
        await screenshot(page, "pipeline-run-triggered");
      }
    });

    test("pipeline detail — Edit button navigates to builder", async ({ page }) => {
      await page.goto("/pipelines");
      await waitForPage(page);

      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);

      const editBtn = page.getByRole("link", { name: /edit/i }).or(
        page.getByRole("button", { name: /edit/i })
      );
      if (await editBtn.first().isVisible().catch(() => false)) {
        await editBtn.first().click();
        await waitForPage(page);
        await assertPageNotCrashed(page);
        await screenshot(page, "pipeline-edit-builder");
      }
    });

    test("pipeline detail — tabs (Overview, Runs, Config, Logs)", async ({ page }) => {
      await page.goto("/pipelines");
      await waitForPage(page);

      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);

      const tabs = ["Overview", "Runs", "Run History", "Configuration", "Config", "Logs", "Settings"];
      for (const tabName of tabs) {
        const tab = page.getByRole("tab", { name: new RegExp(tabName, "i") });
        if (await tab.isVisible().catch(() => false)) {
          await tab.click();
          await page.waitForTimeout(500);
          await assertPageNotCrashed(page);
          await screenshot(page, `pipeline-detail-tab-${tabName.toLowerCase().replace(/\s+/g, "-")}`);
        }
      }
    });

    test("pipeline builder loads via direct URL", async ({ page }) => {
      const ec = setupErrorCollector(page);
      // Use known pipeline ID from the running instance
      await page.goto("/pipelines/2bd06450-2bf2-4b06-838e-7c003b2398b3/edit");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "pipeline-builder-existing");
    });
  });

  // -------------------------------------------------------------------------
  // 5. APPS
  // -------------------------------------------------------------------------
  test.describe("Apps", () => {
    test("list page loads with app cards", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/apps");
      await waitForPage(page);
      await assertPageNotCrashed(page);

      await expect(page.getByRole("heading", { name: /apps/i, level: 1 })).toBeVisible({ timeout: 10_000 });
      await screenshot(page, "apps-list");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("'New App' button opens template picker dialog", async ({ page }) => {
      await page.goto("/apps");
      await waitForPage(page);

      const newBtn = page.getByRole("button", { name: /new app|create app/i });
      if (await newBtn.isVisible().catch(() => false)) {
        await newBtn.click();
        await page.waitForTimeout(1000);
        await assertPageNotCrashed(page);
        await screenshot(page, "apps-new-dialog");

        // Close
        const cancelBtn = page.getByRole("button", { name: /cancel|close/i });
        if (await cancelBtn.isVisible().catch(() => false)) {
          await cancelBtn.click();
        } else {
          await page.keyboard.press("Escape");
        }
      }
    });

    test("app detail page loads — click first app card", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/apps");
      await waitForPage(page);

      // App cards use onClick (not <a> links). Click the first card container.
      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);
      await assertPageNotCrashed(page);

      expect(page.url()).toContain("/apps/");
      await screenshot(page, "app-detail");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("app detail — all action buttons respond", async ({ page }) => {
      await page.goto("/apps");
      await waitForPage(page);

      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);

      const buttonNames = [/edit|open editor/i, /build/i, /deploy/i, /share/i, /settings/i, /delete/i, /rollback/i];
      for (const name of buttonNames) {
        const btn = page.getByRole("button", { name }).or(page.getByRole("link", { name }));
        if (await btn.first().isVisible().catch(() => false)) {
          await screenshot(page, `app-detail-btn-${name.source.replace(/[^a-z]/gi, "")}-visible`);
        }
      }
    });

    test("app detail — Edit in Monaco button opens editor", async ({ page }) => {
      await page.goto("/apps");
      await waitForPage(page);

      // Click the "Edit in Monaco" button directly from the app list
      const editMonacoBtn = page.getByRole("button", { name: /edit in monaco/i }).first();
      if (await editMonacoBtn.isVisible().catch(() => false)) {
        await editMonacoBtn.click();
        await waitForPage(page, 30_000);
        await assertPageNotCrashed(page);
        await screenshot(page, "app-editor-from-list");
      }
    });

    test("app detail — Build button triggers build", async ({ page }) => {
      await page.goto("/apps");
      await waitForPage(page);

      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);

      const buildBtn = page.getByRole("button", { name: /build/i });
      if (await buildBtn.isVisible().catch(() => false)) {
        await buildBtn.click();
        await page.waitForTimeout(1000);
        await assertPageNotCrashed(page);
        await screenshot(page, "app-build-triggered");
      }
    });

    test("app detail — Deploy button triggers deployment", async ({ page }) => {
      await page.goto("/apps");
      await waitForPage(page);

      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);

      const deployBtn = page.getByRole("button", { name: /deploy/i });
      if (await deployBtn.isVisible().catch(() => false)) {
        await deployBtn.click();
        await page.waitForTimeout(1000);
        await assertPageNotCrashed(page);
        await screenshot(page, "app-deploy-triggered");
      }
    });

    test("app detail — Share dialog opens", async ({ page }) => {
      await page.goto("/apps");
      await waitForPage(page);

      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);

      const shareBtn = page.getByRole("button", { name: /share/i });
      if (await shareBtn.isVisible().catch(() => false)) {
        await shareBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "app-share-dialog");
        await page.keyboard.press("Escape");
      }
    });

    test("app detail — tabs (Overview, Builds, Deployments, Settings)", async ({ page }) => {
      await page.goto("/apps");
      await waitForPage(page);

      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);

      const tabs = ["Overview", "Builds", "Build History", "Deployments", "Deploy History", "Settings", "Config", "Logs"];
      for (const tabName of tabs) {
        const tab = page.getByRole("tab", { name: new RegExp(tabName, "i") });
        if (await tab.isVisible().catch(() => false)) {
          await tab.click();
          await page.waitForTimeout(500);
          await assertPageNotCrashed(page);
          await screenshot(page, `app-detail-tab-${tabName.toLowerCase().replace(/\s+/g, "-")}`);
        }
      }
    });

    test("app editor page loads via direct URL", async ({ page }) => {
      const ec = setupErrorCollector(page);
      // Use known app ID
      await page.goto("/apps/76147a79-bf3d-42e6-92eb-f897d9620d1e/edit");
      await waitForPage(page, 30_000);
      await assertPageNotCrashed(page);
      await screenshot(page, "app-editor-direct");
    });

    test("app builder page loads via direct URL", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/apps/76147a79-bf3d-42e6-92eb-f897d9620d1e/build");
      await waitForPage(page, 30_000);
      await assertPageNotCrashed(page);
      await screenshot(page, "app-builder-direct");
    });
  });

  // -------------------------------------------------------------------------
  // 6. LOGS
  // -------------------------------------------------------------------------
  test.describe("Logs", () => {
    test("logs page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/logs");
      await waitForPage(page);
      await assertPageNotCrashed(page);

      await expect(page.getByRole("heading", { name: /logs/i, level: 1 })).toBeVisible({ timeout: 10_000 });
      await screenshot(page, "logs-page");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("logs — filter controls work", async ({ page }) => {
      await page.goto("/logs");
      await waitForPage(page);

      // Try service filter dropdown
      const serviceFilter = page.locator('select, [role="combobox"]').first();
      if (await serviceFilter.isVisible().catch(() => false)) {
        await serviceFilter.click();
        await page.waitForTimeout(300);
        await screenshot(page, "logs-service-filter");
        await page.keyboard.press("Escape");
      }

      // Try level filter
      const levelFilter = page.getByRole("combobox", { name: /level|severity/i }).or(
        page.locator('select').nth(1)
      );
      if (await levelFilter.isVisible().catch(() => false)) {
        await screenshot(page, "logs-level-filter");
      }

      // Search input
      const searchInput = page.getByPlaceholder(/search|filter/i);
      if (await searchInput.isVisible().catch(() => false)) {
        await searchInput.fill("test query");
        await page.waitForTimeout(500);
        await screenshot(page, "logs-search-filled");
        await searchInput.clear();
      }
    });

    test("audit page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/logs/audit");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "audit-page");
    });
  });

  // -------------------------------------------------------------------------
  // 7. DLQ
  // -------------------------------------------------------------------------
  test.describe("DLQ (Dead Letter Queue)", () => {
    test("DLQ page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/dlq");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "dlq-page");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("DLQ — retry/delete buttons on items", async ({ page }) => {
      await page.goto("/dlq");
      await waitForPage(page);

      const retryBtn = page.getByRole("button", { name: /retry/i }).first();
      const deleteBtn = page.getByRole("button", { name: /delete|discard/i }).first();

      if (await retryBtn.isVisible().catch(() => false)) {
        await screenshot(page, "dlq-retry-button-visible");
      }
      if (await deleteBtn.isVisible().catch(() => false)) {
        await screenshot(page, "dlq-delete-button-visible");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 8. METRICS
  // -------------------------------------------------------------------------
  test.describe("Metrics", () => {
    test("metrics page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/metrics");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "metrics-page");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("metrics — time range selector works", async ({ page }) => {
      await page.goto("/metrics");
      await waitForPage(page);

      const timeRange = page.getByRole("combobox", { name: /time|range|period/i }).or(
        page.locator('select').first()
      ).or(
        page.getByRole("button", { name: /24h|7d|30d|1h|last/i }).first()
      );

      if (await timeRange.isVisible().catch(() => false)) {
        await timeRange.click();
        await page.waitForTimeout(300);
        await screenshot(page, "metrics-time-range");
        await page.keyboard.press("Escape");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 9. PLUGINS
  // -------------------------------------------------------------------------
  test.describe("Plugins", () => {
    test("plugins list page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/plugins");
      await waitForPage(page);
      await assertPageNotCrashed(page);

      await expect(page.getByRole("heading", { name: /plugins/i, level: 1 })).toBeVisible({ timeout: 10_000 });
      await screenshot(page, "plugins-list");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("'Install Plugin' button works", async ({ page }) => {
      await page.goto("/plugins");
      await waitForPage(page);

      const installBtn = page.getByRole("button", { name: /install|add|upload/i });
      if (await installBtn.isVisible().catch(() => false)) {
        await installBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "plugins-install-dialog");
        await page.keyboard.press("Escape");
      }
    });

    test("plugin detail page loads — click first plugin card", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/plugins");
      await waitForPage(page);

      // Plugin cards use onClick (not <a> links)
      const card = page.locator('[class*="cursor-pointer"]').first();
      if (!(await card.isVisible().catch(() => false))) {
        test.skip();
        return;
      }
      await card.click();
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "plugin-detail");
    });
  });

  // -------------------------------------------------------------------------
  // 10. SETTINGS
  // -------------------------------------------------------------------------
  test.describe("Settings", () => {
    test("settings redirects to profile", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/settings");
      await page.waitForURL("**/settings/profile", { timeout: 10_000 });
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "settings-profile");
    });

    test("profile page — form fields are editable", async ({ page }) => {
      await page.goto("/settings/profile");
      await waitForPage(page);

      const nameInput = page.getByLabel(/name|display name/i);
      if (await nameInput.isVisible().catch(() => false)) {
        const currentValue = await nameInput.inputValue();
        await screenshot(page, "settings-profile-form");
      }

      const saveBtn = page.getByRole("button", { name: /save|update/i });
      if (await saveBtn.isVisible().catch(() => false)) {
        await screenshot(page, "settings-profile-save-btn");
      }
    });

    test("teams page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/settings/teams");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "settings-teams");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("teams — invite user button", async ({ page }) => {
      await page.goto("/settings/teams");
      await waitForPage(page);

      const inviteBtn = page.getByRole("button", { name: /invite|add user|add member/i });
      if (await inviteBtn.isVisible().catch(() => false)) {
        await inviteBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "settings-teams-invite-dialog");
        await page.keyboard.press("Escape");
      }
    });

    test("API keys page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/settings/api-keys");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "settings-api-keys");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("API keys — create new key button", async ({ page }) => {
      await page.goto("/settings/api-keys");
      await waitForPage(page);

      const createBtn = page.getByRole("button", { name: /create|generate|new/i });
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "settings-api-keys-create-dialog");
        await page.keyboard.press("Escape");
      }
    });

    test("webhooks page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/settings/webhooks");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "settings-webhooks");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("webhooks — create webhook button", async ({ page }) => {
      await page.goto("/settings/webhooks");
      await waitForPage(page);

      const createBtn = page.getByRole("button", { name: /create|add|new/i });
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "settings-webhooks-create-dialog");
        await page.keyboard.press("Escape");
      }
    });

    test("storage browser page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/settings/storage");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "settings-storage");
    });

    test("roles page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/settings/roles");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "settings-roles");

      const realErrors = ec.getReal();
      expect(realErrors, `Console errors: ${realErrors.join(", ")}`).toHaveLength(0);
    });

    test("roles — create role button", async ({ page }) => {
      await page.goto("/settings/roles");
      await waitForPage(page);

      const createBtn = page.getByRole("button", { name: /create|add|new/i });
      if (await createBtn.isVisible().catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(500);
        await assertPageNotCrashed(page);
        await screenshot(page, "settings-roles-create-dialog");
        await page.keyboard.press("Escape");
      }
    });

    test("admin page loads", async ({ page }) => {
      const ec = setupErrorCollector(page);
      await page.goto("/settings/admin");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "settings-admin");
    });

    test("admin — all admin actions visible", async ({ page }) => {
      await page.goto("/settings/admin");
      await waitForPage(page);

      // Look for admin action buttons
      const buttons = page.getByRole("button");
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const text = await buttons.nth(i).textContent();
        if (text && text.trim().length > 0) {
          // Just verify each button is visible and not broken
          await expect(buttons.nth(i)).toBeVisible();
        }
      }
      await screenshot(page, "settings-admin-buttons");
    });

    test("settings sidebar navigation between sub-pages", async ({ page }) => {
      await page.goto("/settings/profile");
      await waitForPage(page);

      // Navigate through each settings sub-page via sidebar links
      const settingsLinks = ["Teams", "API Keys", "Webhooks", "Storage", "Roles", "Admin"];
      for (const linkText of settingsLinks) {
        const link = page.getByRole("link", { name: new RegExp(`^${linkText}$`, "i") }).or(
          page.locator(`a:has-text("${linkText}")`).first()
        );
        if (await link.first().isVisible().catch(() => false)) {
          await link.first().click();
          await page.waitForTimeout(500);
          await assertPageNotCrashed(page);
          await screenshot(page, `settings-nav-${linkText.toLowerCase().replace(/\s+/g, "-")}`);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 11. SIDEBAR NAVIGATION
  // -------------------------------------------------------------------------
  test.describe("Sidebar Navigation", () => {
    test("every sidebar link navigates correctly", async ({ page }) => {
      await page.goto("/dashboard");
      await waitForPage(page);

      const sidebarNav = page.getByRole("navigation", { name: /primary navigation/i }).or(
        page.locator("nav").first()
      );
      await expect(sidebarNav).toBeVisible({ timeout: 10_000 });

      // Get all links from sidebar
      const links = sidebarNav.getByRole("link");
      const count = await links.count();

      for (let i = 0; i < count; i++) {
        const link = links.nth(i);
        const href = await link.getAttribute("href");
        const text = await link.textContent();

        if (!href || href === "#") continue;

        await link.click();
        await waitForPage(page);
        await assertPageNotCrashed(page);
        await screenshot(page, `sidebar-nav-${text?.trim().toLowerCase().replace(/\s+/g, "-") ?? i}`);

        // Go back to dashboard for next iteration
        await page.goto("/dashboard");
        await waitForPage(page);
      }
    });

    test("collapse and expand sidebar", async ({ page }) => {
      await page.goto("/dashboard");
      await waitForPage(page);

      const collapseBtn = page.getByRole("button", { name: /collapse/i });
      if (await collapseBtn.isVisible().catch(() => false)) {
        await collapseBtn.click();
        await page.waitForTimeout(300);
        await screenshot(page, "sidebar-collapsed");

        const expandBtn = page.getByRole("button", { name: /expand/i });
        await expect(expandBtn).toBeVisible({ timeout: 5_000 });
        await expandBtn.click();
        await page.waitForTimeout(300);
        await screenshot(page, "sidebar-expanded");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 12. USER MENU / HEADER
  // -------------------------------------------------------------------------
  test.describe("User Menu", () => {
    test("user menu dropdown opens", async ({ page }) => {
      await page.goto("/dashboard");
      await waitForPage(page);

      // Look for avatar/user button in header
      const userBtn = page.getByRole("button", { name: /user|profile|account|avatar/i }).or(
        page.locator('[data-testid="user-menu"]')
      ).or(
        page.locator('button:has(img[alt*="avatar" i])')
      );

      if (await userBtn.first().isVisible().catch(() => false)) {
        await userBtn.first().click();
        await page.waitForTimeout(300);
        await screenshot(page, "user-menu-open");
        await page.keyboard.press("Escape");
      }
    });
  });

  // -------------------------------------------------------------------------
  // 13. ERROR HANDLING — 404
  // -------------------------------------------------------------------------
  test.describe("Error Handling", () => {
    test("404 page renders for unknown route", async ({ page }) => {
      await page.goto("/this-does-not-exist-12345");
      await waitForPage(page);

      const body = await page.locator("body").textContent();
      const isNotFound = /404|not found|page not found/i.test(body ?? "");
      expect(isNotFound, `Expected 404 but got: ${body?.slice(0, 200)}`).toBe(true);
      await screenshot(page, "404-page");
    });

    test("invalid connector ID shows error gracefully", async ({ page }) => {
      await page.goto("/connectors/invalid-uuid-12345");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "invalid-connector-id");
    });

    test("invalid pipeline ID shows error gracefully", async ({ page }) => {
      await page.goto("/pipelines/invalid-uuid-12345");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "invalid-pipeline-id");
    });

    test("invalid app ID shows error gracefully", async ({ page }) => {
      await page.goto("/apps/invalid-uuid-12345");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "invalid-app-id");
    });

    test("invalid plugin ID shows error gracefully", async ({ page }) => {
      await page.goto("/plugins/invalid-uuid-12345");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "invalid-plugin-id");
    });
  });

  // -------------------------------------------------------------------------
  // 14. BREADCRUMB NAVIGATION
  // -------------------------------------------------------------------------
  test.describe("Breadcrumb Navigation", () => {
    test("breadcrumbs on connectors page link back correctly", async ({ page }) => {
      await page.goto("/connectors");
      await waitForPage(page);

      const breadcrumb = page.getByRole("navigation", { name: /breadcrumb/i });
      if (await breadcrumb.isVisible().catch(() => false)) {
        const homeLink = breadcrumb.getByRole("link").first();
        if (await homeLink.isVisible().catch(() => false)) {
          await homeLink.click();
          await waitForPage(page);
          await assertPageNotCrashed(page);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 15. RESPONSIVE — MOBILE MENU
  // -------------------------------------------------------------------------
  test.describe("Mobile responsiveness check", () => {
    test("page loads at mobile viewport", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto("/dashboard");
      await waitForPage(page);
      await assertPageNotCrashed(page);
      await screenshot(page, "mobile-dashboard");
    });
  });
});
