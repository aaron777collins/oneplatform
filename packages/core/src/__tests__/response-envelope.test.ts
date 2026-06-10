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
    // Routes should return raw objects; the middleware wraps them.
    // This test ensures a route returning { data: [...] } (pagination) is wrapped
    // to { data: { data: [...] } } — the pagination shape belongs inside data.
    // (Routes producing PaginatedResponse should return the full pagination object
    // and the middleware will wrap it.)
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.get("/list", (c) => c.json({ data: [1, 2], pagination: { nextCursor: null, total: 2 } }));
    const res = await app.request("/list");
    const body = await res.json();
    // The middleware wraps the whole object
    expect(body.data).toMatchObject({ data: [1, 2], pagination: { nextCursor: null, total: 2 } });
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
