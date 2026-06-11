/**
 * client.events namespace — real-time event subscriptions via SSE.
 */

import type { Transport } from '../transport.js';
import type { AuthHandler } from '../auth/api-key.js';
import type { SubscriptionOptions, Subscription, PlatformEvent } from '../types/subscription.js';
import { createSseSubscription } from '../subscriptions/sse-subscriber.js';

export interface EventNamespace {
  /**
   * Subscribe to platform events matching the specified patterns.
   *
   * @param options - Event patterns and optional server-side filter.
   * @param handler - Called for each received event.
   * @returns A Subscription object for lifecycle management and status monitoring.
   */
  subscribe(
    options: SubscriptionOptions,
    handler: (event: PlatformEvent) => void,
  ): Subscription;
}

export function createEventNamespace(
  transport: Transport,
  authHandler: AuthHandler,
  fetchImpl: typeof globalThis.fetch,
  isBrowser: boolean,
): EventNamespace {
  return {
    subscribe(options: SubscriptionOptions, handler: (event: PlatformEvent) => void): Subscription {
      if (options.events.length === 0) {
        throw new Error(
          '[OnePlatform SDK] events.subscribe() requires at least one event pattern.',
        );
      }

      // transport.buildUrl() prepends the stored baseUrl — do not pass baseUrl here
      const sseUrl = transport.buildUrl('/api/v1/events/subscribe');

      return createSseSubscription(
        sseUrl,
        options,
        authHandler,
        handler,
        fetchImpl,
        isBrowser,
      );
    },
  };
}
