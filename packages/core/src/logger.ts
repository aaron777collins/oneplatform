import type { Redis } from "ioredis";
import type { Queue } from "bullmq";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  timestamp: string;
  traceId: string;
  service: string;
  level: LogLevel;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AuditEvent {
  timestamp: string;
  traceId: string;
  actorId: string;
  actorType: "user" | "service" | "system";
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: "success" | "failure";
  metadata: Record<string, unknown>;
}

export interface LoggerConfig {
  serviceName: string;
  redis: Redis;
  // auditQueue is optional at construction time so services that never emit
  // audit events don't need to wire up a BullMQ queue.  The queue is required
  // only when audit() is called.
  auditQueue?: Queue;
}

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
  audit(event: Omit<AuditEvent, "timestamp" | "traceId">): Promise<void>;
  withTraceId(traceId: string): Logger;
}

export function createLogger(config: LoggerConfig): Logger {
  function log(
    level: LogLevel,
    message: string,
    metadata: Record<string, unknown>,
    traceId: string
  ): void {
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      traceId,
      service: config.serviceName,
      level,
      message,
      metadata,
    };
    // Fire-and-forget: log emission must never crash the caller.  Consumers
    // subscribe to the Redis pub/sub channel for real-time streaming; the
    // channel is named by service so subscribers can filter cheaply.
    config.redis
      .publish(`logs:${config.serviceName}`, JSON.stringify(event))
      .catch(() => {});
  }

  function makeLogger(traceId: string): Logger {
    return {
      debug: (msg, meta = {}) => log("debug", msg, meta, traceId),
      info: (msg, meta = {}) => log("info", msg, meta, traceId),
      warn: (msg, meta = {}) => log("warn", msg, meta, traceId),
      error: (msg, meta = {}) => log("error", msg, meta, traceId),

      async audit(event) {
        if (!config.auditQueue) {
          throw new Error(
            "auditQueue is required to emit audit events. Pass it to createLogger()."
          );
        }
        const full: AuditEvent = {
          ...event,
          timestamp: new Date().toISOString(),
          traceId,
        };
        // Audit events are durable — they go through BullMQ with the same
        // retry/backoff policy as other pipeline jobs so no event is silently
        // dropped on transient failures.
        await config.auditQueue.add("audit.event", full, {
          attempts: 5,
          backoff: { type: "exponential", delay: 1_000 },
        });
      },

      withTraceId(newTraceId: string): Logger {
        // Returns a new logger bound to a child trace ID; the parent logger's
        // trace context is discarded so spans don't accidentally cross.
        return makeLogger(newTraceId);
      },
    };
  }

  return makeLogger("");
}
