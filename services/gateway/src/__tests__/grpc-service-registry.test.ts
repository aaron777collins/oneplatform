/**
 * Unit tests for gRPC-Web ServiceRegistry.
 *
 * The registry is pure logic with no I/O — all tests are synchronous.
 */

import { describe, it, expect } from "vitest";
import { createServiceRegistry } from "../grpc/service-registry.js";
import type { ServiceDescriptor, RpcHandler } from "../grpc/service-registry.js";

// ---------------------------------------------------------------------------
// Minimal test descriptors
// ---------------------------------------------------------------------------

const unaryDescriptor: ServiceDescriptor = {
  name: "TestService",
  rpcs: [
    {
      name: "DoThing",
      inputType: "DoThingRequest",
      outputType: "DoThingResponse",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "StreamThings",
      inputType: "StreamRequest",
      outputType: "ThingMessage",
      clientStreaming: false,
      serverStreaming: true,
    },
  ],
};

const clientStreamDescriptor: ServiceDescriptor = {
  name: "IngestService",
  rpcs: [
    {
      name: "BulkUpload",
      inputType: "UploadRecord",
      outputType: "UploadSummary",
      clientStreaming: true,
      serverStreaming: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("ServiceRegistry.register", () => {
  it("registers all rpcs from a descriptor under the correct paths", () => {
    const registry = createServiceRegistry();
    const doThingHandler: RpcHandler = async () => ({});
    const streamHandler: RpcHandler = async function* () { yield {}; };

    registry.register(unaryDescriptor, "oneplatform.v1", {
      DoThing: doThingHandler,
      StreamThings: streamHandler,
    });

    expect(registry.lookup("/oneplatform.v1.TestService/DoThing")).not.toBeNull();
    expect(registry.lookup("/oneplatform.v1.TestService/StreamThings")).not.toBeNull();
  });

  it("throws when a handler is missing for a declared rpc", () => {
    const registry = createServiceRegistry();
    expect(() =>
      registry.register(unaryDescriptor, "oneplatform.v1", {
        DoThing: async () => ({}),
        // StreamThings intentionally missing
      }),
    ).toThrow(/missing handler/i);
  });

  it("supports multiple services registered under different packages", () => {
    const registry = createServiceRegistry();
    registry.register(unaryDescriptor, "pkg.v1", {
      DoThing: async () => ({}),
      StreamThings: async function* () { yield {}; },
    });
    registry.register(clientStreamDescriptor, "pkg.v1", {
      BulkUpload: async (_stream: AsyncIterable<unknown>) => ({}),
    });

    expect(registry.lookup("/pkg.v1.TestService/DoThing")).not.toBeNull();
    expect(registry.lookup("/pkg.v1.IngestService/BulkUpload")).not.toBeNull();
  });

  it("overwrites a previously registered handler for the same path", () => {
    const registry = createServiceRegistry();
    const handlerA: RpcHandler = async () => ({ version: "A" });
    const handlerB: RpcHandler = async () => ({ version: "B" });

    const singleRpcDescriptor: ServiceDescriptor = {
      name: "SvcA",
      rpcs: [
        {
          name: "Call",
          inputType: "Req",
          outputType: "Res",
          clientStreaming: false,
          serverStreaming: false,
        },
      ],
    };

    registry.register(singleRpcDescriptor, "x", { Call: handlerA });
    registry.register(singleRpcDescriptor, "x", { Call: handlerB });

    const entry = registry.lookup("/x.SvcA/Call");
    expect(entry?.handler).toBe(handlerB);
  });
});

// Declare the unused import to avoid noUnusedLocals issue in strict tests.
const _unused = clientStreamDescriptor;

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

describe("ServiceRegistry.lookup", () => {
  it("returns null for unknown paths", () => {
    const registry = createServiceRegistry();
    expect(registry.lookup("/oneplatform.v1.Unknown/Method")).toBeNull();
  });

  it("returns null for empty string path", () => {
    const registry = createServiceRegistry();
    expect(registry.lookup("")).toBeNull();
  });

  it("returns the correct handler for a registered path", () => {
    const registry = createServiceRegistry();
    const handler: RpcHandler = async () => ({ ok: true });
    registry.register(unaryDescriptor, "test", {
      DoThing: handler,
      StreamThings: async function* () { yield {}; },
    });

    const entry = registry.lookup("/test.TestService/DoThing");
    expect(entry).not.toBeNull();
    expect(entry?.handler).toBe(handler);
  });

  it("returns the descriptor with correct streaming flags", () => {
    const registry = createServiceRegistry();
    registry.register(unaryDescriptor, "test", {
      DoThing: async () => ({}),
      StreamThings: async function* () { yield {}; },
    });

    const unaryEntry = registry.lookup("/test.TestService/DoThing");
    expect(unaryEntry?.descriptor.serverStreaming).toBe(false);
    expect(unaryEntry?.descriptor.clientStreaming).toBe(false);

    const streamEntry = registry.lookup("/test.TestService/StreamThings");
    expect(streamEntry?.descriptor.serverStreaming).toBe(true);
    expect(streamEntry?.descriptor.clientStreaming).toBe(false);
  });

  it("lookup is case-sensitive for paths", () => {
    const registry = createServiceRegistry();
    registry.register(unaryDescriptor, "test", {
      DoThing: async () => ({}),
      StreamThings: async function* () { yield {}; },
    });

    // Wrong case should not match
    expect(registry.lookup("/test.TestService/dothing")).toBeNull();
    expect(registry.lookup("/TEST.TestService/DoThing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registeredPaths
// ---------------------------------------------------------------------------

describe("ServiceRegistry.registeredPaths", () => {
  it("returns all registered paths sorted alphabetically", () => {
    const registry = createServiceRegistry();
    registry.register(unaryDescriptor, "z.pkg", {
      DoThing: async () => ({}),
      StreamThings: async function* () { yield {}; },
    });
    registry.register(clientStreamDescriptor, "a.pkg", {
      BulkUpload: async (_stream: AsyncIterable<unknown>) => ({}),
    });

    const paths = registry.registeredPaths();
    expect(paths.length).toBe(3);
    expect(paths).toEqual([...paths].sort());
  });

  it("returns empty array for an empty registry", () => {
    const registry = createServiceRegistry();
    expect(registry.registeredPaths()).toEqual([]);
  });
});
