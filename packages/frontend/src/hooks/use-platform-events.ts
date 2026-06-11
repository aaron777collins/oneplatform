import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSSEStream } from "./use-sse-stream.js";
import type { SSEEvent } from "./use-sse-stream.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlatformEvent {
  eventId: string;
  eventType: string;
  tenantId: string;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface UsePlatformEventsResult {
  isConnected: boolean;
  reconnectCount: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to the platform-wide SSE event stream at
 * GET /api/v1/events/stream and invalidates TanStack Query caches on relevant
 * events.
 *
 * Design: events are signals to re-fetch, not data payloads to merge into
 * cache. This keeps state management simple and avoids partial-update bugs.
 * The extra round-trip (one GET after each relevant event) is acceptable
 * for a dashboard with 1-10 active pipelines (§8.4).
 *
 * `eventFilter` is a list of eventType prefixes (e.g. ["pipeline.*", "ingestion.*"]).
 * Events matching any prefix are forwarded to the handler.
 * Pass an empty array to receive all events.
 *
 * `handler` receives the parsed event and can trigger additional side effects
 * (toast notifications, query invalidations for non-standard resources, etc.)
 * beyond the default invalidation logic built into this hook.
 */
export function usePlatformEvents(
  eventFilter: string[],
  handler?: (event: PlatformEvent) => void,
): UsePlatformEventsResult {
  const queryClient = useQueryClient();

  const onEvent = useCallback(
    (sseEvent: SSEEvent) => {
      if (sseEvent.type !== "message" && sseEvent.type !== "platform-event") return;

      let event: PlatformEvent;
      try {
        event = JSON.parse(sseEvent.data) as PlatformEvent;
      } catch {
        // Malformed event — skip silently
        return;
      }

      // Filter: skip events that don't match any of the caller's prefixes
      if (eventFilter.length > 0) {
        const matches = eventFilter.some((filter) => {
          if (filter.endsWith(".*")) {
            const prefix = filter.slice(0, -2);
            return event.eventType.startsWith(prefix);
          }
          return event.eventType === filter;
        });
        if (!matches) return;
      }

      // Default invalidation strategy: invalidate the resource type's query key
      const resourceKey = event.resourceType.toLowerCase().replace(/_/g, "-");
      void queryClient.invalidateQueries({ queryKey: [resourceKey] });

      // Also invalidate more specific keys that include the resource ID
      void queryClient.invalidateQueries({
        queryKey: [resourceKey, event.resourceId],
      });

      handler?.(event);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, handler, JSON.stringify(eventFilter)],
  );

  return useSSEStream("/api/v1/events/stream", {
    enabled: true,
    onEvent,
  });
}
