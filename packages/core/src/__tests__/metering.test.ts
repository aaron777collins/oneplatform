// Unit tests for the metering middleware.
//
// The middleware must be zero-latency: it calls next() first, then records
// asynchronously. Tests verify skip logic and that the recorder is called
// with the correct arguments.

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { meteringMiddleware } from "../middleware/metering.js";
import type { AppVariables } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecorder() {
  return {
    recordApiCall: vi.fn(),
  };
}

function makeApp(recorder: ReturnType<typeof makeRecorder>, skipPaths?: string[]) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", meteringMiddleware({ recorder, ...(skipPaths ? { skipPaths } : {}) }));

  // Inject a user context for authenticated routes
  app.use("/api/*", async (c, next) => {
    c.set("user", {
      userId: "user-1",
      tenantId: "tenant-1",
      roles: ["developer"],
      scopes: ["data:read"],
      isGuest: false,
      isService: false,
      emailVerified: true,
    });
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) => c.json({ ok: true }));
  app.get("/api/v1/data", (c) => c.json({ data: [] }));
  app.get("/api/v1/usage", (c) => c.json({ data: {} }));
  app.get("/unauthenticated", (c) => c.json({ data: "public" }));

  return app;
}

// ---------------------------------------------------------------------------
// Skip logic
// ---------------------------------------------------------------------------

describe("meteringMiddleware — skip paths", () => {
  it("does not record /healthz", async () => {
    const recorder = makeRecorder();
    const app = makeApp(recorder);

    await app.request("/healthz");

    expect(recorder.recordApiCall).not.toHaveBeenCalled();
  });

  it("does not record /readyz", async () => {
    const recorder = makeRecorder();
    const app = makeApp(recorder);

    await app.request("/readyz");

    expect(recorder.recordApiCall).not.toHaveBeenCalled();
  });

  it("does not record custom skip paths", async () => {
    const recorder = makeRecorder();
    const app = makeApp(recorder, ["/api/v1/usage"]);

    // Inject auth for this specific test
    await app.request("/api/v1/usage", {
      headers: { Authorization: "Bearer token" },
    });

    expect(recorder.recordApiCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Authenticated requests are metered
// ---------------------------------------------------------------------------

describe("meteringMiddleware — authenticated requests", () => {
  it("records the tenantId, path, and method for authenticated requests", async () => {
    const recorder = makeRecorder();
    const app = makeApp(recorder);

    await app.request("/api/v1/data");

    expect(recorder.recordApiCall).toHaveBeenCalledOnce();
    expect(recorder.recordApiCall).toHaveBeenCalledWith(
      "tenant-1",
      "/api/v1/data",
      "GET",
    );
  });

  it("does not record unauthenticated requests (no tenantId)", async () => {
    const recorder = makeRecorder();
    const app = makeApp(recorder);

    await app.request("/unauthenticated");

    // No c.var.user is set for this route, so it must be skipped
    expect(recorder.recordApiCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-blocking: next() completes before recording
// ---------------------------------------------------------------------------

describe("meteringMiddleware — non-blocking behaviour", () => {
  it("calls next() before recording so response latency is unaffected", async () => {
    const callOrder: string[] = [];

    const recorder = {
      recordApiCall: vi.fn(() => {
        callOrder.push("recorded");
      }),
    };

    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", meteringMiddleware({ recorder }));
    app.use("/api/*", async (c, next) => {
      c.set("user", {
        userId: "u",
        tenantId: "t",
        roles: [],
        scopes: [],
        isGuest: false,
        isService: false,
        emailVerified: true,
      });
      await next();
    });
    app.get("/api/v1/test", (c) => {
      callOrder.push("handler");
      return c.json({ ok: true });
    });

    await app.request("/api/v1/test");

    // Handler executes before recording; both must be present
    expect(callOrder).toEqual(["handler", "recorded"]);
  });
});
