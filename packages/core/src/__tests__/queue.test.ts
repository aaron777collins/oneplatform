import { describe, it, expect, vi } from "vitest";

vi.mock("bullmq", () => {
  const Queue = vi.fn().mockImplementation((name, opts) => ({ _name: name, _opts: opts }));
  const Worker = vi.fn().mockImplementation((name, processor, opts) => ({
    _name: name,
    _opts: opts,
  }));
  return { Queue, Worker };
});

describe("createQueue", () => {
  it("constructs a Queue with the given name and Redis connection", async () => {
    const { createQueue } = await import("../queue.js");
    const q = createQueue("pipeline.run", { host: "redis", port: 6379 });
    // @ts-expect-error
    expect(q._name).toBe("pipeline.run");
  });

  it("default job options include 5 retry attempts with exponential backoff", async () => {
    const { createQueue } = await import("../queue.js");
    const q = createQueue("test.queue", { host: "redis", port: 6379 });
    // @ts-expect-error
    const defaultJobOptions = q._opts.defaultJobOptions;
    expect(defaultJobOptions.attempts).toBe(5);
    expect(defaultJobOptions.backoff.type).toBe("exponential");
  });
});

describe("createWorker", () => {
  it("creates a Worker bound to the named queue", async () => {
    const { createWorker } = await import("../queue.js");
    const processor = vi.fn();
    const w = createWorker("pipeline.run", processor, { host: "redis", port: 6379 });
    // @ts-expect-error
    expect(w._name).toBe("pipeline.run");
  });

  it("configures removeOnFail to retain failed jobs for DLQ inspection", async () => {
    const { createWorker } = await import("../queue.js");
    const w = createWorker("test.queue", vi.fn(), { host: "redis", port: 6379 });
    // @ts-expect-error
    expect(w._opts.removeOnFail).toEqual({ count: 100 });
  });
});
