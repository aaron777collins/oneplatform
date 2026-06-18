import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Plugin Service errors — design spec §13 error code taxonomy
//
// HTTP status conventions:
//   - 404: resource not found
//   - 409: conflict requiring explicit confirmation
//   - 413: payload too large
//   - 422: validation or business-rule rejection (not retryable)
//   - 500: unexpected internal error
//   - 502: upstream service failure
//   - 503: infrastructure unavailable (retryable)
// ---------------------------------------------------------------------------

// Manifest failed Zod validation; details.fieldErrors present.
export class InvalidManifestError extends AppError {
  readonly code = "INVALID_MANIFEST" as const;
  readonly statusCode = 422;
}

// SHA-256 of bundle.js does not match manifest.bundleChecksum.
export class ChecksumMismatchError extends AppError {
  readonly code = "CHECKSUM_MISMATCH" as const;
  readonly statusCode = 422;
}

// GPG verification deferred — see G-034 in GAP-ANALYSIS.md

// Required files missing from the tarball.
export class InvalidPackageStructureError extends AppError {
  readonly code = "INVALID_PACKAGE_STRUCTURE" as const;
  readonly statusCode = 422;
}

// Execution Service could not call metadata() on the entrypoint.
export class EntrypointNotCallableError extends AppError {
  readonly code = "ENTRYPOINT_NOT_CALLABLE" as const;
  readonly statusCode = 422;
}

// manifest.minPlatformVersion exceeds current platform version.
export class PlatformVersionTooOldError extends AppError {
  readonly code = "PLATFORM_VERSION_TOO_OLD" as const;
  readonly statusCode = 422;
}

// Hook dependency graph contains a cycle (v2 guard, always passes in v1).
export class CircularDependencyError extends AppError {
  readonly code = "CIRCULAR_DEPENDENCY" as const;
  readonly statusCode = 422;
}

// Bundle exceeds 50MB limit.
export class UploadTooLargeError extends AppError {
  readonly code = "UPLOAD_TOO_LARGE" as const;
  readonly statusCode = 413;
}

// Plugin ID or manifest_id not found.
export class PluginNotFoundError extends AppError {
  readonly code = "PLUGIN_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// Instance ID not found.
export class InstanceNotFoundError extends AppError {
  readonly code = "INSTANCE_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// Plugin is not in `active` status for instance operations.
export class PluginNotActiveError extends AppError {
  readonly code = "PLUGIN_NOT_ACTIVE" as const;
  readonly statusCode = 422;
}

// Config does not conform to manifest.configSchema.
export class ConfigValidationFailedError extends AppError {
  readonly code = "CONFIG_VALIDATION_FAILED" as const;
  readonly statusCode = 422;
}

// Upgrade blocked because existing instance configs fail the new configSchema.
export class ConfigMigrationRequiredError extends AppError {
  readonly code = "CONFIG_MIGRATION_REQUIRED" as const;
  readonly statusCode = 422;
}

// Uninstall blocked — one or more instances are enabled.
export class PluginHasActiveInstancesError extends AppError {
  readonly code = "PLUGIN_HAS_ACTIVE_INSTANCES" as const;
  readonly statusCode = 422;
}

// Uninstall blocked — active BullMQ jobs reference this plugin.
export class PluginHasActiveJobsError extends AppError {
  readonly code = "PLUGIN_HAS_ACTIVE_JOBS" as const;
  readonly statusCode = 422;
}

// Data orphans exist; caller must resubmit with confirmOrphan=true.
export class OrphanConfirmationRequiredError extends AppError {
  readonly code = "ORPHAN_CONFIRMATION_REQUIRED" as const;
  readonly statusCode = 409;
}

// Ingestion Service call failed during connector registration.
export class ConnectorRegistrationFailedError extends AppError {
  readonly code = "CONNECTOR_REGISTRATION_FAILED" as const;
  readonly statusCode = 502;
}

// Execution Service call failed during install entrypoint validation.
export class ExecutionValidationFailedError extends AppError {
  readonly code = "EXECUTION_VALIDATION_FAILED" as const;
  readonly statusCode = 502;
}

// MinIO not reachable (retryable).
export class StorageUnavailableError extends AppError {
  readonly code = "STORAGE_UNAVAILABLE" as const;
  readonly statusCode = 503;
}

// Unexpected server error — catch-all.
export class InternalPluginError extends AppError {
  readonly code = "INTERNAL_ERROR" as const;
  readonly statusCode = 500;
}
