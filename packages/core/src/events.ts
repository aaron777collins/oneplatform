import { randomUUID } from "crypto";
import type { Redis } from "ioredis";
import type { PlatformEvent } from "./types.js";

export interface EventPublisherConfig {
  redis: Redis;
}

export interface EventPublisher {
  publish(
    event: Omit<PlatformEvent, "eventId" | "timestamp">
  ): Promise<void>;
}

export function createEventPublisher(config: EventPublisherConfig): EventPublisher {
  return {
    async publish(partial) {
      const event: PlatformEvent = {
        ...partial,
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
      };

      // Channel format allows per-tenant and per-event-type subscriptions
      const channel = `events:${event.tenantId}:${event.eventType}`;
      await config.redis.publish(channel, JSON.stringify(event));
    },
  };
}
