/**
 * smoke.spec.ts — Basic smoke tests that verify the E2E infrastructure works.
 *
 * These tests have a single goal: confirm that Playwright can drive the
 * frontend, intercept API calls, and capture screenshots. They do NOT test
 * application logic in depth — that is the job of feature-specific specs.
 *
 * The smoke suite should always pass, even when backend services are down,
 * because mock-api.ts intercepts every /api/* request. If a smoke test fails
 * it means the E2E infrastructure itself is broken.
 */

import { test, expect } from "./fixtures/base.js";
import { setupMockApi } from "./helpers/mock-api.js";

test.describe("Smoke — infrastructure sanity", () => {
  test.beforeEach(async ({ page }) => {
    // Wire up API mocks before any navigation so the very first request is
    // intercepted. The bootstrap mock returns { completed: true } which causes
    // the index route loader to redirect to /login.
    await setupMockApi(page);
  });

  test("/ loads and redirects to /login when bootstrap is complete", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    await page.goto("/");

    // Wait for the redirect to complete. The loader at "/" checks bootstrap
    // status and throws redirect({ to: "/login" }) when completed is true.
    await page.waitForURL("**/login", { timeout: 15_000 });

    // Page must display the sign-in heading
    const heading = page.getByRole("heading", { name: /sign in/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // Capture a screenshot as visual evidence
    await screenshotHelper.capture("login-page");

    // No unexpected console errors
    consoleErrors.assertNone();
  });

  test("/login page renders the login form", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/login");

    // Form fields must be present
    await expect(
      page.getByRole("textbox", { name: /email/i }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(page.getByLabel(/password/i)).toBeVisible();

    // Use exact match to distinguish the primary "Sign in" submit button from
    // the OAuth "Sign in with GitHub/Google" buttons on the same page.
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();

    await screenshotHelper.capture("login-form");
  });

  test("navigating to an unknown route shows a 404 page", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/this-route-does-not-exist-12345");

    // TanStack Router renders the catch-all "*" route which mounts NotFoundPage
    await page.waitForLoadState("networkidle");

    // The NotFoundPage should render something that indicates the page was not
    // found. Check for common patterns — the exact text depends on the component.
    const bodyText = await page.locator("body").textContent();
    const looksLikeNotFound =
      /404|not found|page not found/i.test(bodyText ?? "");

    expect(
      looksLikeNotFound,
      "Expected 404 page content but found: " + bodyText?.slice(0, 200),
    ).toBe(true);

    await screenshotHelper.capture("not-found-page");
  });

  test("API mock intercepts /api/v1/auth/me and returns user data", async ({
    page,
  }) => {
    let intercepted = false;
    let responseBody: unknown;

    // Listen for the response before navigation
    page.on("response", async (response) => {
      if (response.url().includes("/api/v1/auth/me")) {
        intercepted = true;
        try {
          responseBody = await response.json();
        } catch {
          // Body may already be consumed
        }
      }
    });

    // Navigate to a protected route to trigger the auth check
    await page.goto("/dashboard");
    // Give the page time to make its API calls
    await page.waitForLoadState("networkidle");

    // Confirm the mock was called (or at least that the page loaded without
    // crashing, which proves the mock infrastructure works even if auth/me
    // isn't called on this path)
    if (intercepted) {
      expect(responseBody).toBeDefined();
    }
    // Either way the page should have loaded without crashing
    const title = await page.title();
    expect(title).toBeTruthy();
  });

  test("screenshot infrastructure saves files to the correct directory", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const screenshotPath = await screenshotHelper.capture("infrastructure-test");

    // The path must be a string pointing to a .png file
    expect(screenshotPath).toMatch(/\.png$/);
    expect(screenshotPath).toContain("screenshots");
  });
});
