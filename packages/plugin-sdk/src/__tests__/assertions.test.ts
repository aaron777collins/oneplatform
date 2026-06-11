import { describe, it, expect } from "vitest";
import { assertValidPlugin, assertValidMetadata } from "../testing/assertions.js";

// ────────────────────────────────────────────────────────────────────────────
// Minimal stub implementations for testing the assertion helpers
// ────────────────────────────────────────────────────────────────────────────

const minimalConnector = {
  metadata: () => ({
    type: "connector",
    id: "com.example.connector",
    name: "Test Connector",
    description: "A test connector plugin",
    version: "1.0.0",
    author: "Test Author",
    configSchema: {},
    category: "other",
    outputSchema: {},
    supportsIncremental: false,
    supportsRealtime: false,
  }),
  connect: async () => ({ connectionId: "c1", metadata: {} }),
  fetchBatch: async () => ({
    records: [],
    nextCursor: null,
    hasMore: false,
    fetchedAt: new Date().toISOString(),
  }),
  disconnect: async () => undefined,
};

const minimalTransformer = {
  metadata: () => ({
    type: "transformer",
    id: "com.example.transformer",
    name: "Test Transformer",
    description: "A test transformer plugin",
    version: "1.0.0",
    author: "Test Author",
    configSchema: {},
    idempotent: true,
  }),
  transform: async () => null,
};

describe("assertValidPlugin", () => {
  it("does not throw for a valid connector", () => {
    expect(() => assertValidPlugin(minimalConnector, "connector")).not.toThrow();
  });

  it("does not throw for a valid transformer", () => {
    expect(() => assertValidPlugin(minimalTransformer, "transformer")).not.toThrow();
  });

  it("throws if plugin is not an object", () => {
    expect(() => assertValidPlugin(null, "connector")).toThrow(/expected an object/);
    expect(() => assertValidPlugin("string", "connector")).toThrow(/expected an object/);
  });

  it("throws if a required method is missing", () => {
    const { disconnect: _ignored, ...partial } = minimalConnector;
    expect(() => assertValidPlugin(partial, "connector")).toThrow(/disconnect/);
  });

  it("throws if metadata().type does not match expectedType", () => {
    const wrongType = {
      ...minimalConnector,
      metadata: () => ({ ...minimalConnector.metadata(), type: "transformer" }),
    };
    expect(() => assertValidPlugin(wrongType, "connector")).toThrow(/metadata.*type/i);
  });

  it("throws for null plugin", () => {
    expect(() => assertValidPlugin(null, "transformer")).toThrow();
  });
});

describe("assertValidMetadata", () => {
  it("does not throw for valid metadata", () => {
    const meta = minimalConnector.metadata();
    expect(() => assertValidMetadata(meta)).not.toThrow();
  });

  it("throws if id is missing", () => {
    const { id: _ignored, ...noId } = minimalConnector.metadata();
    expect(() => assertValidMetadata(noId)).toThrow(/id/);
  });

  it("throws if type is invalid", () => {
    expect(() =>
      assertValidMetadata({ ...minimalConnector.metadata(), type: "invalid-type" }),
    ).toThrow(/type/);
  });

  it("throws if description is too short", () => {
    expect(() =>
      assertValidMetadata({ ...minimalConnector.metadata(), description: "short" }),
    ).toThrow(/description/);
  });

  it("throws if name is too short", () => {
    expect(() =>
      assertValidMetadata({ ...minimalConnector.metadata(), name: "X" }),
    ).toThrow(/name/);
  });

  it("throws for non-object input", () => {
    expect(() => assertValidMetadata(null)).toThrow();
    expect(() => assertValidMetadata(42)).toThrow();
  });
});
