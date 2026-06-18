/**
 * gRPC module barrel.
 *
 * Exports everything needed by the gateway index.ts to mount gRPC-Web
 * endpoints without importing internal implementation details.
 */

export { createGrpcWebHandler } from "./grpc-web-handler.js";
export type { GrpcWebHandler, RpcContext } from "./grpc-web-handler.js";
export { createServiceRegistry } from "./service-registry.js";
export type { ServiceRegistry, RpcHandler, UnaryHandler, ServerStreamHandler, ClientStreamHandler } from "./service-registry.js";
export { createDataService } from "./services/data-service.js";
export type { DataServiceDeps } from "./services/data-service.js";
export { createIngestionService } from "./services/ingestion-service.js";
export type { IngestionServiceDeps } from "./services/ingestion-service.js";
export { DataServiceDescriptor, IngestionServiceDescriptor } from "@oneplatform/sdk/grpc-types";
