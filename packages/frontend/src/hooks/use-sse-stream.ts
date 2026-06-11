import { useEffect, useRef, useState } from "react";
import { SSEConnection, type SSEHandlers } from "@/lib/sse.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEEvent {
  type: string;
  data: string;
  id: string | null;
}

export interface UseSSEStreamOptions {
  /** Set to false to pause/close the connection without unmounting */
  enabled?: boolean;
  onEvent?: (event: SSEEvent) => void;
  onConnect?: () => void;
  onDisconnect?: (reconnectCount: number) => void;
}

export interface UseSSEStreamResult {
  isConnected: boolean;
  reconnectCount: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Opens an SSE connection to the given URL and calls onEvent for each
 * incoming message. The connection is closed on unmount or when `enabled`
 * becomes false.
 *
 * Uses SSEConnection for exponential backoff reconnect and Last-Event-ID
 * replay — see src/lib/sse.ts for the implementation details.
 */
export function useSSEStream(
  url: string,
  options: UseSSEStreamOptions = {},
): UseSSEStreamResult {
  const { enabled = true, onEvent, onConnect, onDisconnect } = options;
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);

  // Keep stable refs to callbacks so the effect does not re-run when the
  // caller inline-defines callbacks (which would create new references each render).
  const onEventRef = useRef(onEvent);
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  onEventRef.current = onEvent;
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;

  const connectionRef = useRef<SSEConnection | null>(null);

  useEffect(() => {
    if (!enabled) {
      connectionRef.current?.disconnect();
      connectionRef.current = null;
      setIsConnected(false);
      return;
    }

    const conn = new SSEConnection();
    connectionRef.current = conn;

    const handlers: SSEHandlers = {
      onMessage: (type, data, id) => {
        onEventRef.current?.({ type, data, id });
      },
      onConnect: () => {
        setIsConnected(true);
        onConnectRef.current?.();
      },
      onDisconnect: (count) => {
        setIsConnected(false);
        setReconnectCount(count);
        onDisconnectRef.current?.(count);
      },
    };

    conn.connect(url, handlers);

    return () => {
      conn.disconnect();
      connectionRef.current = null;
    };
  }, [url, enabled]);

  return { isConnected, reconnectCount };
}
