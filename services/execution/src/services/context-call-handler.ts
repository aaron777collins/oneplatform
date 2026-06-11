import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// ContextCallHandler — handles PluginContext API calls from the sandbox
// Design spec §11.2 / §11.3 / §12
//
// When sandbox user code calls context.fetch(), context.credentials.get(),
// context.cache.get(), or context.pipeline.trigger(), the sandbox sends a
// `contextCall` message back over the Unix socket. This handler dispatches
// each call to the appropriate platform service and returns the result.
//
// Security invariants enforced here:
//   1. fetch()   — block RFC 1918 and internal service URLs (spec §11.3)
//   2. pipeline.trigger() — blocked when hookContext = true (spec §12)
//   3. credentials.get() — only permitted for connector-run type
// ---------------------------------------------------------------------------

// ContextCall message received from the sandbox (spec §11.2)
export interface ContextCallRequest {
  id: string;        // correlation ID of the parent execution request
  callId: string;    // unique ID for this specific context call
  type: "contextCall";
  method:
    | "fetch"
    | "credentials.get"
    | "credentials.list"
    | "cache.get"
    | "cache.set"
    | "cache.delete"
    | "pipeline.trigger"
    | "ontology.getEntity";
  args: unknown[];
}

export interface ContextCallResponse {
  callId: string;
  type: "contextCallResponse";
  result?: unknown;
  error?: { code: string; message: string };
}

// Execution context provided to the handler for each dispatched call
export interface ExecutionContext {
  executionId: string;
  tenantId: string;
  pluginId?: string;
  /** Whether this execution is running inside a hook chain */
  hookContext: boolean;
  /** Execution type determines which context APIs are permitted */
  executionType: "code" | "connector-run" | "app-build" | "expression" | "plugin-drain";
  credentialBundleId?: string;
  /** Local ontology snapshot injected at execution start time */
  ontologySnapshot?: unknown;
  traceId: string;
}

export interface ContextCallHandler {
  handleContextCall(
    request: ContextCallRequest,
    executionCtx: ExecutionContext,
  ): Promise<ContextCallResponse>;
}

export interface ContextCallHandlerDeps {
  logger: Logger;
  /** Base URL of the Ingestion Service for credential access */
  ingestionServiceUrl: string;
  /** Base URL of the Plugin Service for cache operations */
  pluginServiceUrl: string;
  /** Base URL of the Pipeline Service for pipeline.trigger() */
  pipelineServiceUrl: string;
  /** Service token for outbound calls */
  serviceToken: string;
}

// ---------------------------------------------------------------------------
// RFC 1918 and internal URL blocklist — spec §11.3
// The sandbox itself has no network access, but we enforce here as the sole
// outbound proxy, adding defense-in-depth.
// ---------------------------------------------------------------------------

const BLOCKED_URL_PATTERNS = [
  // localhost
  /^https?:\/\/localhost(:\d+)?(\/|$)/i,
  /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  // RFC 1918 ranges
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?(\/|$)/,
  // Link-local
  /^https?:\/\/169\.254\.\d+\.\d+(:\d+)?(\/|$)/,
  // Internal service hostnames (*.service:*)
  /^https?:\/\/[^/]*\.service(:\d+)?(\/|$)/i,
  // Non-HTTP/HTTPS schemes
  /^file:\/\//i,
  /^data:/i,
  /^ftp:\/\//i,
];

function isUrlBlocked(url: string): boolean {
  return BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

// All pipeline-adjacent context call methods that must be guarded by
// the hookContext check.  This list is the authoritative source used by
// the guard below and is tested separately to ensure completeness.
const PIPELINE_ADJACENT_METHODS: ReadonlySet<ContextCallRequest["method"]> = new Set([
  "pipeline.trigger",
]);

export function createContextCallHandler(deps: ContextCallHandlerDeps): ContextCallHandler {
  const {
    logger,
    ingestionServiceUrl,
    pluginServiceUrl,
    pipelineServiceUrl,
    serviceToken,
  } = deps;

  const authHeaders = {
    "X-Service-Token": serviceToken,
    "Content-Type": "application/json",
  };

  // ---------------------------------------------------------------------------
  // Individual method handlers
  // ---------------------------------------------------------------------------

  async function handleFetch(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<unknown> {
    const rawUrl = typeof args[0] === "string" ? args[0] : null;
    if (rawUrl === null) {
      throw { code: "EXECUTION_FETCH_BLOCKED", message: "Invalid fetch URL" };
    }

    if (isUrlBlocked(rawUrl)) {
      logger.warn("ContextCallHandler: fetch blocked", {
        executionId: executionCtx.executionId,
        tenantId: executionCtx.tenantId,
        url: rawUrl,
      });
      throw { code: "EXECUTION_FETCH_BLOCKED", message: `Fetch to '${rawUrl}' is blocked.` };
    }

    // Validate scheme — only http/https allowed
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw { code: "EXECUTION_FETCH_BLOCKED", message: "Malformed URL" };
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw {
        code: "EXECUTION_FETCH_BLOCKED",
        message: `URL scheme '${parsedUrl.protocol}' is not allowed.`,
      };
    }

    const init = (args[1] ?? {}) as RequestInit;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(rawUrl, {
        ...init,
        signal: controller.signal,
      });

      // Validate redirect destination against blocklist
      if (response.redirected && isUrlBlocked(response.url)) {
        throw { code: "EXECUTION_FETCH_BLOCKED", message: "Redirect target is blocked." };
      }

      const responseBody = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleCredentialsGet(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<unknown> {
    if (executionCtx.executionType !== "connector-run") {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: "credentials.get() is only available in connector-run executions.",
      };
    }

    const key = typeof args[0] === "string" ? args[0] : null;
    if (key === null) {
      throw { code: "EXECUTION_CREDENTIALS_DENIED", message: "credentials.get() requires a key argument." };
    }

    const credentialBundleId = executionCtx.credentialBundleId;
    if (credentialBundleId === undefined) {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: "No credentialBundleId in execution context.",
      };
    }

    const url = `${ingestionServiceUrl}/internal/ingestion/credentials/${encodeURIComponent(credentialBundleId)}/field/${encodeURIComponent(key)}`;
    const response = await fetch(url, { headers: authHeaders });

    if (!response.ok) {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: `Credential lookup failed with status ${response.status}.`,
      };
    }

    const body = await response.json() as { data: { value: string } };
    // The credential value is passed directly to the sandbox — never logged.
    return body.data.value;
  }

  async function handleCredentialsList(
    _args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<unknown> {
    if (executionCtx.executionType !== "connector-run") {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: "credentials.list() is only available in connector-run executions.",
      };
    }

    const credentialBundleId = executionCtx.credentialBundleId;
    if (credentialBundleId === undefined) {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: "No credentialBundleId in execution context.",
      };
    }

    const url = `${ingestionServiceUrl}/internal/ingestion/credentials/${encodeURIComponent(credentialBundleId)}`;
    const response = await fetch(url, { headers: authHeaders });

    if (!response.ok) {
      throw {
        code: "EXECUTION_CREDENTIALS_DENIED",
        message: `Credential list failed with status ${response.status}.`,
      };
    }

    const body = await response.json() as { data: { keys: string[] } };
    return body.data.keys;
  }

  async function handleCacheGet(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<unknown> {
    const key = typeof args[0] === "string" ? args[0] : null;
    if (key === null || executionCtx.pluginId === undefined) return null;

    const url = `${pluginServiceUrl}/internal/plugins/cache/${encodeURIComponent(executionCtx.tenantId)}/${encodeURIComponent(executionCtx.pluginId)}/${encodeURIComponent(key)}`;
    const response = await fetch(url, { headers: authHeaders });
    if (!response.ok) return null;

    const body = await response.json() as { data: { value: unknown } };
    return body.data.value ?? null;
  }

  async function handleCacheSet(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<void> {
    const key = typeof args[0] === "string" ? args[0] : null;
    if (key === null || executionCtx.pluginId === undefined) return;

    const value = args[1];
    const ttlSeconds = typeof args[2] === "number" ? args[2] : undefined;

    const url = `${pluginServiceUrl}/internal/plugins/cache/${encodeURIComponent(executionCtx.tenantId)}/${encodeURIComponent(executionCtx.pluginId)}/${encodeURIComponent(key)}`;
    await fetch(url, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        value,
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      }),
    });
  }

  async function handleCacheDelete(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<void> {
    const key = typeof args[0] === "string" ? args[0] : null;
    if (key === null || executionCtx.pluginId === undefined) return;

    const url = `${pluginServiceUrl}/internal/plugins/cache/${encodeURIComponent(executionCtx.tenantId)}/${encodeURIComponent(executionCtx.pluginId)}/${encodeURIComponent(key)}`;
    await fetch(url, { method: "DELETE", headers: authHeaders });
  }

  async function handlePipelineTrigger(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): Promise<void> {
    // Guard: block all pipeline-adjacent methods when running inside a hook chain
    // (spec §12). The set PIPELINE_ADJACENT_METHODS documents all guarded methods.
    if (executionCtx.hookContext) {
      logger.warn("ContextCallHandler: hook recursion blocked", {
        executionId: executionCtx.executionId,
        tenantId: executionCtx.tenantId,
      });
      throw {
        code: "EXECUTION_HOOK_RECURSION",
        message: "pipeline.trigger() is not allowed inside a hook execution (would cause infinite recursion).",
      };
    }

    const pipelineId = typeof args[0] === "string" ? args[0] : null;
    if (pipelineId === null) {
      throw { code: "VALIDATION_ERROR", message: "pipeline.trigger() requires a pipelineId argument." };
    }

    const payload = args[1] ?? {};
    await fetch(`${pipelineServiceUrl}/internal/pipeline/trigger`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        pipelineId,
        tenantId: executionCtx.tenantId,
        triggeredBy: "service",
        callerService: "execution-service",
        input: payload,
      }),
    });
  }

  function handleOntologyGetEntity(
    args: unknown[],
    executionCtx: ExecutionContext,
  ): unknown {
    // Served from the local snapshot injected at execution start — no network call
    const entityName = typeof args[0] === "string" ? args[0] : null;
    if (entityName === null) return null;

    const snapshot = executionCtx.ontologySnapshot as
      | { entities?: Array<{ name: string }> }
      | undefined;
    if (snapshot === undefined) return null;

    return snapshot.entities?.find((e) => e.name === entityName) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  async function handleContextCall(
    request: ContextCallRequest,
    executionCtx: ExecutionContext,
  ): Promise<ContextCallResponse> {
    // Pipeline-adjacent guard is enforced inside handlePipelineTrigger, but we
    // also assert here so future additions to PIPELINE_ADJACENT_METHODS are
    // caught at the dispatch boundary, not buried in individual handlers.
    if (PIPELINE_ADJACENT_METHODS.has(request.method) && executionCtx.hookContext) {
      return {
        callId: request.callId,
        type: "contextCallResponse",
        error: {
          code: "EXECUTION_HOOK_RECURSION",
          message: "Pipeline operations are not permitted inside hook executions.",
        },
      };
    }

    try {
      let result: unknown;

      switch (request.method) {
        case "fetch":
          result = await handleFetch(request.args, executionCtx);
          break;
        case "credentials.get":
          result = await handleCredentialsGet(request.args, executionCtx);
          break;
        case "credentials.list":
          result = await handleCredentialsList(request.args, executionCtx);
          break;
        case "cache.get":
          result = await handleCacheGet(request.args, executionCtx);
          break;
        case "cache.set":
          await handleCacheSet(request.args, executionCtx);
          result = null;
          break;
        case "cache.delete":
          await handleCacheDelete(request.args, executionCtx);
          result = null;
          break;
        case "pipeline.trigger":
          await handlePipelineTrigger(request.args, executionCtx);
          result = null;
          break;
        case "ontology.getEntity":
          result = handleOntologyGetEntity(request.args, executionCtx);
          break;
        default: {
          const _exhaustive: never = request.method;
          throw { code: "UNSUPPORTED_METHOD", message: `Unknown contextCall method: ${String(_exhaustive)}` };
        }
      }

      return {
        callId: request.callId,
        type: "contextCallResponse",
        result,
      };
    } catch (err) {
      const structured = err as { code?: string; message?: string };
      return {
        callId: request.callId,
        type: "contextCallResponse",
        error: {
          code: structured.code ?? "CONTEXT_CALL_ERROR",
          message: structured.message ?? String(err),
        },
      };
    }
  }

  return { handleContextCall };
}
