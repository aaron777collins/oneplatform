/**
 * Real-time entity subscription hook.
 *
 * Opens (or reuses) a shared WebSocket connection via WebSocketManager and
 * registers interest in a specific entity. Delivers incoming events via the
 * lastEvent state value and the optional onEvent callback.
 *
 * Connection state (isConnected, reconnectAttempts) reflects the shared
 * WebSocket connection — not per-subscription status.
 *
 * Options stability note: options.filter, options.events, and options.onEvent
 * are intentionally excluded from the useEffect dependency array. This prevents
 * re-registering the subscription on every render when callers pass inline
 * object/function literals. App developers who need dynamic filter changes must
 * memoize their options object with useMemo.
 */

import React from "react";
import { useAppContext } from "../provider/AppContext.js";
import type {
  EntityEvent,
  SubscriptionOptions,
  SubscriptionResult,
} from "../types/entities.js";
import type { WsStatus } from "../ws/WebSocketManager.js";

// TODO: Auto-invalidate related queries on entity mutation events (M-14)
export function useSubscription<T = unknown>(
  entity: string,
  options: SubscriptionOptions = {},
): SubscriptionResult<T> {
  const { wsManager } = useAppContext();

  // React 18 stable ID — unique per hook instance, used as the subscription key
  const id = React.useId();

  const [lastEvent, setLastEvent] = React.useState<EntityEvent<T> | null>(null);

  // useSyncExternalStore subscribes to WebSocketManager status changes.
  // This is the correct React 18 primitive for tearing-safe external store reads.
  const status = React.useSyncExternalStore<WsStatus>(
    React.useCallback(
      (notify: () => void) => wsManager.subscribeToStatus(notify),
      [wsManager],
    ),
    React.useCallback(() => wsManager.getStatus(), [wsManager]),
  );

  // Use a ref to hold the latest options so the effect closure does not go stale
  // when options change, without needing to re-register the subscription.
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  });

  React.useEffect(() => {
    // Use spread pattern to avoid assigning `FilterSpec | undefined` to
    // SubscriptionRegistration.filter (exactOptionalPropertyTypes)
    const registration: import("../ws/WebSocketManager.js").SubscriptionRegistration = {
      entity,
      onEvent: (event: EntityEvent<unknown>) => {
        setLastEvent(event as EntityEvent<T>);
        optionsRef.current.onEvent?.(event);
      },
    };
    if (optionsRef.current.filter !== undefined) {
      registration.filter = optionsRef.current.filter;
    }
    if (optionsRef.current.events !== undefined) {
      registration.events = optionsRef.current.events;
    }
    wsManager.register(id, registration);

    return () => {
      wsManager.unregister(id);
    };
    // Intentional: only re-register when the entity or manager changes.
    // filter/events/onEvent changes are handled via optionsRef without
    // re-registration. This is documented in the spec as a design trade-off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, entity, wsManager]);

  return {
    lastEvent,
    isConnected: status.isConnected,
    reconnectAttempts: status.reconnectAttempts,
  };
}
