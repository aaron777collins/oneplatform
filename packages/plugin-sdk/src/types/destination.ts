/**
 * Destination interface and supporting types.
 *
 * A Destination writes mapped, ontology-typed records to an external system.
 * The Ingestion Service calls destinations after a record has been validated,
 * mapped to an ontology entity, and committed to the platform data store.
 * Destinations may receive both upsert and delete operations.
 */

import type { MappedRecord } from "./primitives.js";
import type {
  TenantContext,
  PluginLogger,
  CacheAccessor,
  FetchProxy,
  TracingContext,
} from "./context.js";
import type { DestinationMetadata } from "./metadata.js";

export interface WriteResult {
  /** Count of records successfully written. */
  written: number;

  /** Count of records that failed. */
  failed: number;

  /**
   * Per-record error details for failed records.
   * Include the sourceId so the platform can correlate failures to records.
   * Do not include credential values in the error string.
   */
  errors: Array<{ sourceId: string; error: string }>;
}

export interface DestinationContext {
  tenant: TenantContext;
  logger: PluginLogger;
  cache: CacheAccessor;
  fetch: FetchProxy;
  tracing: TracingContext;
}

export interface Destination {
  metadata(): DestinationMetadata;

  /**
   * Write a batch of mapped records to the destination.
   *
   * The platform calls this with batches sized according to the destination's
   * delivery guarantee. For at-least-once destinations, the same record may be
   * delivered more than once (e.g., after a retry). The destination must handle
   * idempotent writes if its DestinationMetadata.deliveryGuarantee is
   * "at-least-once" or "exactly-once".
   *
   * Never partially fail silently — report all failures in WriteResult.errors.
   * The platform uses this to trigger DLQ routing.
   */
  write(records: MappedRecord[], context: DestinationContext): Promise<WriteResult>;

  /**
   * Stream records to the destination. Only implement if
   * DestinationMetadata.supportsStreaming is true.
   *
   * The platform provides an AsyncIterable of records. The destination should
   * maintain an open connection to the target system and write records as they
   * arrive. Return a WriteResult when the stream is exhausted.
   */
  writeStream?(
    stream: AsyncIterable<MappedRecord>,
    context: DestinationContext,
  ): Promise<WriteResult>;
}
