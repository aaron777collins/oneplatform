/**
 * Global test setup for @oneplatform/app-sdk.
 *
 * Imported by vitest via setupFiles. Extends vitest's expect with
 * @testing-library/jest-dom matchers and registers automatic DOM cleanup
 * after each test so rendered components don't bleed into subsequent tests.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Ensures React trees are unmounted and the DOM is cleared between tests.
// Without this, multiple render() calls accumulate in the same document body,
// causing "Found multiple elements" errors in query selectors.
afterEach(() => {
  cleanup();
});
