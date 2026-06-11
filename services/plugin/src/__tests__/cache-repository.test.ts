// Unit tests for repositories/cache-repository.ts
//
// Verifies Redis key construction scoping, JSON serialisation/deserialisation,
// set with TTL, delete returning boolean, and JSON parse fallback.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CacheRepository } from "../repositories/cache-repository.js";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function makeRedis() {
  return {
    get: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
  } as unknown as import("ioredis").Redis;
}

// ---------------------------------------------------------------------------
// CacheRepository.get
// ---------------------------------------------------------------------------

describe("CacheRepository.get", () => {
  let redis: ReturnType<typeof makeRedis>;
  let repo: CacheRepository;

  beforeEach(() => {
    redis = makeRedis();
    repo = new CacheRepository(redis);
  });

  it("returns null when Redis key does not exist", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await repo.get("tenant-001", "plugin-001", "config");
    expect(result).toBeNull();
  });

  it("parses JSON string value returned from Redis", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ apiKey: "secret", retries: 3 })
    );

    const result = await repo.get("tenant-001", "plugin-001", "config");
    expect(result).toEqual({ apiKey: "secret", retries: 3 });
  });

  it("parses JSON number value", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue("42");

    const result = await repo.get("tenant-001", "plugin-001", "count");
    expect(result).toBe(42);
  });

  it("parses JSON boolean value true", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue("true");

    const result = await repo.get("tenant-001", "plugin-001", "enabled");
    expect(result).toBe(true);
  });

  it("parses JSON null value", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue("null");

    const result = await repo.get("tenant-001", "plugin-001", "data");
    expect(result).toBeNull();
  });

  it("falls back to raw string when Redis value is not valid JSON", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue("not-json-{invalid");

    const result = await repo.get("tenant-001", "plugin-001", "raw");
    expect(result).toBe("not-json-{invalid");
  });

  it("uses key format plugin:cache:{tenantId}:{pluginId}:{key}", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await repo.get("tenant-abc", "plugin-xyz", "my-key");
    const redisKey = (redis.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(redisKey).toBe("plugin:cache:tenant-abc:plugin-xyz:my-key");
  });

  it("key scoping: different tenant produces different Redis key", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await repo.get("tenant-001", "plugin-001", "config");
    await repo.get("tenant-002", "plugin-001", "config");

    const key1 = (redis.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const key2 = (redis.get as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    expect(key1).not.toBe(key2);
    expect(key1).toBe("plugin:cache:tenant-001:plugin-001:config");
    expect(key2).toBe("plugin:cache:tenant-002:plugin-001:config");
  });

  it("key scoping: different plugin produces different Redis key", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await repo.get("tenant-001", "plugin-001", "config");
    await repo.get("tenant-001", "plugin-002", "config");

    const key1 = (redis.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const key2 = (redis.get as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    expect(key1).toBe("plugin:cache:tenant-001:plugin-001:config");
    expect(key2).toBe("plugin:cache:tenant-001:plugin-002:config");
  });

  it("key scoping: different cache key produces different Redis key", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await repo.get("tenant-001", "plugin-001", "key-a");
    await repo.get("tenant-001", "plugin-001", "key-b");

    const key1 = (redis.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const key2 = (redis.get as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    expect(key1).toBe("plugin:cache:tenant-001:plugin-001:key-a");
    expect(key2).toBe("plugin:cache:tenant-001:plugin-001:key-b");
  });
});

// ---------------------------------------------------------------------------
// CacheRepository.set
// ---------------------------------------------------------------------------

describe("CacheRepository.set", () => {
  let redis: ReturnType<typeof makeRedis>;
  let repo: CacheRepository;

  beforeEach(() => {
    redis = makeRedis();
    repo = new CacheRepository(redis);
    (redis.setex as ReturnType<typeof vi.fn>).mockResolvedValue("OK");
  });

  it("calls setex with the correct key, ttl, and serialised value", async () => {
    await repo.set("tenant-001", "plugin-001", "config", { apiKey: "secret" }, 3600);

    expect(redis.setex).toHaveBeenCalledOnce();
    const [key, ttl, value] = (redis.setex as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number, string];
    expect(key).toBe("plugin:cache:tenant-001:plugin-001:config");
    expect(ttl).toBe(3600);
    expect(JSON.parse(value)).toEqual({ apiKey: "secret" });
  });

  it("serialises string value as JSON", async () => {
    await repo.set("tenant-001", "plugin-001", "greeting", "hello world", 60);

    const [, , value] = (redis.setex as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number, string];
    expect(JSON.parse(value)).toBe("hello world");
  });

  it("serialises number value as JSON", async () => {
    await repo.set("tenant-001", "plugin-001", "count", 42, 120);

    const [, , value] = (redis.setex as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number, string];
    expect(JSON.parse(value)).toBe(42);
  });

  it("serialises boolean value as JSON", async () => {
    await repo.set("tenant-001", "plugin-001", "enabled", false, 300);

    const [, , value] = (redis.setex as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number, string];
    expect(JSON.parse(value)).toBe(false);
  });

  it("serialises null value as JSON", async () => {
    await repo.set("tenant-001", "plugin-001", "data", null, 60);

    const [, , value] = (redis.setex as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number, string];
    expect(JSON.parse(value)).toBeNull();
  });

  it("uses the provided TTL value", async () => {
    await repo.set("tenant-001", "plugin-001", "k", "v", 86400);

    const [, ttl] = (redis.setex as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number, string];
    expect(ttl).toBe(86400);
  });

  it("serialises array value as JSON", async () => {
    await repo.set("tenant-001", "plugin-001", "items", [1, 2, 3], 600);

    const [, , value] = (redis.setex as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number, string];
    expect(JSON.parse(value)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// CacheRepository.delete
// ---------------------------------------------------------------------------

describe("CacheRepository.delete", () => {
  let redis: ReturnType<typeof makeRedis>;
  let repo: CacheRepository;

  beforeEach(() => {
    redis = makeRedis();
    repo = new CacheRepository(redis);
  });

  it("returns true when the key was deleted (del returns 1)", async () => {
    (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    const result = await repo.delete("tenant-001", "plugin-001", "config");
    expect(result).toBe(true);
  });

  it("returns false when the key did not exist (del returns 0)", async () => {
    (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const result = await repo.delete("tenant-001", "plugin-001", "non-existent");
    expect(result).toBe(false);
  });

  it("uses the correct Redis key for deletion", async () => {
    (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    await repo.delete("tenant-abc", "plugin-xyz", "my-key");
    const redisKey = (redis.del as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(redisKey).toBe("plugin:cache:tenant-abc:plugin-xyz:my-key");
  });

  it("returns true even when del returns a value greater than 1 (multiple keys)", async () => {
    (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    const result = await repo.delete("t", "p", "k");
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-method key consistency
// ---------------------------------------------------------------------------

describe("key consistency across get/set/delete", () => {
  it("all three methods use the same key format for the same inputs", async () => {
    const redis = makeRedis();
    const repo = new CacheRepository(redis);
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (redis.setex as ReturnType<typeof vi.fn>).mockResolvedValue("OK");
    (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

    await repo.get("t1", "p1", "k1");
    await repo.set("t1", "p1", "k1", "val", 60);
    await repo.delete("t1", "p1", "k1");

    const getKey = (redis.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const setKey = (redis.setex as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const delKey = (redis.del as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;

    expect(getKey).toBe("plugin:cache:t1:p1:k1");
    expect(setKey).toBe("plugin:cache:t1:p1:k1");
    expect(delKey).toBe("plugin:cache:t1:p1:k1");
  });
});
