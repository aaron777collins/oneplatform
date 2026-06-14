// @oneplatform/core — public API surface
// Services import everything from "@oneplatform/core", not from internal paths.

// ---------------------------------------------------------------------------
// App factory — the primary entry point for every service
// ---------------------------------------------------------------------------
export { createApp, setupProcessErrorHandlers } from "./app.js";
export type { CreateAppConfig } from "./app.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export type {
  ApiResponse,
  ApiError,
  PaginatedResponse,
  UserContext,
  PlatformEvent,
  DataEnvelope,
  AppVariables,
  RateLimitInfo,
  DeprecationInfo,
} from "./types.js";
export { ServiceName } from "./types.js";

// ---------------------------------------------------------------------------
// Error registry
// ---------------------------------------------------------------------------
export {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  InsufficientScopeError,
  PermissionDeniedError,
  NotFoundError,
  EntityNotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  InternalError,
  ServiceUnavailableError,
  PaginationLimitExceededError,
  InvalidCursorError,
  CursorExpiredError,
  BulkLimitExceededError,
  OriginNotAllowedError,
  UnknownFilterFieldError,
  UnsortableFieldError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Config loader and per-service schemas (OA-6)
// ---------------------------------------------------------------------------
export { loadConfig } from "./config.js";
export {
  baseConfigSchema,
  gatewayConfigSchema,
  authConfigSchema,
  ingestionConfigSchema,
  ontologyConfigSchema,
  pipelineConfigSchema,
  executionConfigSchema,
  appConfigSchema,
  loggingConfigSchema,
  pluginConfigSchema,
} from "./config.js";
export type {
  BaseConfig,
  GatewayConfig,
  AuthConfig,
  IngestionConfig,
  OntologyConfig,
  PipelineConfig,
  ExecutionConfig,
  AppServiceConfig,
  LoggingConfig,
  PluginServiceConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Database client
// ---------------------------------------------------------------------------
export { createDbClient, setTenantContext } from "./db.js";
export type { DbClientConfig } from "./db.js";

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
export { createRedisClient } from "./redis.js";
export type { RedisClientConfig } from "./redis.js";

// ---------------------------------------------------------------------------
// Queue / BullMQ helpers
// ---------------------------------------------------------------------------
export { createQueue, createWorker, createDlqQueue } from "./queue.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
export { createLogger } from "./logger.js";
export type { Logger, LoggerConfig, LogEvent, AuditEvent, LogLevel } from "./logger.js";

// ---------------------------------------------------------------------------
// Event publisher
// ---------------------------------------------------------------------------
export { createEventPublisher } from "./events.js";
export type { EventPublisher, EventPublisherConfig } from "./events.js";

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------
export { healthz, readyz } from "./health.js";
export type { HealthConfig, ReadyzConfig } from "./health.js";

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------
export { encodeCursor, decodeCursor } from "./cursor.js";

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------
export { encrypt, decrypt, loadMasterKey } from "./encryption.js";

// ---------------------------------------------------------------------------
// Service RBAC matrix
// ---------------------------------------------------------------------------
export { isServiceCallAllowed } from "./service-rbac.js";

// ---------------------------------------------------------------------------
// Middleware (exported for services that need to compose custom stacks)
// ---------------------------------------------------------------------------
export { requestIdMiddleware } from "./middleware/request-id.js";
export { corsMiddleware } from "./middleware/cors.js";
export type { CorsConfig } from "./middleware/cors.js";
export { authMiddleware } from "./middleware/auth.js";
export type { AuthMiddlewareConfig } from "./middleware/auth.js";
export { serviceAuthMiddleware } from "./middleware/service-auth.js";
export type { ServiceAuthConfig } from "./middleware/service-auth.js";
export { responseEnvelopeMiddleware } from "./middleware/response-envelope.js";
export { errorHandlerMiddleware } from "./middleware/error-handler.js";
export type { ErrorHandlerConfig } from "./middleware/error-handler.js";
export { rateLimitHeadersMiddleware } from "./middleware/rate-limit-headers.js";
export { deprecationHeadersMiddleware } from "./middleware/deprecation-headers.js";
