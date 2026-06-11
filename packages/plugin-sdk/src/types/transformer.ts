/**
 * Transformer interface and supporting types.
 *
 * A Transformer processes records in a pipeline step. The Pipeline Service calls the
 * transformer for each step that is configured to use this plugin.
 *
 * Transformers run inside the Execution Service sandbox with a context that does NOT
 * include the fetch or credentials APIs. Pipeline transformers are expected to be pure
 * data operations; external calls should be handled by connectors. This is enforced
 * by interface design — omitting those fields makes accidental misuse a compile-time error.
 */

import type { DataRecord } from "./primitives.js";
import type { TenantContext, PluginLogger, OntologyAccessor, CacheAccessor, TracingContext } from "./context.js";
import type { TransformerMetadata } from "./metadata.js";

export interface TransformerContext {
  tenant: TenantContext;
  logger: PluginLogger;
  ontology: OntologyAccessor;
  cache: CacheAccessor;
  tracing: TracingContext;

  /**
   * Present when the transformer runs inside a named pipeline run.
   * Use for logging and correlation, not for control flow.
   */
  pipelineRunId?: string;

  /** The ID of the pipeline step that invoked this transformer. */
  stageId?: string;
}

export interface Transformer {
  metadata(): TransformerMetadata;

  /**
   * Transform a single record.
   *
   * Return the (possibly modified) DataRecord to pass it downstream.
   * Return null to drop the record — it will not appear in the output.
   * Do not mutate the input record — return a new object.
   *
   * @throws PluginDataError if the record is malformed and cannot be processed.
   *         The platform will route the record to the pipeline's dead-letter queue.
   *         Do not throw for recoverable data issues — return a modified record instead.
   */
  transform(record: DataRecord, context: TransformerContext): Promise<DataRecord | null>;

  /**
   * Transform a batch of records. Optional optimization for transformers that can
   * process records more efficiently in bulk (e.g., batch enrichment API calls).
   *
   * If implemented, the platform uses this instead of calling transform() N times.
   * The result array must preserve ordering: records[i] maps to result[i] or is
   * absent (dropped). Use an empty array to drop all records.
   *
   * The platform NEVER calls both transform() and transformBatch() for the same
   * batch — it prefers transformBatch() if present.
   */
  transformBatch?(records: DataRecord[], context: TransformerContext): Promise<DataRecord[]>;
}
