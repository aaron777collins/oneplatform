/**
 * Real-time entity subscription hook.
 *
 * Opens (or reuses) a shared WebSocket connection via `WebSocketManager` and
 * registers interest in a specific entity. Delivers incoming events via the
 * `lastEvent` state value and the optional `onEvent` callback.
 *
 * Connection state (`isConnected`, `reconnectAttempts`) reflects the shared
 * WebSocket connection — not per-subscription status.
 *
 * **Options reactivity:** `options.filter` and `options.events` are compared
 * by serialized value (JSON.stringify) on every render. When their serialized
 * form changes, the hook automatically unsubscribes from the old registration
 * and re-subscribes with the new parameters. Callers do not need to memoize
 * their options object — passing a new object literal with identical values
 * does not trigger a re-registration.
 *
 * @param entity  - The ontology entity type name to subscribe to.
 * @param options - Optional event type filter and `onEvent` callback.
 * @returns A {@link SubscriptionResult} with the last received event and connection status.
 *
 * @example
 * ```tsx
 * const { lastEvent, isConnected } = useSubscription<Product>('Product', {
 *   events: ['created', 'updated'],
 *   onEvent: (e) => console.log(e.type, e.data),
 * });
 * ```
 */

import React from "react";
import { useAppContext } from "../provider/AppContext.js";
import { useQueryInvalidation } from "./useQueryInvalidation.js";
import type {
  EntityEvent,
  EntityEventType,
  FilterSpec,
  SubscriptionOptions,
  SubscriptionResult,
} from "../types/entities.js";
import type { WsStatus } from "../ws/WebSocketManager.js";

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

  // Keep the latest onEvent ref so the registration closure does not go stale
  // when the caller passes an inline function that changes reference each render.
  const onEventRef = React.useRef(options.onEvent);
  React.useEffect(() => {
    onEventRef.current = options.onEvent;
  });

  // Serialize filter and events to stable strings so we only re-register when
  // the values actually change — not just the object reference. This lets
  // callers pass inline object literals without triggering spurious re-registrations.
  const filterKey = JSON.stringify(options.filter ?? null);
  const eventsKey = JSON.stringify(options.events ?? null);

  // autoInvalidate is read directly from the current render's options, not from
  // a ref: it is a boolean consumed by useQueryInvalidation's dependency array
  // and must reflect the caller's latest value at render time.
  const autoInvalidate = options.autoInvalidate !== false;

  // Delegate cache invalidation to its own hook (Single Responsibility).
  // Runs after every new lastEvent; is a no-op when autoInvalidate is false.
  useQueryInvalidation(entity, lastEvent, autoInvalidate);

  React.useEffect(() => {
    // Use spread pattern to avoid assigning `FilterSpec | undefined` to
    // SubscriptionRegistration.filter (exactOptionalPropertyTypes)
    const registration: import("../ws/WebSocketManager.js").SubscriptionRegistration = {
      entity,
      onEvent: (event: EntityEvent<unknown>) => {
        setLastEvent(event as EntityEvent<T>);
        onEventRef.current?.(event);
      },
    };

    // Deserialize from the stable key strings so the registration always reflects
    // the serialized values that triggered this effect, not a stale closure.
    // Cast to the exact non-optional types — exactOptionalPropertyTypes requires
    // that we never assign `T | undefined` to an optional property typed as `T`.
    const parsedFilter = JSON.parse(filterKey) as FilterSpec | null;
    const parsedEvents = JSON.parse(eventsKey) as EntityEventType[] | null;
    if (parsedFilter !== null) {
      registration.filter = parsedFilter;
    }
    if (parsedEvents !== null) {
      registration.events = parsedEvents;
    }

    wsManager.register(id, registration);

    return () => {
      wsManager.unregister(id);
    };
    // Re-register whenever entity, manager, or the serialized filter/events values change.
    // filterKey and eventsKey are stable strings that only change when the values change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, entity, wsManager, filterKey, eventsKey]);

  return {
    lastEvent,
    isConnected: status.isConnected,
    reconnectAttempts: status.reconnectAttempts,
    reconnectExhausted: status.reconnectExhausted,
  };
}
