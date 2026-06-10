// Unit tests for schemas/index.ts
//
// Tests every exported Zod schema: valid inputs, invalid inputs, defaults,
// optional/nullable fields, and boundary conditions.

import { describe, it, expect } from "vitest";
import {
  createWebhookRequest,
  updateWebhookRequest,
  listWebhooksQuery,
  listDeliveriesQuery,
  sseQuery,
  updateRateLimitConfigRequest,
} from "../schemas/index.js";

// ---------------------------------------------------------------------------
// createWebhookRequest
// ---------------------------------------------------------------------------

describe("createWebhookRequest — valid inputs", () => {
  it("accepts a minimal valid request", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["entity.created"],
    });
    expect(result.success).toBe(true);
  });

  it("defaults enabled to true when omitted", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["entity.created"],
    });
    expect(result.success && result.data.enabled).toBe(true);
  });

  it("accepts enabled: false", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["entity.created"],
      enabled: false,
    });
    expect(result.success && result.data.enabled).toBe(false);
  });

  it("accepts an optional description", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["entity.created"],
      description: "My hook",
    });
    expect(result.success && result.data.description).toBe("My hook");
  });

  it("accepts an optional headers record", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["entity.created"],
      headers: { "X-Custom": "value" },
    });
    expect(result.success && result.data.headers).toEqual({ "X-Custom": "value" });
  });

  it("accepts exactly 50 events (max bound)", () => {
    const events = Array.from({ length: 50 }, (_, i) => `event.${i}`);
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events,
    });
    expect(result.success).toBe(true);
  });

  it("accepts exactly 1 event (min bound)", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["single.event"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a description up to 512 chars", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["e"],
      description: "a".repeat(512),
    });
    expect(result.success).toBe(true);
  });
});

describe("createWebhookRequest — invalid inputs", () => {
  it("rejects a non-URL string for url", () => {
    const result = createWebhookRequest.safeParse({
      url: "not-a-url",
      events: ["entity.created"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty string for url", () => {
    const result = createWebhookRequest.safeParse({
      url: "",
      events: ["entity.created"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when events array is empty", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when events array has 51 entries (over max)", () => {
    const events = Array.from({ length: 51 }, (_, i) => `event.${i}`);
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when any event string is empty", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["valid", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects description longer than 512 chars", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["e"],
      description: "a".repeat(513),
    });
    expect(result.success).toBe(false);
  });

  it("rejects when url is missing", () => {
    const result = createWebhookRequest.safeParse({
      events: ["entity.created"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when events is missing", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
    });
    expect(result.success).toBe(false);
  });

  it("rejects headers where a value is not a string", () => {
    const result = createWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["e"],
      headers: { "X-Key": 42 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateWebhookRequest — all fields optional
// ---------------------------------------------------------------------------

describe("updateWebhookRequest — valid inputs", () => {
  it("accepts an empty object (all optional)", () => {
    const result = updateWebhookRequest.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts url alone", () => {
    const result = updateWebhookRequest.safeParse({
      url: "https://example.com/new-hook",
    });
    expect(result.success).toBe(true);
  });

  it("accepts events alone", () => {
    const result = updateWebhookRequest.safeParse({
      events: ["entity.updated"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts description set to null (clear the field)", () => {
    const result = updateWebhookRequest.safeParse({ description: null });
    expect(result.success).toBe(true);
  });

  it("accepts headers set to null (clear custom headers)", () => {
    const result = updateWebhookRequest.safeParse({ headers: null });
    expect(result.success).toBe(true);
  });

  it("accepts enabled: false", () => {
    const result = updateWebhookRequest.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it("accepts a full update with all optional fields provided", () => {
    const result = updateWebhookRequest.safeParse({
      url: "https://example.com/hook",
      events: ["a", "b"],
      description: "updated",
      headers: { "X-Custom": "v" },
      enabled: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("updateWebhookRequest — invalid inputs", () => {
  it("rejects an invalid URL when url is provided", () => {
    const result = updateWebhookRequest.safeParse({ url: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty events array when events is provided", () => {
    const result = updateWebhookRequest.safeParse({ events: [] });
    expect(result.success).toBe(false);
  });

  it("rejects events array with more than 50 entries", () => {
    const events = Array.from({ length: 51 }, (_, i) => `event.${i}`);
    const result = updateWebhookRequest.safeParse({ events });
    expect(result.success).toBe(false);
  });

  it("rejects description longer than 512 chars", () => {
    const result = updateWebhookRequest.safeParse({ description: "a".repeat(513) });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listWebhooksQuery
// ---------------------------------------------------------------------------

describe("listWebhooksQuery", () => {
  it("defaults limit to 50 when omitted", () => {
    const result = listWebhooksQuery.safeParse({});
    expect(result.success && result.data.limit).toBe(50);
  });

  it("coerces a string limit to number", () => {
    const result = listWebhooksQuery.safeParse({ limit: "25" });
    expect(result.success && result.data.limit).toBe(25);
  });

  it("accepts limit = 1 (min bound)", () => {
    const result = listWebhooksQuery.safeParse({ limit: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts limit = 100 (max bound)", () => {
    const result = listWebhooksQuery.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
  });

  it("rejects limit = 0", () => {
    const result = listWebhooksQuery.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects limit = 101", () => {
    const result = listWebhooksQuery.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects a fractional limit", () => {
    const result = listWebhooksQuery.safeParse({ limit: 1.5 });
    expect(result.success).toBe(false);
  });

  it("accepts an optional cursor string", () => {
    const result = listWebhooksQuery.safeParse({ cursor: "some-cursor-id" });
    expect(result.success && result.data.cursor).toBe("some-cursor-id");
  });

  it("cursor is undefined when omitted", () => {
    const result = listWebhooksQuery.safeParse({});
    expect(result.success && result.data.cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listDeliveriesQuery
// ---------------------------------------------------------------------------

describe("listDeliveriesQuery", () => {
  it("defaults limit to 50 when omitted", () => {
    const result = listDeliveriesQuery.safeParse({});
    expect(result.success && result.data.limit).toBe(50);
  });

  it("accepts limit = 100 (max bound)", () => {
    const result = listDeliveriesQuery.safeParse({ limit: 100 });
    expect(result.success).toBe(true);
  });

  it("rejects limit = 101", () => {
    const result = listDeliveriesQuery.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sseQuery
// ---------------------------------------------------------------------------

describe("sseQuery — valid inputs", () => {
  it("accepts a single event type string", () => {
    const result = sseQuery.safeParse({ events: "entity.created" });
    expect(result.success).toBe(true);
  });

  it("accepts a comma-separated events string", () => {
    const result = sseQuery.safeParse({ events: "entity.created,entity.updated" });
    expect(result.success).toBe(true);
  });

  it("accepts '*' wildcard events string", () => {
    const result = sseQuery.safeParse({ events: "*" });
    expect(result.success).toBe(true);
  });

  it("accepts an optional Last-Event-ID", () => {
    const result = sseQuery.safeParse({
      events: "entity.created",
      "Last-Event-ID": "evt-123",
    });
    expect(result.success && result.data["Last-Event-ID"]).toBe("evt-123");
  });

  it("Last-Event-ID is undefined when omitted", () => {
    const result = sseQuery.safeParse({ events: "entity.created" });
    expect(result.success && result.data["Last-Event-ID"]).toBeUndefined();
  });
});

describe("sseQuery — invalid inputs", () => {
  it("rejects an empty events string", () => {
    const result = sseQuery.safeParse({ events: "" });
    expect(result.success).toBe(false);
  });

  it("rejects when events is missing", () => {
    const result = sseQuery.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateRateLimitConfigRequest
// ---------------------------------------------------------------------------

describe("updateRateLimitConfigRequest — valid tier names", () => {
  const validTiers = ["standard", "pro", "enterprise", "custom"] as const;

  for (const tier of validTiers) {
    it(`accepts tierName = '${tier}'`, () => {
      const result = updateRateLimitConfigRequest.safeParse({ tierName: tier });
      expect(result.success).toBe(true);
    });
  }
});

describe("updateRateLimitConfigRequest — invalid tier names", () => {
  it("rejects an unknown tier name", () => {
    const result = updateRateLimitConfigRequest.safeParse({ tierName: "free" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty tier name", () => {
    const result = updateRateLimitConfigRequest.safeParse({ tierName: "" });
    expect(result.success).toBe(false);
  });

  it("rejects when tierName is missing", () => {
    const result = updateRateLimitConfigRequest.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("updateRateLimitConfigRequest — optional numeric fields", () => {
  it("accepts reqPerMinTenant as a positive integer", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "standard",
      reqPerMinTenant: 100,
    });
    expect(result.success).toBe(true);
  });

  it("rejects reqPerMinTenant = 0", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "standard",
      reqPerMinTenant: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects reqPerMinTenant negative", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "standard",
      reqPerMinTenant: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts reqPerMinApiKey as a positive integer", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "pro",
      reqPerMinApiKey: 60,
    });
    expect(result.success).toBe(true);
  });

  it("accepts burstMultiplier at min (1.0)", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "pro",
      burstMultiplier: 1.0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts burstMultiplier at max (10.0)", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "pro",
      burstMultiplier: 10.0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects burstMultiplier below 1.0", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "pro",
      burstMultiplier: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it("rejects burstMultiplier above 10.0", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "pro",
      burstMultiplier: 10.1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts burstDurationSec = 1 (min)", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "enterprise",
      burstDurationSec: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts burstDurationSec = 60 (max)", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "enterprise",
      burstDurationSec: 60,
    });
    expect(result.success).toBe(true);
  });

  it("rejects burstDurationSec = 0", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "enterprise",
      burstDurationSec: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects burstDurationSec = 61", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "enterprise",
      burstDurationSec: 61,
    });
    expect(result.success).toBe(false);
  });

  it("accepts apiKeyOverrides with valid structure", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "custom",
      apiKeyOverrides: {
        "key-abc": { req_per_min: 200 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects apiKeyOverrides where req_per_min is 0", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "custom",
      apiKeyOverrides: {
        "key-abc": { req_per_min: 0 },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects apiKeyOverrides where req_per_min is negative", () => {
    const result = updateRateLimitConfigRequest.safeParse({
      tierName: "custom",
      apiKeyOverrides: {
        "key-abc": { req_per_min: -5 },
      },
    });
    expect(result.success).toBe(false);
  });
});
