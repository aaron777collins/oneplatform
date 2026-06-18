/**
 * Unit tests for gRPC-Web serialization helpers.
 *
 * Tests cover frame encoding/decoding, error mapping, and the multi-frame
 * decoder used by client-streaming handlers.
 */

import { describe, it, expect } from "vitest";
import {
  encodeDataFrame,
  encodeTrailerFrame,
  decodeDataFrame,
  decodeAllDataFrames,
  GrpcStatus,
  GrpcWebSerializationError,
  toGrpcError,
  GRPC_WEB_DATA_FRAME,
  GRPC_WEB_TRAILER_FRAME,
} from "../grpc/serialization.js";

// ---------------------------------------------------------------------------
// encodeDataFrame
// ---------------------------------------------------------------------------

describe("encodeDataFrame", () => {
  it("produces a 5-byte header + JSON payload", () => {
    const msg = { id: "123", name: "test" };
    const frame = encodeDataFrame(msg);
    expect(frame.length).toBeGreaterThan(5);
    expect(frame[0]).toBe(GRPC_WEB_DATA_FRAME);
  });

  it("encodes the payload length correctly in big-endian bytes 1–4", () => {
    const msg = { value: "hello" };
    const frame = encodeDataFrame(msg);
    const payload = Buffer.from(JSON.stringify(msg), "utf-8");
    const declaredLength = frame.readUInt32BE(1);
    expect(declaredLength).toBe(payload.length);
  });

  it("payload bytes match the JSON stringification", () => {
    const msg = { x: 42 };
    const frame = encodeDataFrame(msg);
    const payloadLength = frame.readUInt32BE(1);
    const payload = frame.subarray(5, 5 + payloadLength).toString("utf-8");
    expect(JSON.parse(payload)).toEqual(msg);
  });

  it("handles an empty object", () => {
    const frame = encodeDataFrame({});
    expect(frame[0]).toBe(GRPC_WEB_DATA_FRAME);
    const len = frame.readUInt32BE(1);
    expect(len).toBe(2); // "{}"
  });

  it("handles arrays", () => {
    const frame = encodeDataFrame([1, 2, 3]);
    const len = frame.readUInt32BE(1);
    const payload = frame.subarray(5, 5 + len).toString("utf-8");
    expect(JSON.parse(payload)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// encodeTrailerFrame
// ---------------------------------------------------------------------------

describe("encodeTrailerFrame", () => {
  it("sets the trailer frame flag (0x80)", () => {
    const frame = encodeTrailerFrame(0, "");
    expect(frame[0]).toBe(GRPC_WEB_TRAILER_FRAME);
  });

  it("embeds grpc-status and grpc-message in the payload", () => {
    const frame = encodeTrailerFrame(GrpcStatus.NOT_FOUND, "not found");
    const len = frame.readUInt32BE(1);
    const text = frame.subarray(5, 5 + len).toString("utf-8");
    expect(text).toContain("grpc-status: 5");
    expect(text).toContain("grpc-message:");
  });

  it("URL-encodes the gRPC message", () => {
    const frame = encodeTrailerFrame(GrpcStatus.INTERNAL, "error: bad input");
    const len = frame.readUInt32BE(1);
    const text = frame.subarray(5, 5 + len).toString("utf-8");
    expect(text).toContain("error%3A");
  });
});

// ---------------------------------------------------------------------------
// decodeDataFrame
// ---------------------------------------------------------------------------

describe("decodeDataFrame", () => {
  it("round-trips a message through encode+decode", () => {
    const original = { entityType: "Product", id: "abc" };
    const frame = encodeDataFrame(original);
    const decoded = decodeDataFrame(frame);
    expect(decoded).toEqual(original);
  });

  it("throws GrpcWebSerializationError for buffers shorter than 5 bytes", () => {
    expect(() => decodeDataFrame(Buffer.from([0x00, 0x00]))).toThrow(
      GrpcWebSerializationError,
    );
  });

  it("throws GrpcWebSerializationError for wrong frame flag", () => {
    const buf = Buffer.allocUnsafe(10);
    buf.writeUInt8(GRPC_WEB_TRAILER_FRAME, 0);
    buf.writeUInt32BE(5, 1);
    expect(() => decodeDataFrame(buf)).toThrow(GrpcWebSerializationError);
  });

  it("throws GrpcWebSerializationError when declared length exceeds buffer", () => {
    const buf = Buffer.allocUnsafe(9);
    buf.writeUInt8(GRPC_WEB_DATA_FRAME, 0);
    buf.writeUInt32BE(100, 1); // claims 100 bytes but only 4 follow
    expect(() => decodeDataFrame(buf)).toThrow(GrpcWebSerializationError);
  });

  it("throws GrpcWebSerializationError for non-JSON payload", () => {
    const payload = Buffer.from("not valid json!!", "utf-8");
    const header = Buffer.allocUnsafe(5);
    header.writeUInt8(GRPC_WEB_DATA_FRAME, 0);
    header.writeUInt32BE(payload.length, 1);
    const frame = Buffer.concat([header, payload]);
    expect(() => decodeDataFrame(frame)).toThrow(GrpcWebSerializationError);
  });
});

// ---------------------------------------------------------------------------
// decodeAllDataFrames
// ---------------------------------------------------------------------------

describe("decodeAllDataFrames", () => {
  it("decodes multiple consecutive data frames", () => {
    const f1 = encodeDataFrame({ n: 1 });
    const f2 = encodeDataFrame({ n: 2 });
    const f3 = encodeDataFrame({ n: 3 });
    const combined = Buffer.concat([f1, f2, f3]);
    const decoded = decodeAllDataFrames(combined);
    expect(decoded).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("skips trailer frames", () => {
    const data = encodeDataFrame({ done: true });
    const trailer = encodeTrailerFrame(GrpcStatus.OK, "");
    const combined = Buffer.concat([data, trailer]);
    const decoded = decodeAllDataFrames(combined);
    expect(decoded).toEqual([{ done: true }]);
  });

  it("returns empty array for a buffer containing only a trailer", () => {
    const trailer = encodeTrailerFrame(GrpcStatus.OK, "");
    const decoded = decodeAllDataFrames(trailer);
    expect(decoded).toEqual([]);
  });

  it("returns empty array for an empty buffer", () => {
    expect(decodeAllDataFrames(Buffer.alloc(0))).toEqual([]);
  });

  it("throws for an unknown frame flag", () => {
    const buf = Buffer.allocUnsafe(10);
    buf.writeUInt8(0x05, 0); // unknown flag
    buf.writeUInt32BE(4, 1);
    buf.fill(0x00, 5);
    expect(() => decodeAllDataFrames(buf)).toThrow(GrpcWebSerializationError);
  });

  it("stops gracefully at incomplete data frame header", () => {
    const complete = encodeDataFrame({ a: 1 });
    const truncated = complete.subarray(0, 4); // missing one header byte
    // Incomplete — should return just the already-parsed items (none here).
    const decoded = decodeAllDataFrames(truncated);
    expect(decoded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toGrpcError
// ---------------------------------------------------------------------------

describe("toGrpcError", () => {
  it("maps UnauthorizedError name to UNAUTHENTICATED", () => {
    const err = new Error("not allowed");
    err.name = "UnauthorizedError";
    const grpcErr = toGrpcError(err);
    expect(grpcErr.status).toBe(GrpcStatus.UNAUTHENTICATED);
  });

  it("maps ForbiddenError name to PERMISSION_DENIED", () => {
    const err = new Error("forbidden");
    err.name = "ForbiddenError";
    expect(toGrpcError(err).status).toBe(GrpcStatus.PERMISSION_DENIED);
  });

  it("maps NotFoundError name to NOT_FOUND", () => {
    const err = new Error("missing");
    err.name = "NotFoundError";
    expect(toGrpcError(err).status).toBe(GrpcStatus.NOT_FOUND);
  });

  it("maps ValidationError name to INVALID_ARGUMENT", () => {
    const err = new Error("bad request");
    err.name = "ValidationError";
    expect(toGrpcError(err).status).toBe(GrpcStatus.INVALID_ARGUMENT);
  });

  it("maps ServiceUnavailableError name to UNAVAILABLE", () => {
    const err = new Error("down");
    err.name = "ServiceUnavailableError";
    expect(toGrpcError(err).status).toBe(GrpcStatus.UNAVAILABLE);
  });

  it("maps generic Error to INTERNAL", () => {
    expect(toGrpcError(new Error("oops")).status).toBe(GrpcStatus.INTERNAL);
  });

  it("maps non-Error values to UNKNOWN", () => {
    expect(toGrpcError("string error").status).toBe(GrpcStatus.UNKNOWN);
    expect(toGrpcError(42).status).toBe(GrpcStatus.UNKNOWN);
    expect(toGrpcError(null).status).toBe(GrpcStatus.UNKNOWN);
  });

  it("preserves the original error message", () => {
    const err = new Error("specific problem");
    expect(toGrpcError(err).message).toBe("specific problem");
  });
});
