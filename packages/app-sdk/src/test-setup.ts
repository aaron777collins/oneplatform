/**
 * Global test setup for @oneplatform/app-sdk.
 *
 * Imported by vitest via setupFiles. Extends vitest's expect with
 * @testing-library/jest-dom matchers and registers automatic DOM cleanup
 * after each test so rendered components don't bleed into subsequent tests.
 */
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

// Extend vitest expect with jest-dom matchers (toBeInTheDocument, toHaveClass, etc.)
// Note: We import matchers explicitly rather than using "@testing-library/jest-dom/vitest"
// because the vitest auto-extend entry point is incompatible with vitest 4.x.
expect.extend(matchers);

// Ensures React trees are unmounted and the DOM is cleared between tests.
// Without this, multiple render() calls accumulate in the same document body,
// causing "Found multiple elements" errors in query selectors.
afterEach(() => {
  cleanup();
});
