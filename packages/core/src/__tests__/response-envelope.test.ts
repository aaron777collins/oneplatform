// packages/core/src/__tests__/response-envelope.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { responseEnvelopeMiddleware } from "../middleware/response-envelope.js";

describe("responseEnvelopeMiddleware", () => {
  it("wraps a plain object return in { data: ... }", async () => {
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.get("/items", (c) => c.json({ id: "1", name: "Widget" }));
    const res = await app.request("/items");
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body.data).toMatchObject({ id: "1", name: "Widget" });
  });

  it("wraps a route that returns c.json directly", async () => {
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.get("/ping", (c) => c.json({ pong: true }));
    const res = await app.request("/ping");
    const body = await res.json();
    expect(body.data.pong).toBe(true);
  });

  it("does not double-wrap if data key is already present at top level", async () => {
    // Routes that already return { data: T } (e.g. paginated list endpoints or
    // proxied upstream responses) must not be wrapped again. The middleware skips
    // wrapping when the top-level body already contains a "data" key.
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.get("/list", (c) => c.json({ data: [1, 2], pagination: { nextCursor: null, total: 2 } }));
    const res = await app.request("/list");
    const body = await res.json();
    // The middleware must NOT wrap — the response already has { data: ... }
    expect(body).toMatchObject({ data: [1, 2], pagination: { nextCursor: null, total: 2 } });
  });

  it("passes through non-JSON responses unchanged (e.g. 204 No Content)", async () => {
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.delete("/items/1", (c) => new Response(null, { status: 204 }));
    const res = await app.request("/items/1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("does not wrap error responses (error handler takes precedence)", async () => {
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    // Simulate a response that already has the error shape set directly
    app.get("/err", (c) => c.json({ error: { code: "NOT_FOUND", message: "x", requestId: "r" } }, 404));
    const res = await app.request("/err");
    const body = await res.json();
    // Response envelope must not double-wrap error responses
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("data");
  });
});
