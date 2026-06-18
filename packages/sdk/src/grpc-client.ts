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
          ? decodeURIComponent(messageMatch[1] ?? "")
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

/** Thrown when the server returns a non-zero gRPC status code. */
export class GrpcClientError extends Error {
  override readonly name = "GrpcClientError";
  readonly grpcStatus: number;

  constructor(grpcStatus: number, message: string) {
    super(message);
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

async function* grpcServerStreamingCall<TReq, TRes>(
  opts: GrpcCallOptions,
  request: TReq,
): AsyncIterable<TRes> {
  const frame = encodeDataFrame(request);
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
      body: new Blob([frame]),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new GrpcClientError(13, `HTTP ${response.status} from gRPC endpoint`);
    }

    const buffer = await response.arrayBuffer();
    const frames = decodeAllDataFrames(buffer);
    for (const f of frames) {
      yield f as TRes;
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
  /** Auth config — same shape as ClientOptions.auth. */
  readonly auth: ClientOptions["auth"];
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

  if (options.auth === undefined) {
    throw new ConfigurationError("GrpcClientOptions.auth is required");
  }

  let authHandler: AuthHandler;
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
