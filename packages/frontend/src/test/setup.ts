/**
 * Vitest global test setup.
 *
 * Imported by vitest.config.ts via setupFiles. Runs before each test file.
 * Provides:
 * - @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 * - Global fetch mock
 * - EventSource polyfill for SSE tests in jsdom
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, vi, type MockInstance } from "vitest";
import { cleanup } from "@testing-library/react";

// Always clean up React trees between tests to prevent state leakage
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// EventSource polyfill for jsdom
// EventSource is not implemented in jsdom, so SSE-dependent hooks need a mock.
// ---------------------------------------------------------------------------

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readyState: number = MockEventSource.CONNECTING;
  url: string;
  withCredentials: boolean;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private listeners: Map<string, ((event: Event) => void)[]> = new Map();

  constructor(url: string, options?: EventSourceInit) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockEventSource.OPEN;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, existing.filter((l) => l !== listener));
  }

  dispatchEvent(event: Event): boolean {
    const listeners = this.listeners.get(event.type) ?? [];
    listeners.forEach((l) => l(event));
    return true;
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }
}

// Install the mock globally so tests can use EventSource without a real browser
vi.stubGlobal("EventSource", MockEventSource);

// Expose the mock class so individual tests can spy on it
export { MockEventSource };

// ---------------------------------------------------------------------------
// Silence console.error for expected React warnings in tests
// Tests that expect error output should use vi.spyOn(console, 'error') locally.
// ---------------------------------------------------------------------------
const originalError = console.error.bind(console);
(console as { error: MockInstance | typeof originalError }).error = vi.fn(
  (...args: unknown[]) => {
    const firstArg = args[0];
    const isReactWarning =
      typeof firstArg === "string" &&
      (firstArg.includes("Warning:") || firstArg.includes("React does not recognize"));
    if (!isReactWarning) {
      originalError(...args);
    }
  },
);
