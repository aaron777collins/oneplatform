/**
 * Stable platform resource types exported from the SDK.
 * These represent server-returned shapes that the SDK wraps.
 */

// --- Error shapes ---

/**
 * Canonical error response shape returned by all OnePlatform service routes.
 * Every 4xx/5xx response body matches this structure, allowing clients to
 * reliably parse error details without pattern-matching on status codes alone.
 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

// --- Identity ---

export interface WhoAmIResponse {
  readonly userId: string;
  readonly email: string;
  readonly tenantId: string;
  readonly roles: string[];
  readonly scopes: string[];
}

// --- Pipelines ---

export type PipelineTrigger =
  | { type: 'manual' }
  | { type: 'schedule'; cron: string }
  | { type: 'event'; eventPattern: string };

export interface Pipeline {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: 'active' | 'paused' | 'draft';
  readonly trigger: PipelineTrigger;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PipelineRun {
  readonly id: string;
  readonly pipelineId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly input: Record<string, unknown>;
  readonly output: Record<string, unknown> | null;
  readonly error: { message: string; code: string } | null;
}

export interface PipelineDefinition {
  readonly version: 1;
  readonly entryStepId: string;
  readonly steps: readonly PipelineStep[];
  readonly options?: {
    readonly maxConcurrentRuns?: number;
    readonly allowConcurrentRuns?: boolean;
    readonly stepTimeout?: number;
    readonly retainRunsCount?: number;
  };
}

export interface PipelineStep {
  readonly id: string;
  readonly name: string;
  readonly type: 'code' | 'connector' | 'transformer' | 'conditional' | 'parallel' | 'webhook' | 'transform' | 'wait' | 'approval' | 'sub_workflow';
  readonly inputs?: Record<string, PipelineInputSource>;
  readonly onError?: 'fail' | 'skip';
  readonly condition?: string;
  readonly timeout?: number;
  readonly [key: string]: unknown;
}

export type PipelineInputSource =
  | { readonly from: 'pipeline.input'; readonly path?: string }
  | { readonly from: 'step'; readonly stepId: string; readonly path?: string }
  | { readonly from: 'literal'; readonly value: unknown };

export interface CreatePipelineRequest {
  readonly name: string;
  readonly slug?: string;
  readonly description?: string;
  readonly definition: PipelineDefinition;
  readonly isActive?: boolean;
}

export interface UpdatePipelineRequest {
  readonly name?: string;
  readonly description?: string;
  readonly definition?: PipelineDefinition;
  readonly isActive?: boolean;
}

// --- Connectors ---

export interface ConnectorInstance {
  readonly id: string;
  readonly name: string;
  readonly pluginId: string;
  readonly status: 'healthy' | 'error' | 'unchecked';
  readonly syncMode: 'full' | 'incremental';
  readonly scheduleCron: string | null;
  readonly isEnabled: boolean;
  readonly config: Record<string, unknown>;
  readonly lastSyncAt: string | null;
  readonly createdAt: string;
}

export interface CreateConnectorRequest {
  readonly name: string;
  readonly pluginId: string;
  readonly config: Record<string, unknown>;
  readonly credentials?: Record<string, unknown>;
  readonly syncMode?: 'full' | 'incremental';
  readonly isEnabled?: boolean;
  readonly scheduleCron?: string;
}

export interface UpdateConnectorRequest {
  readonly name?: string;
  readonly config?: Record<string, unknown>;
}

export interface ConnectorTestResult {
  readonly success: boolean;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface SyncJob {
  readonly syncJobId: string;
  readonly connectorId: string;
  readonly status: "queued" | "running" | "success" | "failed" | "cancelled";
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly recordsProcessed: number;
  readonly errorMessage: string | null;
}

export interface SyncProgress {
  readonly syncJobId: string;
  readonly status: string;
  readonly progress: number; // 0–100
  readonly recordsProcessed: number;
  readonly estimatedCompletionAt: string | null;
}

// --- Ontologies ---

export interface OntologyField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly indexed: boolean;
  readonly description: string | null;
}

export interface OntologyRelationship {
  readonly name: string;
  readonly targetEntity: string;
  readonly cardinality: 'one' | 'many';
}

export interface OntologySchema {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly version: number;
  readonly fields: OntologyField[];
  readonly relationships: OntologyRelationship[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateOntologyRequest {
  readonly name: string;
  readonly displayName: string;
  readonly fields: OntologyField[];
  readonly relationships?: OntologyRelationship[];
}

export interface UpdateOntologyRequest {
  readonly displayName?: string;
  readonly fields?: OntologyField[];
  readonly relationships?: OntologyRelationship[];
}

export interface ValidateOntologyRequest {
  readonly schema: Partial<CreateOntologyRequest>;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: Array<{ field: string; message: string }>;
}

export interface OntologyDiff {
  readonly changes: Array<{
    readonly op: 'add' | 'remove' | 'modify';
    readonly path: string;
    readonly from?: unknown;
    readonly to?: unknown;
  }>;
  readonly isBreaking: boolean;
  readonly requiresMigration: boolean;
}

export interface MigrationStatus {
  readonly ontologyId: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly progress: number;
  readonly completedAt: string | null;
  readonly error: string | null;
}

// --- Apps ---

export interface App {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly accessMode: 'platform-user' | 'public';
  readonly currentBuildId: string | null;
  readonly allowedModules: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
}

export interface CreateAppRequest {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly accessMode?: 'platform-user' | 'public';
}

export interface UpdateAppRequest {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly accessMode?: 'platform-user' | 'public';
  readonly allowedModules?: string[];
}

// --- Plugins ---

export interface Plugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly status: 'active' | 'inactive';
  readonly installedAt: string;
}

export interface CreatePluginRequest {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly config?: Record<string, unknown>;
}

export interface UpdatePluginRequest {
  readonly version?: string;
  readonly config?: Record<string, unknown>;
  readonly status?: Plugin['status'];
}

// --- API Keys ---

export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
}

export interface CreatedApiKey extends ApiKey {
  /** Full key value. Returned exactly once — store it securely. */
  readonly key: string;
}

export interface CreateApiKeyRequest {
  readonly name: string;
  readonly scopes?: string[];
  readonly expiresAt?: string;
}

// --- Users ---

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly roles: string[];
  readonly tenantId: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

export interface CreateUserRequest {
  readonly email: string;
  readonly displayName?: string;
  readonly roles?: string[];
}

export interface UpdateUserRequest {
  readonly displayName?: string;
  readonly roles?: string[];
}

// --- Logs and Audit ---

export interface LogEntry {
  readonly id: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly service: string;
  readonly traceId: string;
  readonly tenantId: string;
  readonly metadata: Record<string, unknown>;
  readonly timestamp: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly actorId: string | null;
  readonly actorType: 'user' | 'api-key' | 'service' | 'system';
  readonly resourceType: string;
  readonly resourceId: string;
  readonly tenantId: string;
  readonly metadata: Record<string, unknown>;
  readonly traceId: string;
  readonly timestamp: string;
}

// --- Bulk operations ---

export interface BulkOperation<T> {
  readonly operation: 'create' | 'update' | 'delete';
  readonly items: Array<Partial<T>>;
  readonly transactional?: boolean;
}

export type BulkResultItem<T> =
  | { index: number; id: string; status: 'success'; item: T }
  | { index: number; status: 'error'; error: { code: string; message: string } };

export interface BulkResult<T> {
  readonly results: Array<BulkResultItem<T>>;
  readonly summary: { total: number; succeeded: number; failed: number };
}
