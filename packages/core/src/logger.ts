import { randomUUID } from "node:crypto";
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

// Level ordering used to filter stdout output based on OP_LOG_LEVEL.
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

// Parse OP_LOG_LEVEL once at module load so the hot path avoids env reads.
// Default to 'info' to avoid flooding stdout with debug lines in production.
function resolveMinLevel(): LogLevel {
  const raw = process.env["OP_LOG_LEVEL"]?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

const MIN_LEVEL = resolveMinLevel();

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

    // Stdout transport — always active regardless of Redis availability.
    // docker logs captures this even when Redis is unreachable.
    // warn/error go to stderr so they surface in container runtime alerts;
    // debug/info go to stdout so they can be filtered independently.
    if (LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL]) {
      const line = JSON.stringify(event);
      if (level === "warn" || level === "error") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    }

    // Redis pub/sub transport — secondary channel for real-time streaming.
    // Consumers subscribe to logs:<service> for live tailing; the channel is
    // named by service so subscribers can filter cheaply. Failures are swallowed
    // because the stdout transport already guarantees durability.
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
          console.warn(
            "auditQueue is not configured — audit event dropped. Pass auditQueue to createLogger() to enable audit logging."
          );
          return;
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

  return makeLogger(randomUUID());
}
