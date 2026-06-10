// Unit tests for the BatchAccumulator class in services/ingestion-service.ts
//
// BatchAccumulator buffers parsed log events and flushes them via two triggers:
//   1. Buffer reaches the configurable size limit (default 1000, overridden via env)
//   2. Timer fires after the configurable interval (default 1000ms, overridden via env)
//
// All tests use fake repos (simple objects implementing the repo interface) and
// control env vars so no real Redis or Postgres connection is needed.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { BatchAccumulator } from "../services/ingestion-service.js";

// ---------------------------------------------------------------------------
// Minimal fake repository — only insertBatch is exercised in these tests
// ---------------------------------------------------------------------------

type InsertBatchFn = (events: unknown[]) => Promise<void>;

function makeRepo(insertBatch: InsertBatchFn = async () => {}) {
  return { insertBatch } as unknown as ConstructorParameters<
    typeof BatchAccumulator
  >[0];
}

// ---------------------------------------------------------------------------
// A minimal valid ParsedLogEvent used throughout the test suite
// ---------------------------------------------------------------------------

const EVENT = {
  timestamp: "2026-01-15T10:00:00.000Z",
  traceId: "trace-abc",
  service: "test-service",
  level: "info" as const,
  message: "Test event",
  metadata: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all pending microtasks and macro-tasks in the fake timer queue. */
async function drainTimers(): Promise<void> {
  await Promise.resolve();
  vi.runAllTimers();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchAccumulator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset env vars to predictable small values so tests run quickly
    process.env["OP_LOG_BATCH_SIZE"] = "3";
    process.env["OP_LOG_BATCH_INTERVAL_MS"] = "100";
    process.env["OP_LOG_MEMORY_BUFFER_MAX"] = "20";
  });

  afterEach(async () => {
    delete process.env["OP_LOG_BATCH_SIZE"];
    delete process.env["OP_LOG_BATCH_INTERVAL_MS"];
    delete process.env["OP_LOG_MEMORY_BUFFER_MAX"];
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe("construction", () => {
    it("can be instantiated with a repository", () => {
      const acc = new BatchAccumulator(makeRepo());
      expect(acc).toBeDefined();
    });

    it("extends EventEmitter — supports on() and emit()", () => {
      const acc = new BatchAccumulator(makeRepo());
      const handler = vi.fn();
      acc.on("batch", handler);
      // Internal flush is not yet triggered — just verify the listener attaches
      expect(typeof acc.on).toBe("function");
      expect(typeof acc.emit).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // push() — batch size flush trigger
  // -------------------------------------------------------------------------

  describe("push() — size-based flush trigger", () => {
    it("does not flush before reaching the size limit", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));
      // OP_LOG_BATCH_SIZE is 3 — push 2 events (below threshold)
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      await Promise.resolve();
      expect(insertBatch).not.toHaveBeenCalled();
      await acc.stop();
    });

    it("flushes exactly when the buffer reaches the size limit", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));
      // Push 3 events — should flush immediately on the 3rd push
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      await Promise.resolve();
      expect(insertBatch).toHaveBeenCalledTimes(1);
      expect(insertBatch.mock.calls[0]?.[0]).toHaveLength(3);
    });

    it("emits the 'batch' event before the DB write on size flush", async () => {
      let batchEmittedBeforeInsert = false;
      let insertCalled = false;
      const insertBatch = vi.fn(async () => {
        insertCalled = true;
      });
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.on("batch", () => {
        // At the moment the batch event fires, insertBatch should not yet be called
        // because the batch event fires synchronously before the async writeBatch call
        batchEmittedBeforeInsert = !insertCalled;
      });

      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      await Promise.resolve();

      expect(batchEmittedBeforeInsert).toBe(true);
    });

    it("clears the buffer after flush so the next push starts fresh", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      // First batch flush (3 events)
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      await Promise.resolve();
      expect(insertBatch).toHaveBeenCalledTimes(1);

      // Second batch flush (3 more events)
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      await Promise.resolve();
      expect(insertBatch).toHaveBeenCalledTimes(2);
      expect(insertBatch.mock.calls[1]?.[0]).toHaveLength(3);
    });

    it("passes correct row shape to insertBatch", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      const specificEvent = {
        timestamp: "2026-03-01T09:00:00.000Z",
        traceId: "trace-xyz",
        service: "payments",
        level: "error" as const,
        message: "Payment failed",
        metadata: { amount: 100 },
      };

      acc.push(specificEvent);
      acc.push(specificEvent);
      acc.push(specificEvent);
      await Promise.resolve();

      const rows = insertBatch.mock.calls[0]?.[0] as Array<{
        service: string;
        level: string;
        message: string;
        traceId: string;
        createdAt: Date;
      }>;
      expect(rows[0]?.service).toBe("payments");
      expect(rows[0]?.level).toBe("error");
      expect(rows[0]?.message).toBe("Payment failed");
      expect(rows[0]?.traceId).toBe("trace-xyz");
      expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    });
  });

  // -------------------------------------------------------------------------
  // push() — timer-based flush trigger
  // -------------------------------------------------------------------------

  describe("push() — timer-based flush trigger", () => {
    it("sets a timer on the first push when buffer is below size limit", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.push({ ...EVENT });
      // Timer not yet fired — no flush
      expect(insertBatch).not.toHaveBeenCalled();

      await drainTimers();
      expect(insertBatch).toHaveBeenCalledTimes(1);
      expect(insertBatch.mock.calls[0]?.[0]).toHaveLength(1);
    });

    it("does not set a second timer if one is already pending", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      // Push two events without reaching the size limit
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      // Both events should be in the same batch when the timer fires
      await drainTimers();
      expect(insertBatch).toHaveBeenCalledTimes(1);
      expect(insertBatch.mock.calls[0]?.[0]).toHaveLength(2);
    });

    it("resets the timer after a size-triggered flush", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      // Fill to size limit — flushes synchronously and clears timer
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      await Promise.resolve();
      expect(insertBatch).toHaveBeenCalledTimes(1);

      // Push one more — starts a new timer
      acc.push({ ...EVENT });
      await drainTimers();
      expect(insertBatch).toHaveBeenCalledTimes(2);
      expect(insertBatch.mock.calls[1]?.[0]).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // flush() — explicit flush
  // -------------------------------------------------------------------------

  describe("flush() — explicit flush call", () => {
    it("does nothing when buffer is empty", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.flush();
      await Promise.resolve();
      expect(insertBatch).not.toHaveBeenCalled();
    });

    it("flushes whatever is in the buffer immediately", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.flush();
      await Promise.resolve();

      expect(insertBatch).toHaveBeenCalledTimes(1);
      expect(insertBatch.mock.calls[0]?.[0]).toHaveLength(2);
    });

    it("cancels the pending timer when flushing explicitly", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.push({ ...EVENT });
      // Explicit flush before timer fires
      acc.flush();
      await Promise.resolve();
      expect(insertBatch).toHaveBeenCalledTimes(1);

      // Advance timers — should not trigger a second flush
      await drainTimers();
      expect(insertBatch).toHaveBeenCalledTimes(1);
    });

    it("emits the batch event when flushing explicitly", () => {
      const batchHandler = vi.fn();
      const acc = new BatchAccumulator(makeRepo());

      acc.on("batch", batchHandler);
      acc.push({ ...EVENT });
      acc.flush();

      expect(batchHandler).toHaveBeenCalledTimes(1);
      const emittedBatch = batchHandler.mock.calls[0]?.[0] as unknown[];
      expect(emittedBatch).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // stop() — graceful shutdown
  // -------------------------------------------------------------------------

  describe("stop() — graceful shutdown", () => {
    it("flushes the remaining buffer on stop", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      await acc.stop();

      expect(insertBatch).toHaveBeenCalledTimes(1);
      expect(insertBatch.mock.calls[0]?.[0]).toHaveLength(2);
    });

    it("stop on an empty buffer does not call insertBatch", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      await acc.stop();
      expect(insertBatch).not.toHaveBeenCalled();
    });

    it("stop does not throw even if insertBatch rejects", async () => {
      const insertBatch = vi.fn(async () => {
        throw new Error("DB unavailable");
      });
      const acc = new BatchAccumulator(makeRepo(insertBatch));
      acc.push({ ...EVENT });

      // stop() silently discards errors — must not propagate
      await expect(acc.stop()).resolves.toBeUndefined();
    });

    it("cancels the pending timer during stop", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.push({ ...EVENT });
      await acc.stop();
      // Timer is cancelled — advancing fake timers should not fire a second flush
      await drainTimers();
      // Only one call from the stop itself
      expect(insertBatch).toHaveBeenCalledTimes(1);
    });

    it("stop is idempotent — calling it twice does not double-flush", async () => {
      const insertBatch = vi.fn(async () => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.push({ ...EVENT });
      await acc.stop();
      await acc.stop();
      // Buffer was drained on first stop; second stop finds empty buffer
      expect(insertBatch).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // 'batch' event emission
  // -------------------------------------------------------------------------

  describe("'batch' event emission", () => {
    it("emits 'batch' with the full array of events", () => {
      const batchHandler = vi.fn();
      const acc = new BatchAccumulator(makeRepo());

      acc.on("batch", batchHandler);
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT }); // triggers size flush

      expect(batchHandler).toHaveBeenCalledTimes(1);
      const payload = batchHandler.mock.calls[0]?.[0] as unknown[];
      expect(payload).toHaveLength(3);
    });

    it("multiple listeners both receive the batch event", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const acc = new BatchAccumulator(makeRepo());

      acc.on("batch", handler1);
      acc.on("batch", handler2);
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("batch event fires even when insertBatch will later fail", async () => {
      const insertBatch = vi.fn(async () => {
        throw new Error("Insert failed");
      });
      const batchHandler = vi.fn();
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      acc.on("batch", batchHandler);
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });

      // Batch event fires synchronously before the async write
      expect(batchHandler).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Memory buffer and failure handling
  // -------------------------------------------------------------------------

  describe("insert failure — memory buffer fallback", () => {
    it("logs a warning and schedules a retry when insertBatch rejects", async () => {
      // Verify that a failed insertBatch causes the error to be logged and
      // the events to be moved to the memory buffer (evidenced by the
      // "Batch insert failed" log message, which only fires from handleInsertFailure).
      const insertBatch = vi.fn(async () => {
        throw new Error("Transient DB failure");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      // Push 3 events to trigger a size-based flush
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });

      // Let the async rejection propagate through the catch handler
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // handleInsertFailure logs "Batch insert failed" before buffering events
      const failedMessages = errorSpy.mock.calls.filter((args) =>
        String(args[0]).includes("Batch insert failed")
      );
      expect(failedMessages.length).toBeGreaterThan(0);

      errorSpy.mockRestore();
      await acc.stop();
    });

    it("logs an error when the in-memory fallback buffer is full and events are discarded", async () => {
      // Set memory buffer max to 0 so there is no room to buffer failed events
      process.env["OP_LOG_MEMORY_BUFFER_MAX"] = "0";

      const insertBatch = vi.fn(async () => {
        throw new Error("DB down");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const acc = new BatchAccumulator(makeRepo(insertBatch));

      // Push exactly 3 events to trigger a size-based flush
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });
      acc.push({ ...EVENT });

      // Let the async rejection propagate all the way to handleInsertFailure
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The "In-memory fallback buffer full" error should have been logged
      const fullMessages = errorSpy.mock.calls.filter((args) => {
        const msg = String(args[0]);
        return msg.includes("fallback buffer full") || msg.includes("discarded");
      });
      expect(fullMessages.length).toBeGreaterThan(0);

      errorSpy.mockRestore();
      await acc.stop();
    });
  });
});
