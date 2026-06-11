import { randomUUID } from "node:crypto";
import type { Logger } from "@oneplatform/core";

// How long to retain the log buffer after execution completion.
// Late subscribers (e.g. a UI that reconnects within 5 minutes) can still
// replay all lines via Last-Event-ID without a full DB round-trip.
const LOG_BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// SseManager — fan-out SSE log streaming for in-progress executions
// Design spec §4.3
//
// Each subscriber gets an async iterator that yields SSE events. The manager
// fans out log lines and terminal events (complete/error) to all subscribers
// registered for a given execution ID.
//
// Last-Event-ID resume: callers pass the last received line number when
// subscribing so they get only new lines when reconnecting.
// ---------------------------------------------------------------------------

export interface SseLogEvent {
  type: "log";
  line: number;
  level: "debug" | "info" | "warn" | "error";
  stream: "stdout" | "stderr";
  message: string;
  timestamp: string;
}

export interface SseCompleteEvent {
  type: "complete";
  status: "success";
  durationMs: number;
  exitCode: number;
}

export interface SseErrorEvent {
  type: "error";
  status: "error" | "timeout" | "killed";
  errorCode: string;
  errorMessage: string;
}

export type SseEvent = SseLogEvent | SseCompleteEvent | SseErrorEvent;

export interface SseSubscription {
  id: string;
  asyncIterator(): AsyncIterableIterator<SseEvent>;
  close(): void;
}

export interface SseManager {
  subscribe(executionId: string, lastLineNumber?: number): SseSubscription;
  publish(executionId: string, logLine: SseLogEvent): void;
  publishComplete(executionId: string, status: "success", durationMs: number, exitCode: number): void;
  publishError(executionId: string, errorCode: string, errorMessage: string, status?: "error" | "timeout" | "killed"): void;
  unsubscribe(executionId: string, subscriberId: string): void;
}

export interface SseManagerDeps {
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Per-subscriber queue with backpressure via a simple push buffer
// ---------------------------------------------------------------------------

interface Subscriber {
  readonly id: string;
  readonly lastLineNumber: number;
  readonly buffer: SseEvent[];
  notify: (() => void) | null; // Wakes the async iterator when data arrives
  closed: boolean;
}

export function createSseManager(deps: SseManagerDeps): SseManager {
  const { logger } = deps;

  // execution ID → set of active subscribers
  const subscriptions = new Map<string, Map<string, Subscriber>>();

  // Buffered log lines per execution (for Last-Event-ID replay).
  // Entries survive for LOG_BUFFER_TTL_MS after closeAllSubscribers() so that
  // late subscribers connecting within the TTL window can replay missed lines.
  const logBuffers = new Map<string, SseLogEvent[]>();

  // Pending cleanup timers keyed by execution ID (set on completion/error)
  const bufferCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function getOrCreateSubscriberMap(executionId: string): Map<string, Subscriber> {
    let map = subscriptions.get(executionId);
    if (map === undefined) {
      map = new Map();
      subscriptions.set(executionId, map);
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // subscribe — returns an async iterable SSE event stream
  // ---------------------------------------------------------------------------

  function subscribe(executionId: string, lastLineNumber = 0): SseSubscription {
    const subscriberId = randomUUID();
    const subscriber: Subscriber = {
      id: subscriberId,
      lastLineNumber,
      buffer: [],
      notify: null,
      closed: false,
    };

    // Replay buffered lines beyond lastLineNumber for resume support
    const bufferedLines = logBuffers.get(executionId) ?? [];
    for (const line of bufferedLines) {
      if (line.line > lastLineNumber) {
        subscriber.buffer.push(line);
      }
    }

    const map = getOrCreateSubscriberMap(executionId);
    map.set(subscriberId, subscriber);

    logger.debug("SseManager: subscriber registered", { executionId, subscriberId });

    function asyncIterator(): AsyncIterableIterator<SseEvent> {
      return {
        next(): Promise<IteratorResult<SseEvent>> {
          return new Promise((resolve) => {
            function tryDequeue(): void {
              if (subscriber.buffer.length > 0) {
                const event = subscriber.buffer.shift();
                if (event !== undefined) {
                  resolve({ value: event, done: false });
                  return;
                }
              }

              if (subscriber.closed) {
                resolve({ value: undefined as unknown as SseEvent, done: true });
                return;
              }

              // Park — will be woken by notify()
              subscriber.notify = tryDequeue;
            }

            tryDequeue();
          });
        },

        return(): Promise<IteratorResult<SseEvent>> {
          subscriber.closed = true;
          map.delete(subscriberId);
          return Promise.resolve({ value: undefined as unknown as SseEvent, done: true });
        },

        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }

    function close(): void {
      subscriber.closed = true;
      const notify = subscriber.notify;
      subscriber.notify = null;
      if (notify !== null) notify();
      map.delete(subscriberId);
    }

    return { id: subscriberId, asyncIterator, close };
  }

  // ---------------------------------------------------------------------------
  // publish helpers
  // ---------------------------------------------------------------------------

  function deliverToSubscribers(executionId: string, event: SseEvent): void {
    const map = subscriptions.get(executionId);
    if (map === undefined) return;

    for (const subscriber of map.values()) {
      if (subscriber.closed) continue;
      subscriber.buffer.push(event);
      const notify = subscriber.notify;
      subscriber.notify = null;
      if (notify !== null) notify();
    }
  }

  function publish(executionId: string, logLine: SseLogEvent): void {
    // Buffer for Last-Event-ID replay
    let buf = logBuffers.get(executionId);
    if (buf === undefined) {
      buf = [];
      logBuffers.set(executionId, buf);
    }
    buf.push(logLine);

    deliverToSubscribers(executionId, logLine);
  }

  function publishComplete(
    executionId: string,
    status: "success",
    durationMs: number,
    exitCode: number,
  ): void {
    const event: SseCompleteEvent = { type: "complete", status, durationMs, exitCode };
    deliverToSubscribers(executionId, event);
    closeAllSubscribers(executionId);
  }

  function publishError(
    executionId: string,
    errorCode: string,
    errorMessage: string,
    status: "error" | "timeout" | "killed" = "error",
  ): void {
    const event: SseErrorEvent = { type: "error", status, errorCode, errorMessage };
    deliverToSubscribers(executionId, event);
    closeAllSubscribers(executionId);
  }

  function closeAllSubscribers(executionId: string): void {
    const map = subscriptions.get(executionId);
    if (map === undefined) return;

    for (const subscriber of map.values()) {
      subscriber.closed = true;
      const notify = subscriber.notify;
      subscriber.notify = null;
      if (notify !== null) notify();
    }

    subscriptions.delete(executionId);

    // Retain the log buffer for LOG_BUFFER_TTL_MS so late-connecting subscribers
    // (e.g. a UI that briefly drops its SSE connection) can still replay all lines.
    // Cancel any existing timer for this execution before setting a new one to
    // avoid double-cleanup if the execution terminates unexpectedly mid-drain.
    const existing = bufferCleanupTimers.get(executionId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const handle = setTimeout(() => {
      logBuffers.delete(executionId);
      bufferCleanupTimers.delete(executionId);
    }, LOG_BUFFER_TTL_MS);
    // unref() so the timer does not prevent Node from exiting cleanly in tests
    handle.unref();
    bufferCleanupTimers.set(executionId, handle);
  }

  function unsubscribe(executionId: string, subscriberId: string): void {
    const map = subscriptions.get(executionId);
    if (map === undefined) return;

    const subscriber = map.get(subscriberId);
    if (subscriber !== undefined) {
      subscriber.closed = true;
      const notify = subscriber.notify;
      subscriber.notify = null;
      if (notify !== null) notify();
    }

    map.delete(subscriberId);
    logger.debug("SseManager: subscriber removed", { executionId, subscriberId });
  }

  return { subscribe, publish, publishComplete, publishError, unsubscribe };
}
