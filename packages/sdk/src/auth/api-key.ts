/**
 * API key authentication handler.
 *
 * Sends the API key as a Bearer token in every request header.
 * Validates the key format at construction time so misconfigurations surface
 * immediately rather than on the first API call.
 *
 * Security invariant (ADR-22): API key mode is rejected in browser environments.
 * The check lives in client.ts; this handler does not need to repeat it.
 */

import { ConfigurationError } from '../errors/client-errors.js';

/** Valid API key prefixes as a type-level constant for exhaustive checks. */
const VALID_PREFIXES = ['op_live_', 'op_test_'] as const;

/** Handler returned by createApiKeyHandler(). */
export interface AuthHandler {
  getHeaders(): Promise<Record<string, string>>;
}

export function createApiKeyHandler(apiKey: string): AuthHandler {
  const isValid = VALID_PREFIXES.some((prefix) => apiKey.startsWith(prefix));
  if (!isValid) {
    throw new ConfigurationError(
      `Invalid API key format. Keys must start with "op_live_" or "op_test_". ` +
        `Received key starting with: "${apiKey.slice(0, 3)}..."`,
    );
  }

  return {
    async getHeaders(): Promise<Record<string, string>> {
      return { Authorization: `Bearer ${apiKey}` };
    },
  };
}
