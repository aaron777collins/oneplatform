import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";

export interface PlatformEvent {
  eventId: string;
  eventType: string;
  eventVersion: string;
  tenantId: string;
  timestamp: string;
  actor: { type: string; id: string };
  data: Record<string, unknown>;
}

const RING_BUFFER_CAPACITY = 1000;
const LRU_MAX_TENANTS = 500;
const LRU_TTL_MS = 15 * 60 * 1000;

interface TenantRingBuffer {
  tenantId: string;
  events: (PlatformEvent | null)[];
  head: number;
  size: number;
  lastAccessedAt: number;
}

export interface SseSubscriber {
  tenantId: string;
  patterns: string[];
  write: (data: string) => boolean;
  close: () => void;
}

export interface SseService {
  writeEvent(event: PlatformEvent): void;
  replay(tenantId: string, lastEventId: string, patterns: string[]): PlatformEvent[] | "overflow";
  subscribe(subscriber: SseSubscriber): () => void;
  getBuffer(tenantId: string): TenantRingBuffer | undefined;
  startPubSubListener(redis: Redis): void;
  stopPubSubListener(): void;
}

export function createSseService(deps: { logger: Logger }): SseService {
  const { logger } = deps;

  const buffers = new Map<string, TenantRingBuffer>();
  const subscribers = new Set<SseSubscriber>();
  let lruCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let pubsubRedis: Redis | null = null;

  function getOrCreateBuffer(tenantId: string): TenantRingBuffer {
    let buf = buffers.get(tenantId);
    if (!buf) {
      if (buffers.size >= LRU_MAX_TENANTS) {
        evictOldestBuffer();
      }
      buf = {
        tenantId,
        events: new Array(RING_BUFFER_CAPACITY).fill(null) as (PlatformEvent | null)[],
        head: 0,
        size: 0,
        lastAccessedAt: Date.now(),
      };
      buffers.set(tenantId, buf);
    }
    buf.lastAccessedAt = Date.now();
    return buf;
  }

  function evictOldestBuffer(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [id, buf] of buffers) {
      if (buf.lastAccessedAt < oldestTime) {
        oldestTime = buf.lastAccessedAt;
        oldest = id;
      }
    }
    if (oldest) buffers.delete(oldest);
  }

  function matchesPattern(eventType: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (pattern === "*") return true;
      if (pattern === eventType) return true;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -2);
        if (eventType.startsWith(prefix + ".") || eventType === prefix) return true;
      }
    }
    return false;
  }

  function startLruCleanup(): void {
    if (lruCleanupTimer) return;
    lruCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, buf] of buffers) {
        if (now - buf.lastAccessedAt > LRU_TTL_MS) {
          buffers.delete(id);
        }
      }
    }, 60_000);
  }

  startLruCleanup();

  return {
    writeEvent(event) {
      const buf = getOrCreateBuffer(event.tenantId);
      const writeIdx = (buf.head + buf.size) % RING_BUFFER_CAPACITY;
      buf.events[writeIdx] = event;
      if (buf.size < RING_BUFFER_CAPACITY) {
        buf.size++;
      } else {
        buf.head = (buf.head + 1) % RING_BUFFER_CAPACITY;
      }

      for (const sub of subscribers) {
        if (sub.tenantId === event.tenantId && matchesPattern(event.eventType, sub.patterns)) {
          const sseData = formatSseEvent(event);
          const ok = sub.write(sseData);
          if (!ok) {
            sub.close();
            subscribers.delete(sub);
          }
        }
      }
    },

    replay(tenantId, lastEventId, patterns) {
      const buf = buffers.get(tenantId);
      // An empty or absent buffer means the tenant has no history at all —
      // no events were missed, so return an empty list. Reserve "overflow" for
      // the case where the buffer is populated but the lastEventId is no longer
      // present (i.e. the ring buffer wrapped past it).
      if (!buf || buf.size === 0) return [];

      let foundIdx = -1;
      for (let i = 0; i < buf.size; i++) {
        const idx = (buf.head + i) % RING_BUFFER_CAPACITY;
        const evt = buf.events[idx];
        if (evt && evt.eventId === lastEventId) {
          foundIdx = i;
          break;
        }
      }

      if (foundIdx === -1) return "overflow";

      const result: PlatformEvent[] = [];
      for (let i = foundIdx + 1; i < buf.size; i++) {
        const idx = (buf.head + i) % RING_BUFFER_CAPACITY;
        const evt = buf.events[idx];
        if (evt && matchesPattern(evt.eventType, patterns)) {
          result.push(evt);
        }
      }
      return result;
    },

    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },

    getBuffer(tenantId) {
      return buffers.get(tenantId);
    },

    startPubSubListener(redis) {
      pubsubRedis = redis.duplicate();
      void pubsubRedis.psubscribe("events:*").catch((err) => {
        logger.error(`Failed to subscribe to events:*: ${String(err)}`);
      });
      pubsubRedis.on("pmessage", (_pattern: string, _channel: string, message: string) => {
        try {
          const event = JSON.parse(message) as PlatformEvent;
          if (event.eventId && event.tenantId) {
            this.writeEvent(event);
          }
        } catch {
          logger.warn("Failed to parse pub/sub event message");
        }
      });
    },

    stopPubSubListener() {
      if (lruCleanupTimer) {
        clearInterval(lruCleanupTimer);
        lruCleanupTimer = null;
      }
      if (pubsubRedis) {
        void pubsubRedis.punsubscribe("events:*").catch(() => {});
        void pubsubRedis.quit().catch(() => {});
        pubsubRedis = null;
      }
    },
  };
}

function formatSseEvent(event: PlatformEvent): string {
  return [
    `id: ${event.eventId}`,
    `event: ${event.eventType}`,
    `data: ${JSON.stringify(event)}`,
    `retry: 5000`,
    "",
    "",
  ].join("\n");
}
