/**
 * gRPC-Web client for OnePlatform high-throughput data operations.
 *
 * Provides typed methods for DataService and IngestionService over
 * gRPC-Web (HTTP + custom framing). Works in both Node.js and browser
 * environments that support the Fetch API and ReadableStream.
 *
 * Auth is shared with the main SDK client — pass the same AuthHandler
 * so tokens are refreshed transparently.
 *
 * WHY a separate client class instead of extending Transport:
 *   gRPC-Web has fundamentally different framing, content-types, and
 *   streaming semantics from the REST Transport. Mixing them into one
 *   class would make both harder to reason about and test.
 *
 * Usage:
 *   const grpc = createGrpcClient({
 *     baseUrl: 'https://api.example.com',
 *     auth: { apiKey: 'op_live_...' },
 *   });
 *
 *   const entity = await grpc.data.GetEntity({ entityType: 'Product', id: '123', tenantId: 't1' });
 *
 *   // Server-streaming
 *   for await (const entity of grpc.data.StreamEntities({ entityType: 'Product', tenantId: 't1', filterJson: '', limit: 0 })) {
 *     console.log(entity);
 *   }
 *
 *   // Client-streaming bulk ingest
 *   async function* records() { yield { connectorId: 'c1', tenantId: 't1', dataJson: '{}', externalId: '' }; }
 *   const result = await grpc.data.BulkIngest(records());
 */

import type { AuthHandler } from "./auth/api-key.js";
import { createApiKeyHandler } from "./auth/api-key.js";
import { createAccessTokenHandler } from "./auth/access-token.js";
import { ConfigurationError } from "./errors/client-errors.js";
import { OnePlatformError } from "./errors/base.js";
import { NetworkError } from "./errors/network-error.js";
import type {
  Entity,
  GetEntityRequest,
  ListEntitiesRequest,
  ListEntitiesResponse,
  CreateEntityRequest,
  UpdateEntityRequest,
  DeleteEntityRequest,
  DeleteEntityResponse,
  StreamEntitiesRequest,
  IngestRecord,
  BulkIngestResponse,
} from "./grpc-types/data.js";
import type {
  TriggerSyncRequest,
  TriggerSyncResponse,
  GetSyncStatusRequest,
  SyncStatus,
  StreamSyncEventsRequest,
  SyncEvent,
} from "./grpc-types/ingestion.js";
import type { ClientOptions } from "./types/client-options.js";

// ---------------------------------------------------------------------------
// gRPC-Web framing constants
// ---------------------------------------------------------------------------

const GRPC_WEB_DATA_FRAME_FLAG = 0x00;
const GRPC_WEB_TRAILER_FRAME_FLAG = 0x80;
const GRPC_WEB_CONTENT_TYPE = "application/grpc-web+json";

// ---------------------------------------------------------------------------
// Safety helper — decodeURIComponent on untrusted gRPC message headers can
// throw a URIError if the value contains malformed percent-encoding. Fall
// back to the raw string rather than crashing the entire call.
// ---------------------------------------------------------------------------

function safeDecodeGrpcMessage(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Framing helpers — encode / decode gRPC-Web frames on the client side.
// ---------------------------------------------------------------------------

function encodeDataFrame(message: unknown): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  // Allocate the full frame in a single ArrayBuffer so the result satisfies
  // TypeScript's strict Uint8Array<ArrayBuffer> bound (not ArrayBufferLike).
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = GRPC_WEB_DATA_FRAME_FLAG;
  // Write payload length as big-endian uint32 starting at byte 1.
  frame[1] = (payload.byteLength >>> 24) & 0xff;
  frame[2] = (payload.byteLength >>> 16) & 0xff;
  frame[3] = (payload.byteLength >>> 8) & 0xff;
  frame[4] = payload.byteLength & 0xff;
  frame.set(payload, 5);
  return frame;
}

function decodeAllDataFrames(buffer: ArrayBuffer): unknown[] {
  const results: unknown[] = [];
  const view = new DataView(buffer);
  let offset = 0;

  while (offset + 5 <= buffer.byteLength) {
    const flag = view.getUint8(offset);
    const messageLength = view.getUint32(offset + 1, false);

    if (flag === GRPC_WEB_TRAILER_FRAME_FLAG) {
      // Parse trailers to surface gRPC error status codes
      const trailerBytes = new Uint8Array(buffer, offset + 5, messageLength);
      const trailerText = new TextDecoder().decode(trailerBytes);
      const statusMatch = /grpc-status:\s*(\d+)/.exec(trailerText);
      const messageMatch = /grpc-message:\s*([^\r\n]*)/.exec(trailerText);
      const status = statusMatch ? parseInt(statusMatch[1] ?? "0", 10) : 0;
      if (status !== 0) {
        const msg = messageMatch
          ? safeDecodeGrpcMessage(messageMatch[1] ?? "")
          : `gRPC error status ${status}`;
        throw new GrpcClientError(status, msg);
      }
      offset += 5 + messageLength;
      continue;
    }

    if (flag !== GRPC_WEB_DATA_FRAME_FLAG) {
      throw new GrpcClientError(13, `Unknown frame flag 0x${flag.toString(16)} at offset ${offset}`);
    }

    if (offset + 5 + messageLength > buffer.byteLength) break;

    const payloadBytes = new Uint8Array(buffer, offset + 5, messageLength);
    const payloadText = new TextDecoder().decode(payloadBytes);
    results.push(JSON.parse(payloadText) as unknown);
    offset += 5 + messageLength;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Maps gRPC status codes to OnePlatformError-compatible error codes and
 * approximate HTTP status codes for unified error handling.
 */
const GRPC_STATUS_MAP: Record<number, { code: string; statusCode: number; retryable: boolean }> = {
  0:  { code: 'OK',                    statusCode: 200, retryable: false },
  1:  { code: 'GRPC_CANCELLED',        statusCode: 499, retryable: false },
  2:  { code: 'GRPC_UNKNOWN',          statusCode: 500, retryable: true  },
  3:  { code: 'GRPC_INVALID_ARGUMENT', statusCode: 400, retryable: false },
  4:  { code: 'GRPC_DEADLINE_EXCEEDED',statusCode: 504, retryable: true  },
  5:  { code: 'GRPC_NOT_FOUND',        statusCode: 404, retryable: false },
  6:  { code: 'GRPC_ALREADY_EXISTS',   statusCode: 409, retryable: false },
  7:  { code: 'GRPC_PERMISSION_DENIED',statusCode: 403, retryable: false },
  8:  { code: 'GRPC_RESOURCE_EXHAUSTED',statusCode: 429, retryable: true },
  9:  { code: 'GRPC_FAILED_PRECONDITION',statusCode: 400, retryable: false },
  10: { code: 'GRPC_ABORTED',          statusCode: 409, retryable: true  },
  11: { code: 'GRPC_OUT_OF_RANGE',     statusCode: 400, retryable: false },
  12: { code: 'GRPC_UNIMPLEMENTED',    statusCode: 501, retryable: false },
  13: { code: 'GRPC_INTERNAL',         statusCode: 500, retryable: true  },
  14: { code: 'GRPC_UNAVAILABLE',      statusCode: 503, retryable: true  },
  15: { code: 'GRPC_DATA_LOSS',        statusCode: 500, retryable: false },
  16: { code: 'GRPC_UNAUTHENTICATED',  statusCode: 401, retryable: false },
};

/** Thrown when the server returns a non-zero gRPC status code. */
export class GrpcClientError extends OnePlatformError {
  readonly grpcStatus: number;

  constructor(grpcStatus: number, message: string) {
    const mapped = GRPC_STATUS_MAP[grpcStatus] ?? {
      code: `GRPC_STATUS_${grpcStatus}`,
      statusCode: 500,
      retryable: false,
    };
    super({
      code: mapped.code,
      message,
      statusCode: mapped.statusCode,
      retryable: mapped.retryable,
    });
    this.grpcStatus = grpcStatus;
  }
}

// ---------------------------------------------------------------------------
// Core fetch helper
// ---------------------------------------------------------------------------

interface GrpcCallOptions {
  readonly baseUrl: string;
  readonly path: string;
  readonly authHandler: AuthHandler;
  readonly fetch: typeof globalThis.fetch;
  readonly timeout: number;
}

async function grpcUnaryCall<TReq, TRes>(
  opts: GrpcCallOptions,
  request: TReq,
): Promise<TRes> {
  const frame = encodeDataFrame(request);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);

  try {
    const authHeaders = await opts.authHandler.getHeaders();
    // Use a typed blob for BodyInit: Uint8Array<ArrayBufferLike> fails strict
    // DOM type checks in newer TypeScript. Blob accepts Uint8Array and is
    // valid BodyInit in both browsers and Node.js >=18.
    const response = await opts.fetch(`${opts.baseUrl}${opts.path}`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": GRPC_WEB_CONTENT_TYPE,
        "x-grpc-web": "1",
      },
      body: new Blob([frame]),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new GrpcClientError(13, `HTTP ${response.status} from gRPC endpoint`);
    }

    const buffer = await response.arrayBuffer();
    const frames = decodeAllDataFrames(buffer);

    if (frames.length === 0) {
      throw new GrpcClientError(13, "gRPC server returned empty response");
    }

    return frames[0] as TRes;
  } catch (err) {
    if (err instanceof GrpcClientError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new NetworkError({
        message: `gRPC call timed out after ${opts.timeout}ms`,
        reason: "timeout",
        timeoutMs: opts.timeout,
        cause: err,
      });
    }
    throw new NetworkError({
      message: err instanceof Error ? err.message : String(err),
      reason: "fetch-failed",
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode gRPC-Web data frames from partial buffer, returning decoded messages
 * and the number of bytes consumed so leftover bytes can be carried forward.
 */
function decodeFramesIncremental(buffer: Uint8Array): { messages: unknown[]; consumed: number } {
  const messages: unknown[] = [];
  let offset = 0;

  while (offset + 5 <= buffer.byteLength) {
    const flag = buffer[offset]!;
    const messageLength =
      ((buffer[offset + 1]! << 24) |
       (buffer[offset + 2]! << 16) |
       (buffer[offset + 3]! << 8) |
        buffer[offset + 4]!) >>> 0;

    // Not enough data for the full frame yet — stop and carry the remainder.
    if (offset + 5 + messageLength > buffer.byteLength) break;

    if (flag === GRPC_WEB_TRAILER_FRAME_FLAG) {
      const trailerBytes = buffer.subarray(offset + 5, offset + 5 + messageLength);
      const trailerText = new TextDecoder().decode(trailerBytes);
      const statusMatch = /grpc-status:\s*(\d+)/.exec(trailerText);
      const messageMatch = /grpc-message:\s*([^\r\n]*)/.exec(trailerText);
      const status = statusMatch ? parseInt(statusMatch[1] ?? "0", 10) : 0;
      if (status !== 0) {
        const msg = messageMatch
          ? safeDecodeGrpcMessage(messageMatch[1] ?? "")
          : `gRPC error status ${status}`;
        throw new GrpcClientError(status, msg);
      }
      offset += 5 + messageLength;
      continue;
    }

    if (flag !== GRPC_WEB_DATA_FRAME_FLAG) {
      throw new GrpcClientError(13, `Unknown frame flag 0x${flag.toString(16)} at offset ${offset}`);
    }

    const payloadBytes = buffer.subarray(offset + 5, offset + 5 + messageLength);
    const payloadText = new TextDecoder().decode(payloadBytes);
    messages.push(JSON.parse(payloadText) as unknown);
    offset += 5 + messageLength;
  }

  return { messages, consumed: offset };
}

async function* grpcServerStreamingCall<TReq, TRes>(
  opts: GrpcCallOptions,
  request: TReq,
): AsyncIterable<TRes> {
  const frame = encodeDataFrame(request);
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), opts.timeout);

  function resetIdleTimer(): void {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), opts.timeout);
  }

  try {
    const authHeaders = await opts.authHandler.getHeaders();
    const response = await opts.fetch(`${opts.baseUrl}${opts.path}`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": GRPC_WEB_CONTENT_TYPE,
        "x-grpc-web": "1",
      },
      body: new Blob([frame]),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new GrpcClientError(13, `HTTP ${response.status} from gRPC endpoint`);
    }

    resetIdleTimer();

    // Incremental frame parsing: read chunks from the response body stream and
    // yield messages as soon as complete frames arrive, rather than buffering
    // the entire response before decoding.
    if (response.body) {
      const reader = response.body.getReader();
      let leftover = new Uint8Array(0);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          resetIdleTimer();

          // Concatenate leftover bytes from previous iteration with new chunk
          const chunk = new Uint8Array(value as ArrayBuffer | Uint8Array);
          const combined = new Uint8Array(leftover.byteLength + chunk.byteLength);
          combined.set(leftover, 0);
          combined.set(chunk, leftover.byteLength);

          const { messages, consumed } = decodeFramesIncremental(combined);
          for (const msg of messages) {
            yield msg as TRes;
          }

          // Carry forward any unconsumed bytes
          leftover = combined.subarray(consumed);
        }

        // Process any remaining bytes after stream ends
        if (leftover.byteLength > 0) {
          const { messages } = decodeFramesIncremental(leftover);
          for (const msg of messages) {
            yield msg as TRes;
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      // Fallback for environments where response.body is null
      const buffer = await response.arrayBuffer();
      const frames = decodeAllDataFrames(buffer);
      for (const f of frames) {
        yield f as TRes;
      }
    }
  } catch (err) {
    if (err instanceof GrpcClientError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new NetworkError({
        message: `gRPC streaming call timed out after ${opts.timeout}ms`,
        reason: "timeout",
        timeoutMs: opts.timeout,
        cause: err,
      });
    }
    throw new NetworkError({
      message: err instanceof Error ? err.message : String(err),
      reason: "fetch-failed",
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function grpcClientStreamingCall<TReq, TRes>(
  opts: GrpcCallOptions,
  stream: AsyncIterable<TReq>,
): Promise<TRes> {
  // Collect all client messages and concatenate their frames into one body.
  // True HTTP/2 client streaming would send frames incrementally, but for
  // HTTP/1.1 compatibility we buffer all records before sending.
  const frameBuffers: Uint8Array<ArrayBuffer>[] = [];
  for await (const record of stream) {
    frameBuffers.push(encodeDataFrame(record));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);

  try {
    const authHeaders = await opts.authHandler.getHeaders();
    const response = await opts.fetch(`${opts.baseUrl}${opts.path}`, {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": GRPC_WEB_CONTENT_TYPE,
        "x-grpc-web": "1",
      },
      // Blob accepts Uint8Array<ArrayBuffer>[] as BlobPart[] for BodyInit.
      body: new Blob(frameBuffers),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new GrpcClientError(13, `HTTP ${response.status} from gRPC endpoint`);
    }

    const buffer = await response.arrayBuffer();
    const frames = decodeAllDataFrames(buffer);
    if (frames.length === 0) {
      throw new GrpcClientError(13, "gRPC server returned empty response to client-streaming call");
    }
    return frames[0] as TRes;
  } catch (err) {
    if (err instanceof GrpcClientError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new NetworkError({
        message: `gRPC client-streaming call timed out after ${opts.timeout}ms`,
        reason: "timeout",
        timeoutMs: opts.timeout,
        cause: err,
      });
    }
    throw new NetworkError({
      message: err instanceof Error ? err.message : String(err),
      reason: "fetch-failed",
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Service namespaces
// ---------------------------------------------------------------------------

/** gRPC DataService client namespace. */
export interface GrpcDataNamespace {
  GetEntity(request: GetEntityRequest): Promise<Entity>;
  ListEntities(request: ListEntitiesRequest): Promise<ListEntitiesResponse>;
  CreateEntity(request: CreateEntityRequest): Promise<Entity>;
  UpdateEntity(request: UpdateEntityRequest): Promise<Entity>;
  DeleteEntity(request: DeleteEntityRequest): Promise<DeleteEntityResponse>;
  StreamEntities(request: StreamEntitiesRequest): AsyncIterable<Entity>;
  BulkIngest(stream: AsyncIterable<IngestRecord>): Promise<BulkIngestResponse>;
}

/** gRPC IngestionService client namespace. */
export interface GrpcIngestionNamespace {
  TriggerSync(request: TriggerSyncRequest): Promise<TriggerSyncResponse>;
  GetSyncStatus(request: GetSyncStatusRequest): Promise<SyncStatus>;
  StreamSyncEvents(request: StreamSyncEventsRequest): AsyncIterable<SyncEvent>;
}

// ---------------------------------------------------------------------------
// Public client interface
// ---------------------------------------------------------------------------

/** gRPC-Web client returned by createGrpcClient(). */
export interface GrpcClient {
  readonly data: GrpcDataNamespace;
  readonly ingestion: GrpcIngestionNamespace;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GrpcClientOptions {
  /**
   * Base URL of the OnePlatform gateway — must point to the same server as
   * the REST client so gRPC-Web and REST share the same auth context.
   */
  readonly baseUrl: string;
  /**
   * Auth config — same shape as ClientOptions.auth.
   * Alternatively, pass an already-constructed AuthHandler directly via
   * `authHandler` to avoid duplicating credentials when you already have
   * a REST client instance.
   */
  readonly auth?: ClientOptions["auth"];
  /**
   * Pre-constructed auth handler. When provided, `auth` is ignored.
   * Use this to share a single auth handler between the REST and gRPC clients.
   */
  readonly authHandler?: AuthHandler;
  /** Request timeout in milliseconds. Defaults to 30 000. */
  readonly timeout?: number;
  /** Override fetch implementation (useful in tests). */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Creates a gRPC-Web client for high-throughput data operations.
 *
 * The client shares auth with the main REST client — pass the same credentials.
 *
 * @throws {@link ConfigurationError} for invalid baseUrl or auth config.
 */
export function createGrpcClient(options: GrpcClientOptions): GrpcClient {
  if (!options.baseUrl || options.baseUrl.trim() === "") {
    throw new ConfigurationError("GrpcClientOptions.baseUrl is required");
  }

  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeout = options.timeout ?? 30_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (fetchImpl === undefined) {
    throw new ConfigurationError(
      "fetch is not available. Provide a fetch implementation or upgrade to Node.js 18+.",
    );
  }

  let authHandler: AuthHandler;

  if (options.authHandler !== undefined) {
    // Caller provided a pre-constructed handler — use it directly.
    authHandler = options.authHandler;
  } else if (options.auth !== undefined) {
    const auth = options.auth;

    if ("apiKey" in auth) {
      authHandler = createApiKeyHandler(auth.apiKey);
    } else if ("accessToken" in auth) {
      authHandler = createAccessTokenHandler(auth);
    } else {
      // Browser PKCE auth is not supported for gRPC calls (no token storage in
      // the scope of this client). Use accessToken mode with PKCE-obtained tokens.
      throw new ConfigurationError(
        "gRPC client supports apiKey and accessToken auth only. " +
        "For PKCE-authenticated calls, extract the access token and use auth: { accessToken: '...' }.",
      );
    }
  } else {
    throw new ConfigurationError(
      "GrpcClientOptions requires either auth or authHandler",
    );
  }

  const callOpts: GrpcCallOptions = { baseUrl, path: "", authHandler, fetch: fetchImpl, timeout };

  const DATA_PACKAGE = "oneplatform.v1.DataService";
  const INGEST_PACKAGE = "oneplatform.v1.IngestionService";

  function opts(path: string): GrpcCallOptions {
    return { ...callOpts, path };
  }

  const data: GrpcDataNamespace = {
    GetEntity: (req) =>
      grpcUnaryCall<GetEntityRequest, Entity>(opts(`/grpc/${DATA_PACKAGE}/GetEntity`), req),

    ListEntities: (req) =>
      grpcUnaryCall<ListEntitiesRequest, ListEntitiesResponse>(
        opts(`/grpc/${DATA_PACKAGE}/ListEntities`), req,
      ),

    CreateEntity: (req) =>
      grpcUnaryCall<CreateEntityRequest, Entity>(opts(`/grpc/${DATA_PACKAGE}/CreateEntity`), req),

    UpdateEntity: (req) =>
      grpcUnaryCall<UpdateEntityRequest, Entity>(opts(`/grpc/${DATA_PACKAGE}/UpdateEntity`), req),

    DeleteEntity: (req) =>
      grpcUnaryCall<DeleteEntityRequest, DeleteEntityResponse>(
        opts(`/grpc/${DATA_PACKAGE}/DeleteEntity`), req,
      ),

    StreamEntities: (req) =>
      grpcServerStreamingCall<StreamEntitiesRequest, Entity>(
        opts(`/grpc/${DATA_PACKAGE}/StreamEntities`), req,
      ),

    BulkIngest: (stream) =>
      grpcClientStreamingCall<IngestRecord, BulkIngestResponse>(
        opts(`/grpc/${DATA_PACKAGE}/BulkIngest`), stream,
      ),
  };

  const ingestion: GrpcIngestionNamespace = {
    TriggerSync: (req) =>
      grpcUnaryCall<TriggerSyncRequest, TriggerSyncResponse>(
        opts(`/grpc/${INGEST_PACKAGE}/TriggerSync`), req,
      ),

    GetSyncStatus: (req) =>
      grpcUnaryCall<GetSyncStatusRequest, SyncStatus>(
        opts(`/grpc/${INGEST_PACKAGE}/GetSyncStatus`), req,
      ),

    StreamSyncEvents: (req) =>
      grpcServerStreamingCall<StreamSyncEventsRequest, SyncEvent>(
        opts(`/grpc/${INGEST_PACKAGE}/StreamSyncEvents`), req,
      ),
  };

  return { data, ingestion };
}
