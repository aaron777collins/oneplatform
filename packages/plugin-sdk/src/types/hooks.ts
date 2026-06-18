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
// Each interface carries exactly the fields available at that stage (ISP).
// Stages that share a shape use a single interface to avoid duplication while
// keeping stage semantics distinct at the discriminated-union level.
// ---------------------------------------------------------------------------

// ── Ingestion Service ────────────────────────────────────────────────────────

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

/**
 * Record during the enrichment phase.
 * The `enrichments` map accumulates key→value pairs added by enrichment
 * adapters. Hooks may read existing enrichments and add new ones by returning
 * a modified copy; the platform merges returned data back into the record.
 */
export interface IngestionEnrichData {
  sourceId: string;
  record: Record<string, unknown>;
  /** Enrichments applied so far, keyed by enricher name. */
  enrichments: Record<string, unknown>;
  receivedAt: string;
}

/**
 * Record at the staging phase — just before it is written to the staging store
 * pending ontology mapping and downstream delivery.
 */
export interface IngestionStageData {
  sourceId: string;
  record: Record<string, unknown>;
  /** Enrichments applied during the enrich phase. */
  enrichments: Record<string, unknown>;
  receivedAt: string;
  /** Target staging partition key (e.g., tenant + entity type). */
  partitionKey: string;
}

// ── Ontology Service ─────────────────────────────────────────────────────────

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

/**
 * Record after field-level normalization against the ontology schema.
 * At this stage field names and value types conform to the entity schema.
 */
export interface OntologyNormalizeData {
  record: Record<string, unknown>;
  entityType: string;
  /** Fields that were coerced or renamed during normalization. */
  normalizedFields: Array<{ originalName: string; normalizedName: string; coerced: boolean }>;
}

// ── Pipeline Service ─────────────────────────────────────────────────────────

/**
 * Data available when a pipeline run is triggered.
 * The `triggerPayload` is the raw event that caused the run (webhook body,
 * schedule tick, manual invocation, etc.).
 */
export interface PipelineTriggerData {
  pipelineId: string;
  pipelineRunId: string;
  /** How the run was triggered. */
  triggerType: "schedule" | "webhook" | "manual" | "api";
  /** The raw event payload that initiated the trigger, if any. */
  triggerPayload: unknown;
  /** ISO 8601 timestamp when the trigger was received. */
  triggeredAt: string;
}

/**
 * @deprecated Use `PipelineStepData`. Renamed in G-092 for clarity.
 * This alias will be removed in a future major version.
 */
export type PipelineExecuteData = PipelineStepData;

/** Pipeline execution step data. */
export interface PipelineStepData {
  pipelineId: string;
  pipelineRunId: string;
  stepId: string;
  stepType: string;
  /** Input values for this step, keyed by parameter name. */
  input: Record<string, unknown>;
  /** Output from the previous step, if any. */
  previousOutput: Record<string, unknown> | null;
}

/**
 * Data available when a pipeline run finishes.
 * Available to `after:pipeline.complete` only — at this point all steps have
 * either succeeded or failed.
 */
export interface PipelineCompleteData {
  pipelineId: string;
  pipelineRunId: string;
  /** Final status of the run. */
  status: "succeeded" | "failed" | "cancelled";
  /** ISO 8601 duration (e.g., "PT4.5S") for the entire run. */
  duration: string;
  /** Per-step outcomes. */
  stepResults: Array<{
    stepId: string;
    status: "succeeded" | "failed" | "skipped";
    error?: string;
  }>;
}

// ── Execution Service ────────────────────────────────────────────────────────

/**
 * Data during the execution setup phase — the sandbox is being wired before
 * the first pipeline step runs.
 */
export interface ExecutionSetupData {
  executionId: string;
  pipelineRunId: string;
  /** Resolved configuration values injected into the execution sandbox. */
  config: Record<string, unknown>;
  /** ISO 8601 timestamp when setup started. */
  startedAt: string;
}

/**
 * Data during the execution teardown phase — the sandbox is being cleaned up
 * after the last pipeline step has finished (or after a fatal error).
 */
export interface ExecutionTeardownData {
  executionId: string;
  pipelineRunId: string;
  /** Exit status of the execution. */
  exitStatus: "success" | "error" | "timeout";
  /** ISO 8601 duration of the execution from setup to teardown. */
  duration: string;
}

// ── Auth Service ─────────────────────────────────────────────────────────────

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
 * Auth logout event.
 * Only `after:auth.logout` exists — there is no `before:auth.logout` because
 * logout is synchronous and cannot be intercepted pre-flight.
 */
export interface AuthLogoutData {
  userId: string;
  tenantId: string;
  /** Reason for the logout, if known. */
  reason: "user-initiated" | "session-expired" | "admin-revoke";
}

/** Token issuance event (access + optional refresh token pair). */
export interface AuthTokenIssueData {
  userId: string;
  tenantId: string;
  /** The token type being issued. */
  tokenType: "access" | "refresh" | "api-key";
  /** Scopes encoded in the token. */
  scopes: string[];
  /** ISO 8601 timestamp when the token expires. */
  expiresAt: string;
}

// ── App Service ──────────────────────────────────────────────────────────────

/**
 * Inbound HTTP request to the App Service.
 * Available at `before:app.request` (before routing) and `after:app.request`
 * (after response is formed). The `response` field is only present in the
 * `after:app.request` payload.
 */
export interface AppRequestData {
  /** HTTP method. */
  method: string;
  /** Full request URL including query string. */
  url: string;
  /** Incoming request headers. */
  headers: Record<string, string>;
  /** Parsed request body, if the Content-Type is JSON. Otherwise null. */
  body: unknown;
  /** Authenticated user ID, if the request is authenticated. */
  userId?: string;
  /** Tenant ID derived from the request context. */
  tenantId: string;
  /**
   * Response data. Present only in `after:app.request` payloads.
   * Undefined in `before:app.request`.
   */
  response?: {
    statusCode: number;
    headers: Record<string, string>;
  };
}

/**
 * App build event — fired when the frontend application bundle is being
 * compiled (e.g., SSR pre-render or asset pipeline run).
 */
export interface AppBuildData {
  /** Unique identifier for this build job. */
  buildId: string;
  /** Git commit SHA that triggered the build. */
  commitSha: string;
  /** Target environment. */
  environment: "development" | "staging" | "production";
  /** ISO 8601 timestamp when the build started. */
  startedAt: string;
  /**
   * Build outcome. Present only in `after:app.build` payloads.
   * Undefined in `before:app.build`.
   */
  outcome?: {
    status: "succeeded" | "failed";
    /** ISO 8601 duration. */
    duration: string;
    /** URL of the deployed build artifact, if succeeded. */
    artifactUrl?: string;
  };
}

// ---------------------------------------------------------------------------
// HookPayloadDataMap
//
// Maps every concrete (non-template) HookStage to its data interface.
// Template stages (`before:pipeline.step:${string}`) share PipelineStepData.
// Stages not in this map are not reachable via DiscriminatedHookPayload but
// remain valid via the generic HookPayload<S> for forward compatibility.
// ---------------------------------------------------------------------------

/**
 * Mapping from HookStage to the concrete data shape at that stage.
 * Stages not listed here fall back to Record<string, unknown>.
 */
export interface HookPayloadDataMap {
  // Ingestion Service
  "before:ingestion.receive":  IngestionReceiveData;
  "after:ingestion.receive":   IngestionReceiveData;
  "before:ingestion.validate": IngestionValidateData;
  "after:ingestion.validate":  IngestionValidateData;
  "before:ingestion.enrich":   IngestionEnrichData;
  "after:ingestion.enrich":    IngestionEnrichData;
  "before:ingestion.stage":    IngestionStageData;
  "after:ingestion.stage":     IngestionStageData;
  // Ontology Service
  "before:ontology.map":       OntologyMapData;
  "after:ontology.map":        OntologyMapData;
  "before:ontology.normalize": OntologyNormalizeData;
  "after:ontology.normalize":  OntologyNormalizeData;
  // Pipeline Service
  "before:pipeline.trigger":   PipelineTriggerData;
  "after:pipeline.trigger":    PipelineTriggerData;
  "before:pipeline.step":      PipelineStepData;
  "after:pipeline.step":       PipelineStepData;
  "before:pipeline.complete":  PipelineCompleteData;
  "after:pipeline.complete":   PipelineCompleteData;
  // Execution Service
  "before:execution.setup":    ExecutionSetupData;
  "after:execution.setup":     ExecutionSetupData;
  "before:execution.teardown": ExecutionTeardownData;
  "after:execution.teardown":  ExecutionTeardownData;
  // Auth Service
  "before:auth.login":         AuthLoginData;
  "after:auth.login":          AuthLoginData;
  "after:auth.logout":         AuthLogoutData;
  "before:auth.token.issue":   AuthTokenIssueData;
  "after:auth.token.issue":    AuthTokenIssueData;
  // App Service
  "before:app.request":        AppRequestData;
  "after:app.request":         AppRequestData;
  "before:app.build":          AppBuildData;
  "after:app.build":           AppBuildData;
}

// ---------------------------------------------------------------------------
// DiscriminatedHookPayload
//
// A discriminated union keyed on `stage`. TypeScript narrows `data` to the
// correct interface when a plugin checks `payload.stage === "..."`.
//
// Use this type for hook handler implementations that switch on stage — it
// enables exhaustiveness checking and eliminates all `as unknown as` casts.
//
// The generic HookPayload<S> is retained for call-site typing where the stage
// is known statically (i.e., you declare a single-stage hook function).
// ---------------------------------------------------------------------------

/**
 * Helper that maps a concrete stage key to a `{ stage; data; context }` member
 * of the discriminated union. Template-string stages are excluded because their
 * infinite cardinality cannot be enumerated; use HookPayload<S> for those.
 */
type DiscriminatedMember<S extends keyof HookPayloadDataMap> = {
  stage: S;
  data: HookPayloadDataMap[S];
  context: HookContext;
};

/**
 * A discriminated union of all concrete hook payload shapes.
 *
 * TypeScript narrows `data` to the correct per-stage interface whenever a
 * plugin narrows `stage`:
 *
 * @example
 * function handleAny(payload: DiscriminatedHookPayload): void {
 *   if (payload.stage === "before:ingestion.receive") {
 *     // payload.data is IngestionReceiveData — no cast needed
 *     console.log(payload.data.rawPayload);
 *   }
 * }
 *
 * All members use string literal discriminants so TypeScript can narrow
 * correctly. A catch-all `stage: string` member is intentionally absent —
 * it would prevent narrowing by absorbing every literal match.
 *
 * For handlers that must also accept template-string or future stages, use
 * `AnyHookPayload` which adds the `UnknownStageHookPayload` fallback member.
 */
export type DiscriminatedHookPayload =
  | DiscriminatedMember<"before:ingestion.receive">
  | DiscriminatedMember<"after:ingestion.receive">
  | DiscriminatedMember<"before:ingestion.validate">
  | DiscriminatedMember<"after:ingestion.validate">
  | DiscriminatedMember<"before:ingestion.enrich">
  | DiscriminatedMember<"after:ingestion.enrich">
  | DiscriminatedMember<"before:ingestion.stage">
  | DiscriminatedMember<"after:ingestion.stage">
  | DiscriminatedMember<"before:ontology.map">
  | DiscriminatedMember<"after:ontology.map">
  | DiscriminatedMember<"before:ontology.normalize">
  | DiscriminatedMember<"after:ontology.normalize">
  | DiscriminatedMember<"before:pipeline.trigger">
  | DiscriminatedMember<"after:pipeline.trigger">
  | DiscriminatedMember<"before:pipeline.step">
  | DiscriminatedMember<"after:pipeline.step">
  | DiscriminatedMember<"before:pipeline.complete">
  | DiscriminatedMember<"after:pipeline.complete">
  | DiscriminatedMember<"before:execution.setup">
  | DiscriminatedMember<"after:execution.setup">
  | DiscriminatedMember<"before:execution.teardown">
  | DiscriminatedMember<"after:execution.teardown">
  | DiscriminatedMember<"before:auth.login">
  | DiscriminatedMember<"after:auth.login">
  | DiscriminatedMember<"after:auth.logout">
  | DiscriminatedMember<"before:auth.token.issue">
  | DiscriminatedMember<"after:auth.token.issue">
  | DiscriminatedMember<"before:app.request">
  | DiscriminatedMember<"after:app.request">
  | DiscriminatedMember<"before:app.build">
  | DiscriminatedMember<"after:app.build">;

/**
 * Payload shape for template-string or future stages not yet in HookPayloadDataMap.
 * The `stage` is a plain `string` so it does not narrow `data`.
 * Platform-internal code uses this type to accept any hook payload without
 * knowing the specific stage at compile time.
 */
export interface UnknownStageHookPayload {
  stage: string;
  data: Record<string, unknown>;
  context: HookContext;
}

/**
 * `DiscriminatedHookPayload` extended with the catch-all `UnknownStageHookPayload`
 * for code paths that must handle stages not in HookPayloadDataMap (e.g.,
 * template-string `before:pipeline.step:${string}` stages or future stages
 * added after this SDK version).
 *
 * Note: checking `payload.stage === "before:ingestion.receive"` will NOT narrow
 * `data` correctly when the variable is typed as `AnyHookPayload` — the
 * `UnknownStageHookPayload` member absorbs narrowing. Cast to
 * `DiscriminatedHookPayload` first if you need narrowing.
 */
export type AnyHookPayload = DiscriminatedHookPayload | UnknownStageHookPayload;

/**
 * Convenience type alias: extracts the `data` type for a given stage from the
 * discriminated union without needing to reference HookPayloadDataMap directly.
 *
 * @example
 * type MyData = HookDataFor<"before:ingestion.receive">; // IngestionReceiveData
 */
export type HookDataFor<S extends keyof HookPayloadDataMap> = HookPayloadDataMap[S];

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
