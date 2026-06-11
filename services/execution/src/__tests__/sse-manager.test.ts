// Unit tests for services/sse-manager.ts
//
// Tests: subscribe, publish, publishComplete, publishError, unsubscribe,
// Last-Event-ID replay, async iterator termination, subscriber map management.

import { describe, it, expect, vi } from "vitest";
import type { Logger } from "@oneplatform/core";
import { createSseManager } from "../services/sse-manager.js";
import type { SseLogEvent } from "../services/sse-manager.js";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeLogLine(line: number, message = "test message"): SseLogEvent {
  return {
    type: "log",
    line,
    level: "info",
    stream: "stdout",
    message,
    timestamp: new Date().toISOString(),
  };
}

const EXEC_ID = "exec-001";

// ---------------------------------------------------------------------------
// subscribe — basic
// ---------------------------------------------------------------------------

describe("createSseManager — subscribe", () => {
  it("returns a subscription with a unique id", () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub1 = manager.subscribe(EXEC_ID);
    const sub2 = manager.subscribe(EXEC_ID);
    expect(sub1.id).toBeTruthy();
    expect(sub2.id).toBeTruthy();
    expect(sub1.id).not.toBe(sub2.id);
  });

  it("subscription has asyncIterator and close methods", () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    expect(typeof sub.asyncIterator).toBe("function");
    expect(typeof sub.close).toBe("function");
  });

  it("asyncIterator is an async iterable iterator", () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();
    expect(typeof iter.next).toBe("function");
    expect(typeof iter[Symbol.asyncIterator]).toBe("function");
    expect(iter[Symbol.asyncIterator]()).toBe(iter);
  });
});

// ---------------------------------------------------------------------------
// publish — delivers events to subscribers
// ---------------------------------------------------------------------------

describe("createSseManager — publish", () => {
  it("delivers a published log event to a subscriber", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    const logLine = makeLogLine(1, "hello");
    manager.publish(EXEC_ID, logLine);

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual(logLine);
  });

  it("delivers events to multiple concurrent subscribers", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub1 = manager.subscribe(EXEC_ID);
    const sub2 = manager.subscribe(EXEC_ID);
    const iter1 = sub1.asyncIterator();
    const iter2 = sub2.asyncIterator();

    const logLine = makeLogLine(1, "broadcast");
    manager.publish(EXEC_ID, logLine);

    const [r1, r2] = await Promise.all([iter1.next(), iter2.next()]);
    expect(r1.value).toEqual(logLine);
    expect(r2.value).toEqual(logLine);
  });

  it("does not deliver events to subscribers of a different execution", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe("exec-other");
    const iter = sub.asyncIterator();

    manager.publish(EXEC_ID, makeLogLine(1, "wrong-exec"));

    // Subscribe to the actual execution that got the event and verify isolation
    const sub2 = manager.subscribe(EXEC_ID);
    const iter2 = sub2.asyncIterator();
    manager.publish(EXEC_ID, makeLogLine(2, "correct-exec"));

    const r2 = await iter2.next();
    expect(r2.value.type).toBe("log");

    // The first subscriber should not have received anything
    // (close it to avoid hanging)
    sub.close();
    const otherResult = await iter.next();
    expect(otherResult.done).toBe(true);
  });

  it("delivers multiple sequential log events in order", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    const line1 = makeLogLine(1, "first");
    const line2 = makeLogLine(2, "second");
    const line3 = makeLogLine(3, "third");

    manager.publish(EXEC_ID, line1);
    manager.publish(EXEC_ID, line2);
    manager.publish(EXEC_ID, line3);

    const r1 = await iter.next();
    const r2 = await iter.next();
    const r3 = await iter.next();

    expect(r1.value).toEqual(line1);
    expect(r2.value).toEqual(line2);
    expect(r3.value).toEqual(line3);
  });
});

// ---------------------------------------------------------------------------
// publishComplete — closes subscribers with complete event
// ---------------------------------------------------------------------------

describe("createSseManager — publishComplete", () => {
  it("delivers a complete event with correct fields", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    manager.publishComplete(EXEC_ID, "success", 1500, 0);

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toMatchObject({
      type: "complete",
      status: "success",
      durationMs: 1500,
      exitCode: 0,
    });
  });

  it("closes the iterator after delivering complete event", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    manager.publishComplete(EXEC_ID, "success", 500, 0);

    await iter.next(); // consume complete event
    const terminal = await iter.next();
    expect(terminal.done).toBe(true);
  });

  it("closes all subscribers after publishComplete", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub1 = manager.subscribe(EXEC_ID);
    const sub2 = manager.subscribe(EXEC_ID);
    const iter1 = sub1.asyncIterator();
    const iter2 = sub2.asyncIterator();

    manager.publishComplete(EXEC_ID, "success", 500, 0);

    const [r1, r2] = await Promise.all([iter1.next(), iter2.next()]);
    expect(r1.value.type).toBe("complete");
    expect(r2.value.type).toBe("complete");

    const [t1, t2] = await Promise.all([iter1.next(), iter2.next()]);
    expect(t1.done).toBe(true);
    expect(t2.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// publishError — closes subscribers with error event
// ---------------------------------------------------------------------------

describe("createSseManager — publishError", () => {
  it("delivers an error event with correct fields", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    manager.publishError(EXEC_ID, "EXECUTION_TIMEOUT", "Timed out after 30s");

    const result = await iter.next();
    expect(result.value).toMatchObject({
      type: "error",
      status: "error",
      errorCode: "EXECUTION_TIMEOUT",
      errorMessage: "Timed out after 30s",
    });
  });

  it("uses provided status value (timeout, killed)", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    manager.publishError(EXEC_ID, "EXECUTION_OOM", "Out of memory", "killed");

    const result = await iter.next();
    expect(result.value).toMatchObject({ type: "error", status: "killed" });
  });

  it("defaults status to 'error' when not provided", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    manager.publishError(EXEC_ID, "EXECUTION_SANDBOX_CRASH", "Sandbox crashed");

    const result = await iter.next();
    expect(result.value).toMatchObject({ type: "error", status: "error" });
  });

  it("closes iterator after delivering error event", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    manager.publishError(EXEC_ID, "EXECUTION_TIMEOUT", "Timed out");

    await iter.next(); // consume error event
    const terminal = await iter.next();
    expect(terminal.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Last-Event-ID replay — buffered lines replayed on reconnect
// ---------------------------------------------------------------------------

describe("createSseManager — Last-Event-ID replay", () => {
  it("replays buffered lines with line number > lastLineNumber on subscribe", async () => {
    const manager = createSseManager({ logger: makeLogger() });

    // Publish before any subscriber
    const line1 = makeLogLine(1, "line 1");
    const line2 = makeLogLine(2, "line 2");
    const line3 = makeLogLine(3, "line 3");
    manager.publish(EXEC_ID, line1);
    manager.publish(EXEC_ID, line2);
    manager.publish(EXEC_ID, line3);

    // Subscribe with lastLineNumber = 1: should replay lines 2 and 3 only
    const sub = manager.subscribe(EXEC_ID, 1);
    const iter = sub.asyncIterator();

    const r1 = await iter.next();
    const r2 = await iter.next();
    expect(r1.value).toEqual(line2);
    expect(r2.value).toEqual(line3);
  });

  it("replays all buffered lines when lastLineNumber = 0", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    manager.publish(EXEC_ID, makeLogLine(1, "first"));
    manager.publish(EXEC_ID, makeLogLine(2, "second"));

    const sub = manager.subscribe(EXEC_ID, 0);
    const iter = sub.asyncIterator();

    const r1 = await iter.next();
    const r2 = await iter.next();
    expect((r1.value as SseLogEvent).message).toBe("first");
    expect((r2.value as SseLogEvent).message).toBe("second");
  });

  it("replays no buffered lines when lastLineNumber is beyond all buffered lines", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    manager.publish(EXEC_ID, makeLogLine(5, "old line"));

    const sub = manager.subscribe(EXEC_ID, 10);
    const iter = sub.asyncIterator();

    // Publish a new line after subscribe
    const newLine = makeLogLine(11, "new line");
    manager.publish(EXEC_ID, newLine);

    const result = await iter.next();
    expect(result.value).toEqual(newLine);
  });
});

// ---------------------------------------------------------------------------
// unsubscribe
// ---------------------------------------------------------------------------

describe("createSseManager — unsubscribe", () => {
  it("closes the subscriber when unsubscribed by id", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    manager.unsubscribe(EXEC_ID, sub.id);

    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("no-ops when executionId has no subscribers", () => {
    const manager = createSseManager({ logger: makeLogger() });
    // Should not throw
    expect(() => manager.unsubscribe("nonexistent-exec", "any-sub-id")).not.toThrow();
  });

  it("no-ops when subscriberId not found for a known execution", () => {
    const manager = createSseManager({ logger: makeLogger() });
    manager.subscribe(EXEC_ID);
    // Should not throw
    expect(() => manager.unsubscribe(EXEC_ID, "nonexistent-sub-id")).not.toThrow();
  });

  it("unsubscribing one subscriber does not affect others", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub1 = manager.subscribe(EXEC_ID);
    const sub2 = manager.subscribe(EXEC_ID);
    const iter2 = sub2.asyncIterator();

    manager.unsubscribe(EXEC_ID, sub1.id);

    // sub2 should still receive events
    const logLine = makeLogLine(1, "still alive");
    manager.publish(EXEC_ID, logLine);

    const result = await iter2.next();
    expect(result.value).toEqual(logLine);
  });
});

// ---------------------------------------------------------------------------
// close — explicit close on subscription
// ---------------------------------------------------------------------------

describe("createSseManager — subscription.close()", () => {
  it("terminates the async iterator when close() is called", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    sub.close();

    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("wakes a parked iterator when close() is called", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    // Park the iterator (it's waiting for data)
    const nextPromise = iter.next();

    // Close it while parked
    sub.close();

    const result = await nextPromise;
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// asyncIterator.return() — consumer-driven close
// ---------------------------------------------------------------------------

describe("createSseManager — asyncIterator.return()", () => {
  it("terminates the iterator when return() is called", async () => {
    const manager = createSseManager({ logger: makeLogger() });
    const sub = manager.subscribe(EXEC_ID);
    const iter = sub.asyncIterator();

    const result = await iter.return!();
    expect(result.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("createSseManager — edge cases", () => {
  it("publishing to an execution with no subscribers is a no-op", () => {
    const manager = createSseManager({ logger: makeLogger() });
    // Should not throw even with no subscribers
    expect(() =>
      manager.publish("exec-no-subs", makeLogLine(1, "orphan")),
    ).not.toThrow();
  });

  it("publishComplete to execution with no subscribers is a no-op", () => {
    const manager = createSseManager({ logger: makeLogger() });
    expect(() =>
      manager.publishComplete("exec-no-subs", "success", 500, 0),
    ).not.toThrow();
  });

  it("publishError to execution with no subscribers is a no-op", () => {
    const manager = createSseManager({ logger: makeLogger() });
    expect(() =>
      manager.publishError("exec-no-subs", "EXECUTION_TIMEOUT", "Timed out"),
    ).not.toThrow();
  });

  it("log events published before subscribe are buffered and replayed", async () => {
    const manager = createSseManager({ logger: makeLogger() });

    // Publish before any subscriber exists
    manager.publish(EXEC_ID, makeLogLine(1, "buffered"));

    // Subscribe now
    const sub = manager.subscribe(EXEC_ID, 0);
    const iter = sub.asyncIterator();

    const result = await iter.next();
    expect((result.value as SseLogEvent).message).toBe("buffered");
  });
});
