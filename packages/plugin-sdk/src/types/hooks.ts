/**
 * Hook declaration interface and supporting types.
 *
 * HookDeclaration maps directly to entries in plugin.manifest.json's hooks array.
 * Hooks are registered at plugin-enable time and deregistered at disable time by
 * the Plugin Service.
 */

/**
 * All valid hook stages. The pattern is "{timing}:{domain}.{event}" or
 * "{timing}:{domain}.{event}:{stepId}" for parameterized pipeline step hooks.
 *
 * Timing: "before" = before the stage executes; "after" = after the stage executes.
 */
export type HookStage =
  // Ingestion Service
  | "before:ingestion.receive"
  | "after:ingestion.receive"
  | "before:ingestion.validate"
  | "after:ingestion.validate"
  | "before:ingestion.enrich"
  | "after:ingestion.enrich"
  | "before:ingestion.stage"
  | "after:ingestion.stage"
  // Ontology Service
  | "before:ontology.map"
  | "after:ontology.map"
  | "before:ontology.normalize"
  | "after:ontology.normalize"
  // Pipeline Service
  | "before:pipeline.trigger"
  | "after:pipeline.trigger"
  | "before:pipeline.step"
  | "after:pipeline.step"
  | "before:pipeline.complete"
  | "after:pipeline.complete"
  // Execution Service
  // "setup" = the pre-run wiring phase; "teardown" = the post-run cleanup phase
  | "before:execution.setup"
  | "after:execution.setup"
  | "before:execution.teardown"
  | "after:execution.teardown"
  // Auth Service
  | "before:auth.login"
  | "after:auth.login"
  | "after:auth.logout"
  | "before:auth.token.issue"
  | "after:auth.token.issue"
  // App Service
  | "before:app.request"
  | "after:app.request"
  | "before:app.build"
  | "after:app.build"
  // Parameterized pipeline step (stepId substituted at registration time)
  | `before:pipeline.step:${string}`
  | `after:pipeline.step:${string}`;

export interface HookDeclaration {
  /**
   * The hook stage this declaration registers for.
   * Must be one of the HookStage values above.
   */
  stage: HookStage;

  /**
   * Criticality determines what happens when this hook fails or times out.
   *
   * "critical":  Hook failure aborts the stage and returns an error to the caller.
   *              Use for hooks that enforce invariants (e.g., schema validation).
   * "advisory":  Hook failure is logged but the stage continues with the pre-hook
   *              payload. Use for enrichment or observability hooks.
   */
  criticality: "critical" | "advisory";

  /**
   * Execution order within a stage's hook chain. Lower priority = earlier execution.
   * Default: 100. Valid range: 0-999.
   * When two hooks share the same priority, execution order is deterministic but
   * not specified — do not rely on ordering between plugins with equal priority.
   */
  priority?: number;

  /**
   * Execution timeout override for this specific hook.
   * Default: 30 seconds. Maximum: 300 seconds.
   * Must be specified in seconds as a positive integer.
   */
  timeout?: number;

  /**
   * The named export in dist/bundle.js that implements this hook.
   * Example: "onBeforeIngestionReceive"
   *
   * The export must be a function with this signature:
   *   async function onBeforeIngestionReceive(
   *     payload: HookPayload,
   *     context: PluginContext
   *   ): Promise<HookResult>
   */
  entrypoint: string;
}

// ---------------------------------------------------------------------------
// Per-stage payload data shapes
//
// Each entry maps a HookStage to the concrete shape of HookPayload.data at
// that stage. Unmapped stages fall back to Record<string, unknown> so hooks
// written against unknown future stages still compile.
// ---------------------------------------------------------------------------

/** Raw inbound record from a connector or webhook before any processing. */
export interface IngestionReceiveData {
  sourceId: string;
  rawPayload: unknown;
  contentType: string;
  receivedAt: string; // ISO 8601
  headers: Record<string, string>;
}

/** Record after structural/schema validation. */
export interface IngestionValidateData {
  sourceId: string;
  record: Record<string, unknown>;
  /** Validation errors found so far. Empty when all checks passed. */
  validationErrors: Array<{ field: string; message: string }>;
  receivedAt: string;
}

/** Record paired with its resolved ontology entity type. */
export interface OntologyMapData {
  record: Record<string, unknown>;
  /** Resolved entity type name from the tenant's ontology schema. */
  entityType: string;
  /** Confidence score 0-1 for the entity type mapping. */
  mappingConfidence: number;
  /** All candidate entity types considered during mapping. */
  candidates: Array<{ entityType: string; confidence: number }>;
}

/** Pipeline execution step data. */
export interface PipelineExecuteData {
  pipelineId: string;
  pipelineRunId: string;
  stepId: string;
  stepType: string;
  /** Input values for this step, keyed by parameter name. */
  input: Record<string, unknown>;
  /** Output from the previous step, if any. */
  previousOutput: Record<string, unknown> | null;
}

/** Auth login event. */
export interface AuthLoginData {
  userId: string;
  tenantId: string;
  /** OAuth scopes granted in this session. */
  scopes: string[];
  /** True if the user authenticated via SSO rather than password. */
  isSso: boolean;
}

/**
 * Mapping from HookStage to the concrete data shape at that stage.
 * Stages not listed here fall back to Record<string, unknown>.
 */
export interface HookPayloadDataMap {
  "before:ingestion.receive":  IngestionReceiveData;
  "after:ingestion.receive":   IngestionReceiveData;
  "before:ingestion.validate": IngestionValidateData;
  "after:ingestion.validate":  IngestionValidateData;
  "before:ontology.map":       OntologyMapData;
  "after:ontology.map":        OntologyMapData;
  "before:pipeline.step":      PipelineExecuteData;
  "after:pipeline.step":       PipelineExecuteData;
  "before:auth.login":         AuthLoginData;
  "after:auth.login":          AuthLoginData;
}

// ---------------------------------------------------------------------------
// Generic HookPayload
// ---------------------------------------------------------------------------

/** Shared metadata injected into every hook invocation. */
export interface HookContext {
  tenantId: string;
  traceId: string;
  spanId: string;
  pipelineRunId?: string;
  ingestionJobId?: string;
}

/**
 * The payload passed to every hook function.
 *
 * Generic form: HookPayload<S extends HookStage>
 * When S is a key of HookPayloadDataMap, data is narrowed to its specific type.
 * For all other stages data is Record<string, unknown>.
 *
 * @example
 * async function onBeforeIngestionReceive(
 *   payload: HookPayload<"before:ingestion.receive">,
 *   ctx: PluginContext,
 * ): Promise<HookResult<"before:ingestion.receive">> {
 *   // payload.data is IngestionReceiveData — fully typed
 *   console.log(payload.data.rawPayload);
 *   return { data: payload.data };
 * }
 */
export interface HookPayload<S extends HookStage = HookStage> {
  /** The stage that triggered this hook. */
  stage: S;

  /**
   * The data being processed at this stage.
   * Narrowed to a specific type when S is a known stage in HookPayloadDataMap.
   */
  data: S extends keyof HookPayloadDataMap ? HookPayloadDataMap[S] : Record<string, unknown>;

  /** Metadata about the execution context. */
  context: HookContext;
}

/**
 * The return type of a hook function.
 * To modify the data flowing through the stage, return a new payload.
 * To pass data through unmodified, return the input payload unchanged.
 * Returning null from an advisory hook is equivalent to returning the input payload.
 */
export interface HookResult<S extends HookStage = HookStage> {
  /** The (possibly modified) data to pass to the next hook or to the stage itself. */
  data: S extends keyof HookPayloadDataMap ? HookPayloadDataMap[S] : Record<string, unknown>;
}

/**
 * Convenience type alias for a typed hook function.
 * @example
 * const onBeforeReceive: HookFn<"before:ingestion.receive"> = async (payload, ctx) => {
 *   return { data: { ...payload.data, receivedAt: new Date().toISOString() } };
 * };
 */
export type HookFn<S extends HookStage = HookStage> = (
  payload: HookPayload<S>,
  context: import('./context.js').PluginContext,
) => Promise<HookResult<S>>;
