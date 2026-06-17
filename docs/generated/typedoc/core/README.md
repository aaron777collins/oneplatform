**@oneplatform/core**

***

# @oneplatform/core

@oneplatform/core — Shared infrastructure for all OnePlatform services.

Every service imports from this package rather than from internal paths.
It provides the Hono app factory, database/Redis clients, BullMQ queue helpers,
structured logging, middleware stack, error hierarchy, and configuration loader.

## Typical service bootstrap
```ts
import { createApp, loadConfig, createDbClient, createRedisClient } from '@oneplatform/core';

const config = loadConfig();
const redis = createRedisClient({ url: config.OP_REDIS_URL });
const db = createDbClient({ connectionString: config.OP_DATABASE_URL, maxConnections: 10 });

const app = createApp({
  serviceName: 'my-service',
  version: '1.0.0',
  jwtSecret: config.OP_JWT_SECRET,
  redis,
  validateApiKey: async (key) => { ... },
  allowedOrigins: config.OP_ALLOWED_ORIGINS,
  publicRoutes: ['/healthz', '/readyz'],
  targetService: 'my-service',
  servicePublicKeys: {},
});
```

## Enumerations

- [ServiceName](enumerations/ServiceName.md)

## Classes

- [AppError](classes/AppError.md)
- [BulkLimitExceededError](classes/BulkLimitExceededError.md)
- [ConflictError](classes/ConflictError.md)
- [CursorExpiredError](classes/CursorExpiredError.md)
- [EntityNotFoundError](classes/EntityNotFoundError.md)
- [ForbiddenError](classes/ForbiddenError.md)
- [InsufficientScopeError](classes/InsufficientScopeError.md)
- [InternalError](classes/InternalError.md)
- [InvalidCursorError](classes/InvalidCursorError.md)
- [NotFoundError](classes/NotFoundError.md)
- [OriginNotAllowedError](classes/OriginNotAllowedError.md)
- [PaginationLimitExceededError](classes/PaginationLimitExceededError.md)
- [PermissionDeniedError](classes/PermissionDeniedError.md)
- [RateLimitError](classes/RateLimitError.md)
- [ServiceUnavailableError](classes/ServiceUnavailableError.md)
- [UnauthorizedError](classes/UnauthorizedError.md)
- [UnknownFilterFieldError](classes/UnknownFilterFieldError.md)
- [UnsortableFieldError](classes/UnsortableFieldError.md)
- [ValidationError](classes/ValidationError.md)

## Interfaces

- [ApiError](interfaces/ApiError.md)
- [ApiResponse](interfaces/ApiResponse.md)
- [AuditEvent](interfaces/AuditEvent.md)
- [AuthMiddlewareConfig](interfaces/AuthMiddlewareConfig.md)
- [CorsConfig](interfaces/CorsConfig.md)
- [CreateAppConfig](interfaces/CreateAppConfig.md)
- [DataEnvelope](interfaces/DataEnvelope.md)
- [DbClientConfig](interfaces/DbClientConfig.md)
- [DeprecationInfo](interfaces/DeprecationInfo.md)
- [ErrorHandlerConfig](interfaces/ErrorHandlerConfig.md)
- [EventPublisher](interfaces/EventPublisher.md)
- [EventPublisherConfig](interfaces/EventPublisherConfig.md)
- [HealthConfig](interfaces/HealthConfig.md)
- [LogEvent](interfaces/LogEvent.md)
- [Logger](interfaces/Logger.md)
- [LoggerConfig](interfaces/LoggerConfig.md)
- [PaginatedResponse](interfaces/PaginatedResponse.md)
- [PlatformEvent](interfaces/PlatformEvent.md)
- [RateLimitInfo](interfaces/RateLimitInfo.md)
- [ReadyzConfig](interfaces/ReadyzConfig.md)
- [RedisClientConfig](interfaces/RedisClientConfig.md)
- [ServiceAuthConfig](interfaces/ServiceAuthConfig.md)
- [ServiceTokenSigner](interfaces/ServiceTokenSigner.md)
- [UserContext](interfaces/UserContext.md)

## Type Aliases

- [AppServiceConfig](type-aliases/AppServiceConfig.md)
- [AppVariables](type-aliases/AppVariables.md)
- [AuthConfig](type-aliases/AuthConfig.md)
- [BaseConfig](type-aliases/BaseConfig.md)
- [ExecutionConfig](type-aliases/ExecutionConfig.md)
- [GatewayConfig](type-aliases/GatewayConfig.md)
- [IngestionConfig](type-aliases/IngestionConfig.md)
- [LoggingConfig](type-aliases/LoggingConfig.md)
- [LogLevel](type-aliases/LogLevel.md)
- [OntologyConfig](type-aliases/OntologyConfig.md)
- [PipelineConfig](type-aliases/PipelineConfig.md)
- [PluginServiceConfig](type-aliases/PluginServiceConfig.md)

## Variables

- [appConfigSchema](variables/appConfigSchema.md)
- [authConfigSchema](variables/authConfigSchema.md)
- [baseConfigSchema](variables/baseConfigSchema.md)
- [cronExpressionSchema](variables/cronExpressionSchema.md)
- [executionConfigSchema](variables/executionConfigSchema.md)
- [gatewayConfigSchema](variables/gatewayConfigSchema.md)
- [ingestionConfigSchema](variables/ingestionConfigSchema.md)
- [loggingConfigSchema](variables/loggingConfigSchema.md)
- [ontologyConfigSchema](variables/ontologyConfigSchema.md)
- [pipelineConfigSchema](variables/pipelineConfigSchema.md)
- [pluginConfigSchema](variables/pluginConfigSchema.md)

## Functions

- [authMiddleware](functions/authMiddleware.md)
- [corsMiddleware](functions/corsMiddleware.md)
- [createApp](functions/createApp.md)
- [createDbClient](functions/createDbClient.md)
- [createDlqQueue](functions/createDlqQueue.md)
- [createEventPublisher](functions/createEventPublisher.md)
- [createLogger](functions/createLogger.md)
- [createQueue](functions/createQueue.md)
- [createRedisClient](functions/createRedisClient.md)
- [createServiceTokenSigner](functions/createServiceTokenSigner.md)
- [createWorker](functions/createWorker.md)
- [decodeCursor](functions/decodeCursor.md)
- [decrypt](functions/decrypt.md)
- [deprecationHeadersMiddleware](functions/deprecationHeadersMiddleware.md)
- [encodeCursor](functions/encodeCursor.md)
- [encrypt](functions/encrypt.md)
- [errorHandlerMiddleware](functions/errorHandlerMiddleware.md)
- [healthz](functions/healthz.md)
- [isServiceCallAllowed](functions/isServiceCallAllowed.md)
- [isValidCronExpression](functions/isValidCronExpression.md)
- [loadConfig](functions/loadConfig.md)
- [loadMasterKey](functions/loadMasterKey.md)
- [loadServicePrivateKey](functions/loadServicePrivateKey.md)
- [rateLimitHeadersMiddleware](functions/rateLimitHeadersMiddleware.md)
- [readyz](functions/readyz.md)
- [requestIdMiddleware](functions/requestIdMiddleware.md)
- [responseEnvelopeMiddleware](functions/responseEnvelopeMiddleware.md)
- [serviceAuthMiddleware](functions/serviceAuthMiddleware.md)
- [setTenantContext](functions/setTenantContext.md)
- [setupProcessErrorHandlers](functions/setupProcessErrorHandlers.md)
