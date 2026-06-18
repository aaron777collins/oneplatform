/**
 * Internal hook: auto-invalidates the QueryCache when entity mutation events arrive.
 *
 * Extracted from useSubscription to satisfy Single Responsibility — subscription
 * management and cache invalidation are orthogonal concerns that change for
 * different reasons.
 *
 * The hook is a pure side-effect: it has no return value. When `autoInvalidate`
 * is true (default) and a mutation event arrives for `entity`, it calls
 * `queryCache.invalidate(entity)`, which removes all cache entries for that
 * entity and notifies any mounted useQuery listeners, triggering a fresh fetch.
 *
 * Why only mutation events (created / updated / deleted)?
 * Those are the three event types that change server-side data. A hypothetical
 * "ping" or metadata event would not warrant a cache flush. EntityEventType in
 * the current spec is exactly {created, updated, deleted}, so the guard is
 * effectively a no-op today but is explicit for future-proofing.
 */

import React from "react";
import { queryCache } from "../cache/QueryCache.js";
import type { EntityEvent, EntityEventType } from "../types/entities.js";

/** The event types that signal a change to server-side entity data. */
const MUTATION_EVENT_TYPES = new Set<EntityEventType>([
  "created",
  "updated",
  "deleted",
]);

/**
 * Registers a cache invalidation side-effect for the given entity.
 *
 * @param entity         - The ontology entity type name being subscribed to.
 * @param lastEvent      - The most-recently received event from useSubscription.
 * @param autoInvalidate - When false, this hook is a no-op. Default: true.
 */
export function useQueryInvalidation<T>(
  entity: string,
  lastEvent: EntityEvent<T> | null,
  autoInvalidate: boolean,
): void {
  React.useEffect(() => {
    // Guard: feature is opt-out, not forced.
    if (!autoInvalidate) return;
    // Guard: no event yet on mount.
    if (lastEvent === null) return;
    // Guard: only invalidate for data-changing mutation events.
    if (!MUTATION_EVENT_TYPES.has(lastEvent.type)) return;

    // The event's entity field is the ground truth — the subscription `entity`
    // parameter and the event entity should always agree, but we use the event
    // field so behaviour is correct even if the server broadcasts cross-entity
    // events in a future protocol version.
    queryCache.invalidate(lastEvent.entity);
    // lastEvent identity changes only when a new event arrives (setState in
    // useSubscription creates a new object reference), so this effect fires
    // exactly once per new event — not on every re-render.
  }, [autoInvalidate, lastEvent]);

  // Suppress the unused `entity` parameter — it is kept in the signature so
  // callers remain explicit about which entity the invalidation is for,
  // matching the mental model of the subscription. The runtime uses
  // lastEvent.entity for safety (see comment above).
  void entity;
}
