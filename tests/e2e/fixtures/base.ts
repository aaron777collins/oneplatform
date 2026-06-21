/**
 * base.ts — Extended Playwright test fixture.
 *
 * Extends the built-in `test` and `expect` with project-specific helpers:
 *
 *   - screenshotHelper: captures full-page screenshots named after the
 *     current test and saves them to tests/e2e/screenshots/current/.
 *   - consoleErrors: collector that accumulates browser console errors
 *     so individual tests can assert against them without duplicating
 *     event-listener wiring.
 *
 * All spec files should import { test, expect } from this module instead of
 * from @playwright/test directly so the custom fixtures are always available.
 */

import { test as base, expect } from "@playwright/test";
import { captureScreenshot } from "../helpers/screenshot.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Convenience wrapper returned by the screenshotHelper fixture. */
export interface ScreenshotHelper {
  /**
   * Take a full-page screenshot.
   *
   * @param label  - Descriptive suffix added to the filename (e.g. "after-login").
   * @param selector - Optional CSS selector to screenshot a single element.
   */
  capture(label?: string, selector?: string): Promise<string>;
}

/** Convenience wrapper returned by the consoleErrors fixture. */
export interface ConsoleErrorCollector {
  /** All console.error() and uncaught-exception messages captured so far. */
  readonly errors: string[];
  /** Assert that no console errors were collected. */
  assertNone(): void;
}

// ---------------------------------------------------------------------------
// Custom fixture type declaration
// ---------------------------------------------------------------------------

interface OnePlatformFixtures {
  screenshotHelper: ScreenshotHelper;
  consoleErrors: ConsoleErrorCollector;
}

// ---------------------------------------------------------------------------
// Extended test
// ---------------------------------------------------------------------------

export const test = base.extend<OnePlatformFixtures>({
  /**
   * screenshotHelper — names screenshots automatically from the current test
   * title and the active project viewport label.
   *
   * Playwright provides the test title via `testInfo.title` and the project
   * name (e.g. "desktop") via `testInfo.project.name`. Both are injected here
   * via the fixture pattern so tests do not need to pass them explicitly.
   */
  // eslint-disable-next-line no-empty-pattern
  screenshotHelper: async ({ page }, use, testInfo) => {
    const helper: ScreenshotHelper = {
      async capture(label = "screenshot", selector?: string): Promise<string> {
        const name = label
          ? `${testInfo.title}-${label}`
          : testInfo.title;
        const viewport = testInfo.project.name;

        const path = await captureScreenshot(page, name, viewport, {
          selector,
          fullPage: true,
        });

        // Attach to the Playwright report so screenshots appear inline in the
        // HTML report without needing to browse the filesystem.
        await testInfo.attach(`${label} (${viewport})`, {
          path,
          contentType: "image/png",
        });

        return path;
      },
    };

    await use(helper);
  },

  /**
   * consoleErrors — wires up a console-error listener before the test body
   * runs, accumulates messages, and tears it down automatically afterward.
   *
   * Tests that want zero console noise can call collector.assertNone() at
   * the end. Tests that expect specific errors can inspect collector.errors.
   */
  // eslint-disable-next-line no-empty-pattern
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];

    // Capture browser-side console.error() calls
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Capture uncaught page errors (thrown exceptions, unhandled rejections)
    page.on("pageerror", (err) => {
      errors.push(`[pageerror] ${err.message}`);
    });

    const collector: ConsoleErrorCollector = {
      get errors() {
        return errors;
      },
      assertNone() {
        // Filter out errors that are known false positives in a mocked
        // environment — e.g. the SSE endpoint returning 200 with no stream
        // data triggers a harmless EventSource parse error in some browsers.
        const realErrors = errors.filter(
          (e) =>
            !e.includes("EventSource") &&
            !e.includes("WebSocket") &&
            // React 18 double-invocation in StrictMode produces dev-only warnings
            !e.includes("Warning:"),
        );

        if (realErrors.length > 0) {
          throw new Error(
            `Expected no console errors but found:\n${realErrors.map((e) => `  • ${e}`).join("\n")}`,
          );
        }
      },
    };

    await use(collector);
  },
});

// Re-export expect unchanged — consumers import from this module only
export { expect };
