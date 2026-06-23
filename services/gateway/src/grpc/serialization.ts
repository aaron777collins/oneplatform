/**
 * gRPC-Web serialization helpers.
 *
 * WHY JSON framing instead of binary protobuf:
 *   Binary protobuf needs generated codec code (protoc output) which adds
 *   native-build dependencies. JSON-in-gRPC-Web-envelope gives us the
 *   correct wire framing for future binary migration without blocking current
 *   delivery. The content-type is set to "application/grpc-web+json" so
 *   intermediaries and clients can negotiate.
 *
 * gRPC-Web data frame format (big-endian):
 *   byte 0    — flags: 0x00 = data frame, 0x80 = trailer frame
 *   bytes 1-4 — message length (uint32, big-endian)
 *   bytes 5+  — message payload
 */

// ---------------------------------------------------------------------------
// Frame encoding / decoding
// ---------------------------------------------------------------------------

/** gRPC-Web frame type flags. */
export const GRPC_WEB_DATA_FRAME = 0x00;
export const GRPC_WEB_TRAILER_FRAME = 0x80;

/**
 * Encode a JSON-serializable message into a gRPC-Web data frame.
 *
 * Returns a Buffer containing the 5-byte header followed by the UTF-8 payload.
 */
export function encodeDataFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(GRPC_WEB_DATA_FRAME, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Encode a gRPC-Web trailer frame containing the gRPC status headers.
 *
 * Trailers are encoded as HTTP/1.1-style headers separated by \r\n.
 */
export function encodeTrailerFrame(
  grpcStatus: number,
  grpcMessage: string,
): Buffer {
  const trailerText = `grpc-status: ${grpcStatus}\r\ngrpc-message: ${encodeURIComponent(grpcMessage)}\r\n`;
  const payload = Buffer.from(trailerText, "utf-8");
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(GRPC_WEB_TRAILER_FRAME, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Decode a gRPC-Web data frame from a Buffer.
 *
 * Returns the parsed JSON payload. Throws if the frame flag or length is
 * inconsistent with a well-formed data frame.
 */
export function decodeDataFrame(buffer: Buffer): unknown {
  if (buffer.length < 5) {
    throw new GrpcWebSerializationError(
      `Frame too short: expected at least 5 bytes, got ${buffer.length}`,
    );
  }

  const flag = buffer.readUInt8(0);
  if (flag !== GRPC_WEB_DATA_FRAME) {
    throw new GrpcWebSerializationError(
      `Unexpected frame flag 0x${flag.toString(16).padStart(2, "0")} — expected data frame (0x00)`,
    );
  }

  const messageLength = buffer.readUInt32BE(1);
  if (buffer.length < 5 + messageLength) {
    throw new GrpcWebSerializationError(
      `Frame body truncated: header declares ${messageLength} bytes but buffer only has ${buffer.length - 5}`,
    );
  }

  const payloadSlice = buffer.subarray(5, 5 + messageLength);
  try {
    return JSON.parse(payloadSlice.toString("utf-8")) as unknown;
  } catch (err) {
    throw new GrpcWebSerializationError(
      `Failed to parse frame payload as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Decode all complete data frames from a streaming Buffer.
 *
 * Used by the client-streaming handler to process a body that may contain
 * multiple concatenated gRPC-Web frames sent in a single HTTP request.
 */
export function decodeAllDataFrames(buffer: Buffer): unknown[] {
  const results: unknown[] = [];
  let offset = 0;

  while (offset + 5 <= buffer.length) {
    const flag = buffer.readUInt8(offset);

    // Skip trailer frames — they carry status metadata, not business data.
    if (flag === GRPC_WEB_TRAILER_FRAME) {
      if (offset + 5 > buffer.length) break;
      const trailerLength = buffer.readUInt32BE(offset + 1);
      offset += 5 + trailerLength;
      continue;
    }

    if (flag !== GRPC_WEB_DATA_FRAME) {
      throw new GrpcWebSerializationError(
        `Unknown frame flag 0x${flag.toString(16).padStart(2, "0")} at offset ${offset}`,
      );
    }

    if (offset + 5 > buffer.length) break; // incomplete header
    const messageLength = buffer.readUInt32BE(offset + 1);

    if (offset + 5 + messageLength > buffer.length) break; // incomplete body

    const payloadSlice = buffer.subarray(offset + 5, offset + 5 + messageLength);
    try {
      results.push(JSON.parse(payloadSlice.toString("utf-8")) as unknown);
    } catch (err) {
      throw new GrpcWebSerializationError(
        `Failed to parse frame at offset ${offset}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    offset += 5 + messageLength;
  }

  return results;
}

// ---------------------------------------------------------------------------
// gRPC status codes — subset used in this implementation
// ---------------------------------------------------------------------------

/** Standard gRPC status codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html). */
export enum GrpcStatus {
  OK = 0,
  CANCELLED = 1,
  UNKNOWN = 2,
  INVALID_ARGUMENT = 3,
  NOT_FOUND = 5,
  ALREADY_EXISTS = 6,
  PERMISSION_DENIED = 7,
  RESOURCE_EXHAUSTED = 8,
  // Code 12 must be distinct from INTERNAL (13): clients treat INTERNAL as
  // transient and will retry in a loop, but UNIMPLEMENTED is permanent and
  // clients should not retry. Without this distinction, any unregistered method
  // causes infinite retry storms from well-behaved gRPC clients.
  UNIMPLEMENTED = 12,
  INTERNAL = 13,
  UNAVAILABLE = 14,
  UNAUTHENTICATED = 16,
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a frame cannot be decoded due to bad length or non-JSON payload. */
export class GrpcWebSerializationError extends Error {
  override readonly name = "GrpcWebSerializationError";

  constructor(message: string) {
    super(message);
  }
}

/** Structured gRPC error returned to the client via trailer frame. */
export interface GrpcError {
  readonly status: GrpcStatus;
  readonly message: string;
}

/**
 * Maps an application-level Error to a GrpcError.
 *
 * The mapping intentionally keeps the error message terse — verbose internal
 * details should not be surfaced to external callers.
 */
export function toGrpcError(err: unknown): GrpcError {
  if (err instanceof Error) {
    // Use error name as a heuristic to pick the right status code so clients
    // can programmatically branch on the status without string matching.
    if (err.name === "UnauthorizedError") {
      return { status: GrpcStatus.UNAUTHENTICATED, message: err.message };
    }
    if (err.name === "ForbiddenError") {
      return { status: GrpcStatus.PERMISSION_DENIED, message: err.message };
    }
    if (err.name === "NotFoundError") {
      return { status: GrpcStatus.NOT_FOUND, message: err.message };
    }
    if (err.name === "ValidationError") {
      return { status: GrpcStatus.INVALID_ARGUMENT, message: err.message };
    }
    if (err.name === "ServiceUnavailableError") {
      return { status: GrpcStatus.UNAVAILABLE, message: err.message };
    }
    return { status: GrpcStatus.INTERNAL, message: err.message };
  }
  return { status: GrpcStatus.UNKNOWN, message: String(err) };
}
