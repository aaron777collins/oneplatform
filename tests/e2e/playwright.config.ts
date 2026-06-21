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

export default defineConfig({
  testDir: E2E_DIR,
  testMatch: "**/*.spec.ts",

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
    baseURL: "http://localhost:5173",

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

  webServer: {
    // Start the Vite dev server once before any tests run, shared across all
    // worker processes. Turborepo is not used here because `playwright test`
    // is itself invoked from the root package.json — Turbo would be redundant
    // and would add a layer of process management that complicates port detection.
    command: "pnpm --filter @oneplatform/frontend dev",
    url: "http://localhost:5173",
    // Reuse an already-running dev server when developing locally to avoid the
    // ~3 second cold start on every test run.
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
    // Surface Vite's startup output in the terminal so port conflicts are
    // visible immediately rather than timing out silently.
    stdout: "pipe",
    stderr: "pipe",
  },
});
