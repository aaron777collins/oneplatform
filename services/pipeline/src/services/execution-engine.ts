import type { Logger, ServiceTokenSigner } from "@oneplatform/core";
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
  TransformStep,
  ConditionalStep,
  ParallelStep,
  WebhookStep,
  WaitStep,
  ApprovalStep,
  SubWorkflowStep,
  ParallelBranch,
} from "./pipeline-service.js";
import {
  dedup,
  filter,
  mapFields,
  aggregate,
  pivot,
  unpivot,
  join,
  sort,
  limit,
  rename,
  type DataRecord,
} from "./transform-engine.js";
import type {
  RunRow,
  RunStepRow,
  PipelineRunJobPayload,
  RunStatus,
  RunStepStatus,
  RunUpdateInput,
  RunStepRepository,
  RunLogRepository,
} from "./run-service.js";
import {
  StepExecutionError,
  SubWorkflowDepthExceededError,
  SubWorkflowCircularDependencyError,
  SubWorkflowPipelineNotFoundError,
  SubWorkflowTimeoutError,
  SubWorkflowChildFailedError,
} from "./errors.js";
import { evaluateCondition } from "./condition-evaluator.js";
import type { ExecutionTracker } from "./execution-tracker.js";
import type { ApprovalService } from "./approval-service.js";

// ---------------------------------------------------------------------------
// Repository interfaces required by the execution engine
// ---------------------------------------------------------------------------

export interface RunEngineRepository {
  findById(id: string): Promise<RunRow | null>;
  // Uses the concrete RunRepository's updateStatus signature.
  updateStatus(id: string, data: RunUpdateInput): Promise<RunRow | null>;
}

// The execution engine uses the same RunStepRepository interface as RunService,
// which has all the methods the engine needs (createBatch, updateStatus, updateOutput).
export type RunStepEngineRepository = RunStepRepository;

export interface RunLogEngineRepository {
  // Structural alias for the concrete repo's append method.
  append: RunLogRepository["append"];
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
  // The pipeline's top-level input, passed through to steps that source from "pipeline.input"
  runInput: Record<string, unknown>;
  // Accumulated step outputs keyed by stepId
  stepOutputs: Map<string, unknown>;
  // The pool client that holds the advisory lock for this run
  lockClient: PoolClient;
  // Cancellation flag checked between steps
  isCancelled: () => Promise<boolean>;
  // Ordered list of ancestor pipelineIds from the root call down to (but not
  // including) the current pipeline. Empty for top-level runs. Used to enforce
  // the max nesting depth and detect indirect circular dependencies
  // (e.g. A calls B, B calls A). Immutable for each context instance; child
  // contexts receive a new array with the parent pipelineId appended.
  subWorkflowCallStack: readonly string[];
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
// JSONata timeout helper
// ---------------------------------------------------------------------------

// Conditional step expressions are already wrapped with a 100ms timeout.
// Webhook body templates and response mappings use the same evaluator but
// can produce larger data and are afforded a generous 5-second budget before
// being treated as a DoS attempt via a maliciously crafted expression.
const JSONATA_WEBHOOK_TIMEOUT_MS = 5_000;

function evaluateWithTimeout(expr: ReturnType<typeof jsonata>, data: unknown): Promise<unknown> {
  return Promise.race([
    expr.evaluate(data),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`JSONata expression timed out after ${JSONATA_WEBHOOK_TIMEOUT_MS}ms`)),
        JSONATA_WEBHOOK_TIMEOUT_MS,
      ),
    ),
  ]);
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
// Sub-workflow nesting limit
//
// A depth of 5 prevents runaway recursive invocations while still allowing
// meaningful compositions. The call stack is threaded through RunContext so
// each nested execution can check its own depth and detect indirect cycles
// (A → B → A) without needing a separate shared data structure.
// ---------------------------------------------------------------------------

export const SUB_WORKFLOW_MAX_DEPTH = 5;

// ---------------------------------------------------------------------------
// Sub-workflow trigger interface
//
// Injected into the engine so sub-workflow execution can enqueue child runs
// and poll for their completion without coupling the engine to the concrete
// RunService or BullMQ queue implementations.
// ---------------------------------------------------------------------------

export interface SubWorkflowTriggerResult {
  runId: string;
}

export interface SubWorkflowCompletionResult {
  status: RunStatus;
  // The final output of the child run's last completed step, or null when the
  // child produced no output (empty pipeline or all steps skipped).
  output: Record<string, unknown> | null;
}

// SubWorkflowTrigger is the minimal surface that the engine needs from the
// RunService to start and await child runs. Keeping it as a narrow interface
// avoids a direct dependency on the full RunService and makes testing easier.
export interface SubWorkflowTrigger {
  // Enqueue a new run for the given pipeline and return its runId.
  triggerRun(
    pipelineId: string,
    tenantId: string,
    input: Record<string, unknown>,
  ): Promise<SubWorkflowTriggerResult>;

  // Poll until the run reaches a terminal state or timeoutMs elapses.
  // Rejects with SubWorkflowTimeoutError on timeout.
  waitForCompletion(
    runId: string,
    timeoutMs: number,
  ): Promise<SubWorkflowCompletionResult>;
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
  serviceTokenSigner: ServiceTokenSigner;
  // Optional — when provided, step transitions are reflected in the real-time
  // SSE tracker. Tests can omit this to avoid coupling to the tracker.
  executionTracker?: ExecutionTracker;
  // Optional — when provided, wait and approval steps use this service for
  // their control-flow state. When absent, approval steps immediately fail
  // (safe default for test environments that do not wire the service).
  approvalService?: ApprovalService;
  // Optional — when provided, sub_workflow steps can invoke child pipelines.
  // When absent, sub_workflow steps fail loudly with a descriptive error so
  // the absence is immediately visible rather than silently skipping.
  subWorkflowTrigger?: SubWorkflowTrigger;
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
    serviceTokenSigner,
    executionTracker,
    approvalService,
    subWorkflowTrigger,
  } = deps;

  // -------------------------------------------------------------------------
  // appendLog — writes a structured log entry to pipeline.run_logs
  // -------------------------------------------------------------------------

  async function appendLog(
    runId: string,
    tenantId: string,
    message: string,
    opts?: { stepId?: string; level?: "debug" | "info" | "warn" | "error"; details?: Record<string, unknown> },
  ): Promise<void> {
    await runLogRepo.append({
      run_id: runId,
      tenant_id: tenantId,
      ...(opts?.stepId !== undefined ? { step_id: opts.stepId } : {}),
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
    const token = await serviceTokenSigner.sign();
    const response = await fetch(url, {
      headers: { "X-Service-Token": token },
    });
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
    const token = await serviceTokenSigner.sign();
    const response = await fetch(`${executionServiceUrl}/internal/execution/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": token,
      },
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
  // executeTransformStep — applies a pre-built declarative transformation
  // (G-051).  All operations are pure synchronous functions; the async
  // wrapper exists only to conform to the StepResult promise interface.
  // -------------------------------------------------------------------------

  async function executeTransformStep(
    step: TransformStep,
    ctx: RunContext,
    resolvedInput: Record<string, unknown>,
  ): Promise<{ output: Record<string, unknown> }> {
    // Resolve the input record set.
    // When dataSource is set, pull records from a prior step's output.
    // Otherwise, use the resolved input's 'records' field, or treat the
    // entire resolved input as a single-element array if it is not an array.
    let inputRecords: DataRecord[];
    if (step.dataSource !== undefined) {
      const priorOutput = ctx.stepOutputs.get(step.dataSource);
      inputRecords = extractRecordArray(priorOutput, step.dataSource);
    } else {
      const rawRecords = resolvedInput["records"] ?? resolvedInput;
      inputRecords = Array.isArray(rawRecords)
        ? (rawRecords as DataRecord[])
        : [resolvedInput as DataRecord];
    }

    const op = step.transform;
    let outputRecords: DataRecord[];

    switch (op.operation) {
      case "dedup":
        outputRecords = dedup(inputRecords, op.keyFields, op.strategy);
        break;

      case "filter":
        outputRecords = filter(inputRecords, op.condition);
        break;

      case "map":
        outputRecords = mapFields(inputRecords, op.mappings);
        break;

      case "aggregate":
        outputRecords = aggregate(inputRecords, op.groupBy, op.aggregations);
        break;

      case "pivot":
        outputRecords = pivot(inputRecords, {
          groupField: op.groupField,
          pivotField: op.pivotField,
          valueField: op.valueField,
          aggregation: op.aggregation,
        });
        break;

      case "unpivot":
        outputRecords = unpivot(inputRecords, {
          keyField: op.keyField,
          valueFields: op.valueFields,
          nameColumn: op.nameColumn,
          valueColumn: op.valueColumn,
        });
        break;

      case "join": {
        // Resolve the right-hand record set from the named prior step
        const rightOutput = ctx.stepOutputs.get(op.rightDataSource);
        const rightRecords = extractRecordArray(rightOutput, op.rightDataSource);
        outputRecords = join(inputRecords, rightRecords, {
          joinType: op.joinType,
          leftKey: op.leftKey,
          rightKey: op.rightKey,
        });
        break;
      }

      case "sort":
        outputRecords = sort(inputRecords, op.fields);
        break;

      case "limit":
        outputRecords = limit(inputRecords, op.count);
        break;

      case "rename":
        outputRecords = rename(inputRecords, op.fieldMap);
        break;

      default: {
        // Exhaustive check — TypeScript will catch unhandled operations at build time.
        const _exhaustive: never = op;
        throw new StepExecutionError(
          `Unknown transform operation: ${JSON.stringify(_exhaustive)}`,
          { stepId: step.id },
        );
      }
    }

    return { output: { records: outputRecords, count: outputRecords.length } };
  }

  // Extracts a DataRecord[] from a prior step output, failing loudly when the
  // shape is unexpected rather than silently passing an empty array.
  function extractRecordArray(output: unknown, sourceStepId: string): DataRecord[] {
    if (output === null || output === undefined) {
      throw new StepExecutionError(
        `Transform join/dataSource: step "${sourceStepId}" produced no output.`,
      );
    }
    // Step outputs are wrapped as { records: [...] } by executeTransformStep
    if (typeof output === "object" && !Array.isArray(output)) {
      const wrapped = (output as Record<string, unknown>)["records"];
      if (Array.isArray(wrapped)) return wrapped as DataRecord[];
      // Fallback: treat the whole output as a single record
      return [output as DataRecord];
    }
    if (Array.isArray(output)) return output as DataRecord[];
    throw new StepExecutionError(
      `Transform: step "${sourceStepId}" output is not a record array (got ${typeof output}).`,
    );
  }

  // -------------------------------------------------------------------------
  // executeConnectorStep — dispatches to Ingestion Service
  // -------------------------------------------------------------------------

  async function executeConnectorStep(
    step: ConnectorStep,
    ctx: RunContext,
    resolvedInput: Record<string, unknown>,
  ): Promise<{ output: Record<string, unknown> }> {
    const token = await serviceTokenSigner.sign();
    const response = await fetch(`${ingestionServiceUrl}/internal/ingestion/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Token": token,
      },
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
      body = await evaluateWithTimeout(expr, { input: resolvedInput });
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
      const mapped = await evaluateWithTimeout(expr, output);
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
      // When conditionalNextId is defined, route to the chosen branch target.
      // When undefined (elseStepId absent and condition was false), fall
      // through to the next sequential step so execution continues.
      if (conditionalNextId !== undefined) {
        return conditionalNextId;
      }
    }

    const idx = steps.findIndex((s) => s.id === step.id);
    if (idx === -1 || idx === steps.length - 1) return null;
    return steps[idx + 1]?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // executeWaitStep — pauses execution for the configured duration.
  //
  // The sleep is implemented with a plain setTimeout so the BullMQ worker
  // process stays alive during the wait.  This works correctly for waits up to
  // the 24-hour maximum because BullMQ jobs have no processing-time limit
  // beyond the lock renewal interval (which BullMQ handles internally).
  // For very long waits (hours), a BullMQ delayed-job approach would be more
  // resilient to process restarts, but the 24-hour cap makes the simple approach
  // acceptable for V1 without overcomplicating the engine.
  // -------------------------------------------------------------------------

  async function executeWaitStep(
    step: WaitStep,
    ctx: RunContext,
  ): Promise<{ output: Record<string, unknown> }> {
    const startedAt = new Date();
    await appendLog(
      ctx.runId,
      ctx.tenantId,
      `Wait step "${step.name}" pausing for ${step.durationMs}ms.`,
      { stepId: step.id, level: "info", details: { durationMs: step.durationMs } },
    );

    await sleep(step.durationMs);

    const resumedAt = new Date();
    const actualDurationMs = resumedAt.getTime() - startedAt.getTime();

    return {
      output: {
        durationMs: step.durationMs,
        actualDurationMs,
        resumedAt: resumedAt.toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // executeApprovalStep — suspends execution until a human submits a decision.
  //
  // The engine polls the ApprovalService every APPROVAL_POLL_INTERVAL_MS.
  // This is intentionally simple: the HTTP API sets the decision on the
  // ApprovalService, and the next poll picks it up.  A more sophisticated
  // design would use a Promise that the HTTP handler resolves directly, but
  // that couples the web layer to the worker process — polling is safer when
  // the worker may run on a different instance than the API.
  //
  // The cancellation flag is checked on every poll so a pipeline cancel also
  // unblocks approval steps.
  // -------------------------------------------------------------------------

  const APPROVAL_POLL_INTERVAL_MS = 5_000; // 5s between polls

  async function executeApprovalStep(
    step: ApprovalStep,
    ctx: RunContext,
  ): Promise<{ output: Record<string, unknown> }> {
    if (approvalService === undefined) {
      throw new StepExecutionError(
        `Approval step "${step.id}" requires an ApprovalService but none was provided.`,
        { stepId: step.id },
      );
    }

    // Create the approval request (idempotent — safe on retry).
    const record = approvalService.requestApproval(
      ctx.runId,
      step.id,
      step.approvers,
      step.message,
      step.timeoutMs,
    );

    await appendLog(
      ctx.runId,
      ctx.tenantId,
      `Approval step "${step.name}" waiting for decision. Timeout at ${record.timeoutAt}.`,
      {
        stepId: step.id,
        level: "info",
        details: {
          approvers: step.approvers,
          timeoutAt: record.timeoutAt,
        },
      },
    );

    // Poll until a terminal decision or cancellation.
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      await sleep(APPROVAL_POLL_INTERVAL_MS);

      // Check run-level cancellation between polls.
      if (await ctx.isCancelled()) {
        // Cancellation is handled by the outer traversal loop; throw to surface it.
        throw new StepExecutionError(
          `Approval step "${step.id}" interrupted by pipeline cancellation.`,
          { stepId: step.id },
        );
      }

      const current = approvalService.getApprovalStatus(ctx.runId, step.id);
      if (current === null) {
        // Should never happen (we just created it), but be defensive.
        throw new StepExecutionError(
          `Approval record for step "${step.id}" unexpectedly missing from store.`,
          { stepId: step.id },
        );
      }

      if (current.status === "approved") {
        await appendLog(
          ctx.runId,
          ctx.tenantId,
          `Approval step "${step.name}" approved by "${current.decidedBy ?? "unknown"}".`,
          {
            stepId: step.id,
            level: "info",
            details: { decidedBy: current.decidedBy, comment: current.comment },
          },
        );
        return {
          output: {
            decision: "approved",
            decidedBy: current.decidedBy,
            decidedAt: current.decidedAt,
            comment: current.comment,
          },
        };
      }

      if (current.status === "rejected") {
        throw new StepExecutionError(
          `Approval step "${step.id}" rejected by "${current.decidedBy ?? "unknown"}": ${current.comment ?? "no comment provided"}.`,
          { stepId: step.id },
        );
      }

      if (current.status === "timed_out") {
        throw new StepExecutionError(
          `Approval step "${step.id}" timed out at ${current.timeoutAt} without a decision.`,
          { stepId: step.id },
        );
      }

      // status === "pending": keep polling
    }
  }

  // -------------------------------------------------------------------------
  // resolveSubWorkflowInput — maps parent context paths to child input fields.
  //
  // inputMapping: Record<childFieldName, dotPathIntoParentContext>
  // The path syntax mirrors skipIf expressions: { input, steps } is the root,
  // so "input.userId" reads from the parent run's top-level input and
  // "steps.extract-step.output.count" reads from a prior step's output.
  // -------------------------------------------------------------------------

  function resolveSubWorkflowInput(
    inputMapping: Record<string, string>,
    parentInput: Record<string, unknown>,
    parentStepOutputs: Map<string, unknown>,
  ): Record<string, unknown> {
    // Build the same { input, steps } context object that evaluateConditional uses
    // so path semantics are identical to skipIf expressions.
    const stepsCtx: Record<string, unknown> = {};
    for (const [sid, out] of parentStepOutputs) {
      stepsCtx[sid] = { output: out };
    }
    const parentCtx = { input: parentInput, steps: stepsCtx };

    const childInput: Record<string, unknown> = {};
    for (const [childField, parentPath] of Object.entries(inputMapping)) {
      childInput[childField] = getPath(parentCtx, parentPath);
    }
    return childInput;
  }

  // -------------------------------------------------------------------------
  // executeSubWorkflowStep — invokes another pipeline as a child execution.
  //
  // Safety invariants enforced before starting the child:
  //   1. Max nesting depth: callStack length must be < SUB_WORKFLOW_MAX_DEPTH.
  //      The stack records ancestor pipeline IDs, so length 4 means we are one
  //      level away from the limit and the child would be at level 5.
  //   2. No circular dependency: target pipelineId must not appear anywhere in
  //      the call stack nor equal the current pipeline ID.
  //
  // waitForCompletion=true: blocks until child reaches a terminal state and
  //   merges child output into the parent step result.
  // waitForCompletion=false: fires the child asynchronously and returns
  //   { childRunId, status: "pending" } immediately so the parent continues.
  // -------------------------------------------------------------------------

  async function executeSubWorkflowStep(
    step: SubWorkflowStep,
    ctx: RunContext,
  ): Promise<{ output: Record<string, unknown> }> {
    // Guard 1: max nesting depth.
    // callStack contains ancestor IDs (not the current one); adding the current
    // pipeline creates the full chain. If that chain is already SUB_WORKFLOW_MAX_DEPTH
    // items deep, the child would exceed the limit.
    if (ctx.subWorkflowCallStack.length >= SUB_WORKFLOW_MAX_DEPTH) {
      throw new SubWorkflowDepthExceededError(
        `Sub-workflow step "${step.id}" would exceed the maximum nesting depth of ${SUB_WORKFLOW_MAX_DEPTH}. ` +
        `Current depth: ${ctx.subWorkflowCallStack.length}. ` +
        `Call chain: ${[...ctx.subWorkflowCallStack, ctx.pipelineId].join(" → ")}`,
        {
          stepId: step.id,
          depth: ctx.subWorkflowCallStack.length,
          maxDepth: SUB_WORKFLOW_MAX_DEPTH,
        },
      );
    }

    // Guard 2: circular dependency.
    // Build the complete ancestor chain including the current pipeline.
    const fullCallChain = [...ctx.subWorkflowCallStack, ctx.pipelineId];
    if (fullCallChain.includes(step.pipelineId)) {
      throw new SubWorkflowCircularDependencyError(
        `Sub-workflow step "${step.id}" would create a circular dependency. ` +
        `Pipeline "${step.pipelineId}" already appears in the call chain: ` +
        `${fullCallChain.join(" → ")} → ${step.pipelineId}`,
        { stepId: step.id, pipelineId: step.pipelineId, callChain: fullCallChain },
      );
    }

    // Guard 3: sub-workflow trigger must be wired in deps.
    if (subWorkflowTrigger === undefined) {
      throw new StepExecutionError(
        `Sub-workflow step "${step.id}" cannot execute: subWorkflowTrigger is not configured in engine deps.`,
        { stepId: step.id },
      );
    }

    // Resolve child input from parent context via inputMapping.
    const childInput = step.inputMapping !== undefined
      ? resolveSubWorkflowInput(step.inputMapping, ctx.runInput, ctx.stepOutputs)
      : {};

    await appendLog(
      ctx.runId,
      ctx.tenantId,
      `Sub-workflow step "${step.name}" triggering child pipeline "${step.pipelineId}".`,
      {
        stepId: step.id,
        level: "info",
        details: {
          childPipelineId: step.pipelineId,
          waitForCompletion: step.waitForCompletion,
          callDepth: fullCallChain.length,
        },
      },
    );

    // Trigger the child run.
    let triggerResult: SubWorkflowTriggerResult;
    try {
      triggerResult = await subWorkflowTrigger.triggerRun(
        step.pipelineId,
        ctx.tenantId,
        childInput,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface pipeline-not-found as a dedicated error so authors can fix the
      // pipelineId reference rather than digging through generic failure logs.
      if (msg.includes("not found") || msg.includes("PIPELINE_NOT_FOUND")) {
        throw new SubWorkflowPipelineNotFoundError(
          `Sub-workflow step "${step.id}" references pipeline "${step.pipelineId}" which was not found or is inactive.`,
          { stepId: step.id, pipelineId: step.pipelineId },
        );
      }
      throw new StepExecutionError(
        `Sub-workflow step "${step.id}" failed to trigger child pipeline: ${msg}`,
        { stepId: step.id },
      );
    }

    const childRunId = triggerResult.runId;

    await appendLog(
      ctx.runId,
      ctx.tenantId,
      `Sub-workflow step "${step.name}" child run "${childRunId}" started.`,
      { stepId: step.id, details: { childRunId, childPipelineId: step.pipelineId } },
    );

    // Fire-and-forget mode: return immediately with child run metadata.
    if (!step.waitForCompletion) {
      return {
        output: { childRunId, childPipelineId: step.pipelineId, status: "pending" },
      };
    }

    // Synchronous mode: wait for the child run to reach a terminal state.
    // timeoutMs on the step caps how long we poll; fall back to the pipeline's
    // step default so there is always a bound.
    const waitTimeoutMs = step.timeoutMs
      ?? ctx.definition.options?.stepTimeout
      ?? stepDefaultTimeoutMs;

    let completion: SubWorkflowCompletionResult;
    try {
      completion = await subWorkflowTrigger.waitForCompletion(childRunId, waitTimeoutMs);
    } catch (err) {
      if (err instanceof SubWorkflowTimeoutError) {
        throw err;
      }
      throw new StepExecutionError(
        `Sub-workflow step "${step.id}" error while waiting for child run "${childRunId}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
        { stepId: step.id, childRunId },
      );
    }

    // Propagate child failure so the parent step fails and applies its own
    // onError / retry / fallback semantics normally.
    if (completion.status === "failed" || completion.status === "cancelled") {
      throw new SubWorkflowChildFailedError(
        `Sub-workflow step "${step.id}" child run "${childRunId}" finished with status "${completion.status}".`,
        { stepId: step.id, childRunId, childStatus: completion.status },
      );
    }

    await appendLog(
      ctx.runId,
      ctx.tenantId,
      `Sub-workflow step "${step.name}" child run "${childRunId}" completed successfully.`,
      { stepId: step.id, details: { childRunId, childStatus: completion.status } },
    );

    return {
      output: {
        childRunId,
        childPipelineId: step.pipelineId,
        status: completion.status,
        // Only include output key when the child produced output so callers can
        // detect "no output" via the key's absence rather than a null value.
        ...(completion.output !== null ? { output: completion.output } : {}),
      },
    };
  }

  // -------------------------------------------------------------------------
  // scheduleRetryDelay — resolves after the computed exponential backoff window.
  // Separated from executeStepWithRetry so tests can spy on it without needing
  // real timers. The delay grows as: backoffMs * (backoffMultiplier ^ attempt),
  // where attempt is 0-indexed (first retry = attempt 0, so delay = backoffMs).
  // -------------------------------------------------------------------------

  function computeBackoffMs(
    backoffMs: number,
    backoffMultiplier: number,
    attempt: number,
  ): number {
    return Math.round(backoffMs * Math.pow(backoffMultiplier, attempt));
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      ctx.runInput,
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

    if (step.type === "transform") {
      const result = await executeTransformStep(step, ctx, resolvedInput);
      return { output: result.output };
    }

    if (step.type === "conditional") {
      // Build the data context for condition evaluation.
      // The condition field paths are resolved against a flat map that merges
      // the pipeline's top-level input with all accumulated step outputs so
      // that conditions can reference both sources without extra indirection.
      const dataContext: Record<string, unknown> = {
        ...ctx.runInput,
        ...resolvedInput,
      };

      const result = evaluateCondition(dataContext, step.condition);

      // Determine routing: true -> thenStepId, false -> elseStepId (or undefined
      // which signals "fall through to the next sequential step").
      const nextStepId = result ? step.thenStepId : step.elseStepId;

      await appendLog(
        ctx.runId,
        ctx.tenantId,
        `Conditional step "${step.name}" evaluated to ${result}: routing to ${nextStepId ?? "next sequential step"}.`,
        {
          stepId: step.id,
          level: "info",
          details: {
            conditionField: step.condition.field,
            conditionOperator: step.condition.operator,
            conditionResult: result,
            nextStepId: nextStepId ?? null,
          },
        },
      );

      // exactOptionalPropertyTypes requires we omit nextStepId entirely
      // when it is undefined rather than setting it to undefined explicitly.
      if (nextStepId !== undefined) {
        return { output: { condition: result, nextStepId }, nextStepId };
      }
      return { output: { condition: result, nextStepId: null } };
    }

    if (step.type === "parallel") {
      const result = await executeParallelStep(step, ctx);
      return { output: result.output };
    }

    if (step.type === "webhook") {
      const result = await executeWebhookStep(step, ctx, resolvedInput);
      return { output: result.output };
    }

    if (step.type === "wait") {
      const result = await executeWaitStep(step, ctx);
      return { output: result.output };
    }

    if (step.type === "approval") {
      const result = await executeApprovalStep(step, ctx);
      return { output: result.output };
    }

    if (step.type === "sub_workflow") {
      const result = await executeSubWorkflowStep(step, ctx);
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

      // Cast definition_snapshot from JSONB Record to the typed PipelineDefinition.
      // The definition was validated against PipelineDefinitionSchema at write time.
      const definition = run.definition_snapshot as unknown as PipelineDefinition;

      // Build the run context shared across all step executions.
      // subWorkflowCallStack is empty for top-level runs; child runs receive
      // a context with the parent pipelineId appended (see executeSubWorkflowStep).
      const ctx: RunContext = {
        runId,
        tenantId,
        pipelineId: run.pipeline_id,
        definition,
        runInput: run.input,
        stepOutputs: new Map(),
        lockClient,
        isCancelled: async () => {
          const flag = await redis.get(cancellationKey(runId));
          return flag !== null;
        },
        subWorkflowCallStack: [],
      };

      // Step 3: Transition to running
      await runRepo.updateStatus(runId, { status: "running", started_at: new Date() });
      await appendLog(runId, tenantId, `Pipeline run started, triggered by ${run.triggered_by}`);

      // Step 4: Create run_steps rows for all steps (status=pending) so the UI
      // can display the full step graph immediately
      const allSteps = definition.steps;
      await runStepRepo.createBatch(
        allSteps.map((step) => ({
          run_id: runId,
          tenant_id: tenantId,
          step_id: step.id,
          step_name: step.name,
          step_type: step.type,
          input: {},
        })),
      );

      // Initialize in-memory execution tracking so SSE subscribers get immediate
      // visibility into the pending step list.
      //
      // Capture the run's input as an immutable snapshot for replay support.
      // The size guard is enforced inside startExecution; we warn here so the
      // oversized-input case is observable in logs without blocking the run.
      const inputSnapshotBytes = JSON.stringify(run.input).length;
      if (inputSnapshotBytes > 1_048_576) {
        logger.warn("Input snapshot exceeds 1 MiB limit — snapshot will not be stored for replay", {
          runId,
          pipelineId: run.pipeline_id,
          inputBytes: inputSnapshotBytes,
        });
      }

      // replayOf is stored in trigger_meta by the replay route so the engine
      // does not need its own field on RunRow.
      const replayOf = typeof run.trigger_meta["replayOf"] === "string"
        ? run.trigger_meta["replayOf"]
        : undefined;

      executionTracker?.startExecution(
        runId,
        run.pipeline_id,
        allSteps.map((s) => ({ stepId: s.id, name: s.name, type: s.type })),
        {
          // exactOptionalPropertyTypes: only spread optional keys when they have
          // actual values so we never assign `undefined` to an optional-typed key.
          ...(run.input !== undefined ? { inputSnapshot: run.input } : {}),
          ...(replayOf !== undefined ? { replayOf } : {}),
        },
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
          await runRepo.updateStatus(runId, {
            status: "failed",
            completed_at: new Date(),
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
      let currentStepId: string | null = definition.entryStepId;
      let failedStepId: string | null = null;
      let failureError: Error | null = null;

      // Pre-fetch all run_step rows once and build a lookup map to avoid N+1
      // queries inside the step traversal loop.
      const allRunStepRows = await runStepRepo.findByRunId(runId);
      const runStepMap = new Map(allRunStepRows.map((r) => [r.step_id, r]));

      stepTraversal:
      while (currentStepId !== null) {
        // Cancellation check between steps
        if (await ctx.isCancelled()) {
          // Mark all remaining pending steps as cancelled — use the pre-fetched
          // map instead of re-querying.
          const pendingRows = allRunStepRows.filter((r) => r.status === "pending");
          await Promise.all(
            pendingRows.map((r) => runStepRepo.updateStatus(runId, r.step_id, { status: "cancelled" })),
          );

          await runRepo.updateStatus(runId, { status: "cancelled", completed_at: new Date() });
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

        // Find the run_step row for this step from the pre-fetched map
        const runStepRow = runStepMap.get(currentStepId);
        if (runStepRow === undefined) break;

        // Evaluate per-step skipIf expression (JSONata, 100ms timeout).
        // skipIf is separate from the conditional step type; it is a pre-execution
        // guard on any step type that short-circuits to the next sequential step
        // without executing the step body.
        if (step.skipIf !== undefined && step.skipIf.length > 0) {
          const stepsCtx: Record<string, unknown> = {};
          for (const [sid, out] of ctx.stepOutputs) {
            stepsCtx[sid] = { output: out };
          }
          let skip = false;
          try {
            const condTrue = await evaluateConditional(step.skipIf, {
              input: run.input,
              steps: stepsCtx,
            });
            skip = condTrue;
          } catch {
            skip = false; // On skipIf error, proceed with the step
          }

          if (skip) {
            await runStepRepo.updateStatus(runId, runStepRow.step_id, { status: "skipped" });
            executionTracker?.updateStepStatus(runId, step.id, "skipped");
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
            await runStepRepo.updateStatus(runId, runStepRow.step_id, {
              status: "failed",
              completed_at: new Date(),
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
        await runStepRepo.updateStatus(runId, runStepRow.step_id, {
          status: "running",
          started_at: new Date(),
        });
        executionTracker?.updateStepStatus(runId, step.id, "running");

        await appendLog(runId, tenantId, `Step "${step.name}" started.`, { stepId: step.id });

        // Execute the step with per-step retry logic.
        //
        // Retry sequence (when retryConfig is present):
        //   1. Attempt the step.
        //   2. On failure, if attempts remaining > 0: log, increment attempt_count,
        //      wait backoffMs * (backoffMultiplier ^ attemptIndex), then retry.
        //   3. After retries are exhausted (or retryConfig absent): check fallbackStepId.
        //      If set, jump to the fallback step instead of applying onError.
        //   4. Otherwise apply onError ("skip" continues; "fail" breaks the traversal).
        let stepOutput: unknown;
        let nextStepId: string | undefined;
        let stepSucceeded = false;

        const maxRetries = step.retryConfig?.maxRetries ?? 0;
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          // Only increment attempt_count on retries (not the first attempt)
          if (attempt > 0) {
            const delayMs = computeBackoffMs(
              step.retryConfig!.backoffMs,
              step.retryConfig!.backoffMultiplier,
              attempt - 1,
            );
            await appendLog(
              runId,
              tenantId,
              `Step "${step.name}" retry ${attempt}/${maxRetries} after ${delayMs}ms (previous error: ${lastError?.message ?? "unknown"}).`,
              { stepId: step.id, level: "warn", details: { attempt, delayMs } },
            );
            await runStepRepo.updateStatus(runId, runStepRow.step_id, {
              attempt_count: attempt,
            });
            await sleep(delayMs);
          }

          try {
            const result = await executeStep(step, ctx);
            stepOutput = result.output;
            nextStepId = result.nextStepId;
            stepSucceeded = true;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            // Will retry if attempt < maxRetries; otherwise falls through to
            // error handling below.
          }
        }

        if (!stepSucceeded) {
          const errMessage = lastError?.message ?? "unknown error";

          await runStepRepo.updateStatus(runId, runStepRow.step_id, {
            status: "failed",
            completed_at: new Date(),
            error: { code: "STEP_EXECUTION_FAILED", message: errMessage },
          });
          executionTracker?.updateStepStatus(runId, step.id, "failed", { error: errMessage });

          await appendLog(runId, tenantId, `Step "${step.name}" failed after ${maxRetries + 1} attempt(s): ${errMessage}`, {
            stepId: step.id,
            level: "error",
          });

          // Fallback step takes precedence over onError when configured.
          // The fallback step executes next; this step's output is set to null
          // so downstream steps that read from it receive null rather than undefined.
          if (step.fallbackStepId !== undefined) {
            ctx.stepOutputs.set(step.id, null);
            currentStepId = step.fallbackStepId;
            continue;
          }

          const onError = step.onError ?? "fail";
          if (onError === "skip") {
            // Non-fatal — continue traversal with null output for this step
            ctx.stepOutputs.set(step.id, null);
            currentStepId = getNextStepIdFromMain(step, allSteps, undefined);
            continue;
          }

          // onError === "fail": propagate failure
          failedStepId = step.id;
          failureError = lastError ?? new Error(errMessage);
          break stepTraversal;
        }

        ctx.stepOutputs.set(step.id, stepOutput);

        await runStepRepo.updateStatus(runId, runStepRow.step_id, {
          status: "completed",
          completed_at: new Date(),
        });
        executionTracker?.updateStepStatus(runId, step.id, "completed");

        // Write output separately — updateOutput is a dedicated method because
        // output can be large JSONB and is only set on success.
        const outputRecord = (stepOutput !== null && typeof stepOutput === "object")
          ? (stepOutput as Record<string, unknown>)
          : { value: stepOutput };
        await runStepRepo.updateOutput(runId, runStepRow.step_id, outputRecord);

        await appendLog(runId, tenantId, `Step "${step.name}" completed.`, { stepId: step.id });

        // Emit step completion platform event
        await emitPlatformEvent("pipeline.step.completed", tenantId, {
          pipelineId: run.pipeline_id,
          runId,
          stepId: step.id,
          stepName: step.name,
        });

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
            await runStepRepo.updateStatus(runId, runStepRow.step_id, {
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
            .map((r) => runStepRepo.updateStatus(runId, r.step_id, { status: "cancelled" })),
        );

        await runRepo.updateStatus(runId, {
          status: "failed",
          completed_at: new Date(),
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

        // Notify SSE subscribers that the execution has reached a terminal state.
        executionTracker?.completeExecution(runId, "failed");
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
          await runRepo.updateStatus(runId, {
            status: "failed",
            completed_at: new Date(),
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

      await runRepo.updateStatus(runId, { status: "completed", completed_at: completedAt });
      await appendLog(runId, tenantId, `Pipeline run completed in ${durationMs}ms.`);

      await emitPlatformEvent("pipeline.completed", tenantId, {
        pipelineId: run.pipeline_id,
        runId,
        durationMs,
        stepCount: allSteps.length,
      });

      // Notify SSE subscribers that the execution has finished successfully.
      executionTracker?.completeExecution(runId, "completed");
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
      // When conditionalNext is defined, route to the chosen branch target.
      // When undefined (elseStepId absent and condition was false), fall
      // through to the next sequential step in the pipeline's steps array.
      if (conditionalNext !== undefined) {
        return conditionalNext;
      }
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
