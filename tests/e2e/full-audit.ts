/**
 * Full UI audit — visits every route, captures console errors, network failures,
 * and takes screenshots. Outputs a JSON report.
 */
import { chromium } from "@playwright/test";
import { resolve } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";

const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] || "http://localhost:8088";
const AUTH_STATE_PATH = resolve(
  import.meta.dirname,
  ".auth/live-state.json",
);
const SCREENSHOT_DIR = resolve(import.meta.dirname, "audit-screenshots");
const REPORT_PATH = resolve(import.meta.dirname, "audit-report.json");

interface PageAudit {
  route: string;
  url: string;
  status: "ok" | "error" | "timeout";
  consoleErrors: string[];
  networkFailures: string[];
  screenshotPath: string;
  loadTimeMs: number;
  visibleText: string;
  errorMessage?: string;
}

const ROUTES = [
  // Dashboard
  { path: "/dashboard", name: "dashboard" },
  // Connectors
  { path: "/connectors", name: "connectors" },
  { path: "/connectors/marketplace", name: "connector-marketplace" },
  { path: "/connectors/340800f2-eb37-4316-be8e-a2a9e17db1c6", name: "connector-detail" },
  // Ontology
  { path: "/ontology", name: "ontology" },
  { path: "/ontology/query", name: "query-builder" },
  { path: "/ontology/data-quality", name: "data-quality" },
  { path: "/ontology/migrations", name: "migrations" },
  { path: "/ontology/516241e3-edc6-4b2b-bd90-b0271a46d861", name: "entity-detail" },
  // Pipelines
  { path: "/pipelines", name: "pipelines" },
  { path: "/pipelines/2bd06450-2bf2-4b06-838e-7c003b2398b3", name: "pipeline-detail" },
  { path: "/pipelines/new/edit", name: "pipeline-builder-new" },
  { path: "/pipelines/2bd06450-2bf2-4b06-838e-7c003b2398b3/edit", name: "pipeline-builder-edit" },
  // Apps
  { path: "/apps", name: "apps" },
  { path: "/apps/76147a79-bf3d-42e6-92eb-f897d9620d1e", name: "app-detail" },
  { path: "/apps/76147a79-bf3d-42e6-92eb-f897d9620d1e/edit", name: "app-editor" },
  { path: "/apps/76147a79-bf3d-42e6-92eb-f897d9620d1e/build", name: "app-builder" },
  // Logs
  { path: "/logs", name: "logs" },
  { path: "/logs/audit", name: "audit-logs" },
  // DLQ
  { path: "/dlq", name: "dlq" },
  // Metrics
  { path: "/metrics", name: "metrics" },
  // Plugins
  { path: "/plugins", name: "plugins" },
  // Settings
  { path: "/settings/profile", name: "settings-profile" },
  { path: "/settings/teams", name: "settings-teams" },
  { path: "/settings/api-keys", name: "settings-api-keys" },
  { path: "/settings/webhooks", name: "settings-webhooks" },
  { path: "/settings/storage", name: "settings-storage" },
  { path: "/settings/roles", name: "settings-roles" },
  { path: "/settings/admin", name: "settings-admin" },
];

async function authenticate() {
  // Check if we have existing auth state
  if (existsSync(AUTH_STATE_PATH)) {
    console.log("[audit] Using existing auth state");
    return;
  }

  console.log("[audit] No auth state found, authenticating...");
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForURL("**/login", { timeout: 15_000 });

  const emailInput = page.getByRole("textbox", { name: /email/i });
  await emailInput.waitFor({ state: "visible", timeout: 10_000 });
  await emailInput.fill("aaron777collins@gmail.com");
  await page.getByLabel(/password/i).fill("DevPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });

  mkdirSync(resolve(import.meta.dirname, "../../tests/e2e/.auth"), { recursive: true });
  await context.storageState({ path: AUTH_STATE_PATH });
  await browser.close();
  console.log("[audit] Authentication complete");
}

async function auditPage(
  context: Awaited<ReturnType<typeof chromium.launch>>["contexts"][0],
  route: { path: string; name: string },
): Promise<PageAudit> {
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().includes("favicon")) {
      networkFailures.push(`${response.status()} ${response.url()}`);
    }
  });

  page.on("requestfailed", (request) => {
    networkFailures.push(`FAILED ${request.url()} ${request.failure()?.errorText || ""}`);
  });

  const start = Date.now();
  const screenshotPath = resolve(SCREENSHOT_DIR, `${route.name}.png`);
  let status: "ok" | "error" | "timeout" = "ok";
  let errorMessage: string | undefined;
  let visibleText = "";

  try {
    await page.goto(`${BASE_URL}${route.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    // Wait for content to render (SSE connections prevent networkidle)
    await page.waitForTimeout(3000);

    // Check for error boundaries or crash text
    const bodyText = await page.textContent("body");
    visibleText = (bodyText || "").slice(0, 2000);

    if (
      visibleText.includes("Something went wrong") ||
      visibleText.includes("Error:") ||
      visibleText.includes("TypeError") ||
      visibleText.includes("Cannot read properties")
    ) {
      status = "error";
      errorMessage = "Error boundary or crash text visible on page";
    }

    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (err) {
    status = "timeout";
    errorMessage = String(err);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {
      // ignore screenshot failure
    }
  }

  const loadTimeMs = Date.now() - start;
  await page.close();

  return {
    route: route.path,
    url: `${BASE_URL}${route.path}`,
    status,
    consoleErrors,
    networkFailures,
    screenshotPath,
    loadTimeMs,
    visibleText: visibleText.slice(0, 500),
    errorMessage,
  };
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  await authenticate();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
  });

  const results: PageAudit[] = [];

  for (const route of ROUTES) {
    console.log(`[audit] Testing ${route.path} (${route.name})...`);
    const result = await auditPage(context, route);
    results.push(result);

    const icon =
      result.status === "ok" && result.consoleErrors.length === 0 && result.networkFailures.length === 0
        ? "✓"
        : "✗";
    console.log(
      `  ${icon} ${result.status} | ${result.loadTimeMs}ms | ${result.consoleErrors.length} console errors | ${result.networkFailures.length} network failures`,
    );
    if (result.consoleErrors.length > 0) {
      for (const e of result.consoleErrors) {
        console.log(`    CONSOLE: ${e.slice(0, 200)}`);
      }
    }
    if (result.networkFailures.length > 0) {
      for (const f of result.networkFailures) {
        console.log(`    NETWORK: ${f.slice(0, 200)}`);
      }
    }
    if (result.errorMessage) {
      console.log(`    ERROR: ${result.errorMessage.slice(0, 200)}`);
    }
  }

  writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));

  // Summary
  const errors = results.filter(
    (r) => r.status !== "ok" || r.consoleErrors.length > 0 || r.networkFailures.length > 0,
  );
  console.log(`\n=== AUDIT SUMMARY ===`);
  console.log(`Total pages: ${results.length}`);
  console.log(`Clean: ${results.length - errors.length}`);
  console.log(`With issues: ${errors.length}`);

  if (errors.length > 0) {
    console.log(`\nPages with issues:`);
    for (const e of errors) {
      console.log(`  ${e.route}: ${e.status} | ${e.consoleErrors.length} console errors | ${e.networkFailures.length} network failures`);
    }
  }

  console.log(`\nReport saved to: ${REPORT_PATH}`);
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);

  await browser.close();
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
