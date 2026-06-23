// Unit tests for services/sse-service.ts
//
// Tests focus on the ring buffer (writeEvent / getBuffer), replay logic,
// pattern matching, subscriber fan-out, and the LRU eviction behaviour.
// No Redis/pub-sub is exercised — those paths require network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSseService } from "../services/sse-service.js";
import type { PlatformEvent, SseService } from "../services/sse-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

let eventCounter = 0;

function makeEvent(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  eventCounter++;
  return {
    eventId: `evt-${eventCounter}`,
    eventType: "entity.created",
    eventVersion: "1.0",
    tenantId: "tenant-1",
    timestamp: new Date().toISOString(),
    actor: { type: "user", id: "user-1" },
    data: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ring buffer: basic write and size tracking
// ---------------------------------------------------------------------------

describe("ring buffer — basic write", () => {
  let svc: SseService;

  beforeEach(() => {
    svc = createSseService({ logger: makeLogger() as never });
    svc.stopPubSubListener(); // stop the LRU interval to avoid leaks
  });

  it("creates a buffer for a new tenant after the first writeEvent", () => {
    const evt = makeEvent({ tenantId: "t-buf-1" });
    svc.writeEvent(evt);
    const buf = svc.getBuffer("t-buf-1");
    expect(buf).toBeDefined();
    expect(buf!.size).toBe(1);
  });

  it("returns undefined for a tenant that has no events yet", () => {
    expect(svc.getBuffer("no-such-tenant")).toBeUndefined();
  });

  it("increments size with each event up to RING_BUFFER_CAPACITY", () => {
    const tenantId = "t-size-track";
    for (let i = 0; i < 5; i++) {
      svc.writeEvent(makeEvent({ tenantId, eventId: `eid-${i}` }));
    }
    expect(svc.getBuffer(tenantId)!.size).toBe(5);
  });

  it("size does not exceed RING_BUFFER_CAPACITY (1000)", () => {
    const tenantId = "t-overflow";
    for (let i = 0; i < 1005; i++) {
      svc.writeEvent(makeEvent({ tenantId, eventId: `o-${i}` }));
    }
    const buf = svc.getBuffer(tenantId)!;
    expect(buf.size).toBe(1000);
  });

  it("writes events for different tenants into separate buffers", () => {
    svc.writeEvent(makeEvent({ tenantId: "ta", eventId: "ta-1" }));
    svc.writeEvent(makeEvent({ tenantId: "tb", eventId: "tb-1" }));
    expect(svc.getBuffer("ta")!.size).toBe(1);
    expect(svc.getBuffer("tb")!.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ring buffer: overflow wraps correctly (oldest events discarded)
// ---------------------------------------------------------------------------

describe("ring buffer — overflow wrap", () => {
  let svc: SseService;

  beforeEach(() => {
    svc = createSseService({ logger: makeLogger() as never });
    svc.stopPubSubListener();
  });

  it("the oldest event is evicted when capacity is exceeded", () => {
    const tenantId = "t-wrap";
    // Write 1000 events
    for (let i = 0; i < 1000; i++) {
      svc.writeEvent(makeEvent({ tenantId, eventId: `w-${i}` }));
    }
    // Write one more — w-0 should be evicted
    svc.writeEvent(makeEvent({ tenantId, eventId: "w-1000" }));

    // Attempting to replay from w-0 should return "overflow" since it is gone
    const result = svc.replay(tenantId, "w-0", ["*"]);
    expect(result).toBe("overflow");
  });

  it("the newest events are retained after overflow", () => {
    const tenantId = "t-newest";
    for (let i = 0; i < 1001; i++) {
      svc.writeEvent(makeEvent({ tenantId, eventId: `n-${i}` }));
    }
    // n-1000 is the last written event; it should be in the buffer
    const result = svc.replay(tenantId, "n-999", ["*"]);
    expect(result).not.toBe("overflow");
    expect(Array.isArray(result)).toBe(true);
    const events = result as PlatformEvent[];
    expect(events.map((e) => e.eventId)).toContain("n-1000");
  });

  it("head advances correctly after overflow (size stays 1000)", () => {
    const tenantId = "t-head-adv";
    for (let i = 0; i < 1003; i++) {
      svc.writeEvent(makeEvent({ tenantId, eventId: `h-${i}` }));
    }
    const buf = svc.getBuffer(tenantId)!;
    expect(buf.size).toBe(1000);
    // The oldest 3 events (h-0, h-1, h-2) should be gone
    expect(svc.replay(tenantId, "h-0", ["*"])).toBe("overflow");
    expect(svc.replay(tenantId, "h-1", ["*"])).toBe("overflow");
    expect(svc.replay(tenantId, "h-2", ["*"])).toBe("overflow");
    // h-3 should be present
    const result = svc.replay(tenantId, "h-3", ["*"]);
    expect(result).not.toBe("overflow");
  });
});

// ---------------------------------------------------------------------------
// replay — basic semantics
// ---------------------------------------------------------------------------

describe("replay — basic semantics", () => {
  let svc: SseService;

  beforeEach(() => {
    svc = createSseService({ logger: makeLogger() as never });
    svc.stopPubSubListener();
  });

  it("returns an empty array when the tenant has no buffer", () => {
    expect(svc.replay("nonexistent", "any-id", ["*"])).toEqual([]);
  });

  it("returns 'overflow' when lastEventId is not in the buffer", () => {
    const tenantId = "t-replay-miss";
    svc.writeEvent(makeEvent({ tenantId, eventId: "e1" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "e2" }));
    expect(svc.replay(tenantId, "not-present", ["*"])).toBe("overflow");
  });

  it("returns an empty array when lastEventId is the last event", () => {
    const tenantId = "t-replay-last";
    svc.writeEvent(makeEvent({ tenantId, eventId: "r1" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "r2" }));
    const result = svc.replay(tenantId, "r2", ["*"]);
    expect(result).toEqual([]);
  });

  it("returns all events after lastEventId", () => {
    const tenantId = "t-replay-seq";
    svc.writeEvent(makeEvent({ tenantId, eventId: "s1" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "s2" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "s3" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "s4" }));

    const result = svc.replay(tenantId, "s2", ["*"]) as PlatformEvent[];
    expect(result.map((e) => e.eventId)).toEqual(["s3", "s4"]);
  });

  it("does not include the lastEventId event itself in replay results", () => {
    const tenantId = "t-replay-excl";
    svc.writeEvent(makeEvent({ tenantId, eventId: "excl-1" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "excl-2" }));
    const result = svc.replay(tenantId, "excl-1", ["*"]) as PlatformEvent[];
    expect(result.map((e) => e.eventId)).not.toContain("excl-1");
  });

  it("returns 'overflow' when the buffer is empty (size=0)", () => {
    // Indirectly: call replay on a tenant whose buffer was just created but
    // has size=0. We cannot create an empty buffer directly, but we can check
    // via a tenant whose only event's ID doesn't match — which falls through to
    // the foundIdx === -1 branch, returning "overflow".
    const tenantId = "t-no-match";
    svc.writeEvent(makeEvent({ tenantId, eventId: "only-one" }));
    expect(svc.replay(tenantId, "wrong-id", ["*"])).toBe("overflow");
  });
});

// ---------------------------------------------------------------------------
// replay — pattern matching filter
// ---------------------------------------------------------------------------

describe("replay — pattern matching filter", () => {
  let svc: SseService;

  beforeEach(() => {
    svc = createSseService({ logger: makeLogger() as never });
    svc.stopPubSubListener();
  });

  it("wildcard '*' returns all events after lastEventId", () => {
    const tenantId = "t-pat-wild";
    svc.writeEvent(makeEvent({ tenantId, eventId: "p0", eventType: "entity.created" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "p1", eventType: "entity.updated" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "p2", eventType: "pipeline.started" }));
    const result = svc.replay(tenantId, "p0", ["*"]) as PlatformEvent[];
    expect(result.map((e) => e.eventId)).toEqual(["p1", "p2"]);
  });

  it("exact pattern returns only matching events", () => {
    const tenantId = "t-pat-exact";
    svc.writeEvent(makeEvent({ tenantId, eventId: "e0", eventType: "entity.created" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "e1", eventType: "entity.updated" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "e2", eventType: "pipeline.started" }));
    const result = svc.replay(tenantId, "e0", ["entity.updated"]) as PlatformEvent[];
    expect(result.map((e) => e.eventId)).toEqual(["e1"]);
  });

  it("glob 'entity.*' matches all entity sub-types", () => {
    const tenantId = "t-pat-glob";
    svc.writeEvent(makeEvent({ tenantId, eventId: "g0", eventType: "entity.created" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "g1", eventType: "entity.updated" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "g2", eventType: "entity.deleted" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "g3", eventType: "pipeline.started" }));
    const result = svc.replay(tenantId, "g0", ["entity.*"]) as PlatformEvent[];
    expect(result.map((e) => e.eventId)).toEqual(["g1", "g2"]);
  });

  it("multiple patterns act as a union (OR)", () => {
    const tenantId = "t-pat-multi";
    svc.writeEvent(makeEvent({ tenantId, eventId: "m0", eventType: "entity.created" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "m1", eventType: "pipeline.started" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "m2", eventType: "schedule.triggered" }));
    const result = svc.replay(
      tenantId,
      "m0",
      ["pipeline.started", "schedule.triggered"]
    ) as PlatformEvent[];
    expect(result.map((e) => e.eventId)).toEqual(["m1", "m2"]);
  });

  it("no matching pattern yields an empty array replay result", () => {
    const tenantId = "t-pat-none";
    svc.writeEvent(makeEvent({ tenantId, eventId: "n0", eventType: "entity.created" }));
    svc.writeEvent(makeEvent({ tenantId, eventId: "n1", eventType: "entity.created" }));
    const result = svc.replay(tenantId, "n0", ["unrelated.event"]) as PlatformEvent[];
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pattern matching via matchesPattern (tested indirectly through writeEvent)
// ---------------------------------------------------------------------------

describe("pattern matching — writeEvent fan-out", () => {
  let svc: SseService;

  beforeEach(() => {
    svc = createSseService({ logger: makeLogger() as never });
    svc.stopPubSubListener();
  });

  it("subscriber with '*' pattern receives all events for their tenant", () => {
    const received: string[] = [];
    const unsub = svc.subscribe({
      tenantId: "t-fan-all",
      patterns: ["*"],
      write: (data) => {
        received.push(data);
        return true;
      },
      close: vi.fn(),
    });

    svc.writeEvent(makeEvent({ tenantId: "t-fan-all", eventId: "fa-1", eventType: "any.event" }));
    svc.writeEvent(makeEvent({ tenantId: "t-fan-all", eventId: "fa-2", eventType: "other.event" }));
    unsub();

    expect(received.length).toBe(2);
  });

  it("subscriber does not receive events for a different tenant", () => {
    const received: string[] = [];
    const unsub = svc.subscribe({
      tenantId: "tenant-a",
      patterns: ["*"],
      write: (data) => {
        received.push(data);
        return true;
      },
      close: vi.fn(),
    });

    svc.writeEvent(makeEvent({ tenantId: "tenant-b", eventId: "tb-1" }));
    unsub();

    expect(received.length).toBe(0);
  });

  it("subscriber with exact pattern only receives matching events", () => {
    const received: string[] = [];
    const unsub = svc.subscribe({
      tenantId: "t-exact-sub",
      patterns: ["entity.deleted"],
      write: (data) => {
        received.push(data);
        return true;
      },
      close: vi.fn(),
    });

    svc.writeEvent(makeEvent({ tenantId: "t-exact-sub", eventId: "es-1", eventType: "entity.created" }));
    svc.writeEvent(makeEvent({ tenantId: "t-exact-sub", eventId: "es-2", eventType: "entity.deleted" }));
    unsub();

    expect(received.length).toBe(1);
    expect(received[0]).toContain("entity.deleted");
  });

  it("subscriber with glob 'pipeline.*' only receives pipeline events", () => {
    const received: string[] = [];
    const unsub = svc.subscribe({
      tenantId: "t-glob-sub",
      patterns: ["pipeline.*"],
      write: (data) => {
        received.push(data);
        return true;
      },
      close: vi.fn(),
    });

    svc.writeEvent(makeEvent({ tenantId: "t-glob-sub", eventId: "gs-1", eventType: "entity.created" }));
    svc.writeEvent(makeEvent({ tenantId: "t-glob-sub", eventId: "gs-2", eventType: "pipeline.started" }));
    svc.writeEvent(makeEvent({ tenantId: "t-glob-sub", eventId: "gs-3", eventType: "pipeline.completed" }));
    unsub();

    expect(received.length).toBe(2);
  });

  it("subscriber that returns false from write is removed", () => {
    let callCount = 0;
    const closeFn = vi.fn();
    svc.subscribe({
      tenantId: "t-remove-sub",
      patterns: ["*"],
      write: () => {
        callCount++;
        return false; // signal that the connection is dead
      },
      close: closeFn,
    });

    svc.writeEvent(makeEvent({ tenantId: "t-remove-sub", eventId: "rm-1" }));
    svc.writeEvent(makeEvent({ tenantId: "t-remove-sub", eventId: "rm-2" }));

    // close() should have been called once and write() called once
    expect(callCount).toBe(1);
    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops fan-out", () => {
    const received: string[] = [];
    const unsub = svc.subscribe({
      tenantId: "t-unsub",
      patterns: ["*"],
      write: (data) => {
        received.push(data);
        return true;
      },
      close: vi.fn(),
    });

    svc.writeEvent(makeEvent({ tenantId: "t-unsub", eventId: "u1" }));
    unsub();
    svc.writeEvent(makeEvent({ tenantId: "t-unsub", eventId: "u2" }));

    expect(received.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pattern matching — matchesPattern edge cases
// ---------------------------------------------------------------------------

describe("matchesPattern — edge cases (via writeEvent)", () => {
  let svc: SseService;

  beforeEach(() => {
    svc = createSseService({ logger: makeLogger() as never });
    svc.stopPubSubListener();
  });

  it("'pipeline.*' pattern matches 'pipeline' (prefix itself equals prefix)", () => {
    // The code: if (eventType.startsWith(prefix + ".") || eventType === prefix)
    const received: string[] = [];
    const unsub = svc.subscribe({
      tenantId: "t-prefix-self",
      patterns: ["pipeline.*"],
      write: (d) => {
        received.push(d);
        return true;
      },
      close: vi.fn(),
    });
    svc.writeEvent(makeEvent({ tenantId: "t-prefix-self", eventId: "ps1", eventType: "pipeline" }));
    unsub();
    expect(received.length).toBe(1);
  });

  it("'entity.*' does not match 'entity_created' (underscore, not dot)", () => {
    const received: string[] = [];
    const unsub = svc.subscribe({
      tenantId: "t-no-underscore",
      patterns: ["entity.*"],
      write: (d) => {
        received.push(d);
        return true;
      },
      close: vi.fn(),
    });
    svc.writeEvent(makeEvent({ tenantId: "t-no-underscore", eventId: "nu1", eventType: "entity_created" }));
    unsub();
    expect(received.length).toBe(0);
  });

  it("exact match is case-sensitive", () => {
    const received: string[] = [];
    const unsub = svc.subscribe({
      tenantId: "t-case",
      patterns: ["Entity.Created"],
      write: (d) => {
        received.push(d);
        return true;
      },
      close: vi.fn(),
    });
    svc.writeEvent(makeEvent({ tenantId: "t-case", eventId: "c1", eventType: "entity.created" }));
    unsub();
    expect(received.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction — oldest buffer is evicted when LRU_MAX_TENANTS is reached
// ---------------------------------------------------------------------------

describe("LRU eviction", () => {
  it("evicts the least-recently-accessed buffer when 500 tenant limit is exceeded", () => {
    const svc = createSseService({ logger: makeLogger() as never });
    svc.stopPubSubListener();

    // Fill up to 500 tenants
    for (let i = 0; i < 500; i++) {
      svc.writeEvent(makeEvent({ tenantId: `lru-tenant-${i}`, eventId: `le-${i}` }));
    }

    // lru-tenant-0 was written first — it should be the eviction candidate
    // once we add tenant 500.
    const oldestBufBefore = svc.getBuffer("lru-tenant-0");
    expect(oldestBufBefore).toBeDefined();

    // Adding one more tenant triggers eviction
    svc.writeEvent(makeEvent({ tenantId: "lru-new-tenant", eventId: "lru-new" }));

    // lru-tenant-0 should have been evicted (oldest lastAccessedAt)
    expect(svc.getBuffer("lru-tenant-0")).toBeUndefined();
    // The new tenant's buffer should exist
    expect(svc.getBuffer("lru-new-tenant")).toBeDefined();
  });
});
