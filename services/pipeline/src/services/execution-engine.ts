import type { Logger } from "@oneplatform/core";
import type { Job } from "bullmq";
import type { Pool, PoolClient } from "pg";
import type { Redis } from "ioredis";
import jsonata from "jsonata";
import type {
  PipelineDefinition,
  Step,
  CodeStep,
  ConnectorStep,
  TransformerStep,
  ConditionalStep,
  ParallelStep,
  WebhookStep,
  ParallelBranch,
} from "./pipeline-service.js";
import type {
  RunRow,
  RunStepRow,
  PipelineRunJobPayload,
  RunStatus,
  RunStepStatus,
} from "./run-service.js";
import { StepExecutionError } from "./errors.js";

// ---------------------------------------------------------------------------
// Repository interfaces required by the execution engine
// ---------------------------------------------------------------------------

export interface RunEngineRepository {
  findById(id: string): Promise<RunRow | null>;
  update(
    id: string,
    input: {
      status?: RunStatus;
      startedAt?: Date;
      completedAt?: Date;
      error?: { code: string; message: string; stepId?: string; details?: unknown } | null;
    },
  ): Promise<RunRow>;
}

export interface RunStepEngineRepository {
  createBulk(
    steps: Array<{
      runId: string;
      tenantId: string;
      stepId: string;
      stepName: string;
      stepType: string;
      status: RunStepStatus;
      input: Record<string, unknown>;
    }>,
  ): Promise<RunStepRow[]>;
  findByRunId(runId: string): Promise<RunStepRow[]>;
  update(
    id: string,
    input: {
      status?: RunStepStatus;
      startedAt?: Date;
      completedAt?: Date;
      input?: Record<string, unknown>;
      output?: unknown;
      executionId?: string;
      error?: { code: string; message: string; details?: unknown } | null;
    },
  ): Promise<RunStepRow>;
  findByRunIdAndStepId(runId: string, stepId: string): Promise<RunStepRow | null>;
}

export interface RunLogEngineRepository {
  append(entry: {
    runId: string;
    tenantId: string;
    stepId?: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    details?: unknown;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Execution Service response shapes (design spec §7.5)
// ---------------------------------------------------------------------------

interface ExecutionRequest {
  pluginId?: string;
  language?: "javascript" | "typescript" | "python" | "go";
  code?: string;
  entrypoint: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  tenantId: string;
  runId: string;
  stepId: string;
  hookContext: boolean;
}

interface ExecutionResponse {
  executionId: string;
  output: unknown;
  durationMs: number;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Hook types (design spec §9.2)
// ---------------------------------------------------------------------------

interface HookRef {
  hookId: string;
  pluginId: string;
  entrypoint: string;
  criticality: "critical" | "advisory";
  timeoutMs: number;
  priority: number;
}

interface HookPayload {
  stage: string;
  data: Record<string, unknown>;
  meta: {
    pipelineId: string;
    runId?: string;
    stepId?: string;
    tenantId: string;
  };
}

// ---------------------------------------------------------------------------
// Runtime context for a pipeline run
// ---------------------------------------------------------------------------

interface RunContext {
  runId: string;
  tenantId: string;
  pipelineId: string;
  definition: PipelineDefinition;
  // Accumulated step outputs keyed by stepId
  stepOutputs: Map<string, unknown>;
  // The pool client that holds the advisory lock for this run
  lockClient: PoolClient;
  // Cancellation flag checked between steps
  isCancelled: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Advisory lock helpers (design spec §12.3)
// ---------------------------------------------------------------------------

function advisoryLockKey(pipelineId: string): bigint {
  // Deterministic 64-bit key from first 16 hex chars of the UUID
  const hex = pipelineId.replace(/-/g, "").slice(0, 16);
  return BigInt("0x" + hex);
}

async function tryAcquireAdvisoryLock(
  client: PoolClient,
  pipelineId: string,
): Promise<boolean> {
  const key = advisoryLockKey(pipelineId);
  const result = await client.query<{ pg_try_advisory_lock: boolean }>(
    "SELECT pg_try_advisory_lock($1::bigint)",
    [key.toString()],
  );
  return result.rows[0]?.pg_try_advisory_lock === true;
}

async function releaseAdvisoryLock(
  client: PoolClient,
  pipelineId: string,
): Promise<void> {
  const key = advisoryLockKey(pipelineId);
  await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
}

// ---------------------------------------------------------------------------
// SSRF check for webhook steps (re-checked at execution time per design spec)
// ---------------------------------------------------------------------------

const SSRF_BLOCKED_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?\//i,
  /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?\//,
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?\//,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?\//,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?\//,
  /^https?:\/\/169\.254\.\d+\.\d+(:\d+)?\//,
];

function isUrlSsrfBlocked(url: string): boolean {
  return SSRF_BLOCKED_PATTERNS.some((p) => p.test(url));
}

// ---------------------------------------------------------------------------
// Cancellation Redis key
// ---------------------------------------------------------------------------

function cancellationKey(runId: string): string {
  return `queue:pipeline:run:${runId}:cancel`;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExecutionEngine {
  processRun(job: Job<PipelineRunJobPayload>): Promise<void>;
}

export interface ExecutionEngineDeps {
  runRepo: RunEngineRepository;
  runStepRepo: RunStepEngineRepository;
  runLogRepo: RunLogEngineRepository;
  pool: Pool;
  redis: Redis;
  executionServiceUrl: string;
  pluginServiceUrl: string;
  ingestionServiceUrl: string;
  stepDefaultTimeoutMs: number;
  hookDefaultTimeoutMs: number;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExecutionEngine(deps: ExecutionEngineDeps): ExecutionEngine {
  const {
    runRepo,
    runStepRepo,
    runLogRepo,
    pool,
    redis,
    executionServiceUrl,
    pluginServiceUrl,
    ingestionServiceUrl,
    stepDefaultTimeoutMs,
    hookDefaultTimeoutMs,
    logger,
  } = deps;

  // -------------------------------------------------------------------------
  // appendLog — writes a structured log entry to pipeline.run_logs
  // -------------------------------------------------------------------------

  async function appendLog(
    runId: string,
    tenantId: string,
    message: string,
    opts?: { stepId?: string; level?: "debug" | "info" | "warn" | "error"; details?: unknown },
  ): Promise<void> {
    await runLogRepo.append({
      runId,
      tenantId,
      ...(opts?.stepId !== undefined ? { stepId: opts.stepId } : {}),
      level: opts?.level ?? "info",
      message,
      ...(opts?.details !== undefined ? { details: opts.details } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // resolveHookChain — fetches hooks from Plugin Service for a given stage
  // -------------------------------------------------------------------------

  async function resolveHookChain(stage: string, tenantId: string): Promise<HookRef[]> {
    const url = `${pluginServiceUrl}/internal/plugins/hooks?stage=${encodeURIComponent(stage)}&tenantId=${encodeURIComponent(tenantId)}`;
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn("Failed to resolve hook chain from Plugin Service", {
        stage,
        tenantId,
        status: response.status,
      });
      return [];
    }
    const body = (await response.json()) as { hooks: HookRef[] };
    return body.hooks ?? [];
  }

  // -------------------------------------------------------------------------
  // executeHookChain — runs each hook sequentially, enforcing criticality
  // (design spec §9.3–9.4)
  // -------------------------------------------------------------------------

  async function executeHookChain(
    hooks: HookRef[],
    payload: HookPayload,
    runContext: { runId: string; tenantId: string; stepId?: string },
  ): Promise<HookPayload> {
    let current = payload;

    for (const hook of hooks) {
      const request: ExecutionRequest = {
        pluginId: hook.pluginId,
        entrypoint: hook.entrypoint,
        input: current.data,
        timeoutMs: hook.timeoutMs,
        tenantId: runContext.tenantId,
        runId: runContext.runId,
        ...(runContext.stepId !== undefined ? { stepId: runContext.stepId } : ({ stepId: "" } as { stepId: string })),
        hookContext: true,
      };

      try {
        const execResponse = await callExecutionService(request);
        // Successful hook replaces the current payload's data with the hook's output
        current = {
          ...current,
          data: execResponse.output as Record<string, unknown>,
        };
      } catch (err) {
        if (hook.criticality === "critical") {
          // Critical hook failure aborts the chain
          throw err;
        }
        // Advisory hooks log the failure but continue with the pre-hook payload
        logger.warn("Advisory hook failed — continuing with pre-hook payload", {
          hookId: hook.hookId,
          pluginId: hook.pluginId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return current;
  }

  // -------------------------------------------------------------------------
  // callExecutionService — HTTP POST to Execution Service
  // -------------------------------------------------------------------------

  async function callExecutionService(request: ExecutionRequest): Promise<ExecutionResponse> {
    const response = await fetch(`${executionServiceUrl}/internal/execution/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new StepExecutionError(
        `Execution Service returned ${response.status}: ${errorBody}`,
        { statusCode: response.status },
      );
    }

    return (await response.json()) as ExecutionResponse;
  }

  // -------------------------------------------------------------------------
  // resolveStepInput — resolves InputMapping against the accumulated context
  // -------------------------------------------------------------------------

  function resolveStepInput(
    step: Step,
    runInput: Record<string, unknown>,
    stepOutputs: Map<string, unknown>,
  ): Record<string, unknown> {
    if (step.inputs === undefined) return {};

    const resolved: Record<string, unknown> = {};
    for (const [fieldName, source] of Object.entries(step.inputs)) {
      if (source.from === "literal") {
        resolved[fieldName] = source.value;
      } else if (source.from === "pipeline.input") {
        resolved[fieldName] = source.path !== undefined
          ? getPath(runInput, source.path)
          : runInput;
      } else {
        // source.from === "step"
        const stepOutput = stepOutputs.get(source.stepId);
        resolved[fieldName] = source.path !== undefined
          ? getPath(stepOutput as Record<string, unknown>, source.path)
          : stepOutput;
      }
    }
    return resolved;
  }

  // Simple JSONPath-style path resolver (dot notation + array brackets)
  function getPath(obj: unknown, path: string): unknown {
    if (obj === undefined || obj === null) return undefined;
    // Strip leading $. per JSONPath convention
    const cleanPath = path.replace(/^\$\.?/, "");
    if (!cleanPath) return obj;
    const parts = cleanPath.split(/\.|\[(\d+)\]/).filter(Boolean);
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  // -------------------------------------------------------------------------
  // evaluateConditional — JSONata evaluation with 100ms timeout (design spec §4.2)
  // -------------------------------------------------------------------------

  async function evaluateConditional(
    expression: string,
    context: { input: Record<string, unknown>; steps: Record<string, unknown> },
  ): Promise<boolean> {
    if (expression.length > 5000) {
      throw new Error("Conditional expression exceeds 5000 character limit.");
    }

    const expr = jsonata(expression);
    // Race against a 100ms timeout; jsonata itself does not have a native timeout
    const result = await Promise.race([
      expr.evaluate(context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("JSONata evaluation timed out (100ms)")), 100),
      ),
    ]);

    return Boolean(result);
  }

  // -------------------------------------------------------------------------
  // executeCodeStep
  // -------------------------------------------------------------------------

  async function executeCodeStep(
    step: CodeStep,
    ctx: RunContext,
    resolvedInput: Record<string, unknown>,
  ): Promise<ExecutionResponse> {
    const timeoutMs = step.timeout ?? ctx.definition.options?.stepTimeout ?? stepDefaultTimeoutMs;

    return callExecutionService({
      language: step.language,
      code: step.code,
      entrypoint: step.entrypoint ?? "main",
      input: resolvedInput,
      timeoutMs,
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepId: step.id,
      hookContext: false,
    });
  }

  // -------------------------------------------------------------------------
  // executeConnectorStep — dispatches to Ingestion Service
  // -------------------------------------------------------------------------

  async function executeConnectorStep(
    step: ConnectorStep,
    ctx: RunContext,
    resolvedInput: Record<string, unknown>,
  ): Promise<{ output: Record<string, unknown> }> {
    const response = await fetch(`${ingestionServiceUrl}/internal/ingestion/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectorInstanceId: step.connectorInstanceId,
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        stepId: step.id,
        ...(step.syncMode !== undefined ? { syncMode: step.syncMode } : {}),
        waitForCompletion: step.waitForCompletion,
        ...resolvedInput,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new StepExecutionError(
        `Ingestion Service returned ${response.status}: ${errorBody}`,
        { stepId: step.id, statusCode: response.status },
      );
    }

    return (await response.json()) as { output: Record<string, unknown> };
  }

  // -------------------------------------------------------------------------
  // executeWebhookStep — outbound HTTP request with runtime SSRF re-check
  // -------------------------------------------------------------------------

  async function executeWebhookStep(
    step: WebhookStep,
    _ctx: RunContext,
    resolvedInput: Record<string, unknown>,
  ): Promise<{ output: Record<string, unknown> }> {
    // Re-check SSRF at execution time in case URL was dynamically resolved
    if (isUrlSsrfBlocked(step.url)) {
      throw new StepExecutionError(
        `Webhook step URL "${step.url}" is blocked by the SSRF policy.`,
        { stepId: step.id },
      );
    }

    const timeoutMs = Math.min(step.timeout ?? 30_000, 120_000);

    // Build request body — if it is a string starting with '=', treat as JSONata template
    let body: unknown = step.body;
    if (typeof step.body === "string" && step.body.startsWith("=")) {
      const expr = jsonata(step.body.slice(1));
      body = await expr.evaluate({ input: resolvedInput });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(step.url, {
        method: step.method,
        headers: {
          "Content-Type": "application/json",
          ...(step.headers ?? {}),
        },
        ...(body !== undefined && step.method !== "GET" ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new StepExecutionError(
        `Webhook step HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
        { stepId: step.id },
      );
    } finally {
      clearTimeout(timer);
    }

    const responseBody = await response.json().catch(() => null) as unknown;

    let output: Record<string, unknown> = {
      statusCode: response.status,
      body: responseBody,
    };

    // Apply responseMapping JSONata expression if configured
    if (step.responseMapping !== undefined) {
      const expr = jsonata(step.responseMapping);
      const mapped = await expr.evaluate(output);
      output = (mapped as Record<string, unknown>) ?? output;
    }

    return { output };
  }

  // -------------------------------------------------------------------------
  // executeParallelStep — fan-out branches (design spec §7.4)
  // -------------------------------------------------------------------------

  async function executeParallelStep(
    step: ParallelStep,
    ctx: RunContext,
  ): Promise<{ output: Record<string, unknown> }> {
    type BranchResult = { branchId: string; output: unknown };

    const branchPromises = step.branches.map(
      async (branch: ParallelBranch): Promise<BranchResult> => {
        // Each branch traversal starts from the branch's entryStepId
        const branchOutput = await traverseBranch(branch, ctx);
        return { branchId: branch.id, output: branchOutput };
      },
    );

    if (step.waitMode === "all") {
      const results = await Promise.all(branchPromises);
      const output: Record<string, unknown> = {};
      for (const result of results) {
        output[result.branchId] = result.output;
      }
      return { output };
    } else {
      // waitMode === "any": first branch to succeed wins
      const result = await Promise.race(branchPromises);
      return { output: { [result.branchId]: result.output } };
    }
  }

  // Traverse a parallel branch's step sequence
  async function traverseBranch(
    branch: ParallelBranch,
    ctx: RunContext,
  ): Promise<unknown> {
    let lastOutput: unknown;
    let currentStepId: string | null = branch.entryStepId;

    // Build a lookup for branch-local steps
    const branchStepMap = new Map(branch.steps.map((s) => [s.id, s]));

    while (currentStepId !== null) {
      const step = branchStepMap.get(currentStepId);
      if (step === undefined) break;

      const result = await executeStep(step, ctx);
      lastOutput = result.output;
      currentStepId = getNextStepId(step, result.nextStepId, branch.steps);
    }

    return lastOutput;
  }

  // -------------------------------------------------------------------------
  // getNextStepId — determines the next step after completing the current one
  // -------------------------------------------------------------------------

  function getNextStepId(
    step: Step,
    conditionalNextId: string | undefined,
    steps: Step[],
  ): string | null {
    if (step.type === "conditional") {
      return conditionalNextId ?? null;
    }

    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx === -1 || idx === steps.length - 1) return null;
    return steps[idx + 1]?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // executeStep — dispatches to the correct handler by step type
  // -------------------------------------------------------------------------

  interface StepResult {
    output: unknown;
    nextStepId?: string;
  }

  async function executeStep(step: Step, ctx: RunContext): Promise<StepResult> {
    const resolvedInput = resolveStepInput(
      step,
      ctx.definition.steps[0] !== undefined ? {} : {},
      ctx.stepOutputs,
    );

    if (step.type === "code") {
      const result = await executeCodeStep(step, ctx, resolvedInput);
      return { output: result.output };
    }

    if (step.type === "connector") {
      const result = await executeConnectorStep(step, ctx, resolvedInput);
      return { output: result.output };
    }

    if (step.type === "transformer") {
      const timeoutMs = step.timeout ?? ctx.definition.options?.stepTimeout ?? stepDefaultTimeoutMs;
      const result = await callExecutionService({
        pluginId: step.transformerId,
        entrypoint: "main",
        input: resolvedInput,
        timeoutMs,
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        stepId: step.id,
        hookContext: false,
      });
      return { output: result.output };
    }

    if (step.type === "conditional") {
      const stepsContext: Record<string, unknown> = {};
      for (const [stepId, output] of ctx.stepOutputs) {
        stepsContext[stepId] = { output };
      }

      // resolvedInput for conditional uses the run's original input object
      const runInput = resolvedInput;
      const isTruthy = await evaluateConditional(step.expression, {
        input: runInput,
        steps: stepsContext,
      });

      const nextStepId = isTruthy ? step.trueBranchStepId : step.falseBranchStepId;
      return { output: { condition: isTruthy }, nextStepId };
    }

    if (step.type === "parallel") {
      const result = await executeParallelStep(step, ctx);
      return { output: result.output };
    }

    if (step.type === "webhook") {
      const result = await executeWebhookStep(step, ctx, resolvedInput);
      return { output: result.output };
    }

    // Exhaustive check — TypeScript will catch this at compile time if a new
    // step type is added without handling it here.
    const exhaustive: never = step;
    throw new Error(`Unknown step type: ${JSON.stringify(exhaustive)}`);
  }

  // -------------------------------------------------------------------------
  // processRun — the main BullMQ worker algorithm (design spec §7.3)
  // -------------------------------------------------------------------------

  async function processRun(job: Job<PipelineRunJobPayload>): Promise<void> {
    const { runId, tenantId } = job.data;

    // Step 1: Load run — idempotency guard
    const run = await runRepo.findById(runId);
    if (run === null) {
      logger.warn("processRun: run not found", { runId });
      return;
    }
    if (run.status !== "pending") {
      logger.warn("processRun: run not in pending state — skipping (idempotency guard)", {
        runId,
        status: run.status,
      });
      return;
    }

    // Step 2: Acquire advisory lock — ensures only one worker drives this pipeline at a time
    const lockClient = await pool.connect();
    let lockAcquired = false;

    try {
      lockAcquired = await tryAcquireAdvisoryLock(lockClient, run.pipeline_id);
      if (!lockAcquired) {
        lockClient.release();
        logger.info("Advisory lock not available — re-enqueuing with delay", {
          runId,
          pipelineId: run.pipeline_id,
        });
        // BullMQ will retry according to its backoff policy
        throw new Error(`Advisory lock held for pipeline ${run.pipeline_id} — re-enqueue pending.`);
      }

      // Build the run context shared across all step executions
      const ctx: RunContext = {
        runId,
        tenantId,
        pipelineId: run.pipeline_id,
        definition: run.definition_snapshot,
        stepOutputs: new Map(),
        lockClient,
        isCancelled: async () => {
          const flag = await redis.get(cancellationKey(runId));
          return flag !== null;
        },
      };

      // Step 3: Transition to running
      await runRepo.update(runId, { status: "running", startedAt: new Date() });
      await appendLog(runId, tenantId, `Pipeline run started, triggered by ${run.triggered_by}`);

      // Step 4: Create run_steps rows for all steps (status=pending) so the UI
      // can display the full step graph immediately
      const allSteps = run.definition_snapshot.steps;
      await runStepRepo.createBulk(
        allSteps.map((step) => ({
          runId,
          tenantId,
          stepId: step.id,
          stepName: step.name,
          stepType: step.type,
          status: "pending" as RunStepStatus,
          input: {},
        })),
      );

      // Step 5: Run after:pipeline.trigger hooks
      const afterTriggerHooks = await resolveHookChain("after:pipeline.trigger", tenantId);
      if (afterTriggerHooks.length > 0) {
        try {
          await executeHookChain(
            afterTriggerHooks,
            {
              stage: "after:pipeline.trigger",
              data: { pipelineId: run.pipeline_id, runId, triggeredBy: run.triggered_by },
              meta: { pipelineId: run.pipeline_id, runId, tenantId },
            },
            { runId, tenantId },
          );
        } catch (err) {
          await runRepo.update(runId, {
            status: "failed",
            completedAt: new Date(),
            error: {
              code: "PIPELINE_HOOK_CRITICAL_FAILURE",
              message: err instanceof Error ? err.message : String(err),
            },
          });
          await appendLog(runId, tenantId, `Critical after:trigger hook failed: ${err instanceof Error ? err.message : String(err)}`, {
            level: "error",
          });
          return;
        }
      }

      // Step 6: Traverse the step graph
      const stepMap = new Map(allSteps.map((s) => [s.id, s]));
      let currentStepId: string | null = run.definition_snapshot.entryStepId;
      let failedStepId: string | null = null;
      let failureError: Error | null = null;

      stepTraversal:
      while (currentStepId !== null) {
        // Cancellation check between steps
        if (await ctx.isCancelled()) {
          // Mark all remaining pending steps as cancelled
          const stepRows = await runStepRepo.findByRunId(runId);
          await Promise.all(
            stepRows
              .filter((r) => r.status === "pending")
              .map((r) => runStepRepo.update(r.id, { status: "cancelled" })),
          );

          await runRepo.update(runId, { status: "cancelled", completedAt: new Date() });
          await appendLog(runId, tenantId, "Pipeline run cancelled.");
          await emitPlatformEvent("pipeline.cancelled", tenantId, {
            pipelineId: run.pipeline_id,
            runId,
            cancelledBy: "user",
          });

          // Advisory-only after:complete hooks at cancellation
          await runAfterCompleteHooks(ctx, "cancelled");
          return;
        }

        const step = stepMap.get(currentStepId);
        if (step === undefined) {
          logger.error("Step not found in definition", { runId, stepId: currentStepId });
          break;
        }

        // Find the run_step row for this step
        const stepRows = await runStepRepo.findByRunId(runId);
        const runStepRow = stepRows.find((r) => r.step_id === currentStepId);
        if (runStepRow === undefined) break;

        // Evaluate skip condition (JSONata, 100ms timeout)
        if (step.condition !== undefined && step.condition.length > 0) {
          const stepsCtx: Record<string, unknown> = {};
          for (const [sid, out] of ctx.stepOutputs) {
            stepsCtx[sid] = { output: out };
          }
          let skip = false;
          try {
            const condTrue = await evaluateConditional(step.condition, {
              input: run.input,
              steps: stepsCtx,
            });
            skip = !condTrue;
          } catch {
            skip = false; // On condition error, proceed
          }

          if (skip) {
            await runStepRepo.update(runStepRow.id, { status: "skipped" });
            currentStepId = getNextStepIdFromMain(step, allSteps, undefined);
            continue;
          }
        }

        // Resolve input mapping
        const resolvedInput = resolveStepInput(step, run.input, ctx.stepOutputs);

        // before:step hooks
        const beforeStepHooks = await resolveHookChain(
          `before:pipeline.step:${step.id}`,
          tenantId,
        );
        if (beforeStepHooks.length > 0) {
          try {
            await executeHookChain(
              beforeStepHooks,
              {
                stage: `before:pipeline.step:${step.id}`,
                data: { stepId: step.id, input: resolvedInput },
                meta: { pipelineId: run.pipeline_id, runId, stepId: step.id, tenantId },
              },
              { runId, tenantId, stepId: step.id },
            );
          } catch (err) {
            await runStepRepo.update(runStepRow.id, {
              status: "failed",
              completedAt: new Date(),
              error: {
                code: "PIPELINE_HOOK_CRITICAL_FAILURE",
                message: err instanceof Error ? err.message : String(err),
              },
            });
            failedStepId = step.id;
            failureError = err instanceof Error ? err : new Error(String(err));
            break stepTraversal;
          }
        }

        // Mark step as running
        await runStepRepo.update(runStepRow.id, {
          status: "running",
          startedAt: new Date(),
          input: resolvedInput,
        });

        await appendLog(runId, tenantId, `Step "${step.name}" started.`, { stepId: step.id });

        // Execute the step
        let stepOutput: unknown;
        let nextStepId: string | undefined;

        try {
          const result = await executeStep(step, ctx);
          stepOutput = result.output;
          nextStepId = result.nextStepId;

          ctx.stepOutputs.set(step.id, stepOutput);

          await runStepRepo.update(runStepRow.id, {
            status: "completed",
            completedAt: new Date(),
            output: stepOutput,
          });

          await appendLog(runId, tenantId, `Step "${step.name}" completed.`, { stepId: step.id });

          // Emit step completion platform event
          await emitPlatformEvent("pipeline.step.completed", tenantId, {
            pipelineId: run.pipeline_id,
            runId,
            stepId: step.id,
            stepName: step.name,
          });
        } catch (err) {
          const onError = step.onError ?? "fail";
          const errMessage = err instanceof Error ? err.message : String(err);

          await runStepRepo.update(runStepRow.id, {
            status: "failed",
            completedAt: new Date(),
            error: { code: "STEP_EXECUTION_FAILED", message: errMessage },
          });

          await appendLog(runId, tenantId, `Step "${step.name}" failed: ${errMessage}`, {
            stepId: step.id,
            level: "error",
          });

          if (onError === "skip") {
            // Step failure is non-fatal — continue traversal with null output for this step
            ctx.stepOutputs.set(step.id, null);
            currentStepId = getNextStepIdFromMain(step, allSteps, undefined);
            continue;
          }

          // onError === "fail": propagate failure
          failedStepId = step.id;
          failureError = err instanceof Error ? err : new Error(errMessage);
          break stepTraversal;
        }

        // after:step hooks (advisory-only failure per design spec §9.1)
        const afterStepHooks = await resolveHookChain(
          `after:pipeline.step:${step.id}`,
          tenantId,
        );
        if (afterStepHooks.length > 0) {
          try {
            await executeHookChain(
              afterStepHooks,
              {
                stage: `after:pipeline.step:${step.id}`,
                data: { stepId: step.id, output: stepOutput },
                meta: { pipelineId: run.pipeline_id, runId, stepId: step.id, tenantId },
              },
              { runId, tenantId, stepId: step.id },
            );
          } catch (err) {
            // after:step is critical per spec table — propagate failure
            const errMessage = err instanceof Error ? err.message : String(err);
            await runStepRepo.update(runStepRow.id, {
              status: "failed",
              error: { code: "PIPELINE_HOOK_CRITICAL_FAILURE", message: errMessage },
            });
            failedStepId = step.id;
            failureError = err instanceof Error ? err : new Error(errMessage);
            break stepTraversal;
          }
        }

        currentStepId = getNextStepIdFromMain(step, allSteps, nextStepId);
      }

      // Step traversal complete — check for failure
      if (failedStepId !== null && failureError !== null) {
        // Mark all remaining pending steps as cancelled
        const stepRows = await runStepRepo.findByRunId(runId);
        await Promise.all(
          stepRows
            .filter((r) => r.status === "pending")
            .map((r) => runStepRepo.update(r.id, { status: "cancelled" })),
        );

        await runRepo.update(runId, {
          status: "failed",
          completedAt: new Date(),
          error: {
            code: "STEP_EXECUTION_FAILED",
            message: failureError.message,
            stepId: failedStepId,
          },
        });

        await appendLog(
          runId,
          tenantId,
          `Pipeline run failed at step "${failedStepId}": ${failureError.message}`,
          { level: "error" },
        );

        await emitPlatformEvent("pipeline.failed", tenantId, {
          pipelineId: run.pipeline_id,
          runId,
          stepId: failedStepId,
          error: { message: failureError.message },
        });

        await runAfterCompleteHooks(ctx, "failed");
        return;
      }

      // before:pipeline.complete hooks
      const beforeCompleteHooks = await resolveHookChain("before:pipeline.complete", tenantId);
      if (beforeCompleteHooks.length > 0) {
        try {
          await executeHookChain(
            beforeCompleteHooks,
            {
              stage: "before:pipeline.complete",
              data: { pipelineId: run.pipeline_id, runId },
              meta: { pipelineId: run.pipeline_id, runId, tenantId },
            },
            { runId, tenantId },
          );
        } catch (err) {
          await runRepo.update(runId, {
            status: "failed",
            completedAt: new Date(),
            error: {
              code: "PIPELINE_HOOK_CRITICAL_FAILURE",
              message: err instanceof Error ? err.message : String(err),
            },
          });
          await appendLog(runId, tenantId, `Critical before:complete hook failed: ${err instanceof Error ? err.message : String(err)}`, {
            level: "error",
          });
          return;
        }
      }

      // All steps completed successfully
      const startedAt = run.started_at ?? new Date();
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      await runRepo.update(runId, { status: "completed", completedAt });
      await appendLog(runId, tenantId, `Pipeline run completed in ${durationMs}ms.`);

      await emitPlatformEvent("pipeline.completed", tenantId, {
        pipelineId: run.pipeline_id,
        runId,
        durationMs,
        stepCount: allSteps.length,
      });

      await runAfterCompleteHooks(ctx, "completed");
    } finally {
      // Advisory lock MUST be released even if the worker crashes mid-run.
      // Placed in finally block so BullMQ retries can re-acquire on next attempt.
      if (lockAcquired) {
        try {
          await releaseAdvisoryLock(lockClient, run?.pipeline_id ?? "");
        } catch {
          // Best-effort release — if it fails, the lock will be released when the
          // session closes (Postgres handles session-scoped lock cleanup)
        }
        lockClient.release();
      } else if (!lockAcquired) {
        // Lock was never acquired — client was already released in the lock-fail branch
        // above. Nothing to do here.
      }
    }
  }

  // -------------------------------------------------------------------------
  // getNextStepIdFromMain — determines the next step in the main step array
  // -------------------------------------------------------------------------

  function getNextStepIdFromMain(
    step: Step,
    steps: Step[],
    conditionalNext: string | undefined,
  ): string | null {
    if (step.type === "conditional") {
      return conditionalNext ?? null;
    }
    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx === -1 || idx === steps.length - 1) return null;
    return steps[idx + 1]?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // runAfterCompleteHooks — advisory-only; failure is logged, not propagated
  // -------------------------------------------------------------------------

  async function runAfterCompleteHooks(
    ctx: RunContext,
    finalStatus: RunStatus,
  ): Promise<void> {
    const hooks = await resolveHookChain("after:pipeline.complete", ctx.tenantId);
    if (hooks.length === 0) return;

    try {
      await executeHookChain(
        hooks,
        {
          stage: "after:pipeline.complete",
          data: { pipelineId: ctx.pipelineId, runId: ctx.runId, finalStatus },
          meta: { pipelineId: ctx.pipelineId, runId: ctx.runId, tenantId: ctx.tenantId },
        },
        { runId: ctx.runId, tenantId: ctx.tenantId },
      );
    } catch (err) {
      // after:pipeline.complete failures are advisory-only — never change run status
      logger.warn("after:pipeline.complete hook failed (advisory — ignoring)", {
        runId: ctx.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // emitPlatformEvent — publishes to Redis events channel
  // -------------------------------------------------------------------------

  async function emitPlatformEvent(
    eventType: string,
    tenantId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      const event = {
        eventId: crypto.randomUUID(),
        eventType,
        eventVersion: "1",
        tenantId,
        timestamp: new Date().toISOString(),
        actor: { type: "system" as const, id: "pipeline-service" },
        data,
      };
      await redis.publish(`events:${tenantId}:${eventType}`, JSON.stringify(event));
    } catch (err) {
      // Fire-and-forget; event emission failures must not affect run state
      logger.warn("Failed to emit platform event", {
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { processRun };
}
