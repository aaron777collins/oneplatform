/**
 * login.page.ts — Page Object Model for the /login route.
 *
 * The login page renders a card with email + password fields, a submit button,
 * and optional OAuth buttons. This POM wraps every interaction so specs read
 * like human-readable scenarios rather than low-level selector chains.
 */

import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import { BasePage } from "./base.page.js";

export class LoginPage extends BasePage {
  // ---------------------------------------------------------------------------
  // Locators — defined as getters so they are evaluated lazily at call time,
  // avoiding stale element references across navigations.
  // ---------------------------------------------------------------------------

  private get emailInput(): Locator {
    return this.page.getByRole("textbox", { name: /email/i });
  }

  private get passwordInput(): Locator {
    // type="password" inputs have no accessible role, so query by label text.
    return this.page.getByLabel(/password/i);
  }

  private get submitButton(): Locator {
    // Use exact match to distinguish the primary submit button from the
    // OAuth "Sign in with GitHub/Google" buttons rendered on the same page.
    return this.page.getByRole("button", { name: "Sign in", exact: true });
  }

  private get errorMessage(): Locator {
    // LoginForm renders errors inside an alert or a paragraph with role="alert".
    return this.page.locator('[role="alert"]');
  }

  private get pageHeading(): Locator {
    return this.page.getByRole("heading", { name: /sign in/i });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto("/login");
    await this.waitForPageReady();
  }

  override async waitForPageReady(): Promise<void> {
    // The form is the definitive signal that the page is ready — it only
    // renders after the lazy chunk has been loaded and React has mounted.
    await expect(this.submitButton).toBeVisible({ timeout: 15_000 });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** Fill the email field. */
  async fillEmail(email: string): Promise<void> {
    await this.emailInput.fill(email);
  }

  /** Fill the password field. */
  async fillPassword(password: string): Promise<void> {
    await this.passwordInput.fill(password);
  }

  /** Click the sign-in submit button. */
  async submit(): Promise<void> {
    await this.submitButton.click();
  }

  /**
   * Perform the full login flow: fill credentials and submit.
   *
   * Does not wait for post-login navigation — callers should assert the
   * expected destination themselves so they see a meaningful failure message.
   */
  async login(email: string, password: string): Promise<void> {
    await this.fillEmail(email);
    await this.fillPassword(password);
    await this.submit();
  }

  // ---------------------------------------------------------------------------
  // Assertions
  // ---------------------------------------------------------------------------

  /** Assert that an error message is visible. */
  async assertError(text?: string | RegExp): Promise<void> {
    await expect(this.errorMessage).toBeVisible({ timeout: 5_000 });
    if (text !== undefined) {
      await expect(this.errorMessage).toHaveText(text);
    }
  }

  /** Assert that the login form is rendered correctly. */
  async assertRendered(): Promise<void> {
    await expect(this.pageHeading).toBeVisible();
    await expect(this.emailInput).toBeVisible();
    await expect(this.passwordInput).toBeVisible();
    await expect(this.submitButton).toBeVisible();
  }

  // ---------------------------------------------------------------------------
  // Getters for direct access in assertions
  // ---------------------------------------------------------------------------

  getError(): Locator {
    return this.errorMessage;
  }

  getEmailInput(): Locator {
    return this.emailInput;
  }

  getPasswordInput(): Locator {
    return this.passwordInput;
  }

  getSubmitButton(): Locator {
    return this.submitButton;
  }
}
