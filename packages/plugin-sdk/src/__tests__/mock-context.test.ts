import { describe, it, expect } from "vitest";
import { createMockContext } from "../testing/mock-context.js";
import { PluginAuthError } from "../types/errors.js";

describe("createMockContext", () => {
  describe("defaults", () => {
    it("creates a context with default tenant values", () => {
      const ctx = createMockContext();
      expect(ctx.tenant.tenantId).toBe("test-tenant");
      expect(ctx.tenant.tenantName).toBe("Test Tenant");
      expect(ctx.tenant.instanceId).toBe("test-instance");
      expect(ctx.tenant.config).toEqual({});
    });
  });

  describe("credentials", () => {
    it("returns credential value for known credential name", async () => {
      const ctx = createMockContext({ credentials: { apiKey: "secret-123" } });
      const value = await ctx.credentials.get("apiKey");
      expect(value).toBe("secret-123");
    });

    it("throws PluginAuthError for unknown credential name", async () => {
      const ctx = createMockContext({ credentials: {} });
      await expect(ctx.credentials.get("missing")).rejects.toBeInstanceOf(PluginAuthError);
    });

    it("tracks credential get() calls", async () => {
      const ctx = createMockContext({ credentials: { apiKey: "k" } });
      await ctx.credentials.get("apiKey");
      expect(ctx.credentials.__calls).toContainEqual({ name: "apiKey" });
    });

    it("lists available credential names", async () => {
      const ctx = createMockContext({ credentials: { a: "1", b: "2" } });
      const names = await ctx.credentials.list();
      expect(names).toContain("a");
      expect(names).toContain("b");
    });
  });

  describe("fetch", () => {
    it("returns 200 OK by default without hitting the network", async () => {
      const ctx = createMockContext();
      const response = await ctx.fetch.fetch("https://api.example.com/data");
      expect(response.status).toBe(200);
    });

    it("tracks outbound fetch calls", async () => {
      const ctx = createMockContext();
      await ctx.fetch.fetch("https://api.example.com/orders", { method: "GET" });
      expect(ctx.fetch.__calls).toContainEqual(
        expect.objectContaining({ url: "https://api.example.com/orders" }),
      );
    });

    it("uses custom fetchHandler when provided", async () => {
      const ctx = createMockContext({
        fetchHandler: async () => new Response("custom", { status: 201 }),
      });
      const response = await ctx.fetch.fetch("https://api.example.com/");
      expect(response.status).toBe(201);
    });
  });

  describe("cache", () => {
    it("returns null for missing keys", async () => {
      const ctx = createMockContext();
      const value = await ctx.cache.get<string>("missing");
      expect(value).toBeNull();
    });

    it("stores and retrieves values", async () => {
      const ctx = createMockContext();
      await ctx.cache.set("key", { foo: "bar" });
      const value = await ctx.cache.get<{ foo: string }>("key");
      expect(value).toEqual({ foo: "bar" });
    });

    it("deletes keys", async () => {
      const ctx = createMockContext();
      await ctx.cache.set("key", "value");
      await ctx.cache.delete("key");
      const value = await ctx.cache.get("key");
      expect(value).toBeNull();
    });

    it("lock always succeeds and release is a no-op", async () => {
      const ctx = createMockContext();
      const lock = await ctx.cache.lock("my-lock", 30);
      expect(lock).not.toBeNull();
      await lock?.release(); // must not throw
    });

    it("separate contexts have independent caches", async () => {
      const ctx1 = createMockContext();
      const ctx2 = createMockContext();
      await ctx1.cache.set("key", "ctx1-value");
      const value = await ctx2.cache.get("key");
      expect(value).toBeNull();
    });
  });

  describe("logger", () => {
    it("captures log entries at all levels", () => {
      const ctx = createMockContext();
      ctx.logger.debug("debug msg");
      ctx.logger.info("info msg");
      ctx.logger.warn("warn msg");
      ctx.logger.error("error msg");

      expect(ctx.logger.__logs).toHaveLength(4);
      expect(ctx.logger.__logs[0]).toMatchObject({ level: "debug", message: "debug msg" });
      expect(ctx.logger.__logs[1]).toMatchObject({ level: "info", message: "info msg" });
      expect(ctx.logger.__logs[2]).toMatchObject({ level: "warn", message: "warn msg" });
      expect(ctx.logger.__logs[3]).toMatchObject({ level: "error", message: "error msg" });
    });

    it("captures log metadata", () => {
      const ctx = createMockContext();
      ctx.logger.info("processing", { sourceId: "abc-123" });
      expect(ctx.logger.__logs[0]).toMatchObject({
        metadata: { sourceId: "abc-123" },
      });
    });
  });

  describe("tracing", () => {
    it("injectHeaders appends a traceparent header", () => {
      const ctx = createMockContext();
      const result = ctx.tracing.injectHeaders({ "Content-Type": "application/json" });
      expect(result["traceparent"]).toBeDefined();
      expect(result["Content-Type"]).toBe("application/json");
    });

    it("startSpan records spans and setAttribute calls", () => {
      const ctx = createMockContext();
      const span = ctx.tracing.startSpan("fetchOrders");
      span.setAttribute("order.count", 42);
      span.end();

      expect(ctx.tracing.__spans).toHaveLength(1);
      expect(ctx.tracing.__spans[0]?.name).toBe("fetchOrders");
      expect(ctx.tracing.__spans[0]?.ended).toBe(true);
      expect(ctx.tracing.__spans[0]?.attributes).toContainEqual({
        key: "order.count",
        value: 42,
      });
    });
  });

  describe("ontology", () => {
    it("returns empty schema by default", async () => {
      const ctx = createMockContext();
      const schema = await ctx.ontology.getSchema();
      expect(schema.entityTypes).toHaveLength(0);
    });

    it("returns custom ontology schema when provided", async () => {
      const ontologySchema = {
        entityTypes: [
          {
            name: "Customer",
            displayName: "Customer",
            fields: [
              { name: "id", type: "string" as const, required: true },
            ],
            primaryKey: "id",
          },
        ],
        version: 1,
        updatedAt: "2026-01-01T00:00:00Z",
      };

      const ctx = createMockContext({ ontologySchema });
      const schema = await ctx.ontology.getSchema();
      expect(schema.entityTypes).toHaveLength(1);
      expect(schema.entityTypes[0]?.name).toBe("Customer");
    });

    it("getEntitySchema returns null for unknown types", async () => {
      const ctx = createMockContext();
      const entity = await ctx.ontology.getEntitySchema("Unknown");
      expect(entity).toBeNull();
    });
  });
});
