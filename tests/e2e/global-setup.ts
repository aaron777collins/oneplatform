/**
 * global-setup.ts — Playwright global setup for remote (SSO-protected) runs.
 *
 * When PLAYWRIGHT_BASE_URL is set to a site protected by Authelia SSO,
 * this setup authenticates once using AUTHELIA_USERNAME / AUTHELIA_PASSWORD,
 * then saves the resulting browser storage state (cookies) to
 * tests/e2e/.auth/state.json so every test worker can reuse the session
 * without logging in individually.
 *
 * When PLAYWRIGHT_BASE_URL is not set (local dev against localhost), this
 * file runs but skips authentication since no SSO is configured locally.
 */

import { chromium, FullConfig } from "@playwright/test";
import { resolve } from "path";
import { mkdirSync } from "fs";

const AUTH_STATE_PATH = resolve(import.meta.dirname, ".auth/state.json");

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env["PLAYWRIGHT_BASE_URL"];

  if (!baseURL) {
    // Local dev — no SSO, no setup needed.
    return;
  }

  const username = process.env["AUTHELIA_USERNAME"];
  const password = process.env["AUTHELIA_PASSWORD"];

  if (!username || !password) {
    throw new Error(
      "PLAYWRIGHT_BASE_URL is set but AUTHELIA_USERNAME and AUTHELIA_PASSWORD are not. " +
        "Provide SSO credentials to authenticate before running tests against the remote site.\n" +
        "Example: AUTHELIA_USERNAME=aaron AUTHELIA_PASSWORD=<pass> PLAYWRIGHT_BASE_URL=https://test.aaroncollins.info npx playwright test ...",
    );
  }

  // Derive Authelia base URL from the main site — assumes the auth subdomain
  // is auth3.<domain> (e.g. test.aaroncollins.info → auth3.aaroncollins.info).
  const parsedBase = new URL(baseURL);
  const domainParts = parsedBase.hostname.split(".");
  // Replace the first subdomain label with "auth3"
  domainParts[0] = "auth3";
  const autheliaOrigin = `${parsedBase.protocol}//${domainParts.join(".")}`;

  console.log(`[global-setup] Authenticating with Authelia at ${autheliaOrigin} …`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to the protected site — Authelia will redirect the browser to
    // the SSO login page.
    await page.goto(baseURL, { waitUntil: "networkidle", timeout: 30_000 });

    // Wait for the Authelia login form (React SPA) to render.
    const usernameInput = page.getByLabel(/username/i);
    await usernameInput.waitFor({ state: "visible", timeout: 20_000 });

    await usernameInput.fill(username);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole("button", { name: /sign in|login/i }).click();

    // After successful auth, Authelia redirects back to the original destination.
    // Wait until the URL is no longer on the auth domain.
    await page.waitForURL((url) => !url.hostname.includes("auth3"), { timeout: 30_000 });

    console.log(`[global-setup] Authenticated — session stored at ${AUTH_STATE_PATH}`);
  } catch (err) {
    console.error("[global-setup] Authentication failed:", err);
    throw err;
  } finally {
    mkdirSync(resolve(import.meta.dirname, ".auth"), { recursive: true });
    await context.storageState({ path: AUTH_STATE_PATH });
    await browser.close();
  }
}
