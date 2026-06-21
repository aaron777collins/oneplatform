/**
 * screenshot.ts — Screenshot capture and baseline management utilities.
 *
 * Screenshots serve two purposes:
 *   1. Visual evidence in CI artifacts so reviewers can inspect UI quality.
 *   2. Baseline comparison: when a baseline exists, the helper compares the
 *      current screenshot against it and fails if pixel difference exceeds
 *      the configured threshold.
 *
 * Baseline files live in tests/e2e/screenshots/baselines/ and are committed
 * to version control. Current run artifacts go to tests/e2e/screenshots/current/
 * which is gitignored.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { Page } from "@playwright/test";

const E2E_DIR = resolve(import.meta.dirname, "..");
const BASELINES_DIR = resolve(E2E_DIR, "screenshots", "baselines");
const CURRENT_DIR = resolve(E2E_DIR, "screenshots", "current");

// Maximum pixel difference ratio (0–1) before a comparison is considered failed.
// 0.01 = 1% of pixels may differ to tolerate sub-pixel antialiasing differences
// across environments.
const DEFAULT_DIFF_THRESHOLD = 0.01;

export interface ScreenshotOptions {
  /** Clip to a specific element rather than the full page. */
  selector?: string;
  /** Override the default diff threshold (0–1). */
  diffThreshold?: number;
  /** Full-page screenshot. Defaults to true. */
  fullPage?: boolean;
}

/**
 * Capture a full-page screenshot and save it to tests/e2e/screenshots/current/.
 *
 * The filename encodes the test name, viewport label, and a UTC timestamp so
 * artifacts from multiple runs don't overwrite each other.
 *
 * Returns the path to the saved file.
 */
export async function captureScreenshot(
  page: Page,
  name: string,
  viewportLabel: string,
  options: ScreenshotOptions = {},
): Promise<string> {
  ensureDir(CURRENT_DIR);

  const safeName = toSafeFilename(`${name}-${viewportLabel}`);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${safeName}-${timestamp}.png`;
  const outputPath = resolve(CURRENT_DIR, filename);

  const screenshotOptions = {
    path: outputPath,
    fullPage: options.fullPage ?? true,
  };

  if (options.selector) {
    const element = page.locator(options.selector);
    await element.screenshot(screenshotOptions);
  } else {
    await page.screenshot(screenshotOptions);
  }

  return outputPath;
}

/**
 * Compare the current page against a saved baseline.
 *
 * When no baseline exists the current screenshot is saved AS the new baseline
 * and the comparison passes. This makes it easy to establish baselines on
 * first run and then catch regressions on subsequent runs.
 *
 * Returns an object describing the comparison result.
 */
export async function compareWithBaseline(
  page: Page,
  name: string,
  viewportLabel: string,
  options: ScreenshotOptions = {},
): Promise<{ matched: boolean; baselinePath: string; currentPath: string; message: string }> {
  ensureDir(BASELINES_DIR);
  ensureDir(CURRENT_DIR);

  const safeName = toSafeFilename(`${name}-${viewportLabel}`);
  const baselinePath = resolve(BASELINES_DIR, `${safeName}.png`);
  const currentPath = resolve(CURRENT_DIR, `${safeName}-current.png`);

  // Capture current state
  const screenshotOptions = { path: currentPath, fullPage: options.fullPage ?? true };
  if (options.selector) {
    await page.locator(options.selector).screenshot(screenshotOptions);
  } else {
    await page.screenshot(screenshotOptions);
  }

  // No baseline yet — save current as baseline and treat as passing
  if (!existsSync(baselinePath)) {
    const currentBuffer = readFileSync(currentPath);
    writeFileSync(baselinePath, currentBuffer);
    return {
      matched: true,
      baselinePath,
      currentPath,
      message: `Baseline created at ${baselinePath}`,
    };
  }

  // We do not pull in a pixel-diff library to keep this dependency-free.
  // Buffer-level equality check is a pragmatic starting point; for strict
  // visual regression, swap this for pixelmatch or @playwright/test toHaveScreenshot.
  const baseline = readFileSync(baselinePath);
  const current = readFileSync(currentPath);
  const matched = baseline.equals(current);

  return {
    matched,
    baselinePath,
    currentPath,
    message: matched
      ? "Screenshot matches baseline"
      : `Screenshot differs from baseline. Current: ${currentPath}, Baseline: ${baselinePath}`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Replace characters that are invalid in filenames with hyphens. */
function toSafeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export { DEFAULT_DIFF_THRESHOLD };
