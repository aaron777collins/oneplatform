import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requestIdMiddleware } from "../middleware/request-id.js";

function buildApp() {
  const app = new Hono();
  app.use("*", requestIdMiddleware());
  app.get("/test", (c) => c.json({ requestId: c.var.requestId }));
  return app;
}

describe("requestIdMiddleware", () => {
  it("generates a UUID v7 request ID when none is provided", async () => {
    const res = await buildApp().request("/test");
    const body = await res.json();
    // UUID v7 format: 8-4-4-4-12 hex chars, version nibble = 7
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("sets X-Request-ID response header", async () => {
    const res = await buildApp().request("/test");
    expect(res.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("preserves an incoming X-Request-ID from upstream (e.g. Gateway forwarding)", async () => {
    const incomingId = "01917e3a-1234-7abc-8def-000000000001";
    const res = await buildApp().request("/test", {
      headers: { "X-Request-ID": incomingId },
    });
    const body = await res.json();
    expect(body.requestId).toBe(incomingId);
    expect(res.headers.get("X-Request-ID")).toBe(incomingId);
  });

  it("exposes requestId on c.var.requestId for downstream middleware", async () => {
    const res = await buildApp().request("/test");
    const body = await res.json();
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });
});
