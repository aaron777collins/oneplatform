import { describe, it, expect, vi } from "vitest";

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation((url, config) => ({ _config: { ...config, url } }));
  return { default: Redis, Redis };
});

describe("createRedisClient", () => {
  it("passes connection URL and lazyConnect option", async () => {
    const { createRedisClient } = await import("../redis.js");
    const client = createRedisClient({
      url: "redis://op_auth:secret@redis:6379",
    });
    // @ts-expect-error — accessing mock internals
    expect(client._config.lazyConnect).toBe(true);
  });

  it("configures retry strategy with exponential backoff", async () => {
    const { createRedisClient } = await import("../redis.js");
    const client = createRedisClient({
      url: "redis://redis:6379",
    });
    // @ts-expect-error
    const retryStrategy = client._config.retryStrategy;
    expect(typeof retryStrategy).toBe("function");
    const delay = retryStrategy(1);
    expect(delay).toBeGreaterThan(0);
    const giveUp = retryStrategy(20);
    expect(giveUp).toBeNull();
  });
});
