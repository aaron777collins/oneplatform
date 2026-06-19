/**
 * SSE subscription using fetch + ReadableStream (not native EventSource).
 *
 * We deliberately avoid the browser's native EventSource API because it cannot
 * send custom headers, which would force auth tokens into the query string where
 * they appear in access logs (§Appendix C).
 *
 * Reconnection: exponential backoff starting at 1s, capped at 30s, with ±25%
 * jitter. After 10 consecutive failures the subscription moves to 'closed' and
 * the caller must create a new one.
 */

import type { SubscriptionOptions, Subscription, PlatformEvent } from '../types/subscription.js';
import type { AuthHandler } from '../auth/api-key.js';
import { NetworkError } from '../errors/network-error.js';
import { AuthError, ValidationError } from '../errors/client-errors.js';

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Minimum time (ms) a connection must remain alive before the reconnect counter resets. */
const STABLE_CONNECTION_THRESHOLD_MS = 10_000;

type StatusHandler = (status: Subscription['status']) => void;
type ErrorHandler = (error: NetworkError | AuthError) => void;

/** Validates SSE event pattern syntax. Only alphanumeric, dot, and trailing * are valid. */
function validateEventPattern(pattern: string): void {
  // Allow: letters, digits, dots, and optionally a single trailing wildcard
  if (!/^[\w]+(\.[\w]+)*(\.\*)?$|^\*$/.test(pattern)) {
    // Surface a typed error immediately so callers can distinguish malformed
    // patterns from network failures in their catch blocks.
    throw new ValidationError({
      code: 'VALIDATION_ERROR',
      message: `[OnePlatform SDK] Invalid event pattern: "${pattern}". Patterns must be dot-separated alphanumeric segments with an optional trailing ".*" or the global wildcard "*".`,
      retryable: false,
      fields: [{ field: 'events', message: `Invalid event pattern: "${pattern}". Use dot-separated segments with optional trailing ".*" or "*".` }],
    });
  }
}

function calculateReconnectDelay(attempt: number): number {
  const base = RECONNECT_BASE_MS * Math.pow(2, attempt);
  const capped = Math.min(base, RECONNECT_MAX_MS);
  // ±25% jitter
  const jitterFactor = 0.75 + Math.random() * 0.5;
  return Math.floor(capped * jitterFactor);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Parses SSE text stream and emits complete events. */
async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ type: string; data: string; id: string | null }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = 'message';
  let eventData = '';
  let eventId: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line === '') {
        // Empty line = event boundary — dispatch if we have data
        if (eventData !== '') {
          yield { type: eventType, data: eventData, id: eventId };
        }
        // Reset per-event state
        eventType = 'message';
        eventData = '';
        // eventId persists across events (last seen ID)
      } else if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const chunk = line.slice(5).trimStart();
        eventData = eventData === '' ? chunk : `${eventData}\n${chunk}`;
      } else if (line.startsWith('id:')) {
        eventId = line.slice(3).trim();
      }
      // Ignore 'retry:' lines — we manage our own reconnect timing
      // Ignore comment lines (starting with ':')
    }
  }
}

export function createSseSubscription(
  url: string,
  options: SubscriptionOptions,
  authHandler: AuthHandler,
  eventHandler: (event: PlatformEvent) => void,
  fetchImpl: typeof globalThis.fetch,
  isBrowser: boolean,
): Subscription {
  // Validate patterns at construction time so errors surface synchronously
  for (const pattern of options.events) {
    validateEventPattern(pattern);
  }

  let subscriptionId = '';
  let status: Subscription['status'] = 'connecting';
  let lastEventId: string | null = options.fromEventId ?? null;
  let destroyed = false;
  let currentAbortController: AbortController | null = null;

  const statusHandlers: StatusHandler[] = [];
  const errorHandlers: ErrorHandler[] = [];

  function setStatus(next: Subscription['status']): void {
    if (status === next) return;
    status = next;
    for (const handler of statusHandlers) {
      try {
        handler(next);
      } catch {
        // Never let a user handler crash the subscription loop
      }
    }
  }

  function emitError(error: NetworkError | AuthError): void {
    for (const handler of errorHandlers) {
      try {
        handler(error);
      } catch {
        // Never let a user handler crash the subscription loop
      }
    }
  }

  function buildSseUrl(): string {
    const subscribeUrl = new URL(url);
    subscribeUrl.searchParams.set('events', options.events.join(','));
    if (options.filter?.entityType !== undefined) {
      subscribeUrl.searchParams.set('filter[entityType]', options.filter.entityType);
    }
    if (options.filter?.entityId !== undefined) {
      subscribeUrl.searchParams.set('filter[entityId]', options.filter.entityId);
    }
    if (options.filter?.pipelineId !== undefined) {
      subscribeUrl.searchParams.set('filter[pipelineId]', options.filter.pipelineId);
    }
    return subscribeUrl.toString();
  }

  async function connect(reconnectAttempt: number): Promise<void> {
    if (destroyed) return;

    const sseUrl = buildSseUrl();
    let connectedAt: number | null = null;

    try {
      const authHeaders = await authHandler.getHeaders();
      const requestHeaders: Record<string, string> = {
        ...authHeaders,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      };
      if (isBrowser) {
        requestHeaders['X-Requested-With'] = 'XMLHttpRequest';
      }
      if (lastEventId !== null) {
        requestHeaders['Last-Event-ID'] = lastEventId;
      }

      currentAbortController = new AbortController();
      const response = await fetchImpl(sseUrl, {
        headers: requestHeaders,
        signal: currentAbortController.signal,
      });

      if (response.status === 401) {
        // Auth failure cannot be recovered by reconnecting — surface as AuthError
        // and close immediately so the reconnect loop is never entered.
        const authErr = new AuthError({
          code: 'UNAUTHORIZED',
          message: 'SSE connection rejected: 401 Unauthorized. Check your credentials.',
          statusCode: 401,
          retryable: false,
        });
        emitError(authErr);
        setStatus('closed');
        destroyed = true;
        return;
      }

      if (!response.ok || response.body === null) {
        throw new NetworkError({
          message: `SSE connection failed: server returned ${response.status}`,
          reason: 'fetch-failed',
        });
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        throw new NetworkError({
          message: `SSE connection rejected: expected text/event-stream, got ${contentType}`,
          reason: 'fetch-failed',
        });
      }

      setStatus('connected');
      // Track when the connection was established. The reconnect counter is only
      // reset after the connection has been alive longer than the stability
      // threshold (10 s). This prevents a fast connect-then-drop loop from
      // resetting the backoff and retrying indefinitely.
      connectedAt = Date.now();

      const reader = response.body.getReader();
      for await (const event of parseSseStream(reader)) {
        if (destroyed) {
          reader.cancel().catch(() => undefined);
          return;
        }

        if (event.id !== null) {
          lastEventId = event.id;
        }

        // The first event from the server is a 'connected' control event with the subscription ID
        if (event.type === 'connected') {
          try {
            const payload = JSON.parse(event.data) as { subscriptionId?: string };
            if (payload.subscriptionId !== undefined) {
              subscriptionId = payload.subscriptionId;
            }
          } catch {
            // Ignore malformed connected event
          }
          continue;
        }

        if (event.data === '') continue;

        try {
          const parsed = JSON.parse(event.data) as PlatformEvent;
          eventHandler(parsed);
        } catch {
          // Skip events with malformed JSON rather than crashing the subscription
        }
      }

      // Stream ended without error — server closed the connection; reconnect.
      // Only reset the attempt counter if the connection was stable (alive > threshold).
      if (!destroyed) {
        const wasStable = Date.now() - connectedAt >= STABLE_CONNECTION_THRESHOLD_MS;
        await scheduleReconnect(wasStable ? 0 : reconnectAttempt + 1);
      }
    } catch (err) {
      if (destroyed) return;

      // AbortError from our own unsubscribe() — not an error worth reporting
      if (err instanceof Error && err.name === 'AbortError') return;

      const networkErr =
        err instanceof NetworkError
          ? err
          : new NetworkError({
              message: err instanceof Error ? err.message : 'Unknown SSE connection error',
              reason: 'fetch-failed',
              cause: err,
            });

      emitError(networkErr);
      // Only reset the attempt counter if the connection was alive long enough
      // to be considered stable; otherwise increment to trigger backoff.
      const wasStable =
        connectedAt !== null &&
        Date.now() - connectedAt >= STABLE_CONNECTION_THRESHOLD_MS;
      await scheduleReconnect(wasStable ? 0 : reconnectAttempt + 1);
    }
  }

  async function scheduleReconnect(attempt: number): Promise<void> {
    if (destroyed) return;

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setStatus('closed');
      emitError(
        new NetworkError({
          message: `SSE subscription closed after ${MAX_RECONNECT_ATTEMPTS} failed reconnect attempts.`,
          reason: 'fetch-failed',
        }),
      );
      return;
    }

    setStatus('reconnecting');
    const delayMs = calculateReconnectDelay(attempt);
    await sleep(delayMs);
    await connect(attempt);
  }

  // Start the connection asynchronously
  void connect(0);

  const subscription: Subscription = {
    get id() {
      return subscriptionId;
    },
    get status() {
      return status;
    },
    get lastEventId() {
      return lastEventId;
    },

    unsubscribe(): void {
      destroyed = true;
      setStatus('closed');
      currentAbortController?.abort();
    },

    on(event: 'status' | 'error', handler: StatusHandler | ErrorHandler): Subscription {
      if (event === 'status') {
        statusHandlers.push(handler as StatusHandler);
      } else if (event === 'error') {
        errorHandlers.push(handler as ErrorHandler);
      }
      return subscription;
    },

    onStatus(handler: StatusHandler): Subscription {
      statusHandlers.push(handler);
      return subscription;
    },

    onError(handler: ErrorHandler): Subscription {
      errorHandlers.push(handler);
      return subscription;
    },
  };

  return subscription;
}
