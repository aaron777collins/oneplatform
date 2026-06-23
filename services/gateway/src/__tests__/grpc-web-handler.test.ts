/**
 * Unit tests for the gRPC-Web HTTP dispatcher.
 *
 * Tests use a mock Hono Context built from real Request objects so the
 * handler's content-type detection and body reading are exercised end-to-end.
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createGrpcWebHandler } from "../grpc/grpc-web-handler.js";
import { createServiceRegistry } from "../grpc/service-registry.js";
import type { ServiceDescriptor } from "../grpc/service-registry.js";
import {
  encodeDataFrame,
  encodeTrailerFrame,
  decodeAllDataFrames,
  GrpcStatus,
} from "../grpc/serialization.js";
import type { AppVariables } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<{ tenantId: string; userId: string }> = {}) {
  return {
    tenantId: overrides.tenantId ?? "tenant-1",
    userId: overrides.userId ?? "user-1",
    roles: ["viewer"],
    sub: "user-1",
  };
}

function buildGrpcRequest(
  path: string,
  body: Buffer,
  user?: ReturnType<typeof makeUser>,
): Request {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/grpc-web+json",
      "x-grpc-web": "1",
    },
    body,
  });
  return req;
}

async function invokeHandler(
  path: string,
  body: Buffer,
  user: ReturnType<typeof makeUser> | null = makeUser(),
): Promise<Response> {
  const app = new Hono<{ Variables: AppVariables }>();
  const registry = createServiceRegistry();

  // Register a simple echo descriptor
  const echoDescriptor: ServiceDescriptor = {
    name: "EchoService",
    rpcs: [
      {
        name: "Echo",
        inputType: "EchoRequest",
        outputType: "EchoResponse",
        clientStreaming: false,
        serverStreaming: false,
      },
      {
        name: "StreamEcho",
        inputType: "EchoRequest",
        outputType: "EchoResponse",
        clientStreaming: false,
        serverStreaming: true,
      },
      {
        name: "CollectEcho",
        inputType: "EchoRequest",
        outputType: "EchoResponse",
        clientStreaming: true,
        serverStreaming: false,
      },
    ],
  };

  registry.register(echoDescriptor, "test.v1", {
    Echo: async (req: unknown) => ({ echoed: (req as { message: string }).message }),
    StreamEcho: async function* (req: unknown) {
      const r = req as { message: string };
      yield { echoed: r.message + "-1" };
      yield { echoed: r.message + "-2" };
    },
    CollectEcho: async (stream: AsyncIterable<unknown>) => {
      const messages: string[] = [];
      for await (const msg of stream) {
        messages.push((msg as { message: string }).message);
      }
      return { collected: messages.join(",") };
    },
  });

  const grpcHandler = createGrpcWebHandler(registry);

  app.post("/*", async (c) => {
    // Inject user into context variables (simulates Hono JWT middleware)
    if (user !== null) {
      c.set("user", user as unknown as AppVariables["user"]);
    }
    c.set("requestId", "req-test-123");

    const response = await grpcHandler.handle(c);
    if (response === null) {
      return c.json({ error: "not handled" }, 415);
    }
    return response;
  });

  const req = buildGrpcRequest(path, body, user ?? undefined);
  return app.fetch(req);
}

// ---------------------------------------------------------------------------
// Content-type gating
// ---------------------------------------------------------------------------

describe("GrpcWebHandler content-type gating", () => {
  it("returns null (not handled) for non-gRPC-Web content-type", async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    const registry = createServiceRegistry();
    const handler = createGrpcWebHandler(registry);

    app.post("/*", async (c) => {
      const response = await handler.handle(c);
      return c.json({ handled: response !== null });
    });

    const req = new Request("http://localhost/grpc/test.v1.EchoService/Echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const res = await app.fetch(req);
    const json = await res.json() as { handled: boolean };
    expect(json.handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("GrpcWebHandler auth", () => {
  it("returns UNAUTHENTICATED trailer when user is absent", async () => {
    const frame = encodeDataFrame({ message: "hi" });
    const res = await invokeHandler(
      "/test.v1.EchoService/Echo",
      frame,
      null, // no user
    );
    // gRPC-Web always returns HTTP 200 — error is in the trailer
    expect(res.status).toBe(200);
    const grpcStatus = res.headers.get("grpc-status");
    expect(grpcStatus).toBe(String(GrpcStatus.UNAUTHENTICATED));
  });
});

// ---------------------------------------------------------------------------
// Unary dispatch
// ---------------------------------------------------------------------------

describe("GrpcWebHandler unary dispatch", () => {
  it("dispatches a unary call and returns the handler response", async () => {
    const frame = encodeDataFrame({ message: "hello" });
    const res = await invokeHandler("/test.v1.EchoService/Echo", frame);

    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const frames = decodeAllDataFrames(buf);
    expect(frames).toEqual([{ echoed: "hello" }]);
  });

  it("returns UNIMPLEMENTED status for an unregistered method", async () => {
    const frame = encodeDataFrame({ message: "hi" });
    const res = await invokeHandler("/test.v1.EchoService/NoSuchMethod", frame);

    expect(res.status).toBe(200);
    const grpcStatus = res.headers.get("grpc-status");
    expect(grpcStatus).toBe(String(GrpcStatus.UNIMPLEMENTED));
  });

  it("sets content-type to application/grpc-web+json", async () => {
    const frame = encodeDataFrame({ message: "test" });
    const res = await invokeHandler("/test.v1.EchoService/Echo", frame);
    expect(res.headers.get("content-type")).toBe("application/grpc-web+json");
  });
});

// ---------------------------------------------------------------------------
// Server-streaming dispatch
// ---------------------------------------------------------------------------

describe("GrpcWebHandler server-streaming dispatch", () => {
  it("returns multiple data frames for a server-streaming call", async () => {
    const frame = encodeDataFrame({ message: "stream-me" });
    const res = await invokeHandler("/test.v1.EchoService/StreamEcho", frame);

    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const frames = decodeAllDataFrames(buf);
    expect(frames).toEqual([
      { echoed: "stream-me-1" },
      { echoed: "stream-me-2" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Client-streaming dispatch
// ---------------------------------------------------------------------------

describe("GrpcWebHandler client-streaming dispatch", () => {
  it("feeds all client frames to the handler and returns a single response", async () => {
    const f1 = encodeDataFrame({ message: "a" });
    const f2 = encodeDataFrame({ message: "b" });
    const combined = Buffer.concat([f1, f2]);

    const res = await invokeHandler("/test.v1.EchoService/CollectEcho", combined);

    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const frames = decodeAllDataFrames(buf);
    expect(frames).toEqual([{ collected: "a,b" }]);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe("GrpcWebHandler error propagation", () => {
  it("maps a thrown NotFoundError to NOT_FOUND gRPC status", async () => {
    const notFoundDescriptor: ServiceDescriptor = {
      name: "NotFoundService",
      rpcs: [
        {
          name: "Find",
          inputType: "FindReq",
          outputType: "FindRes",
          clientStreaming: false,
          serverStreaming: false,
        },
      ],
    };

    const app = new Hono<{ Variables: AppVariables }>();
    const registry = createServiceRegistry();

    registry.register(notFoundDescriptor, "err.v1", {
      Find: async () => {
        const err = new Error("entity not found");
        err.name = "NotFoundError";
        throw err;
      },
    });

    const grpcHandler = createGrpcWebHandler(registry);

    app.post("/*", async (c) => {
      c.set("user", makeUser() as unknown as AppVariables["user"]);
      c.set("requestId", "req-err-test");
      const response = await grpcHandler.handle(c);
      return response ?? c.json({ error: "not handled" }, 415);
    });

    const frame = encodeDataFrame({ id: "missing" });
    const req = new Request("http://localhost/err.v1.NotFoundService/Find", {
      method: "POST",
      headers: { "content-type": "application/grpc-web+json" },
      body: frame,
    });

    const res = await app.fetch(req);
    expect(res.headers.get("grpc-status")).toBe(String(GrpcStatus.NOT_FOUND));
  });
});
