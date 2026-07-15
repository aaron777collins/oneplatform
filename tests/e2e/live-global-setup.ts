/**
 * live-global-setup.ts — Global setup for live-site Playwright tests.
 *
 * Authenticates via OnePlatform's own login form (not Authelia SSO)
 * when targeting the internal gateway at http://localhost:8088.
 */

import { chromium, type FullConfig } from "@playwright/test";
import { resolve } from "path";
import { mkdirSync } from "fs";

const AUTH_STATE_PATH = resolve(import.meta.dirname, ".auth/live-state.json");

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env["PLAYWRIGHT_BASE_URL"] || "http://localhost:8088";

  console.log(`[live-global-setup] Authenticating at ${baseURL} …`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(baseURL, { waitUntil: "networkidle", timeout: 30_000 });

    // Bootstrap is complete → redirects to /login
    await page.waitForURL("**/login", { timeout: 15_000 });

    // Fill login form
    const emailInput = page.getByRole("textbox", { name: /email/i });
    await emailInput.waitFor({ state: "visible", timeout: 10_000 });
    await emailInput.fill("aaron777collins@gmail.com");

    const passwordInput = page.getByLabel(/password/i);
    await passwordInput.fill("DevPassword123!");

    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // Wait for redirect to /dashboard after successful login
    await page.waitForURL("**/dashboard", { timeout: 15_000 });

    console.log(`[live-global-setup] Authenticated — session stored at ${AUTH_STATE_PATH}`);
  } catch (err) {
    console.error("[live-global-setup] Authentication failed:", err);
    // Take a screenshot for debugging
    const debugPath = resolve(import.meta.dirname, "screenshots", "live-spider", "auth-failure.png");
    mkdirSync(resolve(import.meta.dirname, "screenshots", "live-spider"), { recursive: true });
    await page.screenshot({ path: debugPath, fullPage: true });
    console.error(`[live-global-setup] Debug screenshot saved to ${debugPath}`);
    throw err;
  } finally {
    mkdirSync(resolve(import.meta.dirname, ".auth"), { recursive: true });
    await context.storageState({ path: AUTH_STATE_PATH });
    await browser.close();
  }
}
