import { randomUUID } from "node:crypto";
import * as net from "node:net";
import type { Logger } from "@oneplatform/core";
import type { SandboxManager } from "./sandbox-manager.js";
import type { UnixSocketClient, SandboxRequest, SandboxResponse } from "./unix-socket-client.js";
import type { ContextCallRequest, ContextCallHandler, ExecutionContext } from "./context-call-handler.js";

// ---------------------------------------------------------------------------
// ExecutionRouter — routes execution requests to the appropriate sandbox
// Design spec §6 (execution types) / §5.2 (Docker sandbox)
//
// JS/TS → op-sandbox-vm via UnixSocketClient
// Python/Go → short-lived Docker containers via Docker socket proxy
// ---------------------------------------------------------------------------

export type ExecutionLanguage = "js" | "ts" | "python" | "go";
export type ExecutionType = "code" | "connector-run" | "app-build" | "expression" | "plugin-drain";
export type SandboxType = "isolated-vm" | "docker";

export interface RouteRequest {
  executionId: string;
  type: ExecutionType;
  language: ExecutionLanguage;
  code?: string;
  files?: Record<string, string>;
  entrypoint?: string;
  timeout: number;
  context: ExecutionContext;
  pluginBundleBase64?: string;
}

export interface RouteResult {
  status: "ok" | "error" | "timeout" | "oom";
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  errorStack?: string;
  durationMs: number;
  memoryPeakMb: number;
  exitCode: number;
  sandboxType: SandboxType;
}

export interface ExecutionRouter {
  route(request: RouteRequest): Promise<RouteResult>;
}

export interface ExecutionRouterDeps {
  sandboxManager: SandboxManager;
  contextCallHandler: ContextCallHandler;
  logger: Logger;
  /** Docker socket proxy path. Env: OP_DOCKER_SOCKET_PATH */
  dockerSocketPath?: string;
}

// Docker API image names for non-JS languages
const DOCKER_SANDBOX_IMAGES: Partial<Record<ExecutionLanguage, string>> = {
  python: process.env["OP_DOCKER_SANDBOX_IMAGE_PYTHON"] ?? "oneplatform-sandbox-python:latest",
  go: process.env["OP_DOCKER_SANDBOX_IMAGE_GO"] ?? "oneplatform-sandbox-go:latest",
};

// ---------------------------------------------------------------------------
// Minimal Docker API HTTP client over Unix socket — spec §5.2
// Only the 7 API calls needed for sandbox container lifecycle.
// Using a custom client rather than dockerode to minimise attack surface.
// ---------------------------------------------------------------------------

interface DockerCreateBody {
  Image: string;
  Cmd: string[];
  NetworkingConfig: {
    EndpointsConfig: Record<string, Record<string, never>>;
  };
  HostConfig: {
    Memory: number;
    NanoCpus: number;
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    AutoRemove: boolean;
  };
  Env: string[];
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  OpenStdin: boolean;
  StdinOnce: boolean;
}

function dockerRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let headerParsed = false;
    let statusCode = 0;
    let responseBody = "";

    const bodyStr = body !== undefined ? JSON.stringify(body) : "";
    const contentLength = Buffer.byteLength(bodyStr, "utf8");

    const headers = [
      `${method} ${path} HTTP/1.1`,
      "Host: localhost",
      "Connection: close",
      ...(body !== undefined
        ? ["Content-Type: application/json", `Content-Length: ${contentLength}`]
        : []),
      "",
      "",
    ].join("\r\n");

    socket.on("connect", () => {
      socket.write(headers + bodyStr);
    });

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!headerParsed) {
        const sepIdx = raw.indexOf("\r\n\r\n");
        if (sepIdx !== -1) {
          const headerSection = raw.slice(0, sepIdx);
          responseBody = raw.slice(sepIdx + 4);
          const statusLine = headerSection.split("\r\n")[0] ?? "";
          const match = /HTTP\/1\.\d (\d{3})/.exec(statusLine);
          statusCode = match?.[1] !== undefined ? parseInt(match[1], 10) : 0;
          headerParsed = true;
        }
      }
      resolve({ status: statusCode, body: responseBody });
    });

    socket.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Docker sandbox lifecycle — spec §5.2
// ---------------------------------------------------------------------------

async function createDockerContainer(
  socketPath: string,
  executionId: string,
  language: ExecutionLanguage,
  timeoutMs: number,
): Promise<string> {
  const image = DOCKER_SANDBOX_IMAGES[language];
  if (image === undefined) {
    throw new Error(`No Docker sandbox image configured for language: ${language}`);
  }

  const body: DockerCreateBody = {
    Image: image,
    Cmd: language === "python"
      ? ["python3", "/sandbox/entrypoint.py"]
      : ["go", "run", "/sandbox/entrypoint.go"],
    NetworkingConfig: {
      EndpointsConfig: { "oneplatform-sandbox": {} },
    },
    HostConfig: {
      Memory: 536_870_912,    // 512 MB
      NanoCpus: 1_000_000_000, // 1 CPU
      NetworkMode: "oneplatform-sandbox",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      AutoRemove: false,
    },
    Env: [
      `OP_EXECUTION_ID=${executionId}`,
      `OP_TIMEOUT_MS=${timeoutMs}`,
    ],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
  };

  const result = await dockerRequest(socketPath, "POST", "/containers/create", body);
  if (result.status !== 201) {
    throw new Error(`Docker create failed with status ${result.status}: ${result.body}`);
  }

  // Wrap in try-catch so a malformed Docker API response surfaces a clear error
  // rather than a cryptic "Unexpected token" from a bare JSON.parse.
  let parsed: { Id: string };
  try {
    parsed = JSON.parse(result.body) as { Id: string };
  } catch (err) {
    const truncated = result.body.slice(0, 200);
    throw new Error(
      `Failed to parse Docker create response: ${err instanceof Error ? err.message : String(err)} — raw: ${truncated}`,
    );
  }
  return parsed.Id;
}

async function startDockerContainer(socketPath: string, containerId: string): Promise<void> {
  const result = await dockerRequest(socketPath, "POST", `/containers/${containerId}/start`);
  if (result.status !== 204 && result.status !== 304) {
    throw new Error(`Docker start failed with status ${result.status}`);
  }
}

async function deleteDockerContainer(socketPath: string, containerId: string, force = false): Promise<void> {
  const path = `/containers/${containerId}${force ? "?force=true" : ""}`;
  await dockerRequest(socketPath, "DELETE", path);
}

async function getDockerContainerStats(socketPath: string, containerId: string): Promise<{ memoryPeakMb: number }> {
  const result = await dockerRequest(socketPath, "GET", `/containers/${containerId}/stats?stream=false`);
  if (result.status !== 200) return { memoryPeakMb: 0 };

  try {
    const stats = JSON.parse(result.body) as {
      memory_stats?: { max_usage?: number };
    };
    const bytes = stats.memory_stats?.max_usage ?? 0;
    return { memoryPeakMb: Math.round(bytes / (1024 * 1024) * 10) / 10 };
  } catch {
    return { memoryPeakMb: 0 };
  }
}

async function waitForDockerContainer(socketPath: string, containerId: string): Promise<{ exitCode: number }> {
  const result = await dockerRequest(socketPath, "POST", `/containers/${containerId}/wait`);
  if (result.status !== 200) return { exitCode: 1 };

  try {
    const body = JSON.parse(result.body) as { StatusCode: number };
    return { exitCode: body.StatusCode };
  } catch {
    return { exitCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExecutionRouter(deps: ExecutionRouterDeps): ExecutionRouter {
  const {
    sandboxManager,
    contextCallHandler,
    logger,
    dockerSocketPath = process.env["OP_DOCKER_SOCKET_PATH"] ?? "/var/run/docker-proxy.sock",
  } = deps;

  // ---------------------------------------------------------------------------
  // JS/TS via isolated-vm (op-sandbox-vm Unix socket)
  // ---------------------------------------------------------------------------

  async function routeToIsolatedVm(request: RouteRequest): Promise<RouteResult> {
    const sandbox = sandboxManager.getPrimary();
    sandboxManager.recordRun(request.executionId);

    const method: SandboxRequest["method"] =
      request.type === "app-build" ? "app-build" : "execute";

    const sandboxReq: SandboxRequest = {
      id: request.executionId,
      method,
      timeout: request.timeout,
      payload: {
        ...(request.code !== undefined ? { code: request.code } : {}),
        ...(request.language !== undefined ? { language: request.language as "js" | "ts" } : {}),
        ...(request.context !== undefined ? { context: serializeExecutionContext(request.context) } : {}),
        ...(request.files !== undefined ? { files: request.files } : {}),
        ...(request.entrypoint !== undefined ? { entrypoint: request.entrypoint } : {}),
      },
    };

    // ExecutionService registers the global onLogLine callback during construction.
    // Do not register a second callback here — it would overwrite the service-level
    // handler and discard all log lines after the first execution completes.
    const client: UnixSocketClient = sandbox.client;

    let response: SandboxResponse;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("EXECUTION_TIMEOUT")),
        request.timeout + 2_000, // 2s buffer so sandbox-side watchdog fires first
      );
    });

    try {
      response = await Promise.race([
        client.send(sandboxReq),
        timeoutPromise,
      ]);
    } catch (err) {
      sandboxManager.recordCompletion(request.executionId);

      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === "EXECUTION_TIMEOUT") {
        return {
          status: "timeout",
          errorCode: "EXECUTION_TIMEOUT",
          errorMessage: `Execution exceeded ${request.timeout}ms timeout.`,
          durationMs: request.timeout,
          memoryPeakMb: 0,
          exitCode: 1,
          sandboxType: "isolated-vm",
        };
      }

      return {
        status: "error",
        errorCode: "EXECUTION_SANDBOX_CRASH",
        errorMessage: errMsg,
        durationMs: 0,
        memoryPeakMb: 0,
        exitCode: 1,
        sandboxType: "isolated-vm",
      };
    }

    sandboxManager.recordCompletion(request.executionId);

    return {
      status: response.status,
      ...(response.result !== undefined ? { result: response.result } : {}),
      ...(response.error?.code !== undefined ? { errorCode: response.error.code } : {}),
      ...(response.error?.message !== undefined ? { errorMessage: response.error.message } : {}),
      ...(response.error?.stack !== undefined ? { errorStack: response.error.stack } : {}),
      durationMs: response.meta.durationMs,
      memoryPeakMb: response.meta.memoryPeakMb,
      exitCode: response.meta.exitCode,
      sandboxType: "isolated-vm",
    };
  }

  // ---------------------------------------------------------------------------
  // Non-JS via Docker (Python, Go)
  // ---------------------------------------------------------------------------

  async function routeToDocker(request: RouteRequest): Promise<RouteResult> {
    const containerId = await createDockerContainer(
      dockerSocketPath,
      request.executionId,
      request.language,
      request.timeout,
    );

    const startTime = Date.now();
    let exitCode = 0;
    let forceKilled = false;

    // Timeout enforcement via Node.js timer — spec §5.2
    const forceKillTimer = setTimeout(async () => {
      forceKilled = true;
      logger.warn("ExecutionRouter: Docker container timeout — force deleting", {
        executionId: request.executionId,
        containerId,
      });
      await deleteDockerContainer(dockerSocketPath, containerId, true).catch(() => undefined);
    }, request.timeout);

    try {
      await startDockerContainer(dockerSocketPath, containerId);

      const waitResult = await waitForDockerContainer(dockerSocketPath, containerId);
      exitCode = waitResult.exitCode;
    } finally {
      clearTimeout(forceKillTimer);
    }

    if (forceKilled) {
      await deleteDockerContainer(dockerSocketPath, containerId, true).catch(() => undefined);
      return {
        status: "timeout",
        errorCode: "EXECUTION_TIMEOUT",
        errorMessage: `Docker execution exceeded ${request.timeout}ms timeout.`,
        durationMs: Date.now() - startTime,
        memoryPeakMb: 0,
        exitCode: 1,
        sandboxType: "docker",
      };
    }

    // Memory stats before cleanup — note: accuracy is approximate (spec §19.6)
    const { memoryPeakMb } = await getDockerContainerStats(dockerSocketPath, containerId);

    // Cleanup container
    await deleteDockerContainer(dockerSocketPath, containerId).catch((err) => {
      logger.warn("ExecutionRouter: failed to delete Docker container", {
        containerId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const durationMs = Date.now() - startTime;

    if (exitCode !== 0) {
      return {
        status: "error",
        errorCode: "EXECUTION_ERROR",
        errorMessage: `Docker container exited with code ${exitCode}`,
        durationMs,
        memoryPeakMb,
        exitCode,
        sandboxType: "docker",
      };
    }

    return {
      status: "ok",
      durationMs,
      memoryPeakMb,
      exitCode: 0,
      sandboxType: "docker",
    };
  }

  // ---------------------------------------------------------------------------
  // Serialize execution context for the sandbox (strip internal-only fields)
  // design spec §11.1 — hookContext is never exposed to user code
  // ---------------------------------------------------------------------------

  function serializeExecutionContext(ctx: ExecutionContext): unknown {
    return {
      tenantId: ctx.tenantId,
      executionId: ctx.executionId,
      traceId: ctx.traceId,
      executionType: ctx.executionType,
      // hookContext intentionally omitted — must never reach user code
      ...(ctx.ontologySnapshot !== undefined ? { ontologySnapshot: ctx.ontologySnapshot } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Main dispatch
  // ---------------------------------------------------------------------------

  async function route(request: RouteRequest): Promise<RouteResult> {
    const isJsTs = request.language === "js" || request.language === "ts";

    if (isJsTs) {
      return routeToIsolatedVm(request);
    }

    return routeToDocker(request);
  }

  return { route };
}

// Re-export for use in ExecutionService
export type { ExecutionContext };
