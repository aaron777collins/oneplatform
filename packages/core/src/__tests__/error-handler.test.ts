// packages/core/src/__tests__/error-handler.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { errorHandlerMiddleware } from "../middleware/error-handler.js";
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  InternalError,
} from "../errors.js";

function buildApp() {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", (c, next) => { c.set("requestId", "req-test-123"); return next(); });
  // In Hono v4, route errors bypass middleware try/catch — app.onError is the
  // correct hook for catching errors thrown inside route handlers (spec §6).
  app.onError(errorHandlerMiddleware());
  return app;
}

describe("errorHandlerMiddleware", () => {
  it("serializes NotFoundError to { error: { code, message, requestId } } with 404", async () => {
    const app = buildApp();
    app.get("/missing", () => { throw new NotFoundError("Item not found."); });
    const res = await app.request("/missing");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Item not found.");
    expect(body.error.requestId).toBe("req-test-123");
  });

  it("serializes ValidationError with details", async () => {
    const app = buildApp();
    app.post("/items", () => {
      throw new ValidationError("Name is required.", { field: "name" });
    });
    const res = await app.request("/items", { method: "POST" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual({ field: "name" });
  });

  it("hides the real message for InternalError — prevents leaking internals", async () => {
    const app = buildApp();
    app.get("/crash", () => {
      throw new InternalError("SELECT password FROM users WHERE id = 1");
    });
    const res = await app.request("/crash");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe("An unexpected error occurred.");
    expect(body.error.message).not.toContain("SELECT");
  });

  it("converts unknown errors to InternalError (never leaks stack traces)", async () => {
    const app = buildApp();
    app.get("/kaboom", () => {
      throw new TypeError("Cannot read properties of undefined");
    });
    const res = await app.request("/kaboom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // The raw JS error message must not appear in the response
    expect(body.error.message).not.toContain("Cannot read");
    expect(body.error.message).toBe("An unexpected error occurred.");
  });

  it("serializes UnauthorizedError with 401", async () => {
    const app = buildApp();
    app.get("/secure", () => { throw new UnauthorizedError("Token expired."); });
    const res = await app.request("/secure");
    expect(res.status).toBe(401);
  });
});
