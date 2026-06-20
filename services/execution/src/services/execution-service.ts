import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "@oneplatform/core";
import type { ExecutionRepository } from "../repositories/execution-repository.js";
import type { ExecutionLogRepository } from "../repositories/execution-log-repository.js";
import type {
  ExecutionRow,
  CreateExecutionData,
} from "../repositories/types.js";
import type {
  RunRequest,
  InternalRunRequest,
  ConnectorRunRequest,
  PluginDrainRequest,
  CachePrefetchRequest,
  CacheInvalidateRequest,
  ListExecutionsQueryInput,
} from "../schemas/index.js";
import type { ExecutionRouter, RouteRequest } from "./execution-router.js";
import type { PluginBundleCache } from "./plugin-cache.js";
import type { SseManager, SseLogEvent } from "./sse-manager.js";
import type { ContextCallHandler } from "./context-call-handler.js";
import type { UnixSocketClient, SandboxLogLine } from "./unix-socket-client.js";
import {
  ExecutionNotFoundError,
  ServiceDrainingError,
} from "./errors.js";
import type { UserContext } from "@oneplatform/core";
import { ForbiddenError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// ExecutionService — main orchestrator for execution lifecycle
// Design spec §1, §4, §6
// ---------------------------------------------------------------------------

export interface RunExecutionResult {
  executionId: string;
  status: "pending";
  logsUrl: string;
}

export interface ConnectorRunResult {
  executionId: string;
  status: "success" | "error" | "timeout";
  result: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
  memoryPeakMb: number | null;
}

export interface DrainPluginResult {
  pluginId: string;
  drainedAt: string;
  inflightAtDrainStart: number;
  inflightAtCompletion: number;
  killedExecutions: string[];
}

export interface PrefetchResult {
  pluginId: string;
  version: string;
  cached: boolean;
  bundleSizeBytes: number;
  fetchDurationMs: number;
}

export interface InvalidateResult {
  evicted: boolean;
  pluginId: string;
}

export interface ExecutionService {
  runExecution(request: RunRequest, user: UserContext): Promise<RunExecutionResult>;
  /** @param initiatedBy The service name extracted from the verified service token sub claim. */
  runInternalExecution(request: InternalRunRequest, initiatedBy: string): Promise<RunExecutionResult>;
  runConnectorExecution(request: ConnectorRunRequest, initiatedBy: string): Promise<ConnectorRunResult>;
  getExecution(tenantId: string, id: string): Promise<ExecutionRow>;
  listExecutions(tenantId: string, query: ListExecutionsQueryInput): Promise<ExecutionRow[]>;
  drainPlugin(request: PluginDrainRequest): Promise<DrainPluginResult>;
  invalidatePluginCache(request: CacheInvalidateRequest): Promise<InvalidateResult>;
  prefetchPluginBundle(request: CachePrefetchRequest): Promise<PrefetchResult>;
  /** Notify service that a sandbox crash occurred — marks in-flight executions as killed */
  handleSandboxCrash(killedExecutionIds: string[]): void;
}

export interface ExecutionServiceDeps {
  executionRepo: ExecutionRepository;
  logRepo: ExecutionLogRepository;
  executionRouter: ExecutionRouter;
  pluginBundleCache: PluginBundleCache;
  sseManager: SseManager;
  contextCallHandler: ContextCallHandler;
  sandboxClient: UnixSocketClient;
  logger: Logger;
  /** Base URL of this service (used to construct logsUrl in responses) */
  serviceBaseUrl: string;
  /** Service name reported in execution records and log context */
  serviceName?: string;
}

export function createExecutionService(deps: ExecutionServiceDeps): ExecutionService {
  const {
    executionRepo,
    logRepo,
    executionRouter,
    pluginBundleCache,
    sseManager,
    sandboxClient,
    logger,
    serviceBaseUrl,
    serviceName = "execution-service",
  } = deps;

  // Plugins currently being drained — new requests for listed pluginIds are rejected.
  // Must be per-service-instance (inside the factory) so test isolation and future
  // multi-instance setups do not share state across unrelated instances.
  const drainingPlugins = new Map<string, boolean>();

  // Tracks started_at for in-flight executions so log line DB inserts use the
  // correct partition date. Log lines may arrive after midnight relative to when
  // the execution started; using the log line's own timestamp would route those
  // rows into the wrong co-partitioned range.
  const executionStartedAt = new Map<string, Date>();

  // ---------------------------------------------------------------------------
  // Wire sandbox log line callback — fan out to SSE and DB
  // ---------------------------------------------------------------------------

  sandboxClient.onLogLine((logLine: SandboxLogLine) => {
    const sseLog: SseLogEvent = {
      type: "log",
      line: logLine.line,
      level: logLine.level,
      stream: logLine.stream,
      message: logLine.message,
      timestamp: logLine.timestamp,
    };

    // Fan out to SSE subscribers immediately (real-time streaming)
    sseManager.publish(logLine.id, sseLog);

    // Write to DB asynchronously — do not await to keep the socket receive path fast.
    // Loss on crash is acceptable; SSE ensures real-time delivery to connected clients.
    //
    // execution_date must match the execution's started_at so the log row lands in
    // the correct co-partitioned range. Using the log line's own timestamp would
    // cause rows to drift into the wrong daily partition whenever the log line
    // arrives after midnight relative to when the execution started.
    const executionDate = executionStartedAt.get(logLine.id) ?? new Date(logLine.timestamp);
    logRepo
      .append({
        execution_id: logLine.id,
        execution_date: executionDate,
        level: logLine.level,
        message: logLine.message,
        line_number: logLine.line,
        stream: logLine.stream,
      })
      .catch((err) => {
        logger.error("ExecutionService: failed to persist log line", {
          executionId: logLine.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });

  // ---------------------------------------------------------------------------
  // runExecution — user-facing /api/v1/exec/run
  // ---------------------------------------------------------------------------

  async function runExecution(
    request: RunRequest,
    user: UserContext,
  ): Promise<RunExecutionResult> {
    if (!user.scopes.includes("execution:run")) {
      throw new ForbiddenError("Scope 'execution:run' is required.");
    }

    const traceId = randomUUID();
    const codeHash = createHash("sha256").update(request.code).digest("hex");

    const createData: CreateExecutionData = {
      tenant_id: user.tenantId,
      type: "code",
      language: request.language,
      sandbox_type: "isolated-vm",
      trace_id: traceId,
      initiated_by: "api",
      code_hash: codeHash,
    };

    const execution = await executionRepo.create(createData);

    // Dispatch asynchronously — the response is 202 Accepted with logsUrl
    void dispatchExecution(execution, request.code, request.timeout ?? 30_000, {
      executionId: execution.id,
      tenantId: user.tenantId,
      hookContext: false,
      executionType: "code",
      traceId,
    });

    return {
      executionId: execution.id,
      status: "pending",
      logsUrl: `${serviceBaseUrl}/api/v1/exec/${execution.id}/logs`,
    };
  }

  // ---------------------------------------------------------------------------
  // runInternalExecution — service-to-service /internal/execution/run
  // ---------------------------------------------------------------------------

  async function runInternalExecution(
    request: InternalRunRequest,
    initiatedBy: string,
  ): Promise<RunExecutionResult> {
    const ctx = request.context;
    const pluginId = ctx.pluginId;

    // Check drain status before accepting the request
    if (pluginId !== undefined && drainingPlugins.has(pluginId)) {
      throw new ServiceDrainingError(
        `Plugin ${pluginId} is currently being drained. Retry after drain completes.`,
      );
    }

    const codeHash = createHash("sha256").update(request.code).digest("hex");
    const sandboxType =
      request.language === "js" || request.language === "ts" ? "isolated-vm" : "docker";

    const createData: CreateExecutionData = {
      tenant_id: ctx.tenantId,
      type: request.type,
      language: request.language,
      sandbox_type: sandboxType,
      trace_id: ctx.traceId,
      // Use the verified service token sub claim so audit records name the actual caller
      initiated_by: initiatedBy,
      code_hash: codeHash,
      ...(pluginId !== undefined ? { plugin_id: pluginId } : {}),
      ...(ctx.pipelineId !== undefined ? { pipeline_id: ctx.pipelineId } : {}),
      ...(ctx.pipelineRunId !== undefined ? { pipeline_run_id: ctx.pipelineRunId } : {}),
      hook_context: ctx.hookContext ?? false,
    };

    const execution = await executionRepo.create(createData);

    void dispatchExecution(execution, request.code, request.timeout, {
      executionId: execution.id,
      tenantId: ctx.tenantId,
      hookContext: ctx.hookContext ?? false,
      executionType: request.type,
      traceId: ctx.traceId,
      ...(pluginId !== undefined ? { pluginId } : {}),
      ...(ctx.credentialBundleId !== undefined ? { credentialBundleId: ctx.credentialBundleId } : {}),
      ...(ctx.ontologySnapshot !== undefined ? { ontologySnapshot: ctx.ontologySnapshot } : {}),
    });

    return {
      executionId: execution.id,
      status: "pending",
      logsUrl: `${serviceBaseUrl}/api/v1/exec/${execution.id}/logs`,
    };
  }

  // ---------------------------------------------------------------------------
  // runConnectorExecution — synchronous connector invocation (waits for result)
  // Design spec §4.5
  // ---------------------------------------------------------------------------

  async function runConnectorExecution(
    request: ConnectorRunRequest,
    initiatedBy: string,
  ): Promise<ConnectorRunResult> {
    // Fetch plugin bundle from cache (or Plugin Service).
    // "latest" is a well-known sentinel that the Plugin Service resolves to the
    // current published version; it also ensures a stable cache key rather than
    // the empty string which always misses (the LRU key includes the version segment).
    const bundle = await pluginBundleCache.get(
      request.tenantId,
      request.pluginId,
      "latest",
    );

    const traceId = request.traceId;
    const createData: CreateExecutionData = {
      tenant_id: request.tenantId,
      type: "connector-run",
      language: "js",
      sandbox_type: "isolated-vm",
      trace_id: traceId,
      // Use the verified service token sub claim so audit records name the actual caller
      initiated_by: initiatedBy,
      plugin_id: request.pluginId,
      ...(request.pipelineRunId !== undefined ? { pipeline_run_id: request.pipelineRunId } : {}),
    };

    const execution = await executionRepo.create(createData);
    executionStartedAt.set(execution.id, execution.started_at);

    await executionRepo.updateStatus(execution.id, { status: "running" });

    const routeRequest: RouteRequest = {
      executionId: execution.id,
      type: "connector-run",
      language: "js",
      code: bundle?.bundleBase64 ?? "",
      timeout: request.timeout,
      context: {
        executionId: execution.id,
        tenantId: request.tenantId,
        hookContext: false,
        executionType: "connector-run",
        traceId,
        pluginId: request.pluginId,
        credentialBundleId: request.credentialBundleId,
      },
      ...(bundle !== null ? { pluginBundleBase64: bundle.bundleBase64 } : {}),
    };

    let result: Awaited<ReturnType<typeof executionRouter.route>>;
    try {
      result = await executionRouter.route(routeRequest);
    } catch (err) {
      executionStartedAt.delete(execution.id);
      const errMsg = err instanceof Error ? err.message : String(err);
      await executionRepo.updateStatus(execution.id, {
        status: "error",
        completion: {
          completed_at: new Date(),
          duration_ms: 0,
          exit_code: 1,
          error_code: "EXECUTION_SANDBOX_CRASH",
          error_message: errMsg,
        },
      });

      return {
        executionId: execution.id,
        status: "error",
        result: null,
        errorCode: "EXECUTION_SANDBOX_CRASH",
        errorMessage: errMsg,
        durationMs: 0,
        memoryPeakMb: null,
      };
    }

    const terminalStatus =
      result.status === "ok"
        ? "success"
        : result.status === "timeout"
          ? "timeout"
          : "error";

    executionStartedAt.delete(execution.id);

    await executionRepo.updateStatus(execution.id, {
      status: terminalStatus,
      completion: {
        completed_at: new Date(),
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        ...(result.memoryPeakMb !== 0 ? { memory_peak_mb: result.memoryPeakMb } : {}),
        ...(result.errorCode !== undefined ? { error_code: result.errorCode } : {}),
        ...(result.errorMessage !== undefined ? { error_message: result.errorMessage } : {}),
        ...(result.errorStack !== undefined ? { error_stack: result.errorStack } : {}),
      },
    });

    return {
      executionId: execution.id,
      status: terminalStatus as "success" | "error" | "timeout",
      result: result.status === "ok" ? (result.result ?? null) : null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      durationMs: result.durationMs,
      memoryPeakMb: result.memoryPeakMb !== 0 ? result.memoryPeakMb : null,
    };
  }

  // ---------------------------------------------------------------------------
  // dispatchExecution — fire-and-forget async dispatch for 202 endpoints
  // ---------------------------------------------------------------------------

  async function dispatchExecution(
    execution: ExecutionRow,
    code: string,
    timeout: number,
    context: RouteRequest["context"],
  ): Promise<void> {
    executionStartedAt.set(execution.id, execution.started_at);
    try {
      await executionRepo.updateStatus(execution.id, { status: "running" });

      const routeRequest: RouteRequest = {
        executionId: execution.id,
        type: execution.type,
        language: execution.language,
        code,
        timeout,
        context,
      };

      const result = await executionRouter.route(routeRequest);

      const terminalStatus =
        result.status === "ok"
          ? "success"
          : result.status === "timeout"
            ? "timeout"
            : result.status === "oom"
              ? "killed"
              : "error";

      await executionRepo.updateStatus(execution.id, {
        status: terminalStatus,
        completion: {
          completed_at: new Date(),
          duration_ms: result.durationMs,
          exit_code: result.exitCode,
          ...(result.memoryPeakMb !== 0 ? { memory_peak_mb: result.memoryPeakMb } : {}),
          ...(result.errorCode !== undefined ? { error_code: result.errorCode } : {}),
          ...(result.errorMessage !== undefined ? { error_message: result.errorMessage } : {}),
          ...(result.errorStack !== undefined ? { error_stack: result.errorStack } : {}),
        },
      });

      if (result.status === "ok") {
        sseManager.publishComplete(execution.id, "success", result.durationMs, result.exitCode);
      } else {
        sseManager.publishError(
          execution.id,
          result.errorCode ?? "EXECUTION_ERROR",
          result.errorMessage ?? "Execution failed",
          terminalStatus === "killed" ? "killed" : terminalStatus === "timeout" ? "timeout" : "error",
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("ExecutionService: dispatch failed", {
        executionId: execution.id,
        error: errMsg,
      });

      await executionRepo
        .updateStatus(execution.id, {
          status: "error",
          completion: {
            completed_at: new Date(),
            duration_ms: 0,
            exit_code: 1,
            error_code: "EXECUTION_SANDBOX_CRASH",
            error_message: errMsg,
          },
        })
        .catch(() => undefined);

      sseManager.publishError(execution.id, "EXECUTION_SANDBOX_CRASH", errMsg, "error");
    } finally {
      executionStartedAt.delete(execution.id);
    }
  }

  // ---------------------------------------------------------------------------
  // getExecution
  // ---------------------------------------------------------------------------

  async function getExecution(tenantId: string, id: string): Promise<ExecutionRow> {
    const row = await executionRepo.findByTenantAndId(tenantId, id);
    if (row === null) {
      throw new ExecutionNotFoundError(`Execution ${id} not found.`);
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // listExecutions
  // ---------------------------------------------------------------------------

  async function listExecutions(
    tenantId: string,
    query: ListExecutionsQueryInput,
  ): Promise<ExecutionRow[]> {
    return executionRepo.findByTenantId(tenantId, query);
  }

  // ---------------------------------------------------------------------------
  // drainPlugin — design spec §4.6
  // ---------------------------------------------------------------------------

  async function drainPlugin(request: PluginDrainRequest): Promise<DrainPluginResult> {
    const { pluginId, tenantId, gracePeriodMs } = request;

    // Mark plugin as draining — rejects new execution requests for this plugin
    drainingPlugins.set(pluginId, true);

    const inflightAtStart = await executionRepo.countInflightByPluginId(pluginId);
    const drainStart = Date.now();
    const killedExecutions: string[] = [];

    logger.info("ExecutionService: plugin drain started", {
      pluginId,
      tenantId: tenantId ?? "platform-wide",
      inflightAtStart,
      gracePeriodMs,
    });

    // Wait for in-flight executions to complete within the grace period
    await new Promise<void>((resolve) => {
      function poll(): void {
        const elapsed = Date.now() - drainStart;
        executionRepo
          .countInflightByPluginId(pluginId)
          .then(async (count) => {
            if (count === 0 || elapsed >= gracePeriodMs) {
              if (count > 0) {
                // Grace period expired — force-kill remaining
                const inflight = await executionRepo.findByPluginId(pluginId);
                for (const row of inflight) {
                  killedExecutions.push(row.id);
                  await executionRepo.updateStatus(row.id, {
                    status: "killed",
                    completion: {
                      completed_at: new Date(),
                      duration_ms: 0,
                      exit_code: 1,
                      error_code: "EXECUTION_SANDBOX_CRASH",
                      error_message: "Force-killed during plugin drain.",
                    },
                  });
                  sseManager.publishError(row.id, "EXECUTION_SANDBOX_CRASH", "Force-killed during plugin drain.", "killed");
                }
              }
              resolve();
            } else {
              setTimeout(poll, 500);
            }
          })
          .catch(() => resolve());
      }
      poll();
    });

    const inflightAtCompletion = await executionRepo.countInflightByPluginId(pluginId);

    // Evict plugin bundle from cache
    pluginBundleCache.invalidate(pluginId, tenantId);

    // Remove from drain list so the plugin can be re-enabled
    drainingPlugins.delete(pluginId);

    logger.info("ExecutionService: plugin drain complete", {
      pluginId,
      inflightAtStart,
      inflightAtCompletion,
      killedCount: killedExecutions.length,
    });

    return {
      pluginId,
      drainedAt: new Date().toISOString(),
      inflightAtDrainStart: inflightAtStart,
      inflightAtCompletion,
      killedExecutions,
    };
  }

  // ---------------------------------------------------------------------------
  // invalidatePluginCache — design spec §4.8
  // ---------------------------------------------------------------------------

  async function invalidatePluginCache(
    request: CacheInvalidateRequest,
  ): Promise<InvalidateResult> {
    // Check if there is anything to evict before calling invalidate
    const stats = pluginBundleCache.getBundleStats();
    const countBefore = stats.currentEntryCount;

    pluginBundleCache.invalidate(request.pluginId, request.tenantId);

    const countAfter = pluginBundleCache.getBundleStats().currentEntryCount;
    const evicted = countAfter < countBefore;

    logger.info("ExecutionService: plugin cache invalidated", {
      pluginId: request.pluginId,
      tenantId: request.tenantId ?? "platform-wide",
      newVersion: request.newBundleVersion,
      evicted,
    });

    return { evicted, pluginId: request.pluginId };
  }

  // ---------------------------------------------------------------------------
  // prefetchPluginBundle — design spec §4.7
  // ---------------------------------------------------------------------------

  async function prefetchPluginBundle(
    request: CachePrefetchRequest,
  ): Promise<PrefetchResult> {
    const start = Date.now();
    const tenantId = request.tenantId ?? "platform";

    let cached = false;
    let bundleSizeBytes = 0;

    try {
      const bundle = await pluginBundleCache.get(tenantId, request.pluginId, request.version);
      if (bundle !== null) {
        cached = true;
        bundleSizeBytes = bundle.bundleSizeBytes;
      }
    } catch (err) {
      logger.warn("ExecutionService: prefetch failed — non-fatal", {
        pluginId: request.pluginId,
        version: request.version,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      pluginId: request.pluginId,
      version: request.version,
      cached,
      bundleSizeBytes,
      fetchDurationMs: Date.now() - start,
    };
  }

  // ---------------------------------------------------------------------------
  // handleSandboxCrash — called by SandboxManager crash callback
  // ---------------------------------------------------------------------------

  function handleSandboxCrash(killedExecutionIds: string[]): void {
    logger.error("ExecutionService: sandbox crash — marking in-flight executions as killed", {
      killedCount: killedExecutionIds.length,
    });

    for (const id of killedExecutionIds) {
      // Best-effort DB update and SSE notification — crash recovery must not block
      executionRepo
        .updateStatus(id, {
          status: "killed",
          completion: {
            completed_at: new Date(),
            duration_ms: 0,
            exit_code: 1,
            error_code: "EXECUTION_SANDBOX_CRASH",
            error_message: "Sandbox process crashed unexpectedly.",
          },
        })
        .catch((err) => {
          logger.error("ExecutionService: failed to mark execution as killed after crash", {
            executionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      sseManager.publishError(
        id,
        "EXECUTION_SANDBOX_CRASH",
        "Sandbox process crashed unexpectedly.",
        "killed",
      );
    }
  }

  // Side-effect suppression — serviceName is used in log context in a real
  // implementation; retained here so the parameter is not dead.
  void serviceName;

  return {
    runExecution,
    runInternalExecution,
    runConnectorExecution,
    getExecution,
    listExecutions,
    drainPlugin,
    invalidatePluginCache,
    prefetchPluginBundle,
    handleSandboxCrash,
  };
}
