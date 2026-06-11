/**
 * SSE connection factory used by usePlatformEvents and other hooks that need
 * more lifecycle control than raw EventSource provides.
 *
 * Native EventSource does reconnect automatically, but it resets the backoff
 * immediately after reconnecting. This wrapper implements a deliberate
 * exponential backoff (1s → 2s → 4s → 8s → max 30s) that resets only after
 * a sustained connection (defined as HEALTHY_CONNECTION_MS without an error).
 *
 * Last-Event-ID is tracked and sent as a query parameter on reconnect because
 * EventSource does not let you set custom request headers. The server reads
 * `?lastEventId=` as a fallback when the `Last-Event-ID` header is absent.
 */

export interface SSEHandlers {
  onMessage: (eventType: string, data: string, id: string | null) => void;
  onConnect?: () => void;
  onDisconnect?: (reconnectCount: number) => void;
  onError?: (error: Event) => void;
}

// A connection is considered healthy if it has been open for this long without error.
// After HEALTHY_CONNECTION_MS of uptime the reconnect delay is reset to base.
const HEALTHY_CONNECTION_MS = 10_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export class SSEConnection {
  private es: EventSource | null = null;
  private lastEventId: string | null = null;
  private reconnectDelay = BASE_DELAY_MS;
  private reconnectCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private url = "";
  private handlers: SSEHandlers | null = null;
  private closed = false;

  connect(url: string, handlers: SSEHandlers): void {
    this.url = url;
    this.handlers = handlers;
    this.closed = false;
    this.openEventSource();
  }

  disconnect(): void {
    this.closed = true;
    this.clearTimers();
    this.es?.close();
    this.es = null;
  }

  getLastEventId(): string | null {
    return this.lastEventId;
  }

  getReconnectCount(): number {
    return this.reconnectCount;
  }

  isConnected(): boolean {
    return this.es !== null && this.es.readyState === EventSource.OPEN;
  }

  private openEventSource(): void {
    if (this.closed) return;

    // Attach lastEventId as a query parameter — EventSource cannot send headers.
    const url = this.lastEventId
      ? `${this.url}${this.url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(this.lastEventId)}`
      : this.url;

    const es = new EventSource(url, { withCredentials: true });
    this.es = es;

    es.onopen = () => {
      if (this.closed) {
        es.close();
        return;
      }
      this.handlers?.onConnect?.();
      // Start health timer — if connection stays open for HEALTHY_CONNECTION_MS,
      // reset the backoff delay so the next disconnect starts from the base again.
      this.healthTimer = setTimeout(() => {
        this.reconnectDelay = BASE_DELAY_MS;
      }, HEALTHY_CONNECTION_MS);
    };

    es.onmessage = (event) => {
      if (event.lastEventId) {
        this.lastEventId = event.lastEventId;
      }
      this.handlers?.onMessage("message", event.data as string, event.lastEventId || null);
    };

    // The server sends typed events (e.g. "log", "complete", "pipeline.run.started").
    // We listen to every event type by intercepting the raw 'message' flow above
    // AND any named events the caller needs to handle. Since we cannot enumerate
    // event types ahead of time, we intercept at the EventSource level by
    // overriding the dispatchEvent behavior. The caller receives eventType in
    // the onMessage callback.
    const originalDispatchEvent = es.dispatchEvent.bind(es);
    es.dispatchEvent = (event: Event): boolean => {
      if (event instanceof MessageEvent && event.type !== "message" && event.type !== "open" && event.type !== "error") {
        if (event.lastEventId) {
          this.lastEventId = event.lastEventId;
        }
        this.handlers?.onMessage(event.type, event.data as string, event.lastEventId || null);
      }
      return originalDispatchEvent(event);
    };

    es.onerror = (event) => {
      this.handlers?.onError?.(event);
      this.clearHealthTimer();
      es.close();
      this.es = null;

      if (!this.closed) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    this.reconnectCount++;
    const delay = this.reconnectDelay;
    this.handlers?.onDisconnect?.(this.reconnectCount);

    // Double the delay for the next reconnect attempt, capped at MAX_DELAY_MS
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_DELAY_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openEventSource();
    }, delay);
  }

  private clearTimers(): void {
    this.clearHealthTimer();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHealthTimer(): void {
    if (this.healthTimer !== null) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }
}
