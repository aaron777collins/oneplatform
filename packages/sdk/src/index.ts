/**
 * @packageDocumentation
 * @oneplatform/sdk — TypeScript client for the OnePlatform API.
 *
 * ## Quick start
 * ```ts
 * import { createClient } from '@oneplatform/sdk';
 *
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   auth: { apiKey: 'op_live_...' },
 * });
 *
 * const products = client.data.entity('Product').list();
 * for await (const page of products) {
 *   console.log(page.items);
 * }
 * ```
 *
 * Only types and values that external consumers need are re-exported here.
 * Transport internals, auth handler implementations, and platform-type
 * constructors are kept package-private.
 */

// Client factory — the single entry point
export { createClient } from './client.js';
export type { OnePlatformClient } from './client.js';

// Error types — all exported for instanceof checks
export {
  OnePlatformError,
  ClientError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  CursorExpiredError,
  ConfigurationError,
  PaginationLimitError,
  RateLimitError,
  ServerError,
  NetworkError,
} from './errors/index.js';

// Pagination types
export type { PaginatedIterable, PageFetcher } from './pagination/index.js';

// Subscription types
export type {
  Subscription,
  PlatformEvent,
  SubscriptionOptions,
} from './types/subscription.js';

// Client option types
export type {
  ClientOptions,
  RetryPolicy,
  AuthConfig,
  ApiKeyAuthConfig,
  AccessTokenAuthConfig,
  BrowserAuthConfig,
  ResolvedClientConfig,
} from './types/client-options.js';

// Pagination data types
export type { Page, PaginationOptions, CursorResult } from './types/pagination.js';

// Filter/sort builder for advanced queries
export { filter } from './filter-builder/index.js';
export type { FilterBuilder, FieldConditionBuilder, SortSpec } from './filter-builder/index.js';

// Resource option types
export type {
  ListOptions,
  GetOptions,
  MutationOptions,
  LogQueryOptions,
  TailOptions,
  AuditQueryOptions,
} from './types/resources.js';

// Platform resource types — stable shapes for server-returned data
export type {
  WhoAmIResponse,
  Pipeline,
  PipelineRun,
  PipelineTrigger,
  CreatePipelineRequest,
  UpdatePipelineRequest,
  ConnectorInstance,
  CreateConnectorRequest,
  UpdateConnectorRequest,
  ConnectorTestResult,
  OntologySchema,
  OntologyField,
  OntologyRelationship,
  CreateOntologyRequest,
  UpdateOntologyRequest,
  ValidateOntologyRequest,
  ValidationResult,
  OntologyDiff,
  MigrationStatus,
  App,
  CreateAppRequest,
  UpdateAppRequest,
  Plugin,
  CreatePluginRequest,
  UpdatePluginRequest,
  ApiKey,
  CreatedApiKey,
  CreateApiKeyRequest,
  User,
  CreateUserRequest,
  UpdateUserRequest,
  LogEntry,
  AuditEntry,
  BulkOperation,
  BulkResult,
  BulkResultItem,
} from './resources/platform-types.js';
