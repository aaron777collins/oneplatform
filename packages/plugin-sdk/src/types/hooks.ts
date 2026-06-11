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
  | "before:execution.before"
  | "after:execution.before"
  | "before:execution.after"
  | "after:execution.after"
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

/**
 * The payload passed to every hook function.
 * The concrete shape of `data` depends on the hook stage.
 * Hook functions may return a modified payload to alter platform behavior.
 */
export interface HookPayload {
  /** The stage that triggered this hook. */
  stage: HookStage;

  /** The data being processed at this stage. Shape varies by stage. */
  data: Record<string, unknown>;

  /** Metadata about the execution context. */
  context: {
    tenantId: string;
    traceId: string;
    spanId: string;
    pipelineRunId?: string;
    ingestionJobId?: string;
  };
}

/**
 * The return type of a hook function.
 * To modify the data flowing through the stage, return a new payload.
 * To pass data through unmodified, return the input payload unchanged.
 * Returning null from an advisory hook is equivalent to returning the input payload.
 */
export interface HookResult {
  /** The (possibly modified) data to pass to the next hook or to the stage itself. */
  data: Record<string, unknown>;
}
