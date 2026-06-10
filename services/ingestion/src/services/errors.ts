import { AppError } from "@oneplatform/core";

export class ConnectorNotFoundError extends AppError {
  readonly code = "INGESTION_CONNECTOR_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class ConnectorDisabledError extends AppError {
  readonly code = "INGESTION_CONNECTOR_DISABLED" as const;
  readonly statusCode = 409;
}

export class SyncAlreadyRunningError extends AppError {
  readonly code = "INGESTION_SYNC_ALREADY_RUNNING" as const;
  readonly statusCode = 409;
}

export class ConnectorTimeoutError extends AppError {
  readonly code = "INGESTION_CONNECTOR_TIMEOUT" as const;
  readonly statusCode = 502;
}

export class ConnectorAuthFailedError extends AppError {
  readonly code = "INGESTION_CONNECTOR_AUTH_FAILED" as const;
  readonly statusCode = 502;
}

export class ConnectorRateLimitedError extends AppError {
  readonly code = "INGESTION_CONNECTOR_RATE_LIMITED" as const;
  readonly statusCode = 502;
}

export class ConnectorDataError extends AppError {
  readonly code = "INGESTION_CONNECTOR_DATA_ERROR" as const;
  readonly statusCode = 502;
}

export class ConnectorConfigError extends AppError {
  readonly code = "INGESTION_CONNECTOR_CONFIG_ERROR" as const;
  readonly statusCode = 400;
}

export class QueueFullError extends AppError {
  readonly code = "INGESTION_QUEUE_FULL" as const;
  readonly statusCode = 503;
}

export class CredentialDecryptFailedError extends AppError {
  readonly code = "CREDENTIAL_DECRYPT_FAILED" as const;
  readonly statusCode = 500;
}

export class CredentialNotFoundError extends AppError {
  readonly code = "CREDENTIAL_NOT_FOUND" as const;
  readonly statusCode = 400;
}

export class UploadFileTooLargeError extends AppError {
  readonly code = "UPLOAD_FILE_TOO_LARGE" as const;
  readonly statusCode = 413;
}

export class UploadUnsupportedTypeError extends AppError {
  readonly code = "UPLOAD_UNSUPPORTED_TYPE" as const;
  readonly statusCode = 415;
}

export class UploadParseFailedError extends AppError {
  readonly code = "UPLOAD_PARSE_FAILED" as const;
  readonly statusCode = 422;
}

export class UploadJobNotFoundError extends AppError {
  readonly code = "UPLOAD_JOB_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class WebhookReceiverNotFoundError extends AppError {
  readonly code = "INGESTION_WEBHOOK_NOT_FOUND" as const;
  readonly statusCode = 200;
}
