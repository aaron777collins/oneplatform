import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { LogEventRepository } from "../repositories/index.js";
import type { CreateLogEventData } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Zod schema for incoming pub/sub messages (matches LogEvent from core)
// ---------------------------------------------------------------------------

const LogEventSchema = z.object({
  timestamp: z.string().datetime(),
  traceId: z.string().default(""),
  service: z.string().min(1).max(64),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().max(32_768),
  metadata: z.record(z.unknown()).default({}),
});

type ParsedLogEvent = z.infer<typeof LogEventSchema>;

// ---------------------------------------------------------------------------
// Batch accumulator constants — configurable via env vars
// ---------------------------------------------------------------------------

function getBatchSizeLimit(): number {
  return parseInt(process.env["OP_LOG_BATCH_SIZE"] ?? "1000", 10);
}
function getBatchIntervalMs(): number {
  return parseInt(process.env["OP_LOG_BATCH_INTERVAL_MS"] ?? "1000", 10);
}
function getMemoryBufferMax(): number {
  return parseInt(process.env["OP_LOG_MEMORY_BUFFER_MAX"] ?? "10000", 10);
}

// ---------------------------------------------------------------------------
// BatchAccumulator — buffers parsed events and flushes via two triggers:
//   1. Buffer size reaches BATCH_SIZE_LIMIT
//   2. Timer fires after BATCH_INTERVAL_MS
//
// The emitter is used by SSE streaming connections: they tap the 'batch' event
// before the rows are committed to Postgres, delivering sub-second latency.
// ---------------------------------------------------------------------------

export class BatchAccumulator extends EventEmitter {
  private buffer: ParsedLogEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private memoryBuffer: ParsedLogEvent[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private retryBackoffMs = 2_000;
  private readonly MAX_BACKOFF_MS = 60_000;

  constructor(private readonly repo: LogEventRepository) {
    super();
  }

  push(event: ParsedLogEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= getBatchSizeLimit()) {
      this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.flush();
      }, getBatchIntervalMs());
    }
  }

  /**
   * Flush the current buffer. Called by the timer or when the buffer fills.
   * The batch is emitted to SSE subscribers BEFORE the Postgres write so live
   * tailing shows events immediately without waiting for DB confirmation.
   */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);
    // SSE subscribers receive events here — they filter by service/level/traceId
    this.emit("batch", batch);
    this.writeBatch(batch).catch((err: unknown) => {
      this.handleInsertFailure(batch, err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async writeBatch(events: ParsedLogEvent[]): Promise<void> {
    const rows: CreateLogEventData[] = events.map((e) => ({
      traceId: e.traceId,
      service: e.service,
      level: e.level,
      message: e.message,
      metadata: e.metadata,
      createdAt: new Date(e.timestamp),
    }));
    await this.repo.insertBatch(rows);
  }

  private handleInsertFailure(batch: ParsedLogEvent[], err: Error): void {
    console.error("Batch insert failed", { batchSize: batch.length, error: err.message });

    const available = getMemoryBufferMax() - this.memoryBuffer.length;
    if (available <= 0) {
      console.error("In-memory fallback buffer full — events discarded", {
        discarded: batch.length,
      });
      return;
    }

    const toBuffer = batch.slice(0, available);
    this.memoryBuffer.push(...toBuffer);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.drainMemoryBuffer();
    }, this.retryBackoffMs);

    // Exponential backoff capped at MAX_BACKOFF_MS
    this.retryBackoffMs = Math.min(this.retryBackoffMs * 2, this.MAX_BACKOFF_MS);
  }

  private async drainMemoryBuffer(): Promise<void> {
    if (this.memoryBuffer.length === 0) {
      this.retryBackoffMs = 2_000;
      return;
    }

    const batchSize = getBatchSizeLimit();
    try {
      while (this.memoryBuffer.length > 0) {
        const chunk = this.memoryBuffer.splice(0, batchSize);
        await this.writeBatch(chunk);
      }
      // Reset backoff on successful drain
      this.retryBackoffMs = 2_000;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("Memory buffer drain failed", { error: error.message });
      this.scheduleRetry();
    }
  }

  /**
   * Stop timers and flush remaining buffer. Called during graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // Best-effort final flush — do not throw; shutdown must complete.
    const batch = this.buffer.splice(0, this.buffer.length);
    if (batch.length > 0) {
      try {
        await this.writeBatch(batch);
      } catch {
        // Silently discard on shutdown — the service is going away.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// IngestionService — owns the Redis subscriber connection and routes messages
// into the BatchAccumulator.
//
// Two Redis connections are required: ioredis puts a connection in subscriber
// mode once PSUBSCRIBE is issued — regular commands cannot be issued on it.
// ---------------------------------------------------------------------------

export class IngestionService {
  private subscriberRedis: Redis | null = null;

  constructor(
    private readonly accumulator: BatchAccumulator,
    private readonly serviceName: string = "logging-service"
  ) {}

  startPubSubListener(redis: Redis): void {
    // The caller must pass a dedicated subscriber-mode connection. Using the
    // main Redis connection for PSUBSCRIBE would block all other commands.
    this.subscriberRedis = redis;

    redis.psubscribe("logs:*", (err) => {
      if (err) {
        console.error("Failed to subscribe to logs:* channel", {
          error: err.message,
        });
        return;
      }
      console.info("Subscribed to logs:* pub/sub channel");
    });

    redis.on("pmessage", (_pattern: string, channel: string, message: string) => {
      this.handleMessage(channel, message);
    });
  }

  private handleMessage(channel: string, message: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(message) as unknown;
    } catch {
      console.warn("Discarding unparseable log message from channel", { channel });
      return;
    }

    const result = LogEventSchema.safeParse(raw);
    if (!result.success) {
      console.warn("Discarding invalid log event from channel", {
        channel,
        issues: result.error.issues.length,
      });
      return;
    }

    const event = result.data;

    // The channel name provides a redundant service field (e.g. logs:gateway).
    // If the two disagree, the parsed field takes precedence. Warn with
    // console.warn (not via the pub/sub logger — that would create a loop).
    const channelService = channel.replace("logs:", "");
    if (channelService !== event.service && channelService !== this.serviceName) {
      console.warn("Log event service field disagrees with channel name", {
        channelService,
        eventService: event.service,
      });
    }

    this.accumulator.push(event);
  }

  /**
   * Flush the current batch immediately. Called during graceful shutdown to
   * ensure in-flight events are persisted before the process exits.
   */
  async flushBatch(): Promise<void> {
    await this.accumulator.stop();
  }

  stopPubSubListener(): void {
    if (this.subscriberRedis !== null) {
      this.subscriberRedis.punsubscribe("logs:*").catch(() => {});
      this.subscriberRedis = null;
    }
  }
}
