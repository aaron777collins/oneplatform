// AUTO-GENERATED barrel — do not edit by hand.

export * from "./data.js";
export * from "./ingestion.js";

// Descriptor types — RpcDescriptor and ServiceDescriptor are defined in both
// descriptor files. Export from data.descriptor as the canonical source, then
// explicitly re-export the ingestion-specific exports to avoid ambiguity.
export type { RpcDescriptor, ServiceDescriptor } from "./data.descriptor.js";
export { DataServiceDescriptor } from "./data.descriptor.js";
export type { DataServiceImpl } from "./data.descriptor.js";

export { IngestionServiceDescriptor } from "./ingestion.descriptor.js";
export type { IngestionServiceImpl } from "./ingestion.descriptor.js";
