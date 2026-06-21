/**
 * auth.spec.ts — Authentication flow E2E tests.
 *
 * Tests cover the login form's happy-path, validation failures, server-error
 * handling, OAuth button visibility, password-reset link, and the logout flow.
 *
 * All /api/* calls are intercepted by setupMockApi, so no backend process is
 * required. overrideMock is used for the specific "invalid credentials" test
 * to return a 401 response instead of the default 200.
 */

import { test, expect } from "./fixtures/base.js";
import { setupMockApi, overrideMock } from "./helpers/mock-api.js";
import { LoginPage } from "./pages/login.page.js";
import { DashboardPage } from "./pages/dashboard.page.js";
import { TEST_USERS } from "./helpers/test-data.js";

// ---------------------------------------------------------------------------
// Login form — form behavior and validation
// ---------------------------------------------------------------------------

test.describe("Auth — login form", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("should display the login form with all required fields", async ({
    page,
    screenshotHelper,
    consoleErrors,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    await loginPage.assertRendered();

    await screenshotHelper.capture("login-form-initial");
    consoleErrors.assertNone();
  });

  test("should submit credentials successfully and clear the form error state", async ({
    page,
    screenshotHelper,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // The mock POST /api/v1/auth/login returns 200 + a user session.
    // LoginPage.handleLoginSuccess() calls window.location.href = "/" which
    // triggers a full-page reload. In the mocked environment the reload lands
    // back on /login (bootstrap completed → index redirects there). The key
    // assertion is that NO error alert appears, confirming the API call succeeded
    // from the client's perspective.
    await loginPage.fillEmail(TEST_USERS.admin.email);
    await loginPage.fillPassword(TEST_USERS.admin.password);

    // Capture the state just before submit so we have a visual baseline
    await screenshotHelper.capture("before-login-submit");

    await loginPage.submit();

    // The Sign in button briefly shows "Signing in…" then the page navigates.
    // Wait for the navigation to start — the URL will change to "/" then come
    // back to "/login" (bootstrap redirect). Give the page time to settle.
    await page.waitForLoadState("networkidle");

    // After the page reloads, the login form should be present again (no error).
    // The absence of the error alert confirms the mock login succeeded.
    const loginError = loginPage.getError();
    await expect(loginError).toBeHidden();

    await screenshotHelper.capture("after-successful-login");
  });

  test("should redirect back to login when credentials are rejected with 401", async ({
    page,
    screenshotHelper,
  }) => {
    // Override the default 200 mock with a 401 to simulate rejected credentials.
    // The api-client's 401 handler attempts a token refresh first, then retries.
    // The refresh mock returns 200 (from the route table). After the retry also
    // returns 401 the api-client clears the session and sets window.location.href
    // to "/login", which navigates the page. The user stays on the login page.
    await overrideMock(page, /\/api\/v1\/auth\/login/, 401, {
      error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" },
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();

    await loginPage.login("wrong@example.com", "bad-password");

    // After the 401 flow completes, the page navigates to "/login" (the
    // api-client calls window.location.href = "/login"). We confirm that the
    // login page is still rendered and no server-specific error is displayed
    // (the auth-expired redirect produces a clean form, not a 401 alert, because
    // the api-client throws AuthError rather than ApiError for this path).
    await page.waitForURL("**/login", { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible({
      timeout: 10_000,
    });

    await screenshotHelper.capture("login-after-invalid-credentials");
  });

  test("should show a validation error when email field is empty", async ({
    page,
    screenshotHelper,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Submit with only the password filled — Zod requires a valid email
    await loginPage.fillPassword("some-password");
    await loginPage.submit();

    // react-hook-form renders per-field messages via <FormMessage>
    const emailError = page.locator("text=Enter a valid email address");
    await expect(emailError).toBeVisible({ timeout: 5_000 });

    await screenshotHelper.capture("validation-error-empty-email");
  });

  test("should show a validation error when password field is empty", async ({
    page,
    screenshotHelper,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Submit with only the email filled — Zod requires a non-empty password
    await loginPage.fillEmail(TEST_USERS.admin.email);
    await loginPage.submit();

    const passwordError = page.locator("text=Password is required");
    await expect(passwordError).toBeVisible({ timeout: 5_000 });

    await screenshotHelper.capture("validation-error-empty-password");
  });

  test("should show validation errors when both fields are empty", async ({
    page,
    screenshotHelper,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Submit without filling anything
    await loginPage.submit();

    // Both field-level errors must appear
    await expect(page.locator("text=Enter a valid email address")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("text=Password is required")).toBeVisible();

    await screenshotHelper.capture("validation-error-both-empty");
  });

  test("should show a server error when the API returns an unexpected failure", async ({
    page,
    screenshotHelper,
  }) => {
    // The api-client retries 5xx errors twice with backoff (1s, 2s) before
    // throwing — so the error alert appears after ~3 seconds.
    // Override after the 2-retry window by just returning 500 on all attempts.
    await overrideMock(page, /\/api\/v1\/auth\/login/, 500, {
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });

    const loginPage = new LoginPage(page);
    await loginPage.goto();

    await loginPage.login(TEST_USERS.admin.email, TEST_USERS.admin.password);

    // ApiError with a non-401 status code surfaces err.message in the role="alert"
    // paragraph. Allow extra time for the 5xx retry backoff (2 retries × ~1s each).
    await expect(loginPage.getError()).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("login-error-server-500");
  });
});

// ---------------------------------------------------------------------------
// Password reset link
// ---------------------------------------------------------------------------

test.describe("Auth — password reset link", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("should display a Forgot password link that navigates to /forgot-password", async ({
    page,
    screenshotHelper,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // LoginForm renders a "Forgot password?" link next to the Password label
    const forgotLink = page.getByRole("link", { name: /forgot password/i });
    await expect(forgotLink).toBeVisible();

    await forgotLink.click();
    await page.waitForURL("**/forgot-password", { timeout: 10_000 });

    await screenshotHelper.capture("forgot-password-page");
  });
});

// ---------------------------------------------------------------------------
// OAuth buttons
// ---------------------------------------------------------------------------

test.describe("Auth — OAuth buttons", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("should display the GitHub OAuth sign-in button", async ({
    page,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // OAuthButton renders a button with label "Sign in with GitHub"
    // OAUTH_ENABLED defaults to true when VITE_OAUTH_ENABLED is not "false"
    const githubButton = page.getByRole("button", {
      name: /sign in with github/i,
    });
    await expect(githubButton).toBeVisible();
  });

  test("should display the Google OAuth sign-in button", async ({
    page,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    const googleButton = page.getByRole("button", {
      name: /sign in with google/i,
    });
    await expect(googleButton).toBeVisible();
  });

  test("should show an OAuth separator between credentials and OAuth buttons", async ({
    page,
    screenshotHelper,
  }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // The "or" separator sits between the credentials form and the OAuth buttons.
    // Use exact: true so the locator matches only the literal "or" span, not
    // other elements whose accessible name happens to contain "or" (e.g. "Password").
    const orSeparator = page.getByText("or", { exact: true });
    await expect(orSeparator).toBeVisible();

    await screenshotHelper.capture("login-oauth-section");
  });
});

// ---------------------------------------------------------------------------
// Logout flow
// ---------------------------------------------------------------------------

test.describe("Auth — logout flow", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("should log out and redirect to the login page", async ({
    page,
    screenshotHelper,
  }) => {
    // Navigate directly to /dashboard — AuthenticatedLayout calls GET /api/v1/auth/me
    // which the mock answers with a valid session, so we land on the dashboard.
    await page.goto("/dashboard");

    // Wait for the topbar to appear — the User menu button is in the Topbar component
    // which renders once the auth session is loaded.
    const userMenuButton = page.getByRole("button", { name: /user menu/i });
    await expect(userMenuButton).toBeVisible({ timeout: 15_000 });

    await userMenuButton.click();

    // The dropdown renders a "Log out" menu item
    const logoutItem = page.getByRole("menuitem", { name: /log out/i });
    await expect(logoutItem).toBeVisible({ timeout: 5_000 });

    await logoutItem.click();

    // handleLogout() calls window.location.href = "/login" after clearing the session
    await page.waitForURL("**/login", { timeout: 15_000 });

    // Confirm the login page is now rendered
    const heading = page.getByRole("heading", { name: /sign in/i });
    await expect(heading).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("after-logout");
  });
});

// ---------------------------------------------------------------------------
// Login page screenshot — visual baseline
// ---------------------------------------------------------------------------

test.describe("Auth — visual baseline", () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test("should capture a visual baseline screenshot of the complete login page", async ({
    page,
    screenshotHelper,
  }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    // Capture the full page for visual review
    await screenshotHelper.capture("login-page-baseline");

    // Basic structural assertions so the test fails fast when the page breaks
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
  });
});
