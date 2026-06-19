// Unit tests for guest-session-service.ts
// Covers: create(), validate().

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";

function makeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("GuestSessionService.create()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns a guestToken that is exactly 64 hex characters", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const svc = createGuestSessionService({ redis: makeRedis() });
    const result = await svc.create("tenant-1", "app-1");
    expect(result.guestToken).toHaveLength(64);
    expect(result.guestToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the session in Redis with a 24-hour TTL", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const redis = makeRedis();
    const svc = createGuestSessionService({ redis });
    await svc.create("tenant-1", "app-1");
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^guest-session:/),
      expect.any(String),
      "EX",
      86_400,
    );
  });

  it("serialises tenantId and appId in the stored payload", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    let storedPayload: string | undefined;
    const redis = makeRedis({
      set: vi.fn().mockImplementation((_key: string, value: string) => {
        storedPayload = value;
        return Promise.resolve("OK");
      }),
    });
    const svc = createGuestSessionService({ redis });
    await svc.create("tenant-abc", "app-xyz");
    expect(storedPayload).toBeDefined();
    const parsed = JSON.parse(storedPayload!);
    expect(parsed.tenantId).toBe("tenant-abc");
    expect(parsed.appId).toBe("app-xyz");
  });

  it("includes ipAddress in stored payload when provided", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    let storedPayload: string | undefined;
    const redis = makeRedis({
      set: vi.fn().mockImplementation((_key: string, value: string) => {
        storedPayload = value;
        return Promise.resolve("OK");
      }),
    });
    const svc = createGuestSessionService({ redis });
    await svc.create("tenant-1", "app-1", "192.168.1.1");
    const parsed = JSON.parse(storedPayload!);
    expect(parsed.ipAddress).toBe("192.168.1.1");
  });

  it("does not include ipAddress key when not provided", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    let storedPayload: string | undefined;
    const redis = makeRedis({
      set: vi.fn().mockImplementation((_key: string, value: string) => {
        storedPayload = value;
        return Promise.resolve("OK");
      }),
    });
    const svc = createGuestSessionService({ redis });
    await svc.create("tenant-1", "app-1");
    const parsed = JSON.parse(storedPayload!);
    expect(Object.prototype.hasOwnProperty.call(parsed, "ipAddress")).toBe(false);
  });

  it("returns an expiresAt date approximately 24h in the future", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const svc = createGuestSessionService({ redis: makeRedis() });
    const before = Date.now();
    const result = await svc.create("tenant-1", "app-1");
    const after = Date.now();
    const expectedMin = before + 86_400 * 1_000;
    const expectedMax = after + 86_400 * 1_000;
    const actualMs = result.expiresAt.getTime();
    expect(actualMs).toBeGreaterThanOrEqual(expectedMin);
    expect(actualMs).toBeLessThanOrEqual(expectedMax);
  });

  it("generates unique tokens on successive calls", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const svc = createGuestSessionService({ redis: makeRedis() });
    const r1 = await svc.create("tenant-1", "app-1");
    const r2 = await svc.create("tenant-1", "app-1");
    expect(r1.guestToken).not.toBe(r2.guestToken);
  });

  it("throws when tenantId is empty", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const svc = createGuestSessionService({ redis: makeRedis() });
    await expect(svc.create("", "app-1")).rejects.toThrow("tenantId is required");
  });

  it("throws when appId is empty", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const svc = createGuestSessionService({ redis: makeRedis() });
    await expect(svc.create("tenant-1", "")).rejects.toThrow("appId is required");
  });
});

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

describe("GuestSessionService.validate()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the parsed payload for a valid 64-char hex token", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const payload = JSON.stringify({
      tenantId: "tenant-1",
      appId: "app-1",
      createdAt: new Date().toISOString(),
    });
    const token = "a".repeat(64);
    const redis = makeRedis({
      get: vi.fn().mockImplementation((key: string) => {
        if (key === `guest-session:${token}`) return Promise.resolve(payload);
        return Promise.resolve(null);
      }),
    });
    const svc = createGuestSessionService({ redis });
    const result = await svc.validate(token);
    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe("tenant-1");
    expect(result!.appId).toBe("app-1");
  });

  it("returns null when the token is not found in Redis (expired or never created)", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const redis = makeRedis({ get: vi.fn().mockResolvedValue(null) });
    const svc = createGuestSessionService({ redis });
    expect(await svc.validate("b".repeat(64))).toBeNull();
  });

  it("returns null for a token shorter than 64 chars", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const redis = makeRedis();
    const svc = createGuestSessionService({ redis });
    expect(await svc.validate("short")).toBeNull();
    // Redis should not have been called
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("returns null for a token longer than 64 chars", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const redis = makeRedis();
    const svc = createGuestSessionService({ redis });
    expect(await svc.validate("c".repeat(65))).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("returns null for an empty string token", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const redis = makeRedis();
    const svc = createGuestSessionService({ redis });
    expect(await svc.validate("")).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("returns null when Redis contains corrupt JSON", async () => {
    const { createGuestSessionService } = await import("../services/guest-session-service.js");
    const token = "d".repeat(64);
    const redis = makeRedis({
      get: vi.fn().mockResolvedValue("not-valid-json{{{"),
    });
    const svc = createGuestSessionService({ redis });
    expect(await svc.validate(token)).toBeNull();
  });
});
