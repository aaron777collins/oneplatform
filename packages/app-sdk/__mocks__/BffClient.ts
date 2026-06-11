/**
 * Manual mock for BffClient used in unit tests.
 *
 * Tests configure handlers per-path before rendering components.
 * The mock captures all calls so tests can assert on request arguments.
 *
 * Usage:
 *   import { mockBffResponse, mockBffError, getCapturedCalls } from "./__mocks__/BffClient";
 *   mockBffResponse("/bff/me", { id: "u1", ... });
 *   mockBffError("/bff/data/orders", { code: "PERMISSION_DENIED", statusCode: 403 });
 */

import type { AppSDKError } from "../src/types/entities.js";
import type { BffRequestOptions } from "../src/client/BffClient.js";

// ─── Handler registry ──────────────────────────────────────────────────────────

interface MockErrorMarker extends Partial<AppSDKError> {
  __isMockError: true;
}

const handlers = new Map<string, unknown>();
const capturedCalls: Array<{ path: string; options: BffRequestOptions }> = [];

export function mockBffResponse(path: string, response: unknown): void {
  handlers.set(path, response);
}

export function mockBffError(path: string, error: Partial<AppSDKError>): void {
  const marker: MockErrorMarker = { __isMockError: true, ...error };
  handlers.set(path, marker);
}

export function getCapturedCalls(): ReadonlyArray<{
  path: string;
  options: BffRequestOptions;
}> {
  return capturedCalls;
}

export function clearMocks(): void {
  handlers.clear();
  capturedCalls.length = 0;
}

// ─── Mock BffClient class ──────────────────────────────────────────────────────

export class BffClient {
  private onUnauthorized: (() => void) | null = null;

  setUnauthorizedHandler(handler: () => void): void {
    this.onUnauthorized = handler;
  }

  async request<T>(path: string, options: BffRequestOptions = {}): Promise<T> {
    capturedCalls.push({ path, options });

    const handler = handlers.get(path);
    if (handler === undefined) {
      throw new Error(`[mock-bff] No handler registered for path: ${path}`);
    }

    const potentialError = handler as { __isMockError?: boolean } & Partial<AppSDKError>;
    if (potentialError.__isMockError === true) {
      // Simulate 401 handling
      if (potentialError.statusCode === 401) {
        this.onUnauthorized?.();
      }
      const { __isMockError: _, ...error } = potentialError;
      throw error as AppSDKError;
    }

    return handler as T;
  }
}
