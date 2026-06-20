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
 * **Options stability:** `options.filter`, `options.events`, and `options.onEvent`
 * are intentionally excluded from the `useEffect` dependency array. This prevents
 * re-registering the subscription on every render when callers pass inline
 * object/function literals. App developers who need dynamic filter changes must
 * memoize their options object with `useMemo`.
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
  SubscriptionOptions,
  SubscriptionResult,
} from "../types/entities.js";
import type { WsStatus } from "../ws/WebSocketManager.js";

declare const __OP_DEV__: boolean | undefined;

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

  // Track whether the component has mounted so we can detect post-mount changes
  // to filter/events. Changes after mount are silently ignored by the server-side
  // subscription (the registration is not re-sent), so we warn in development to
  // help callers catch the mistake. Use a key prop or memoize the options object
  // to force a clean remount when filter/events must change dynamically.
  const isMountedRef = React.useRef(false);
  const prevFilterRef = React.useRef(options.filter);
  const prevEventsRef = React.useRef(options.events);

  React.useEffect(() => {
    if (
      isMountedRef.current &&
      (typeof __OP_DEV__ !== "undefined" ? __OP_DEV__ : true)
    ) {
      const filterChanged = options.filter !== prevFilterRef.current;
      const eventsChanged = options.events !== prevEventsRef.current;
      if (filterChanged || eventsChanged) {
        console.warn(
          `[app-sdk] useSubscription("${entity}"): ` +
            (filterChanged ? "filter " : "") +
            (eventsChanged ? "events " : "") +
            "changed after mount. The server-side subscription still uses the original values. " +
            "Add a key prop or memoize the options object to force a clean remount when these values change.",
        );
      }
    }
    prevFilterRef.current = options.filter;
    prevEventsRef.current = options.events;
    optionsRef.current = options;
    isMountedRef.current = true;
  });

  // autoInvalidate is read directly from the current render's options, not from
  // optionsRef: it is a boolean consumed by useQueryInvalidation's dependency
  // array and must reflect the caller's latest value at render time.
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
