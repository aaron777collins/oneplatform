/**
 * gRPC-Web HTTP dispatcher.
 *
 * Accepts incoming HTTP requests whose Content-Type begins with
 * "application/grpc-web" and routes them to the appropriate handler in the
 * ServiceRegistry.
 *
 * WHY a dispatcher instead of individual Hono routes per method:
 *   gRPC-Web uses a fixed path schema (/{package}.{Service}/{Method}).
 *   A single dispatcher catches all /grpc/* paths and delegates, keeping
 *   framing/deframing logic in one place.
 *
 * Request framing:
 *   The dispatcher reads the entire HTTP body into a Buffer, decodes the
 *   gRPC-Web data frames, and passes the decoded JSON message(s) to the
 *   handler. For server-streaming responses, it writes each frame to a
 *   ReadableStream followed by the trailer frame.
 *
 * Auth:
 *   The standard Hono JWT middleware runs before this handler on all /grpc/*
 *   routes. The authenticated user is extracted from c.var.user and passed
 *   to handlers via the request context. Unauthenticated requests are
 *   rejected with UNAUTHENTICATED before any handler is invoked.
 */

import type { Context } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import type { ServiceRegistry, RpcContext } from "./service-registry.js";
import {
  encodeDataFrame,
  encodeTrailerFrame,
  decodeDataFrame,
  decodeAllDataFrames,
  GrpcStatus,
  toGrpcError,
} from "./serialization.js";

// Re-export RpcContext so callers can import it from grpc-web-handler.ts,
// which is the canonical home from the external API perspective.
export type { RpcContext };

// The gRPC-Web content-type prefix. Both "application/grpc-web" and
// "application/grpc-web+json" are accepted.
const GRPC_WEB_CONTENT_TYPE_PREFIX = "application/grpc-web";

// gRPC-Web response content type we emit.
const GRPC_WEB_RESPONSE_CONTENT_TYPE = "application/grpc-web+json";

// Status code returned when no handler is registered for the requested path.
const UNIMPLEMENTED_STATUS = GrpcStatus.INTERNAL;
const UNIMPLEMENTED_MESSAGE = "method not implemented";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GrpcWebHandler {
  /**
   * Returns a Response when the request looks like a gRPC-Web call and was
   * processed. Returns null when the content-type does not match,
   * allowing the caller to fall through to REST routes.
   */
  handle(c: Context<{ Variables: AppVariables }>): Promise<Response | null>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGrpcWebHandler(registry: ServiceRegistry): GrpcWebHandler {
  async function handle(
    c: Context<{ Variables: AppVariables }>,
  ): Promise<Response | null> {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith(GRPC_WEB_CONTENT_TYPE_PREFIX)) {
      return null;
    }

    // Auth guard — the Hono JWT middleware populates c.var.user on success.
    // We re-check here so gRPC-Web errors use gRPC status codes, not HTTP 401.
    const user = c.var.user;
    if (!user?.tenantId || !user?.userId) {
      return writeErrorResponse(
        c,
        GrpcStatus.UNAUTHENTICATED,
        "authentication required",
      );
    }

    const rpcContext: RpcContext = {
      tenantId: user.tenantId,
      userId: user.userId,
      roles: user.roles ?? [],
      requestId: c.var.requestId ?? "",
    };

    const url = new URL(c.req.url);
    const path = url.pathname;

    const entry = registry.lookup(path);
    if (entry === null) {
      return writeErrorResponse(c, UNIMPLEMENTED_STATUS, UNIMPLEMENTED_MESSAGE);
    }

    try {
      const bodyBuffer = await readBodyBuffer(c);

      if (entry.descriptor.clientStreaming) {
        return await handleClientStreamingRpc(c, entry, bodyBuffer, rpcContext);
      } else if (entry.descriptor.serverStreaming) {
        return await handleServerStreamingRpc(c, entry, bodyBuffer, rpcContext);
      } else {
        return await handleUnaryRpc(c, entry, bodyBuffer, rpcContext);
      }
    } catch (err) {
      const grpcError = toGrpcError(err);
      return writeErrorResponse(c, grpcError.status, grpcError.message);
    }
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// RPC dispatch helpers
// ---------------------------------------------------------------------------

async function handleUnaryRpc(
  c: Context<{ Variables: AppVariables }>,
  entry: ReturnType<ServiceRegistry["lookup"]> & object,
  bodyBuffer: Buffer,
  ctx: RpcContext,
): Promise<Response> {
  const request = decodeDataFrame(bodyBuffer);

  // Type safety: the registry guarantees this is a UnaryHandler when
  // clientStreaming and serverStreaming are both false.
  // Pass ctx so handlers can enforce tenant isolation using the verified JWT
  // identity rather than trusting the tenant ID in the request body.
  const handler = entry.handler as (req: unknown, ctx: RpcContext) => Promise<unknown>;
  const response = await handler(request, ctx);

  const dataFrame = encodeDataFrame(response);
  const trailerFrame = encodeTrailerFrame(GrpcStatus.OK, "");
  const body = concatToArrayBuffer([dataFrame, trailerFrame]);

  c.header("content-type", GRPC_WEB_RESPONSE_CONTENT_TYPE);
  c.header("grpc-status", "0");
  return c.body(body, 200);
}

async function handleServerStreamingRpc(
  c: Context<{ Variables: AppVariables }>,
  entry: ReturnType<ServiceRegistry["lookup"]> & object,
  bodyBuffer: Buffer,
  ctx: RpcContext,
): Promise<Response> {
  const request = decodeDataFrame(bodyBuffer);

  // Pass ctx so handlers can enforce tenant isolation using the verified JWT
  // identity rather than trusting the tenant ID in the request body.
  const handler = entry.handler as (req: unknown, ctx: RpcContext) => AsyncIterable<unknown>;
  const stream = handler(request, ctx);

  // Collect all frames into a single buffer so the HTTP response can include
  // the correct Content-Length. True HTTP/2 streaming would push frames
  // incrementally — this is the HTTP/1.1-compatible approach.
  const frames: Buffer[] = [];
  for await (const message of stream) {
    frames.push(encodeDataFrame(message));
  }
  frames.push(encodeTrailerFrame(GrpcStatus.OK, ""));

  const body = concatToArrayBuffer(frames);
  c.header("content-type", GRPC_WEB_RESPONSE_CONTENT_TYPE);
  c.header("grpc-status", "0");
  return c.body(body, 200);
}

async function handleClientStreamingRpc(
  c: Context<{ Variables: AppVariables }>,
  entry: ReturnType<ServiceRegistry["lookup"]> & object,
  bodyBuffer: Buffer,
  ctx: RpcContext,
): Promise<Response> {
  const records = decodeAllDataFrames(bodyBuffer);

  // Wrap the decoded records array as an AsyncIterable so handler signatures
  // remain consistent regardless of how records arrive.
  const stream = (async function* (): AsyncGenerator<unknown> {
    for (const record of records) {
      yield record;
    }
  })();

  // Pass ctx so handlers can enforce tenant isolation using the verified JWT
  // identity rather than trusting the tenant ID in the request body.
  const handler = entry.handler as (s: AsyncIterable<unknown>, ctx: RpcContext) => Promise<unknown>;
  const response = await handler(stream, ctx);

  const dataFrame = encodeDataFrame(response);
  const trailerFrame = encodeTrailerFrame(GrpcStatus.OK, "");
  const body = concatToArrayBuffer([dataFrame, trailerFrame]);

  c.header("content-type", GRPC_WEB_RESPONSE_CONTENT_TYPE);
  c.header("grpc-status", "0");
  return c.body(body, 200);
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

async function readBodyBuffer(
  c: Context<{ Variables: AppVariables }>,
): Promise<Buffer> {
  const arrayBuffer = await c.req.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Concatenate one or more Node.js Buffers into a plain ArrayBuffer.
 *
 * Hono's c.body() accepts ArrayBuffer (part of the DOM BodyInit type).
 * Node's Buffer is Uint8Array<ArrayBufferLike> which strict DOM types reject,
 * so we copy into a fresh ArrayBuffer that satisfies the type constraint.
 */
function concatToArrayBuffer(buffers: Buffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const result = new ArrayBuffer(total);
  const view = new Uint8Array(result);
  let offset = 0;
  for (const buf of buffers) {
    view.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

function writeErrorResponse(
  c: Context<{ Variables: AppVariables }>,
  status: GrpcStatus,
  message: string,
): Response {
  // gRPC-Web errors are still HTTP 200 with the error in the trailer frame.
  // Clients check grpc-status, not the HTTP status code.
  const trailerFrame = encodeTrailerFrame(status, message);
  c.header("content-type", GRPC_WEB_RESPONSE_CONTENT_TYPE);
  c.header("grpc-status", String(status));
  c.header("grpc-message", encodeURIComponent(message));
  return c.body(concatToArrayBuffer([trailerFrame]), 200);
}
