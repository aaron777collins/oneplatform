import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// App Service errors — design spec §14.1 error code registry
// ---------------------------------------------------------------------------

// App does not exist or belongs to a different tenant. Same response shape for
// "not found" and "wrong tenant" to prevent existence leakage across tenants.
export class AppNotFoundError extends AppError {
  readonly code = "APP_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// File path not found in the VFS for the given app.
export class AppFileNotFoundError extends AppError {
  readonly code = "APP_FILE_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// Optimistic lock mismatch: another write incremented file_version between the
// client's read and this write. Client must re-fetch and merge.
export class AppFileVersionConflictError extends AppError {
  readonly code = "APP_FILE_VERSION_CONFLICT" as const;
  readonly statusCode = 409;
}

// File content exceeds 1MB limit per file. Checked before DB write.
export class AppFileTooLargeError extends AppError {
  readonly code = "APP_FILE_TOO_LARGE" as const;
  readonly statusCode = 413;
}

// Path traversal detected, invalid extension, forbidden characters, or path
// exceeds 512 chars. Validated at the API boundary before any DB access.
export class AppFileInvalidPathError extends AppError {
  readonly code = "APP_FILE_INVALID_PATH" as const;
  readonly statusCode = 400;
}

// Caller attempted to delete /src/index.tsx, which is the required entrypoint.
// A build without an entrypoint would fail immediately — prevent the delete.
export class AppCannotDeleteEntrypointError extends AppError {
  readonly code = "APP_CANNOT_DELETE_ENTRYPOINT" as const;
  readonly statusCode = 422;
}

// Another build is already running (status = pending or building) for this app.
// One concurrent build per app is enforced at the service layer.
export class AppBuildInProgressError extends AppError {
  readonly code = "APP_BUILD_IN_PROGRESS" as const;
  readonly statusCode = 409;
}

// Build exists but is not in success state. Cannot deploy or rollback to a
// build that failed, is still pending, or is still building.
export class AppBuildNotReadyError extends AppError {
  readonly code = "APP_BUILD_NOT_READY" as const;
  readonly statusCode = 400;
}

// Build artifacts have been purged from MinIO by the retention job.
// The 20-build retention window (configurable) limits available rollback targets.
export class AppBuildArtifactsExpiredError extends AppError {
  readonly code = "APP_BUILD_ARTIFACTS_EXPIRED" as const;
  readonly statusCode = 400;
}

// Caller attempted to delete the build that is currently deployed (current_build_id).
// Deleting the active build would break production serving.
export class AppCannotDeleteActiveBuildError extends AppError {
  readonly code = "APP_CANNOT_DELETE_ACTIVE_BUILD" as const;
  readonly statusCode = 422;
}

// App serving failed because no successful build has been deployed yet.
// current_build_id is NULL or the referenced build has no artifacts.
export class AppNoActiveBuildError extends AppError {
  readonly code = "APP_NO_ACTIVE_BUILD" as const;
  readonly statusCode = 503;
}

// App VFS has no files — submitting a build to the Execution Service would
// fail immediately. Guard at the trigger-build boundary.
export class AppNoFilesError extends AppError {
  readonly code = "APP_NO_FILES" as const;
  readonly statusCode = 422;
}

// Key not found in app.user_storage for the (app_id, user_id, key) tuple.
export class AppStorageKeyNotFoundError extends AppError {
  readonly code = "APP_STORAGE_KEY_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// JSON-serialized storage value exceeds 64KB. Checked before DB write.
export class AppStorageValueTooLargeError extends AppError {
  readonly code = "APP_STORAGE_VALUE_TOO_LARGE" as const;
  readonly statusCode = 413;
}

// Auth Service rejected the OAuth client registration call. The deploy is
// rolled back (current_build_id reverted) when this occurs.
export class AppOAuthClientRegistrationFailedError extends AppError {
  readonly code = "APP_OAUTH_CLIENT_REGISTRATION_FAILED" as const;
  readonly statusCode = 502;
}

// Global feature flag OP_ENABLE_CROSS_TENANT_SHARING=false prevents sharing.
export class AppCrossTenantSharingDisabledError extends AppError {
  readonly code = "APP_CROSS_TENANT_SHARING_DISABLED" as const;
  readonly statusCode = 403;
}

// Guest session creation rate limit exceeded (20 per IP per minute).
export class GuestSessionRateLimitedError extends AppError {
  readonly code = "GUEST_SESSION_RATE_LIMITED" as const;
  readonly statusCode = 429;
}

// Referenced build ID does not exist for this app (e.g., rollback to unknown build).
export class AppBuildNotFoundError extends AppError {
  readonly code = "APP_BUILD_NOT_FOUND" as const;
  readonly statusCode = 400;
}

// Slug is already taken (per-tenant for platform-user, global for public).
export class AppSlugConflictError extends AppError {
  readonly code = "APP_SLUG_CONFLICT" as const;
  readonly statusCode = 409;
}
