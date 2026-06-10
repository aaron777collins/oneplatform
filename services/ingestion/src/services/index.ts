// Barrel export for all ingestion service layer modules.
// Import from this file, not from individual service files, to keep the
// public surface stable as internal file layout evolves.

export {
  createCredentialService,
  type CredentialService,
  type CredentialRepository,
  type CredentialAccessor,
  type CredentialRow,
  type UpsertCredentialData,
} from "./credential-service.js";

export {
  createConnectorService,
  type ConnectorService,
  type ConnectorRepository,
  type SyncStateRepository,
  type ConnectorRow,
  type SyncStateRow,
  type ConnectorWithSyncState,
  type ConnectorListResult,
  type CreateConnectorInput,
  type UpdateConnectorInput,
  type ListConnectorsOptions,
  type TestConnectorOverrides,
  type TestConnectorResult,
} from "./connector-service.js";

export {
  createSyncService,
  type SyncService,
  type RawTableRepository,
  type SyncProgress,
  type SyncJobPayload,
  type BatchJobPayload,
  type SyncJobSummary,
  type ListSyncsOptions,
  type ListSyncsResult,
  type TriggerSyncResult,
} from "./sync-service.js";

export {
  createWebhookReceiveService,
  type WebhookReceiveService,
  type WebhookReceiverRepository,
  type WebhookReceiverRow,
  type ReceiveEventResult,
} from "./webhook-receive-service.js";

export {
  createUploadService,
  type UploadService,
  type UploadJobRepository,
  type UploadJobRow,
  type ObjectStorageClient,
  type FileParseJobPayload,
  type CreateUploadInput,
} from "./upload-service.js";

export {
  createRetentionService,
  type RetentionService,
  type RetentionRawTableRepository,
} from "./retention-service.js";

// Re-export error classes so routes only need to import from services/index.js
export {
  ConnectorNotFoundError,
  ConnectorDisabledError,
  SyncAlreadyRunningError,
  ConnectorTimeoutError,
  ConnectorAuthFailedError,
  ConnectorRateLimitedError,
  ConnectorDataError,
  ConnectorConfigError,
  QueueFullError,
  CredentialDecryptFailedError,
  CredentialNotFoundError,
  UploadFileTooLargeError,
  UploadUnsupportedTypeError,
  UploadParseFailedError,
  UploadJobNotFoundError,
  WebhookReceiverNotFoundError,
} from "./errors.js";
