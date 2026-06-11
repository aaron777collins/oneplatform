// Barrel export — all execution services
export { createUnixSocketClient } from "./unix-socket-client.js";
export type {
  UnixSocketClient,
  UnixSocketClientDeps,
  SandboxRequest,
  SandboxResponse,
  SandboxResponseMeta,
  SandboxLogLine,
  PingResponse,
  DrainResponse,
} from "./unix-socket-client.js";

export { createSandboxManager } from "./sandbox-manager.js";
export type {
  SandboxManager,
  SandboxManagerDeps,
  SandboxInstance,
  SandboxState,
} from "./sandbox-manager.js";

export { createPluginBundleCache } from "./plugin-cache.js";
export type {
  PluginBundleCache,
  PluginBundleCacheDeps,
  CachedBundle,
  BundleStats,
} from "./plugin-cache.js";

export { createContextCallHandler } from "./context-call-handler.js";
export type {
  ContextCallHandler,
  ContextCallHandlerDeps,
  ContextCallRequest,
  ContextCallResponse,
  ExecutionContext,
} from "./context-call-handler.js";

export { createExecutionRouter } from "./execution-router.js";
export type {
  ExecutionRouter,
  ExecutionRouterDeps,
  RouteRequest,
  RouteResult,
  ExecutionLanguage,
  ExecutionType,
  SandboxType,
} from "./execution-router.js";

export { createSseManager } from "./sse-manager.js";
export type {
  SseManager,
  SseManagerDeps,
  SseSubscription,
  SseEvent,
  SseLogEvent,
  SseCompleteEvent,
  SseErrorEvent,
} from "./sse-manager.js";

export { createExecutionService } from "./execution-service.js";
export type {
  ExecutionService,
  ExecutionServiceDeps,
  RunExecutionResult,
  ConnectorRunResult,
  DrainPluginResult,
  PrefetchResult,
  InvalidateResult,
} from "./execution-service.js";

export { createPartitionManager } from "./partition-manager.js";
export type {
  PartitionManager,
  PartitionManagerDeps,
} from "./partition-manager.js";

export {
  ExecutionNotFoundError,
  ExecutionSandboxUnavailableError,
  ExecutionTimeoutError,
  ExecutionOomError,
  ExecutionSandboxCrashError,
  ExecutionHookRecursionError,
  ExecutionCodeTooLargeError,
  ExecutionPayloadTooLargeError,
  ExecutionResultTooLargeError,
  ExecutionInvalidLanguageError,
  ExecutionTimeoutExceededLimitError,
  ExecutionBundleIntegrityError,
  ExecutionModuleNotAllowedError,
  ExecutionFetchBlockedError,
  ExecutionCredentialsDeniedError,
  ServiceDrainingError,
} from "./errors.js";
