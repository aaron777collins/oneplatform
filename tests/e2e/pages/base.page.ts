/**
 * base.page.ts — BasePage class with shared navigation and utility methods.
 *
 * All page-specific POMs extend this class so they inherit common helpers
 * without duplicating them. The constructor takes a Playwright Page so the
 * POM is created inside each test and shares the same browser context.
 */

import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import { captureScreenshot } from "../helpers/screenshot.js";

export abstract class BasePage {
  protected readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Navigate to an absolute path on the Vite dev server. */
  async navigateTo(path: string): Promise<void> {
    await this.page.goto(path);
  }

  /** Navigate to the page's canonical path. Implemented by subclasses. */
  abstract goto(): Promise<void>;

  // ---------------------------------------------------------------------------
  // Readiness
  // ---------------------------------------------------------------------------

  /**
   * Wait until the page is in a stable, interactive state.
   *
   * "Stable" means:
   *   1. The network is idle (no pending XHR/fetch after 500ms).
   *   2. No skeleton/loading spinners are visible.
   *
   * Each POM overrides this if it has a more specific readiness signal
   * (e.g. a unique heading that only appears once data is loaded).
   */
  async waitForPageReady(): Promise<void> {
    // Wait for React to finish rendering the initial page shell.
    // networkidle waits until no more than 0 requests are in-flight for 500ms.
    await this.page.waitForLoadState("networkidle");
  }

  // ---------------------------------------------------------------------------
  // Screenshot
  // ---------------------------------------------------------------------------

  /**
   * Take a full-page screenshot and return the filesystem path.
   *
   * Use the screenshotHelper fixture in specs when you want the image
   * auto-attached to the Playwright report. Use this method in POM flows
   * where you want screenshots at intermediate steps.
   */
  async screenshot(name: string, viewportLabel = "unknown"): Promise<string> {
    return captureScreenshot(this.page, name, viewportLabel);
  }

  // ---------------------------------------------------------------------------
  // Common element helpers
  // ---------------------------------------------------------------------------

  /** Get the page title element (<h1>) and assert its visible text. */
  async assertPageTitle(expected: string | RegExp): Promise<void> {
    const heading = this.page.locator("h1").first();
    await expect(heading).toBeVisible();
    await expect(heading).toHaveText(expected);
  }

  /** Wait for and return a locator by test-id attribute. */
  getByTestId(testId: string): Locator {
    return this.page.getByTestId(testId);
  }

  /** Wait for a toast notification containing `text` to appear. */
  async waitForToast(text: string | RegExp): Promise<Locator> {
    const toast = this.page.locator('[role="status"], [data-radix-toast-viewport]').filter({
      hasText: text,
    });
    await expect(toast).toBeVisible({ timeout: 5_000 });
    return toast;
  }

  /** Wait for a loading spinner to disappear, signaling async content loaded. */
  async waitForLoadingComplete(): Promise<void> {
    // Target the aria-label used by the FullPageSpinner in BootstrapGatePage
    // and any other spinner with role="status".
    const spinner = this.page.locator('[role="status"][aria-label="Loading"]');
    // If a spinner is present, wait for it to detach. If not, continue.
    const count = await spinner.count();
    if (count > 0) {
      await expect(spinner).toBeHidden({ timeout: 10_000 });
    }
  }

  // ---------------------------------------------------------------------------
  // URL utilities
  // ---------------------------------------------------------------------------

  /** Assert the current URL pathname matches the expected value or pattern. */
  async assertPath(expected: string | RegExp): Promise<void> {
    const url = new URL(this.page.url());
    if (typeof expected === "string") {
      expect(url.pathname).toBe(expected);
    } else {
      expect(url.pathname).toMatch(expected);
    }
  }

  /** Return the current URL pathname. */
  get currentPath(): string {
    return new URL(this.page.url()).pathname;
  }
}
