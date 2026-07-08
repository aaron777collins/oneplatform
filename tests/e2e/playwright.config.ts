/**
 * Playwright configuration for OnePlatform frontend E2E tests.
 *
 * The test suite is designed to run against the Vite dev server with all
 * backend API calls intercepted by mock-api.ts route handlers. This means
 * no Docker, no running microservices — only the frontend under test.
 *
 * Projects cover three viewport breakpoints so a single spec file validates
 * desktop, tablet, and mobile layouts without duplication.
 */
import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";

const E2E_DIR = resolve(import.meta.dirname);
const AUTH_STATE = resolve(E2E_DIR, ".auth/state.json");

export default defineConfig({
  testDir: E2E_DIR,
  testMatch: "**/*.spec.ts",

  // Authenticate with Authelia SSO once before any tests run when targeting
  // a remote URL. On localhost the global setup is a no-op.
  globalSetup: resolve(E2E_DIR, "global-setup.ts"),

  // Maximum time each test may run before it is marked failed.
  timeout: 30_000,

  // One retry on CI keeps flaky network-dependent tests from failing the build.
  // On local dev, retries hide real bugs, so use 0 unless overridden by CI env.
  retries: process.env["CI"] ? 1 : 0,

  // Parallelize across workers for speed; each worker gets its own browser
  // context so tests are fully isolated.
  workers: process.env["CI"] ? 2 : undefined,

  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: resolve(E2E_DIR, "playwright-report"),
        open: "never",
      },
    ],
  ],

  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] || "http://localhost:5173",

    // Load the Authelia session cookie saved by global-setup.ts so tests
    // can access the SSO-protected remote site without re-authenticating.
    storageState: process.env["PLAYWRIGHT_BASE_URL"] ? AUTH_STATE : undefined,

    // Always take a screenshot so every test run produces visual evidence
    // regardless of pass/fail status.
    screenshot: "on",

    // Video is expensive; only record on the retry that follows a failure.
    video: "on-first-retry",

    // Trace (DOM snapshots + network) is similarly gated to retries.
    trace: "on-first-retry",
  },

  outputDir: resolve(E2E_DIR, "test-results"),

  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: "tablet",
      use: {
        ...devices["iPad (gen 7)"],
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 375, height: 812 },
      },
    },
  ],

  // Only start the local Vite dev server when not targeting a remote URL.
  // When PLAYWRIGHT_BASE_URL points to a deployed site, there is no local
  // server to start and the webServer block must be omitted entirely.
  webServer: process.env["PLAYWRIGHT_BASE_URL"]
    ? undefined
    : {
        command: "pnpm --filter @oneplatform/frontend dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env["CI"],
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
