/**
 * Playwright configuration for live-site spider tests.
 *
 * Targets the internal gateway at http://localhost:8088 (no Authelia SSO).
 * Uses OnePlatform's own auth via live-global-setup.ts.
 */
import { defineConfig, devices } from "@playwright/test";
import { resolve } from "path";

const E2E_DIR = resolve(import.meta.dirname);
const AUTH_STATE = resolve(E2E_DIR, ".auth/live-state.json");

export default defineConfig({
  testDir: E2E_DIR,
  testMatch: ["live-spider.spec.ts", "live-interactions.spec.ts"],

  globalSetup: resolve(E2E_DIR, "live-global-setup.ts"),

  timeout: 30_000,
  retries: 0,
  workers: 3,

  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: resolve(E2E_DIR, "playwright-report-live"),
        open: "never",
      },
    ],
  ],

  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] || "http://localhost:8088",
    storageState: AUTH_STATE,
    screenshot: "on",
    video: "off",
    trace: "on-first-retry",
    actionTimeout: 10_000,
  },

  outputDir: resolve(E2E_DIR, "test-results-live"),

  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
