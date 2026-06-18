/**
 * gRPC-Web service registry.
 *
 * The registry maps "ServiceName/MethodName" paths to their handler functions.
 * It is the single source of truth for which gRPC methods are available
 * behind /grpc/oneplatform.v1.* — adding a service is a one-line call.
 *
 * WHY a registry instead of per-route declarations:
 *   gRPC-Web has a single HTTP path schema (/package.ServiceName/MethodName)
 *   with content-type negotiation. A registry lets the single dispatcher in
 *   grpc-web-handler.ts route all calls, rather than duplicating the framing
 *   logic in each route handler.
 */

import type { RpcDescriptor, ServiceDescriptor } from "@oneplatform/sdk/grpc-types";

// Re-export the shared descriptor types so callers import from one place.
export type { RpcDescriptor, ServiceDescriptor };

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

/**
 * Unary RPC handler: receives a decoded request message and returns a response.
 */
export type UnaryHandler<TReq = unknown, TRes = unknown> = (
  request: TReq,
) => Promise<TRes>;

/**
 * Server-streaming RPC handler: receives a decoded request and returns an
 * AsyncIterable that yields response messages until exhausted.
 */
export type ServerStreamHandler<TReq = unknown, TRes = unknown> = (
  request: TReq,
) => AsyncIterable<TRes>;

/**
 * Client-streaming RPC handler: receives an AsyncIterable of request messages
 * (decoded from the framed HTTP body) and returns a single response.
 */
export type ClientStreamHandler<TReq = unknown, TRes = unknown> = (
  stream: AsyncIterable<TReq>,
) => Promise<TRes>;

/** Union of all supported handler signatures. */
export type RpcHandler =
  | UnaryHandler
  | ServerStreamHandler
  | ClientStreamHandler;

// ---------------------------------------------------------------------------
// Registration entry
// ---------------------------------------------------------------------------

export interface RegistrationEntry {
  readonly descriptor: RpcDescriptor;
  readonly handler: RpcHandler;
}

// ---------------------------------------------------------------------------
// ServiceRegistry
// ---------------------------------------------------------------------------

export interface ServiceRegistry {
  /**
   * Register all RPC methods for a service.
   *
   * The handlers object must supply a handler for every rpc in the descriptor.
   * This is not statically enforced here (avoiding heavy generics) but the
   * grpc-web-handler will return UNIMPLEMENTED for any method whose key is
   * absent from handlers.
   */
  register(
    descriptor: ServiceDescriptor,
    packageName: string,
    handlers: Record<string, RpcHandler>,
  ): void;

  /** Look up a handler by its full gRPC path "/{package}.{Service}/{Method}". */
  lookup(path: string): RegistrationEntry | null;

  /** All registered paths (useful for health checks and diagnostics). */
  registeredPaths(): string[];
}

export function createServiceRegistry(): ServiceRegistry {
  const entries = new Map<string, RegistrationEntry>();

  function register(
    descriptor: ServiceDescriptor,
    packageName: string,
    handlers: Record<string, RpcHandler>,
  ): void {
    for (const rpc of descriptor.rpcs) {
      const path = `/${packageName}.${descriptor.name}/${rpc.name}`;
      const handler = handlers[rpc.name];

      if (handler === undefined) {
        // Fail loudly at startup rather than silently returning UNIMPLEMENTED
        // at call time, which would be harder to diagnose.
        throw new Error(
          `ServiceRegistry.register: missing handler for ${path}. ` +
          `Provide a handler for every rpc in the descriptor.`,
        );
      }

      entries.set(path, { descriptor: rpc, handler });
    }
  }

  function lookup(path: string): RegistrationEntry | null {
    return entries.get(path) ?? null;
  }

  function registeredPaths(): string[] {
    return Array.from(entries.keys()).sort();
  }

  return { register, lookup, registeredPaths };
}
